import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import type { SessionMeta, AgentConfig, EnvironmentConfig, VaultConfig, CredentialConfig } from "@open-managed-agents/shared";
import { generateSessionId, generateVaultId, generateCredentialId } from "@open-managed-agents/shared";
import { kvKey } from "../kv-helpers";

// Internal endpoints, called only by the integrations gateway worker via the
// `MAIN` service binding. Auth is a shared header secret — no better-auth
// session, no API key. Routes here MUST NOT be exposed publicly; they trust
// the calling worker to have already authenticated the OMA user.
//
// Mounted at /v1/internal/* in apps/main/src/index.ts.

const app = new Hono<{ Bindings: Env }>();

// Header-secret auth middleware. Reject early if the secret is missing or
// the binding isn't configured.
app.use("*", async (c, next) => {
  const expected = c.env.INTEGRATIONS_INTERNAL_SECRET;
  if (!expected) {
    return c.json({ error: "internal endpoints not configured" }, 503);
  }
  const provided = c.req.header("x-internal-secret");
  if (!provided || provided !== expected) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

interface CreateSessionBody {
  action: "create";
  userId: string;
  agentId: string;
  environmentId: string;
  vaultIds?: string[];
  mcpServers?: Array<{ name: string; url: string; type?: string }>;
  metadata?: Record<string, unknown>;
  initialEvent?: { type: string; content: unknown[]; metadata?: Record<string, unknown> };
}

interface ResumeSessionBody {
  /** Session owner; required to resolve tenantId in O(1) without scanning. */
  userId: string;
  event: { type: string; content: unknown[]; metadata?: Record<string, unknown> };
}

interface CreateVaultCredentialBody {
  action: "create_with_credential";
  userId: string;
  vaultName: string;
  displayName: string;
  mcpServerUrl: string;
  bearerToken: string;
  provider?: "github" | "linear";
}

interface AddCommandSecretBody {
  action: "add_command_secret";
  userId: string;
  /** Existing vault id; null = create fresh vault. */
  vaultId: string | null;
  vaultName: string;
  displayName: string;
  commandPrefixes: string[];
  envVar: string;
  token: string;
  provider?: "github" | "linear";
}

interface RotateBody {
  action: "rotate_bearer" | "rotate_command_secret";
  userId: string;
  vaultId: string;
  newToken: string;
  /** Required only when action=rotate_command_secret (disambiguates if vault has multiple). */
  envVar?: string;
}

/**
 * POST /v1/internal/sessions
 * Body: CreateSessionBody. Creates a new session and (optionally) seeds it
 * with an initial user message. Returns { sessionId }.
 */
app.post("/sessions", async (c) => {
  const body = await c.req.json<CreateSessionBody>();
  if (body.action !== "create") {
    return c.json({ error: "unknown action" }, 400);
  }
  if (!body.userId || !body.agentId || !body.environmentId) {
    return c.json({ error: "userId, agentId, environmentId required" }, 400);
  }

  const tenantId = await resolveTenantId(c.env, body.userId);
  if (!tenantId) return c.json({ error: "user has no tenant" }, 404);

  const agentData = await c.env.CONFIG_KV.get(kvKey(tenantId, "agent", body.agentId));
  if (!agentData) return c.json({ error: "agent not found in tenant" }, 404);

  const envSnapshotData = await c.env.CONFIG_KV.get(
    kvKey(tenantId, "env", body.environmentId),
  );
  if (!envSnapshotData) return c.json({ error: "environment not found in tenant" }, 404);
  const envConfig = JSON.parse(envSnapshotData) as EnvironmentConfig;

  // Resolve the sandbox binding for this environment. Same naming convention
  // as the public sessions route: SANDBOX_<sanitized worker name>.
  if (!envConfig.sandbox_worker_name) {
    return c.json({ error: "environment has no sandbox worker" }, 500);
  }
  const bindingName = `SANDBOX_${envConfig.sandbox_worker_name.replace(/-/g, "_")}`;
  const binding = (c.env as unknown as Record<string, unknown>)[bindingName] as
    | Fetcher
    | undefined;
  if (!binding) {
    return c.json({ error: `sandbox binding ${bindingName} not bound` }, 500);
  }

  const sessionId = generateSessionId();
  const vaultIds = body.vaultIds ?? [];

  // Build the agent snapshot up-front so we can ship it to SessionDO at /init
  // (and so the per-session MCP-server augmentation actually takes effect on
  // the snapshot the DO uses, not just the one we persist below).
  let agentSnapshot = JSON.parse(agentData) as AgentConfig;
  if (body.mcpServers && body.mcpServers.length > 0) {
    const existing = agentSnapshot.mcp_servers ?? [];
    agentSnapshot = {
      ...agentSnapshot,
      mcp_servers: [
        ...existing,
        ...body.mcpServers.map((s) => ({
          name: s.name,
          type: (s.type ?? "url") as "url" | "stdio" | "sse",
          url: s.url,
        })),
      ],
    };
  }

  // Pre-fetch vault credentials so SessionDO can serve them from state
  // instead of reading CONFIG_KV (which may be a different namespace if
  // sandbox-default is shared across envs).
  const vaultCredentials = await fetchVaultCredentials(c.env, tenantId, vaultIds);

  // Initialize SessionDO via the sandbox worker. Pass vault_ids so the
  // outbound Worker can match credentials for this session, plus the
  // pre-fetched config snapshots (see snapshot rationale above).
  await binding.fetch(`https://sandbox/sessions/${sessionId}/init`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent_id: body.agentId,
      environment_id: body.environmentId,
      title: "",
      session_id: sessionId,
      tenant_id: tenantId,
      vault_ids: vaultIds,
      agent_snapshot: agentSnapshot,
      environment_snapshot: envConfig,
      vault_credentials: vaultCredentials,
    }),
  });

  // Persist a session record with frozen agent + env snapshots so trajectory
  // and replay work even after the agent or env definition changes.
  const session: SessionMeta = {
    id: sessionId,
    agent_id: body.agentId,
    environment_id: body.environmentId,
    title: "",
    status: "idle",
    vault_ids: vaultIds,
    created_at: new Date().toISOString(),
  };
  const sessionRecord = {
    ...session,
    agent_snapshot: agentSnapshot,
    environment_snapshot: envConfig,
    metadata: body.metadata ?? {},
  };
  await c.env.CONFIG_KV.put(
    kvKey(tenantId, "session", sessionId),
    JSON.stringify(sessionRecord),
  );

  // Seed the session with the initial event, if any.
  if (body.initialEvent) {
    await binding.fetch(`https://sandbox/sessions/${sessionId}/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body.initialEvent),
    });
  }

  return c.json({ sessionId });
});

/**
 * POST /v1/internal/sessions/:id/events
 * Body: ResumeSessionBody. Appends an event to an existing session.
 */
app.post("/sessions/:id/events", async (c) => {
  const sessionId = c.req.param("id");
  const body = await c.req.json<ResumeSessionBody>();
  if (!body?.event || !body?.userId) {
    return c.json({ error: "userId and event required" }, 400);
  }

  const tenantId = await resolveTenantId(c.env, body.userId);
  if (!tenantId) return c.json({ error: "user has no tenant" }, 404);

  const sessionData = await c.env.CONFIG_KV.get(kvKey(tenantId, "session", sessionId));
  if (!sessionData) return c.json({ error: "session not found" }, 404);
  const session = JSON.parse(sessionData) as SessionMeta;

  const envSnapshotData = await c.env.CONFIG_KV.get(
    kvKey(tenantId, "env", session.environment_id),
  );
  if (!envSnapshotData) return c.json({ error: "environment missing" }, 500);
  const envConfig = JSON.parse(envSnapshotData) as EnvironmentConfig;
  const bindingName = `SANDBOX_${(envConfig.sandbox_worker_name ?? "").replace(/-/g, "_")}`;
  const binding = (c.env as unknown as Record<string, unknown>)[bindingName] as
    | Fetcher
    | undefined;
  if (!binding) return c.json({ error: `sandbox binding missing` }, 500);

  await binding.fetch(`https://sandbox/sessions/${sessionId}/event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body.event),
  });

  return c.json({ ok: true });
});

/**
 * POST /v1/internal/vaults
 * Body discriminated by `action`:
 *   - "create_with_credential":  CreateVaultCredentialBody  → fresh vault + static_bearer
 *   - "add_command_secret":      AddCommandSecretBody       → command_secret cred (in existing or fresh vault)
 *
 * Both return { vaultId, credentialId }.
 */
app.post("/vaults", async (c) => {
  const body = (await c.req.json()) as
    | CreateVaultCredentialBody
    | AddCommandSecretBody;

  if (body.action === "create_with_credential") {
    if (!body.userId || !body.mcpServerUrl || !body.bearerToken) {
      return c.json(
        { error: "userId, mcpServerUrl, bearerToken required" },
        400,
      );
    }
    const tenantId = await resolveTenantId(c.env, body.userId);
    if (!tenantId) return c.json({ error: "user has no tenant" }, 404);

    const vault: VaultConfig = {
      id: generateVaultId(),
      name: body.vaultName,
      created_at: new Date().toISOString(),
    };
    await c.env.CONFIG_KV.put(kvKey(tenantId, "vault", vault.id), JSON.stringify(vault));

    const credential: CredentialConfig = {
      id: generateCredentialId(),
      vault_id: vault.id,
      display_name: body.displayName,
      auth: {
        type: "static_bearer",
        mcp_server_url: body.mcpServerUrl,
        token: body.bearerToken,
        provider: body.provider,
      },
      created_at: new Date().toISOString(),
    };
    await c.env.CONFIG_KV.put(
      kvKey(tenantId, "cred", vault.id, credential.id),
      JSON.stringify(credential),
    );
    return c.json({ vaultId: vault.id, credentialId: credential.id });
  }

  if (body.action === "add_command_secret") {
    if (!body.userId || !body.commandPrefixes?.length || !body.envVar || !body.token) {
      return c.json(
        { error: "userId, commandPrefixes, envVar, token required" },
        400,
      );
    }
    const tenantId = await resolveTenantId(c.env, body.userId);
    if (!tenantId) return c.json({ error: "user has no tenant" }, 404);

    let vaultId = body.vaultId;
    if (!vaultId) {
      const vault: VaultConfig = {
        id: generateVaultId(),
        name: body.vaultName,
        created_at: new Date().toISOString(),
      };
      await c.env.CONFIG_KV.put(kvKey(tenantId, "vault", vault.id), JSON.stringify(vault));
      vaultId = vault.id;
    } else {
      // Caller-supplied vault must exist in this tenant; refuse cross-tenant attach.
      const existing = await c.env.CONFIG_KV.get(kvKey(tenantId, "vault", vaultId));
      if (!existing) return c.json({ error: "vault not found in tenant" }, 404);
    }

    const credential: CredentialConfig = {
      id: generateCredentialId(),
      vault_id: vaultId,
      display_name: body.displayName,
      auth: {
        type: "command_secret",
        command_prefixes: body.commandPrefixes,
        env_var: body.envVar,
        token: body.token,
        provider: body.provider,
      },
      created_at: new Date().toISOString(),
    };
    await c.env.CONFIG_KV.put(
      kvKey(tenantId, "cred", vaultId, credential.id),
      JSON.stringify(credential),
    );
    return c.json({ vaultId, credentialId: credential.id });
  }

  return c.json({ error: "unknown action" }, 400);
});

/**
 * POST /v1/internal/vaults/rotate
 * Replace the token on a credential in the given vault, looking it up by
 * type (and env_var for command_secret). Used to refresh short-lived upstream
 * tokens (e.g. GitHub installation tokens, ~1hr TTL) without the caller
 * having to remember credential ids.
 */
app.post("/vaults/rotate", async (c) => {
  const body = (await c.req.json()) as RotateBody;
  if (!body.userId || !body.vaultId || !body.newToken) {
    return c.json({ error: "userId, vaultId, newToken required" }, 400);
  }
  const tenantId = await resolveTenantId(c.env, body.userId);
  if (!tenantId) return c.json({ error: "user has no tenant" }, 404);

  const list = await c.env.CONFIG_KV.list({
    prefix: kvKey(tenantId, "cred", body.vaultId) + ":",
  });
  if (!list.keys.length) return c.json({ error: "vault has no credentials" }, 404);

  let target: { key: string; cred: CredentialConfig } | null = null;
  for (const k of list.keys) {
    const data = await c.env.CONFIG_KV.get(k.name);
    if (!data) continue;
    let cred: CredentialConfig;
    try {
      cred = JSON.parse(data) as CredentialConfig;
    } catch {
      continue;
    }
    if (body.action === "rotate_bearer" && cred.auth?.type === "static_bearer") {
      target = { key: k.name, cred };
      break;
    }
    if (
      body.action === "rotate_command_secret" &&
      cred.auth?.type === "command_secret" &&
      (!body.envVar || cred.auth.env_var === body.envVar)
    ) {
      target = { key: k.name, cred };
      break;
    }
  }
  if (!target) return c.json({ error: "matching credential not found" }, 404);

  if (body.action === "rotate_bearer") {
    if (target.cred.auth?.type !== "static_bearer") {
      return c.json({ error: "credential is not static_bearer" }, 400);
    }
    target.cred.auth.token = body.newToken;
  } else {
    if (target.cred.auth?.type !== "command_secret") {
      return c.json({ error: "credential is not command_secret" }, 400);
    }
    target.cred.auth.token = body.newToken;
  }
  target.cred.updated_at = new Date().toISOString();
  await c.env.CONFIG_KV.put(target.key, JSON.stringify(target.cred));
  return c.json({ ok: true, credentialId: target.cred.id });
});

// ─── Helpers ─────────────────────────────────────────────────────────────

async function resolveTenantId(env: Env, userId: string): Promise<string | null> {
  if (!env.AUTH_DB) return null;
  // Avoid pulling better-auth into the hot path; one direct query.
  const row = await env.AUTH_DB.prepare(`SELECT tenantId FROM "user" WHERE id = ?`)
    .bind(userId)
    .first<{ tenantId: string | null }>();
  return row?.tenantId ?? null;
}

/**
 * Pre-fetch all credentials for the given vaults so they can be passed into
 * SessionDO at /init. Mirrors the list+get loop SessionDO would otherwise
 * do against its own (potentially wrong) CONFIG_KV namespace.
 */
async function fetchVaultCredentials(
  env: Env,
  tenantId: string,
  vaultIds: string[],
): Promise<Array<{ vault_id: string; credentials: CredentialConfig[] }>> {
  if (!vaultIds.length) return [];
  const out: Array<{ vault_id: string; credentials: CredentialConfig[] }> = [];
  for (const vaultId of vaultIds) {
    const list = await env.CONFIG_KV.list({ prefix: kvKey(tenantId, "cred", vaultId) + ":" });
    const credentials: CredentialConfig[] = [];
    for (const k of list.keys) {
      const data = await env.CONFIG_KV.get(k.name);
      if (!data) continue;
      try {
        credentials.push(JSON.parse(data) as CredentialConfig);
      } catch {
        // skip malformed
      }
    }
    out.push({ vault_id: vaultId, credentials });
  }
  return out;
}

export default app;
