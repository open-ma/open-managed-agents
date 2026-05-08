import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import type { AgentConfig, EnvironmentConfig, VaultConfig, CredentialConfig } from "@open-managed-agents/shared";
import { generateVaultId } from "@open-managed-agents/shared";
import type { Services } from "@open-managed-agents/services";
import { toEnvironmentConfig } from "@open-managed-agents/environments-store";

// Internal endpoints, called only by the integrations gateway worker via the
// `MAIN` service binding. Auth is a shared header secret — no better-auth
// session, no API key. Routes here MUST NOT be exposed publicly; they trust
// the calling worker to have already authenticated the OMA user.
//
// Mounted at /v1/internal/* in apps/main/src/index.ts.

const app = new Hono<{ Bindings: Env; Variables: { services: Services } }>();

// Public hostname of the integrations gateway, used to wire a hosted Linear
// MCP server into Linear-triggered sessions. We hard-fail when the env var
// is unset rather than fall back to a default: a silent default would have
// us mint MCP URLs (and per-session bearer tokens) pointing at whatever
// hostname was baked in, on any future env stanza that forgot to declare
// it. Both prod and staging wrangler stanzas explicitly set this — anything
// else is a config bug we want to see immediately.
function integrationsOrigin(env: Env): string {
  const explicit = (env as unknown as { INTEGRATIONS_ORIGIN?: string }).INTEGRATIONS_ORIGIN;
  if (!explicit) {
    throw new Error(
      "INTEGRATIONS_ORIGIN is not configured — refusing to mint MCP URLs against an unknown gateway",
    );
  }
  return explicit;
}

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
  /**
   * Optional repo URL to mount as a github_repository resource. Token is
   * pulled from any vaultIds entry that has a command_secret credential
   * with env_var=GITHUB_TOKEN — providers never see the token.
   */
  githubRepoUrl?: string;
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

  const agentRow = await c.var.services.agents.get({ tenantId, agentId: body.agentId });
  if (!agentRow) return c.json({ error: "agent not found in tenant" }, 404);

  const envRow = await c.var.services.environments.get({
    tenantId,
    environmentId: body.environmentId,
  });
  if (!envRow) return c.json({ error: "environment not found in tenant" }, 404);

  // Resolve the sandbox binding for this environment. Same naming convention
  // as the public sessions route: SANDBOX_<sanitized worker name>.
  // Read directly from the row — sandbox_worker_name is a server-internal
  // detail, not surfaced on the wire.
  if (!envRow.sandbox_worker_name) {
    return c.json({ error: "environment has no sandbox worker" }, 500);
  }
  const bindingName = `SANDBOX_${envRow.sandbox_worker_name.replace(/-/g, "_")}`;
  const binding = (c.env as unknown as Record<string, unknown>)[bindingName] as
    | Fetcher
    | undefined;
  if (!binding) {
    return c.json({ error: `sandbox binding ${bindingName} not bound` }, 500);
  }

  // Build the agent snapshot up-front so we can ship it to SessionDO at /init
  // (and so the per-session MCP-server augmentation actually takes effect on
  // the snapshot the DO uses, not just the one we persist below).
  const vaultIds = body.vaultIds ?? [];
  const { tenant_id: _atid, ...agentBase } = agentRow;
  let agentSnapshot: AgentConfig = agentBase;
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

  // Allocate the session id by inserting the row first — sessions-store owns
  // id generation. Linear MCP wiring below augments the snapshot + metadata
  // and we re-persist via service.update to keep the row consistent.
  const initialMetadata: Record<string, unknown> = { ...(body.metadata ?? {}) };
  const { session: createdSession } = await c.var.services.sessions.create({
    tenantId,
    agentId: body.agentId,
    environmentId: body.environmentId,
    title: "",
    vaultIds,
    agentSnapshot,
    environmentSnapshot: toEnvironmentConfig(envRow),
    metadata: Object.keys(initialMetadata).length === 0 ? undefined : initialMetadata,
  });
  const sessionId = createdSession.id;

  // Pre-fetch vault credentials so SessionDO can serve them from state
  // instead of reading CONFIG_KV (which may be a different namespace if
  // sandbox-default is shared across envs).
  const vaultCredentials = await fetchVaultCredentials(c.var.services, tenantId, vaultIds);

  // Linear-triggered session: wire a hosted Linear MCP server into the
  // sandbox. Mint a per-session UUID, store in metadata.linear.mcp_token,
  // inject a static_bearer cred so outbound MITM auto-attaches it on calls
  // to the integrations gateway, and add the MCP entry to agent_snapshot
  // so the harness picks it up alongside the agent's own mcp_servers.
  const sessionMetadata: Record<string, unknown> = { ...initialMetadata };
  const linearMeta = sessionMetadata.linear as Record<string, unknown> | undefined;
  let metadataDirty = false;
  if (linearMeta) {
    const mcpToken = crypto.randomUUID();
    const mcpUrl = `${integrationsOrigin(c.env)}/linear/mcp/${sessionId}`;
    // Per-turn context (which AgentSession to reply into, which comment to
    // thread under, who triggered) lives on the initialEvent's metadata.linear.
    // Merge it onto the session-static metadata so the MCP server can read it
    // server-side without reaching back into event history.
    const eventLinear =
      (body.initialEvent?.metadata?.linear ?? {}) as Record<string, unknown>;
    sessionMetadata.linear = {
      ...linearMeta,
      mcp_token: mcpToken,
      mcp_url: mcpUrl,
      currentAgentSessionId: eventLinear.agentSessionId ?? null,
      triggerCommentId: eventLinear.commentId ?? null,
      actor: {
        id: eventLinear.actorUserId ?? null,
        // displayName lookup deferred to the MCP server; webhook payload
        // doesn't always include it.
        displayName: null,
      },
    };
    metadataDirty = true;

    // Append our hosted MCP entry to the agent snapshot's mcp_servers list.
    // The Linear provider no longer registers mcp.linear.app — we own that
    // wiring here so any provider can ride the same hosted shim later.
    agentSnapshot = {
      ...agentSnapshot,
      mcp_servers: [
        ...(agentSnapshot.mcp_servers ?? []),
        { name: "linear", type: "url" as const, url: mcpUrl },
      ],
    };

    // Inject the per-session bearer into vaultCredentials so SessionDO's
    // outbound handler matches integrations.openma.dev hostname and attaches
    // Authorization: Bearer <mcp_token>. We attach to the first vault if any
    // (so cred lifecycle ties to the Linear vault); otherwise create a
    // synthetic vault entry just for this MCP cred.
    const synthCred: CredentialConfig = {
      id: `cred-mcp-${sessionId}`,
      vault_id: vaultIds[0] ?? `vlt-mcp-${sessionId}`,
      display_name: "Linear MCP session token",
      auth: {
        type: "static_bearer",
        mcp_server_url: mcpUrl,
        token: mcpToken,
      },
      created_at: new Date().toISOString(),
    };
    const target = vaultCredentials.find((v) => v.vault_id === synthCred.vault_id);
    if (target) {
      target.credentials.push(synthCred);
    } else {
      vaultCredentials.push({ vault_id: synthCred.vault_id, credentials: [synthCred] });
    }
  }

  // Re-persist the augmented snapshot + metadata when the linear branch
  // mutated either. Skipped for the common (non-Linear) case.
  if (metadataDirty) {
    await c.var.services.sessions.update({
      tenantId,
      sessionId,
      agentSnapshot,
      metadata: sessionMetadata,
    });
  }

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
      environment_snapshot: toEnvironmentConfig(envRow),
      vault_credentials: vaultCredentials,
      // Generic event hooks. Per-provider consumers live behind these URLs;
      // SessionDO POSTs every broadcast to each one. Provider-specific
      // translation (e.g. Linear AgentActivity mirror) happens at the
      // consuming endpoint.
      //
      // Linear no longer subscribes here — the bot drives all panel-visible
      // output explicitly via the linear_say / linear_request_input /
      // linear_post_comment MCP tools. event-tap auto-mirror was removed
      // because (a) auto-mirror conflicted with elicitation panel state
      // (trailing assistant message would close the panel), (b) the panel
      // mirror duplicated the same text into the issue thread, and
      // (c) bot internal thinking was leaked to user view. Bot is now a
      // first-class agent that decides what to surface.
      event_hooks: undefined,
    }),
  });

  // Materialize a github_repository resource from the supplied repo URL.
  // The token is sourced from a command_secret credential (env_var=GITHUB_TOKEN)
  // in one of the vaults — provider doesn't pass it inline. SessionDO picks
  // this up via sessions-store at warmup.
  if (body.githubRepoUrl) {
    const ghToken = await findGithubTokenInVaults(vaultCredentials);
    if (ghToken) {
      const added = await c.var.services.sessions.addResource({
        tenantId,
        sessionId,
        resource: {
          type: "github_repository",
          url: body.githubRepoUrl,
          repo_url: body.githubRepoUrl,
          mount_path: "/workspace",
        },
      });
      // Token continues to live in the per-session secret store.
      await c.var.services.sessionSecrets.put({
        tenantId,
        sessionId,
        resourceId: added.id,
        value: ghToken,
      });
    }
  }

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

  const session = await c.var.services.sessions.get({ tenantId, sessionId });
  if (!session) return c.json({ error: "session not found" }, 404);

  const envRow2 = await c.var.services.environments.get({
    tenantId,
    environmentId: session.environment_id,
  });
  if (!envRow2) return c.json({ error: "environment missing" }, 500);
  const bindingName = `SANDBOX_${(envRow2.sandbox_worker_name ?? "").replace(/-/g, "_")}`;
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
 * GET /v1/internal/sessions/:id
 * Returns the persisted session record (id + metadata + snapshots) so the
 * integrations gateway can validate per-session MCP tokens and resolve the
 * publication. O(1) PRIMARY KEY lookup via the sessions-store cross-tenant
 * `getById` — the legacy `sidx:` reverse index + paginated tenant scan
 * fallback is retired.
 */
app.get("/sessions/:id", async (c) => {
  const sessionId = c.req.param("id");
  const session = await c.var.services.sessions.getById({ sessionId });
  if (!session) return c.json({ error: "session not found" }, 404);
  return c.json(session);
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

    const vault = await c.var.services.vaults.create({
      tenantId,
      name: body.vaultName,
    });

    const credential = await c.var.services.credentials.create({
      tenantId,
      vaultId: vault.id,
      displayName: body.displayName,
      auth: {
        type: "static_bearer",
        mcp_server_url: body.mcpServerUrl,
        token: body.bearerToken,
        provider: body.provider,
      },
    });
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
      const vault = await c.var.services.vaults.create({
        tenantId,
        name: body.vaultName,
      });
      vaultId = vault.id;
    } else {
      // Caller-supplied vault must exist in this tenant; refuse cross-tenant attach.
      if (!(await c.var.services.vaults.exists({ tenantId, vaultId }))) {
        return c.json({ error: "vault not found in tenant" }, 404);
      }
    }

    const credential = await c.var.services.credentials.create({
      tenantId,
      vaultId,
      displayName: body.displayName,
      auth: {
        type: "command_secret",
        command_prefixes: body.commandPrefixes,
        env_var: body.envVar,
        token: body.token,
        provider: body.provider,
      },
    });
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

  const service = c.var.services.credentials;
  const list = await service.list({ tenantId, vaultId: body.vaultId });
  if (!list.length) return c.json({ error: "vault has no credentials" }, 404);

  const target = list.find((cred) => {
    if (body.action === "rotate_bearer") return cred.auth?.type === "static_bearer";
    if (body.action === "rotate_command_secret") {
      return (
        cred.auth?.type === "command_secret" &&
        (!body.envVar || cred.auth.env_var === body.envVar)
      );
    }
    return false;
  });
  if (!target) return c.json({ error: "matching credential not found" }, 404);

  if (body.action === "rotate_bearer") {
    if (target.auth?.type !== "static_bearer") {
      return c.json({ error: "credential is not static_bearer" }, 400);
    }
  } else {
    if (target.auth?.type !== "command_secret") {
      return c.json({ error: "credential is not command_secret" }, 400);
    }
  }

  // Merge-replacement keeps every other auth field; service.update merges
  // the partial into the existing row's auth blob.
  await service.update({
    tenantId,
    vaultId: body.vaultId,
    credentialId: target.id,
    auth: { token: body.newToken },
  });
  return c.json({ ok: true, credentialId: target.id });
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
 * Scan vault credentials for a `command_secret` credential whose env_var is
 * GITHUB_TOKEN. Used by the integrations gateway to materialize a
 * github_repository resource without ever sending the token over the
 * service-binding wire.
 */
async function findGithubTokenInVaults(
  vaultCredentials: Array<{ vault_id: string; credentials: CredentialConfig[] }>,
): Promise<string | null> {
  for (const v of vaultCredentials) {
    for (const c of v.credentials) {
      if (
        c.auth?.type === "command_secret" &&
        c.auth.env_var === "GITHUB_TOKEN" &&
        typeof c.auth.token === "string" &&
        c.auth.token.length > 0
      ) {
        return c.auth.token;
      }
    }
  }
  return null;
}

/**
 * Pre-fetch all credentials for the given vaults so they can be passed into
 * SessionDO at /init. Reads from D1 via the credentials-store service.
 */
async function fetchVaultCredentials(
  services: Services,
  tenantId: string,
  vaultIds: string[],
): Promise<Array<{ vault_id: string; credentials: CredentialConfig[] }>> {
  if (!vaultIds.length) return [];
  const grouped = await services.credentials.listByVaults({
    tenantId,
    vaultIds,
  });
  return grouped.map((g) => ({
    vault_id: g.vault_id,
    credentials: g.credentials as unknown as CredentialConfig[],
  }));
}

// ─── Local ACP runtime ────────────────────────────────────────────────────


// /v1/internal/runtime-attach-harness was removed: AcpProxyHarness on the
// agent worker now binds RUNTIME_ROOM directly via cross-script DO binding
// (apps/agent/wrangler.jsonc → script_name: "managed-agents") and calls
// `runtime_room_stub.fetch("http://runtime-room/_attach_harness", ...)`.
// One less worker hop, no shared INTEGRATIONS_INTERNAL_SECRET on agent.

export default app;

// Test-only exports.
export const __testInternals = { integrationsOrigin };
