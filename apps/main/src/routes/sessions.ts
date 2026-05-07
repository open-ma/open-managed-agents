import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "@open-managed-agents/shared";
import type { UserMessageEvent, AgentConfig, EnvironmentConfig, StoredEvent, ContentBlock, CredentialConfig, SessionEvent, SessionResource } from "@open-managed-agents/shared";
import { generateFileId, buildTrajectory, fileR2Key, generateEventId, LOCAL_RUNTIME_ENV_ID } from "@open-managed-agents/shared";
import { logWarn, logError, recordEvent, errFields } from "@open-managed-agents/shared";
import { rateLimitSessionCreate } from "../rate-limit";
import { checkDailySessionCap } from "../quotas";
import type { SessionRecord, FullStatus } from "@open-managed-agents/shared";
import type { Services } from "@open-managed-agents/services";
import { getCfServicesForTenant } from "@open-managed-agents/services";
import { toFileRecord } from "@open-managed-agents/files-store";
import { toEnvironmentConfig } from "@open-managed-agents/environments-store";
import {
  SessionArchivedError,
  SessionMemoryStoreMaxExceededError,
  SessionNotFoundError,
  SessionResourceMaxExceededError,
  SessionResourceNotFoundError,
  type NewResourceInput,
  type SessionRow,
} from "@open-managed-agents/sessions-store";
import { jsonPage, parsePageQuery } from "../lib/list-page";

const app = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; services: Services };
}>();

/**
 * Map sessions-store domain errors → HTTP responses. Centralized so every
 * route handler returns the same status codes for the same failure modes.
 */
function mapSessionError(c: Context, err: unknown): Response {
  if (err instanceof SessionNotFoundError) return c.json({ error: "Session not found" }, 404);
  if (err instanceof SessionResourceNotFoundError) return c.json({ error: "Resource not found" }, 404);
  if (err instanceof SessionArchivedError) return c.json({ error: err.message }, 409);
  if (err instanceof SessionResourceMaxExceededError) return c.json({ error: err.message }, 400);
  if (err instanceof SessionMemoryStoreMaxExceededError) return c.json({ error: err.message }, 422);
  throw err;
}

/**
 * Map AgentConfig snapshot → AMA-shape SessionAgent. Drops fields that
 * BetaManagedAgentsSessionAgent doesn't expose (archived_at, created_at,
 * updated_at, metadata, tenant_id) and the OMA-only top-level fields
 * (aux_model, harness, runtime_binding, appendable_prompts, callable_agents)
 * that surface elsewhere on the wire (under `_oma:` and `multiagent`).
 *
 * `version` defaults to 1 for legacy snapshots that pre-date the version
 * column.
 */
function snapshotToSessionAgent(
  agentId: string,
  snapshot: AgentConfig | null,
): Record<string, unknown> {
  if (!snapshot) {
    // No frozen snapshot — older session, mid-migration row, or test
    // fake. Return the minimum AMA-shape stub.
    return { type: "agent", id: agentId, version: 1 };
  }
  const {
    aux_model: _aux,
    harness: _h,
    runtime_binding: _rb,
    appendable_prompts: _ap,
    callable_agents,
    archived_at: _ar,
    created_at: _ca,
    updated_at: _ua,
    metadata: _md,
    ...rest
  } = snapshot;
  // Inline the multiagent transform (keeps sessions wire shape independent
  // of the agents.ts shaper while reusing the same AMA convention).
  const multiagent = (callable_agents ?? []).length > 0
    ? {
        type: "coordinator" as const,
        agents: (callable_agents ?? []).map((c) => ({
          type: "agent" as const,
          id: c.id,
          version: c.version ?? 1,
        })),
      }
    : null;
  return {
    type: "agent",
    ...rest,
    id: agentId,
    version: snapshot.version ?? 1,
    multiagent,
  };
}

/** Strip server-internal fields from a session row before returning to API.
 *  Emits AMA-aligned BetaManagedAgentsSession shape:
 *    - nested `agent: SessionAgent` (frozen snapshot, top-level agent_id dropped)
 *    - vault_ids defaults to `[]` (never null on the wire)
 *    - title null when stored value is empty
 *    - terminated_at preserved (OMA extension; AMA SDKs ignore unknowns)
 *    - usage / stats defaults present so AMA SDKs always see the field
 *  Live-only fields (`usage` token counts, `outcome_evaluations`,
 *  `resources`, `stats.active_seconds`) are overlaid by the GET handler
 *  when sandbox data is available; this shaper emits structurally
 *  complete defaults so the shape is always present on the wire. */
function toApiSession(row: SessionRow & { tenant_id?: string }): Record<string, unknown> {
  const {
    tenant_id: _t,
    agent_id,
    agent_snapshot,
    environment_snapshot: _es,
    title,
    vault_ids,
    metadata,
    ...rest
  } = row;
  const createdMs = Date.parse(row.created_at);
  const terminatedMs = row.terminated_at ? Date.parse(row.terminated_at) : null;
  // duration_seconds = wall-clock since create. Frozen at terminated_at
  // for terminated sessions (matches AMA's "frozen at the final update").
  const refMs = terminatedMs ?? Date.now();
  const durationSeconds = Number.isFinite(createdMs)
    ? Math.max(0, Math.round((refMs - createdMs) / 1000))
    : undefined;
  return {
    ...rest,
    type: "session" as const,
    title: title === "" ? null : title,
    agent: snapshotToSessionAgent(agent_id, agent_snapshot ?? null),
    vault_ids: vault_ids ?? [],
    metadata: metadata ?? {},
    resources: [] as unknown[],
    outcome_evaluations: [] as unknown[],
    usage: {} as Record<string, unknown>,
    stats: durationSeconds !== undefined ? { duration_seconds: durationSeconds } : {},
  };
}

/**
 * Resolve the sandbox worker fetcher for a given environment.
 *
 * Post-GitHub-build replacement: all sessions route to the single
 * sandbox-default service binding. The legacy per-env worker model
 * (sandbox-${envId} via dynamic SANDBOX_sandbox_env_* bindings + lazy-heal)
 * was removed when setup-on-warmup landed — packages now install at
 * session warmup inside the shared worker, not via per-env CI builds.
 *
 * Two paths:
 *   - SANDBOX_sandbox_default service binding (production-like) — main
 *     calls into the agent worker via service binding, agent's SessionDO
 *     handles the request. This is what main wrangler.jsonc binds.
 *   - SESSION_DO local binding (test/combined worker mode) — used when
 *     main and agent are bundled into one worker (no service hop).
 *
 * Function signature kept so the 13 callsites below don't need to change.
 */
async function getSandboxBinding(
  env: Env,
  environmentId: string,
  tenantId: string,
): Promise<{ binding: Fetcher | null; error?: string; status?: 404 | 500 | 503; retryAfterSeconds?: number }> {
  // Local-runtime sentinel — these sessions never touch a sandbox container;
  // route layer needs a fetcher only to forward /sessions/:id/* into the
  // SessionDO. Skip the env_row lookup entirely (no real env exists for
  // this id by design).
  if (environmentId === LOCAL_RUNTIME_ENV_ID) {
    const fallback = sessionDoFallbackFetcher(env);
    if (!fallback) {
      return {
        binding: null,
        error: "SESSION_DO binding missing — local-runtime session can't route",
        status: 500,
      };
    }
    return { binding: fallback };
  }

  const services = await getCfServicesForTenant(env, tenantId);
  const envRow = await services.environments.get({ tenantId, environmentId });
  if (!envRow) return { binding: null, error: "Environment not found", status: 404 };

  // Production-like: main → service binding → sandbox-default agent worker.
  const svcBinding = (env as unknown as Record<string, unknown>)["SANDBOX_sandbox_default"] as Fetcher | undefined;
  if (svcBinding) {
    return { binding: svcBinding };
  }

  // Combined-worker path: directly invoke SessionDO from this worker.
  if (env.SESSION_DO) {
    const localFetcher: Fetcher = {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        const url = new URL(req.url);
        const match = url.pathname.match(/^\/sessions\/([^/]+)\/(.*)/);
        if (!match) return Promise.resolve(new Response("Not found", { status: 404 }));
        const [, sessionId, rest] = match;
        const doId = env.SESSION_DO!.idFromName(sessionId);
        const stub = env.SESSION_DO!.get(doId);
        // Workaround for cloudflare/workerd#2240: explicitly seed the
        // partyserver .name so internal getters don't throw during DO startup.
        (stub as unknown as { setName?: (n: string) => void }).setName?.(sessionId);
        return stub.fetch(new Request(`http://internal/${rest}${url.search}`, {
          method: req.method,
          headers: req.headers,
          body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
        }));
      },
      connect: () => { throw new Error("not implemented"); },
    } as unknown as Fetcher;
    return { binding: localFetcher };
  }

  return { binding: null, error: "Neither SANDBOX_sandbox_default service binding nor SESSION_DO DO binding present — main worker deploy is broken", status: 500 };
}

/**
 * Translate a getSandboxBinding failure to a Hono Response. Sets
 * Retry-After when the underlying error is recoverable (lazy-heal /
 * still-building), so well-behaved clients back off cleanly.
 */
function bindingErrorResponse(
  c: Context<{ Bindings: Env; Variables: { tenant_id: string; services: Services } }>,
  result: { error?: string; status?: 404 | 500 | 503; retryAfterSeconds?: number },
): Response {
  const status = (result.status ?? 500) as 404 | 500 | 503;
  if (result.retryAfterSeconds) {
    c.header("Retry-After", String(result.retryAfterSeconds));
  }
  return c.json({ error: result.error ?? "binding unavailable" }, status);
}

/**
 * Direct-to-DO fetcher used by local-runtime sessions that don't pin an
 * environment. Skips the sandbox-worker indirection — local-runtime sessions
 * never run a container, so the only thing the "binding" is used for is
 * routing /sessions/:id/* to the SessionDO. This mirrors the lazy fallback
 * already inside getSandboxBinding (see lines 91-114) but factored out so
 * the env_id-less path doesn't have to construct a fake environmentId just
 * to traverse a function whose first action is to look one up.
 */
function sessionDoFallbackFetcher(env: Env): Fetcher | null {
  if (!env.SESSION_DO) return null;
  return {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const url = new URL(req.url);
      const match = url.pathname.match(/^\/sessions\/([^/]+)\/(.*)/);
      if (!match) return Promise.resolve(new Response("Not found", { status: 404 }));
      const [, sessionId, rest] = match;
      const doId = env.SESSION_DO!.idFromName(sessionId);
      const stub = env.SESSION_DO!.get(doId);
      return stub.fetch(new Request(`http://internal/${rest}${url.search}`, {
        method: req.method,
        headers: req.headers,
        body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
      }));
    },
    connect: () => { throw new Error("not implemented"); },
  } as unknown as Fetcher;
}

/**
 * Forward a request to the sandbox worker via service binding.
 */
function forwardToSandbox(
  binding: Fetcher,
  path: string,
  req: Request,
  method?: string,
  body?: BodyInit | null,
): Promise<Response> {
  const url = `https://sandbox${path}`;
  // When the caller overrides the method (e.g. POST→GET to read a file),
  // honor it for the body decision too — otherwise we try to forward the
  // (likely already-consumed) original POST body on what should be a GET.
  const effectiveMethod = method || req.method;
  return binding.fetch(
    new Request(url, {
      method: effectiveMethod,
      headers: req.headers,
      body: body !== undefined ? body : (effectiveMethod !== "GET" && effectiveMethod !== "HEAD" ? req.body : undefined),
    }),
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + CHUNK) as unknown as number[],
    );
  }
  return btoa(bin);
}

/**
 * Walk a ContentBlock[] and replace any {source:{type:"file", file_id}}
 * with {source:{type:"base64", media_type, data}} by fetching bytes from R2.
 * Also returns the list of file_ids that were resolved so the sandbox can
 * mount them at /mnt/session/uploads/{file_id} (Anthropic-style dual path).
 *
 * Mirrors the Anthropic Files-API ↔ Messages-API binding: a file_id from
 * POST /v1/files becomes inline base64 the model can read, with no client
 * re-encoding.
 */
async function resolveFileIds(
  env: Env,
  services: Services,
  tenantId: string,
  content: ContentBlock[],
): Promise<{ content: ContentBlock[]; mountFileIds: string[] }> {
  const bucket = services.filesBlob;
  if (!bucket) return { content, mountFileIds: [] };
  const out: ContentBlock[] = [];
  const mountFileIds: string[] = [];
  for (const block of content) {
    if (
      (block.type === "document" || block.type === "image") &&
      block.source?.type === "file" &&
      block.source.file_id
    ) {
      const fileId = block.source.file_id;
      const meta = await services.files.get({ tenantId, fileId });
      const obj = meta ? await bucket.get(meta.r2_key) : null;
      if (!meta || !obj) {
        throw new Error(`file_id ${fileId} not found`);
      }
      const buf = await obj.arrayBuffer();
      const data = bytesToBase64(new Uint8Array(buf));
      out.push({
        ...block,
        source: {
          type: "base64",
          media_type: block.source.media_type || meta.media_type,
          data,
        },
      } as ContentBlock);
      mountFileIds.push(fileId);
      continue;
    }
    out.push(block);
  }
  return { content: out, mountFileIds };
}

// POST /v1/sessions — create session
app.post("/", async (c) => {
  const t = c.get("tenant_id");
  // Per-tenant cap on session creation — sandbox containers cost real $$
  // per spawn so this is stricter than the generic /v1/* writer limit.
  const rl = await rateLimitSessionCreate(c.env, t);
  if (rl) return rl;
  // Per-tenant DAILY cap (KV-backed). Optional via SESSION_DAILY_CAP_PER_TENANT
  // env — feature off when unset / 0. Catches sustained misuse the per-minute
  // gate above can't (5/min × 60 × 24 = 7200/day worth of containers).
  const daily = await checkDailySessionCap(c.env, c.var.services.kv, t);
  if (daily) return daily;
  const body = await c.req.json<{
    /** Bare id (legacy) OR AMA-shape `{id, version?}` ref. */
    agent: string | { id: string; version?: number };
    environment_id?: string;
    /** AMA-shape wrapper for environment ref — alias for environment_id. */
    environment?: string | { id: string };
    title?: string;
    vault_ids?: string[];
    resources?: Array<{
      // `env` is the canonical name; `env_secret` accepted as legacy alias.
      type: "file" | "memory_store" | "github_repository" | "github_repo" | "env" | "env_secret";
      file_id?: string;
      memory_store_id?: string;
      mount_path?: string;
      access?: "read_write" | "read_only";
      /** Per-attachment guidance for the agent (Anthropic-aligned name). 4096 char cap. */
      instructions?: string;
      url?: string;
      repo_url?: string;
      authorization_token?: string;
      checkout?: { type?: string; name?: string; sha?: string };
      name?: string;
      value?: string;
    }>;
  }>();

  // Normalize AMA-wrapped agent / environment refs to bare ids. AMA SDK
  // sends `agent: {type:"agent", id, version?}` and `environment: {id}`;
  // existing CLI / Console pass bare strings + `environment_id`. Accept all.
  const agentId = typeof body.agent === "string"
    ? body.agent
    : body.agent?.id;
  const wrappedEnvId = typeof body.environment === "string"
    ? body.environment
    : body.environment?.id;

  if (!agentId) {
    return c.json({ error: "agent is required" }, 400);
  }

  // The 8-memory-store sub-cap is enforced inside sessions-store on
  // create — but mirror the early 422 here so over-large payloads fail
  // before snapshot fetches and credential refreshes.
  const memoryStoreCount = (body.resources ?? []).filter((r) => r.type === "memory_store").length;
  if (memoryStoreCount > 8) {
    return c.json({ error: "Maximum 8 memory_store resources per session" }, 422);
  }

  // Reject duplicate memory_store_id within a single session — they would
  // collide on the same /mnt/memory/<store_name>/ mount path. Anthropic
  // also disallows duplicates per session.
  const seenMemoryStoreIds = new Set<string>();
  for (const r of body.resources ?? []) {
    if (r.type === "memory_store" && r.memory_store_id) {
      if (seenMemoryStoreIds.has(r.memory_store_id)) {
        return c.json(
          { error: `Duplicate memory_store resource: ${r.memory_store_id}` },
          422,
        );
      }
      seenMemoryStoreIds.add(r.memory_store_id);
    }
  }

  // Verify agent exists
  const agentRow = await c.var.services.agents.get({ tenantId: t, agentId });
  if (!agentRow) return c.json({ error: "Agent not found" }, 404);

  // Local-runtime agents (acp-proxy harness) don't use the sandbox container
  // — their loop is forwarded to the user's daemon via the RuntimeRoom DO.
  // We still need an environment_id because Anthropic's Managed Agents API
  // requires it on every session (BetaManagedAgentsSession.environment_id
  // is `string`, not nullable). Use the LOCAL_RUNTIME_ENV_ID sentinel so
  // (a) we don't depend on the tenant having ≥1 environment, and (b) the
  // value is self-explanatory in DB / dashboards. getSandboxBinding
  // recognizes the sentinel and short-circuits to sessionDoFallbackFetcher
  // without attempting an environments-store lookup.
  // Cloud agents must supply an explicit environment_id because the
  // picked sandbox lane materially affects the run.
  const agentIsLocalRuntime = !!agentRow.runtime_binding;

  // Optional usage-meter gate. When the USAGE_METER service binding is
  // present, ask it whether this tenant may launch a cloud sandbox
  // (typical implementations: wallet balance check, rate-limit, abuse
  // gate). Self-host / OSS dev deployments leave the binding unbound
  // and skip this — the platform behaves identically.
  if (!agentIsLocalRuntime && c.env.USAGE_METER) {
    try {
      const gate = await c.env.USAGE_METER.canStartSandbox({
        tenantId: t,
        agentId: body.agent,
      });
      if (!gate.ok) {
        return c.json(
          {
            error: gate.reason ?? "Sandbox launch refused by usage meter",
            balance_cents: gate.balance_cents ?? 0,
          },
          402,
        );
      }
    } catch (err) {
      // Fail open: a meter outage shouldn't block all new sessions.
      // The follow-up usage_events write still records the session so
      // the meter can reconcile out-of-band on next sweep.
      console.error(
        `[sessions] USAGE_METER.canStartSandbox failed: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  let resolvedEnvId = body.environment_id ?? wrappedEnvId;
  if (!resolvedEnvId) {
    if (!agentIsLocalRuntime) {
      return c.json({ error: "environment_id is required for cloud agents" }, 400);
    }
    resolvedEnvId = LOCAL_RUNTIME_ENV_ID;
  }

  // Resolve sandbox worker binding. Local-runtime sessions still go
  // through the sandbox lane for SessionDO routing, but the harness skips
  // the container — so a missing/unhealthy sandbox is technically tolerable
  // for them. We keep the same lookup path for now to avoid two routing
  // codepaths; if this becomes a real reliability problem (e.g. the user's
  // first env is in `error` status), revisit and short-circuit to the
  // SESSION_DO direct fetcher (sessionDoFallbackFetcher below).
  const sbRes = await getSandboxBinding(c.env, resolvedEnvId, t);
  let binding = sbRes.binding;
  if (!binding) {
    if (agentIsLocalRuntime) {
      binding = sessionDoFallbackFetcher(c.env);
      if (!binding) return bindingErrorResponse(c, sbRes);
    } else {
      return bindingErrorResponse(c, sbRes);
    }
  }

  // Pre-fetch snapshots so SessionDO doesn't have to read CONFIG_KV with a
  // tenant-prefixed key (which fails when sandbox-default's KV binding
  // differs from main's — e.g. shared sandbox + staging main).
  const { tenant_id: _atid, ...agentSnapshot } = agentRow;
  const envRow = await c.var.services.environments.get({
    tenantId: t,
    environmentId: resolvedEnvId,
  });
  const environmentSnapshot = envRow ? toEnvironmentConfig(envRow) : undefined;
  const vaultIds = body.vault_ids || [];

  // Pre-scan github_repository resources for binding fast-path. When a
  // resource omits authorization_token AND the user has a live github
  // binding for that org, mint a fresh installation token + attach the
  // binding's vault. Done BEFORE SessionDO init so the augmented vault_ids
  // make it into the snapshot the DO uses.
  const fastPathTokens = new Map<string, string>(); // repoUrl → token
  if (body.resources?.length) {
    for (const res of body.resources) {
      if (
        (res.type === "github_repository" || res.type === "github_repo") &&
        (res.url || res.repo_url) &&
        !res.authorization_token
      ) {
        const repoUrl = res.url || res.repo_url!;
        const fast = await tryGitHubBindingFastPath(c.env, t, repoUrl);
        if (fast) {
          fastPathTokens.set(repoUrl, fast.token);
          if (!vaultIds.includes(fast.vaultId)) vaultIds.push(fast.vaultId);
        }
      }
    }
  }

  // Refresh provider-tagged credentials (e.g. GitHub installation tokens,
  // ~1hr TTL) before handing the vault to a fresh session. Per OPE-12: failures
  // are no longer silent — they become session.warning events the console
  // renders, so users see "credential refresh failed" instead of mysterious
  // 401s mid-task. Refresh failure is non-fatal: the existing token may still
  // be valid, and the outbound proxy's on-401 retry path covers a true miss.
  const refreshResult = await refreshProviderCredentialsForSession(
    c.env,
    c.var.services,
    t,
    agentId,
    vaultIds,
  );

  const vaultCredentials = await fetchVaultCredentials(c.var.services, t, vaultIds);

  // Build the non-file initial resources (memory_store, github_repository,
  // env). File resources need the session id BEFORE we can create the
  // scoped file row, so they're handled after the session row exists.
  const nonFileInputs: NewResourceInput[] = [];
  for (const res of body.resources ?? []) {
    if (res.type === "memory_store" && res.memory_store_id) {
      nonFileInputs.push({
        type: "memory_store",
        memory_store_id: res.memory_store_id,
        mount_path: res.mount_path,
        access: res.access === "read_only" ? "read_only" : "read_write",
        instructions: typeof res.instructions === "string" ? res.instructions.slice(0, 4096) : undefined,
      });
    } else if ((res.type === "github_repository" || res.type === "github_repo") && (res.url || res.repo_url)) {
      const repoUrl = res.url || res.repo_url!;
      nonFileInputs.push({
        type: "github_repository",
        url: repoUrl,
        repo_url: repoUrl,
        mount_path: res.mount_path || "/workspace",
        checkout: res.checkout,
      });
    } else if ((res.type === "env" || res.type === "env_secret") && res.name && res.value) {
      // Normalize on write: legacy `env_secret` always lands as `env` in
      // the store. Read-side code only has to handle the new name.
      nonFileInputs.push({
        type: "env",
        name: res.name,
      });
    }
  }

  // Atomic create — session row + non-file resources in one D1 batch.
  // sessions-store throws SessionResourceMaxExceededError /
  // SessionMemoryStoreMaxExceededError if either cap is hit; route maps to
  // 400/422 via mapSessionError.
  let session;
  let createdResources;
  try {
    const result = await c.var.services.sessions.create({
      tenantId: t,
      agentId,
      environmentId: resolvedEnvId,
      title: body.title || "",
      vaultIds,
      agentSnapshot,
      environmentSnapshot,
      resources: nonFileInputs,
    });
    session = result.session;
    createdResources = result.resources;
  } catch (err) {
    return mapSessionError(c, err);
  }
  const sessionId = session.id;

  // Build refresh warnings with the freshly-allocated sessionId.
  const refreshWarnings = refreshResultToInitEvents(refreshResult, {
    sessionId,
    tenantId: t,
  });
  // AE write for refresh failures lives here (env in scope; the projection
  // helper is env-agnostic by design). One row per failure for granular alerts.
  for (const f of refreshResult.failures) {
    recordEvent(c.env.ANALYTICS, {
      op: "session.start.credential_refresh.failed",
      session_id: sessionId,
      tenant_id: t,
      error_name: String(f.httpStatus ?? "exception"),
      error_message: `${f.provider}:${f.vaultId} ${f.error}`,
    });
  }

  // Initialize SessionDO via sandbox worker. Resources land before the DO's
  // first warmup reads `listResourcesBySession` — so any resource we add
  // below (files) must be in place before the SessionDO actually mounts
  // them; the DO does that lazily so this ordering is fine.
  await forwardToSandbox(
    binding,
    `/sessions/${sessionId}/init`,
    c.req.raw,
    "PUT",
    JSON.stringify({
      agent_id: agentId,
      environment_id: resolvedEnvId,
      title: body.title || "",
      session_id: sessionId,
      tenant_id: t,
      vault_ids: vaultIds,
      agent_snapshot: agentSnapshot,
      environment_snapshot: environmentSnapshot,
      vault_credentials: vaultCredentials,
      init_events: refreshWarnings,
    }),
  );

  // Persist secret KV entries for the env + github_repository inputs we
  // created above. These continue to live in CONFIG_KV — sessions-store
  // intentionally records resource METADATA only.
  for (let i = 0; i < (body.resources?.length ?? 0); i++) {
    const res = body.resources![i];
    if ((res.type === "env" || res.type === "env_secret") && res.name && res.value) {
      // Find the matching createdResource by metadata equality (env has no
      // meaningful natural key beyond name; the order is preserved because
      // we built nonFileInputs in source order and sessions-store returns
      // the same order). Read-side already normalized to type=env above.
      const created = createdResources.find(
        (r) => r.type === "env" && r.resource.type === "env" && r.resource.name === res.name,
      );
      if (created) {
        await c.var.services.sessionSecrets.put({
          tenantId: t,
          sessionId,
          resourceId: created.id,
          value: res.value,
        });
      }
    } else if ((res.type === "github_repository" || res.type === "github_repo") && (res.url || res.repo_url)) {
      const repoUrl = res.url || res.repo_url!;
      const token = res.authorization_token ?? fastPathTokens.get(repoUrl) ?? null;
      if (token) {
        const created = createdResources.find(
          (r) => r.type === "github_repository" && r.resource.type === "github_repository" && r.resource.url === repoUrl,
        );
        if (created) {
          await c.var.services.sessionSecrets.put({
            tenantId: t,
            sessionId,
            resourceId: created.id,
            value: token,
          });
        }
      }
    }
  }

  // File resources require sessionId to scope the new R2 + file_metadata
  // row — handle these after the session exists. addResource runs the
  // per-session cap check each time; we already pre-validated 8-memory-store
  // so the only failure mode here is hitting the 100-resource ceiling
  // (extremely unlikely at create time).
  for (const res of body.resources ?? []) {
    if (res.type === "file" && res.file_id) {
      const sourceFile = await c.var.services.files.get({
        tenantId: t,
        fileId: res.file_id,
      });
      if (!sourceFile) continue;

      const scopedFileId = generateFileId();
      const scopedR2Key = fileR2Key(t, scopedFileId);

      // R2 copy first — best-effort (legacy files may have no R2 bytes).
      const filesBucket = c.var.services.filesBlob;
      if (filesBucket) {
        const obj = await filesBucket.get(sourceFile.r2_key);
        if (obj) {
          await filesBucket.put(
            scopedR2Key,
            obj.body,
            { httpMetadata: { contentType: sourceFile.media_type } },
          );
        }
      }

      await c.var.services.files.create({
        id: scopedFileId,
        tenantId: t,
        sessionId,
        filename: sourceFile.filename,
        mediaType: sourceFile.media_type,
        sizeBytes: sourceFile.size_bytes,
        r2Key: scopedR2Key,
        downloadable: sourceFile.downloadable,
      });

      try {
        const added = await c.var.services.sessions.addResource({
          tenantId: t,
          sessionId,
          resource: {
            type: "file",
            file_id: scopedFileId,
            mount_path: res.mount_path,
          },
        });
        createdResources.push(added);
      } catch (err) {
        return mapSessionError(c, err);
      }
    }
  }

  // AMA-shape response — toApiSession defaults `resources: []`; overlay
  // any resources we just created so the create response shows them.
  const response: Record<string, unknown> = { ...toApiSession(session) };
  if (createdResources.length > 0) {
    response.resources = createdResources.map((r) => r.resource);
  }

  return c.json(response, 201);
});

// GET /v1/sessions — list sessions (cursor-paginated, optional agent_id filter)
app.get("/", async (c) => {
  const agentIdFilter = c.req.query("agent_id") || undefined;
  const page = await c.var.services.sessions.listPage({
    tenantId: c.get("tenant_id"),
    agentId: agentIdFilter,
    ...parsePageQuery(c),
  });
  return jsonPage(c, page, (row) => toApiSession(row));
});

// GET /v1/sessions/:id — get session (status from sandbox worker)
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const session = await c.var.services.sessions.get({
    tenantId: c.get("tenant_id"),
    sessionId: id,
  });
  if (!session) return c.json({ error: "Session not found" }, 404);

  // Get live status, usage, and outcome evaluations from sandbox worker
  const { binding } = await getSandboxBinding(c.env, session.environment_id, c.get("tenant_id"));
  const response: Record<string, unknown> = { ...toApiSession(session) };

  if (binding) {
    try {
      const fullStatusRes = await forwardToSandbox(binding, `/sessions/${id}/full-status`, c.req.raw, "GET");
      const fullStatus = (await fullStatusRes.json()) as {
        status: string;
        usage: { input_tokens: number; output_tokens: number };
        // Phase 4 / AMA-aligned: every terminal `span.outcome_evaluation_end`
        // for this session, in iteration order. AMA returns this verbatim
        // under `outcome_evaluations[]` from GET /v1/sessions/:id.
        outcome_evaluations: Array<{
          outcome_id?: string;
          result: string;
          iteration: number;
          explanation?: string;
          /** @deprecated alias of `explanation`. */
          feedback?: string;
          usage?: {
            input_tokens: number;
            output_tokens: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
          };
          processed_at?: string;
        }>;
      };
      response.status = fullStatus.status;
      response.usage = fullStatus.usage;
      if (fullStatus.outcome_evaluations) {
        response.outcome_evaluations = fullStatus.outcome_evaluations;
      }
    } catch (err) {
      // Sandbox worker unreachable — keep stored status. This is the read
      // path; failing soft is correct, but we still need visibility.
      logWarn(
        { op: "session.get.full_status_fetch", session_id: id, tenant_id: c.get("tenant_id"), err },
        "sandbox unreachable; falling back to stored status",
      );
    }
  }

  return c.json(response);
});

// POST /v1/sessions/:id/archive
app.post("/:id/archive", async (c) => {
  try {
    const session = await c.var.services.sessions.archive({
      tenantId: c.get("tenant_id"),
      sessionId: c.req.param("id"),
    });
    return c.json(toApiSession(session));
  } catch (err) {
    return mapSessionError(c, err);
  }
});

// POST /v1/sessions/:id — update session
app.post("/:id", async (c) => {
  const body = await c.req.json<{
    title?: string;
    metadata?: Record<string, unknown>;
  }>();
  try {
    const updated = await c.var.services.sessions.update({
      tenantId: c.get("tenant_id"),
      sessionId: c.req.param("id"),
      title: body.title,
      metadata: body.metadata,
    });
    return c.json(toApiSession(updated));
  } catch (err) {
    return mapSessionError(c, err);
  }
});

// DELETE /v1/sessions/:id
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const t = c.get("tenant_id");
  const session = await c.var.services.sessions.get({ tenantId: t, sessionId: id });
  if (!session) return c.json({ error: "Session not found" }, 404);

  // Check if session is running — cannot delete while active
  const { binding } = await getSandboxBinding(c.env, session.environment_id, t);
  if (binding) {
    try {
      const statusRes = await forwardToSandbox(binding, `/sessions/${id}/status`, c.req.raw, "GET");
      const statusBody = await statusRes.json() as { status: string };
      if (statusBody.status === "running") {
        return c.json({ error: "Cannot delete a running session. Send an interrupt event first." }, 409);
      }
    } catch (err) {
      // Sandbox unreachable on the running-check — proceed with delete and let
      // the destroy call below handle it. Logged because if this happens
      // consistently the running-gate is effectively bypassed.
      logWarn(
        { op: "session.delete.running_check", session_id: id, tenant_id: t, err },
        "running-status check failed; bypassing gate",
      );
    }
    await forwardToSandbox(binding, `/sessions/${id}/destroy`, c.req.raw, "DELETE").catch((err) => {
      logWarn(
        { op: "session.delete.sandbox_destroy", session_id: id, tenant_id: t, err },
        "sandbox destroy failed; row will still be removed",
      );
    });
  }

  // Local-runtime (acp-proxy) sessions: also tell the daemon to kill its
  // ACP child + drop the spawn cwd. Best-effort — if the runtime is offline
  // or the binding missing, the daemon will reconcile next time it sees a
  // 403 on session lookup. RuntimeRoom DO is addressed by runtime_id from
  // the session's agent_snapshot.runtime_binding.
  const agentSnap = (session as { agent_snapshot?: { runtime_binding?: { runtime_id?: string } } }).agent_snapshot;
  const rid = agentSnap?.runtime_binding?.runtime_id;
  if (rid && c.env.RUNTIME_ROOM) {
    try {
      const stub = c.env.RUNTIME_ROOM.get(c.env.RUNTIME_ROOM.idFromName(rid));
      await (stub as unknown as {
        sendToDaemon(msg: Record<string, unknown>): Promise<boolean>;
      }).sendToDaemon({ type: "session.dispose", session_id: id });
    } catch (err) {
      logWarn(
        { op: "session.delete.daemon_dispose", session_id: id, runtime_id: rid, err },
        "daemon dispose forward failed; row will still be removed",
      );
    }
  }

  // Cascade-delete the session row + every session_resources row in one
  // batch. Caller is still responsible for the per-session secret KV
  // entries (env.value, github_repository.token) and for files
  // uploaded under this session — both are cleaned up below.
  try {
    await c.var.services.sessions.delete({ tenantId: t, sessionId: id });
  } catch (err) {
    return mapSessionError(c, err);
  }

  // Cascade-delete file metadata (files-store) and remove the corresponding
  // R2 blobs. Best-effort: a partial failure leaks at most a few bytes of
  // R2 storage, not user-visible.
  try {
    const orphanedFiles = await c.var.services.files.deleteBySession({
      sessionId: id,
    });
    if (c.var.services.filesBlob && orphanedFiles.length) {
      const cleanupBucket = c.var.services.filesBlob;
      await Promise.all(
        orphanedFiles.map((f) =>
          cleanupBucket.delete(f.r2_key).catch((err) => {
            logWarn(
              { op: "session.delete.r2_cleanup", session_id: id, tenant_id: t, r2_key: f.r2_key, err },
              "orphan R2 file delete failed",
            );
            return undefined;
          }),
        ),
      );
    }
  } catch (err) {
    // best-effort; metadata cleanup never blocks the session delete itself
    logWarn(
      { op: "session.delete.metadata_cleanup", session_id: id, tenant_id: t, err },
      "metadata cleanup failed; session row already removed",
    );
  }

  // Best-effort secret cleanup — cascade all per-resource secrets for this
  // session. The route doesn't track resourceIds at delete time, so the
  // store walks its keyspace internally.
  await c.var.services.sessionSecrets.deleteAllForSession({
    tenantId: t,
    sessionId: id,
  });

  // Cascade-delete the /mnt/session/outputs/ R2 prefix. These objects have
  // no D1 file row (listed via R2 prefix scan, not promoted to file_id),
  // so the files-store deleteBySession above doesn't catch them. Without
  // this, every artefact the agent wrote to /mnt/session/outputs/ leaks
  // forever — and worse, becomes unreachable too because the outputs
  // route 404s once the session row is gone.
  if (c.env.FILES_BUCKET) {
    const prefix = SESSION_OUTPUTS_PREFIX(t, id);
    let cursor: string | undefined;
    let deleted = 0;
    try {
      do {
        const list: R2Objects = await c.env.FILES_BUCKET.list({ prefix, cursor, limit: 1000 });
        if (list.objects.length) {
          await Promise.all(
            list.objects.map((o: R2Object) =>
              c.env.FILES_BUCKET!.delete(o.key).catch((err) => {
                logWarn(
                  { op: "session.delete.outputs_cleanup", session_id: id, tenant_id: t, r2_key: o.key, err },
                  "outputs R2 delete failed",
                );
              }),
            ),
          );
          deleted += list.objects.length;
        }
        cursor = list.truncated ? list.cursor : undefined;
      } while (cursor);
      if (deleted > 0) {
        logWarn(
          { op: "session.delete.outputs_cleanup", session_id: id, tenant_id: t, deleted },
          `cleared ${deleted} session-outputs object(s)`,
        );
      }
    } catch (err) {
      logWarn(
        { op: "session.delete.outputs_cleanup_list", session_id: id, tenant_id: t, err },
        "outputs prefix list failed; some objects may leak",
      );
    }
  }

  return c.json({ type: "session_deleted", id });
});

// POST /v1/sessions/:id/events — send user events
app.post("/:id/events", async (c) => {
  const id = c.req.param("id");
  const t = c.get("tenant_id");
  const session = await c.var.services.sessions.get({ tenantId: t, sessionId: id });
  if (!session) return c.json({ error: "Session not found" }, 404);

  // Archived sessions are read-only
  if (session.archived_at) {
    return c.json({ error: "Session is archived and cannot receive new events" }, 409);
  }

  const sbRes = await getSandboxBinding(c.env, session.environment_id, t);
  const binding = sbRes.binding;
  if (!binding) return bindingErrorResponse(c, sbRes);

  const body = await c.req.json<{ events: UserMessageEvent[] }>();
  if (!body.events || !Array.isArray(body.events) || body.events.length === 0) {
    return c.json({ error: "events array is required" }, 400);
  }

  const ALLOWED_EVENT_TYPES = [
    "user.message",
    "user.interrupt",
    "user.tool_confirmation",
    "user.custom_tool_result",
    "user.define_outcome",
  ];

  for (const event of body.events) {
    if (!ALLOWED_EVENT_TYPES.includes(event.type)) {
      return c.json({ error: `Unsupported event type: ${event.type}` }, 400);
    }
    let outgoing: unknown = event;
    if (event.type === "user.message" || event.type === "user.custom_tool_result") {
      const e = event as { content?: ContentBlock[] };
      if (Array.isArray(e.content)) {
        try {
          const { content: resolved, mountFileIds } = await resolveFileIds(c.env, c.var.services, t, e.content);
          outgoing = {
            ...event,
            content: resolved,
            // Sidecar field consumed by SessionDO POST /event handler:
            // sandbox writes each file to /mnt/session/uploads/{file_id} so
            // the agent's bash/read tools can also see them. Stripped before
            // the event is persisted.
            ...(mountFileIds.length > 0 ? { _mount_file_ids: mountFileIds } : {}),
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return c.json({ error: `file_id resolution failed: ${msg}` }, 400);
        }
      }
    }
    const sandboxRes = await forwardToSandbox(
      binding,
      `/sessions/${id}/event`,
      c.req.raw,
      "POST",
      JSON.stringify(outgoing),
    );
    // SessionDO returns 409 when the session is terminated_at != null
    // (added in session-do.ts to align with AMA RetryStatusTerminal).
    // Without this passthrough the client would see 202 unconditionally
    // and never learn the event was rejected. Forward any non-2xx as-is
    // so the canonical error envelope SessionDO emitted reaches the
    // caller verbatim — including its `request_id` and typed `error.type`.
    if (sandboxRes.status >= 400) {
      const body = await sandboxRes.text();
      return new Response(body, {
        status: sandboxRes.status,
        headers: {
          "content-type":
            sandboxRes.headers.get("content-type") ?? "application/json",
        },
      });
    }
  }

  return c.body(null, 202);
});

// POST /v1/sessions/:id/files — container_upload: promote a sandbox file to
// a first-class file_id. Mirrors Anthropic's pattern where code-execution
// outputs become re-referenceable file_ids. The created file is scope_id-tagged
// to the session and `downloadable: true` by default.
app.post("/:id/files", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const session = await c.var.services.sessions.get({ tenantId: t, sessionId: id });
  if (!session) return c.json({ error: "Session not found" }, 404);

  const bucket = c.var.services.filesBlob;
  if (!bucket) return c.json({ error: "FILES_BUCKET binding not configured" }, 500);

  const sbRes = await getSandboxBinding(c.env, session.environment_id, t);
  const binding = sbRes.binding;
  if (!binding) return bindingErrorResponse(c, sbRes);

  const body = await c.req.json<{
    path: string;
    filename?: string;
    media_type?: string;
    downloadable?: boolean;
  }>();
  if (!body.path || typeof body.path !== "string") {
    return c.json({ error: "path is required" }, 400);
  }

  const fileRes = await forwardToSandbox(
    binding,
    `/sessions/${id}/file?path=${encodeURIComponent(body.path)}`,
    c.req.raw,
    "GET",
  );
  if (!fileRes.ok) {
    const msg = await fileRes.text().catch((err) => {
      logWarn(
        { op: "session.file.body_read", session_id: id, tenant_id: t, http_status: fileRes.status, err },
        "sandbox file response body unreadable",
      );
      return "sandbox read failed";
    });
    return c.json({ error: `Cannot read sandbox path: ${msg}` }, 400);
  }
  const buf = await fileRes.arrayBuffer();

  const filename = body.filename || body.path.split("/").pop() || "file";
  const ext = filename.toLowerCase().split(".").pop() || "";
  const guessed: Record<string, string> = {
    pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", txt: "text/plain", md: "text/markdown",
    csv: "text/csv", json: "application/json",
  };
  const mediaType = body.media_type || guessed[ext] || "application/octet-stream";
  const downloadable = body.downloadable === undefined ? true : body.downloadable === true;

  const newFileId = generateFileId();
  const r2Key = fileR2Key(t, newFileId);
  await bucket.put(r2Key, buf, { httpMetadata: { contentType: mediaType } });

  const row = await c.var.services.files.create({
    id: newFileId,
    tenantId: t,
    sessionId: id,
    filename,
    mediaType,
    sizeBytes: buf.byteLength,
    r2Key,
    downloadable,
  });

  return c.json(toFileRecord(row), 201);
});

// SSE stream
async function handleSSEStream(c: Context<{ Bindings: Env; Variables: { tenant_id: string; services: Services } }>, id: string) {
  const t = c.get("tenant_id");
  const session = await c.var.services.sessions.get({ tenantId: t, sessionId: id });
  if (!session) return c.json({ error: "Session not found" }, 404);

  const sbRes = await getSandboxBinding(c.env, session.environment_id, t);
  const binding = sbRes.binding;
  if (!binding) return bindingErrorResponse(c, sbRes);

  const wsHeaders = new Headers(c.req.raw.headers);
  wsHeaders.set("Upgrade", "websocket");
  wsHeaders.set("Connection", "Upgrade");

  const wsReq = new Request(`https://sandbox/sessions/${id}/ws`, {
    method: "GET",
    headers: wsHeaders,
  });

  const wsRes = await binding.fetch(wsReq);

  const ws = (wsRes as any).webSocket;
  if (!ws) {
    return c.json({ error: "Failed to establish WebSocket to session" }, 500);
  }
  ws.accept();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      ws.addEventListener("message", (event: MessageEvent) => {
        controller.enqueue(encoder.encode(`data: ${event.data}\n\n`));
      });
      ws.addEventListener("close", () => {
        controller.close();
      });
      ws.addEventListener("error", () => {
        controller.close();
      });
    },
    cancel() {
      ws.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// JSON events
async function handleJSONEvents(c: Context<{ Bindings: Env; Variables: { tenant_id: string; services: Services } }>, id: string) {
  const t = c.get("tenant_id");
  const session = await c.var.services.sessions.get({ tenantId: t, sessionId: id });
  if (!session) return c.json({ error: "Session not found" }, 404);

  const sbRes = await getSandboxBinding(c.env, session.environment_id, t);
  const binding = sbRes.binding;
  if (!binding) return bindingErrorResponse(c, sbRes);

  const url = new URL(c.req.url);
  const res = await forwardToSandbox(binding, `/sessions/${id}/events${url.search}`, c.req.raw, "GET");
  if (!res.ok) {
    // Sandbox/agent worker can return non-JSON 500s (e.g. SqliteHistory throws,
    // R2 spill resolve fails, DO storage timeout). Pass through the raw body so
    // the caller sees the real cause instead of "Unexpected token … is not
    // valid JSON" from a JSON-greedy res.json().
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "text/plain" },
    });
  }
  const result = await res.json();
  return c.json(result);
}

app.get("/:id/events", async (c) => {
  const accept = c.req.header("Accept") || "";
  if (accept.includes("text/event-stream")) {
    return handleSSEStream(c, c.req.param("id"));
  }
  return handleJSONEvents(c, c.req.param("id"));
});

// POST /v1/sessions/:id/__debug_recovery__ — ops-only forwarder for the
// SessionDO recovery probe. Body forwards as-is. Both layers re-check
// X-Debug-Token against env.DEBUG_TOKEN — the main-worker check fails
// fast on stack traces / errors before any DO state is touched.
app.post("/:id/__debug_recovery__", async (c) => {
  const expected = (c.env as { DEBUG_TOKEN?: string }).DEBUG_TOKEN;
  const provided = c.req.header("x-debug-token");
  if (!expected || !provided || expected !== provided) {
    return c.json({ error: "Forbidden" }, 403);
  }
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const session = await c.var.services.sessions.get({ tenantId: t, sessionId: id });
  if (!session) return c.json({ error: "Session not found" }, 404);
  const sbRes = await getSandboxBinding(c.env, session.environment_id, t);
  const binding = sbRes.binding;
  if (!binding) return bindingErrorResponse(c, sbRes);
  const fwd = new Request(`https://sandbox/sessions/${id}/__debug_recovery__`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-debug-token": provided },
    body: await c.req.text(),
  });
  const res = await binding.fetch(fwd);
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// POST /v1/sessions/:id/messages — combined "send user message + stream
// response" in one HTTP call. Chatbot-friendly. Body: { content: string |
// ContentBlock[] }. Response: text/event-stream of every event from this
// turn (filtered by seq > startSeq), closing on the first session.status_idle.
//
// Why this exists: the current /events + /events/stream split forces
// clients to fire two HTTP calls + correlate the cursor. SDK consumers
// (and Linear/Slack-style chatbots) want one shot: post a message, get
// a stream back, render until done. The streaming chunk events from the
// new harness pipeline (agent.message_stream_start / chunk / stream_end
// + agent.message) flow through the same WS bridge that handleSSEStream
// already uses — no extra plumbing.
app.post("/:id/messages", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const session = await c.var.services.sessions.get({ tenantId: t, sessionId: id });
  if (!session) return c.json({ error: "Session not found" }, 404);

  const sbRes = await getSandboxBinding(c.env, session.environment_id, t);
  const binding = sbRes.binding;
  if (!binding) return bindingErrorResponse(c, sbRes);

  const body = await c.req.json<{
    content: string | ContentBlock[];
  }>().catch(() => ({ content: "" as string | ContentBlock[] }));
  const content: ContentBlock[] = typeof body.content === "string"
    ? [{ type: "text", text: body.content }]
    : Array.isArray(body.content) ? body.content : [];
  if (content.length === 0) {
    return c.json({ error: "content is required (string or ContentBlock[])" }, 400);
  }

  // Forward the user.message into the SessionDO, which appends + drains
  // (kicking the harness). We mint the event id ourselves so the SSE
  // bridge below can identify "our" turn boundary even when the WS
  // replay surfaces every prior event in this session.
  const userMessageId = generateEventId();
  const userMessageReq = new Request(`https://sandbox/sessions/${id}/event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "user.message", id: userMessageId, content }),
  });
  const postRes = await binding.fetch(userMessageReq);
  if (!postRes.ok) {
    return c.json({ error: `Failed to enqueue user message: ${postRes.status}` }, 500);
  }

  // Open the WS bridge same as handleSSEStream. The bridge sends the
  // full event history on connect, then live broadcasts. We need to
  // suppress the historical noise and close exactly once on this
  // turn's idle. State machine:
  //   - PRE_TURN: drop every event until we observe a `user.message`
  //     whose id matches `userMessageId`.
  //   - IN_TURN: forward every event; close on the first
  //     `session.status_idle`.
  // Multiple back-to-back POSTs each carry their own id, so each call
  // gets exactly its own turn back even if calls overlap on the wire.
  const wsHeaders = new Headers(c.req.raw.headers);
  wsHeaders.set("Upgrade", "websocket");
  wsHeaders.set("Connection", "Upgrade");
  const wsReq = new Request(`https://sandbox/sessions/${id}/ws`, {
    method: "GET",
    headers: wsHeaders,
  });
  const wsRes = await binding.fetch(wsReq);
  const ws = (wsRes as { webSocket?: WebSocket }).webSocket;
  if (!ws) {
    return c.json({ error: "Failed to establish WebSocket to session" }, 500);
  }
  ws.accept();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let inTurn = false;
      let closed = false;
      const closeOnce = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch {}
        try { ws.close(); } catch {}
      };
      ws.addEventListener("message", (event: MessageEvent) => {
        if (closed) return;
        const raw = event.data as string;
        let parsed: { type?: string; id?: string } | null = null;
        try { parsed = JSON.parse(raw); } catch { /* malformed — ignore for state, still skip */ }
        if (!inTurn) {
          if (parsed?.type === "user.message" && parsed.id === userMessageId) {
            inTurn = true;
            controller.enqueue(encoder.encode(`data: ${raw}\n\n`));
          }
          return;
        }
        controller.enqueue(encoder.encode(`data: ${raw}\n\n`));
        if (parsed?.type === "session.status_idle") {
          closeOnce();
        }
      });
      ws.addEventListener("close", closeOnce);
      ws.addEventListener("error", closeOnce);
    },
    cancel() {
      try { ws.close(); } catch {}
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

// GET /v1/sessions/:id/trajectory — full Trajectory v1 envelope
app.get("/:id/trajectory", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const sessionRow = await c.var.services.sessions.get({ tenantId: t, sessionId: id });
  if (!sessionRow) return c.json({ error: "Session not found" }, 404);

  // Build a SessionRecord-shaped object for buildTrajectory: it expects the
  // same shape the legacy KV record had (id + agent_id + environment_id +
  // agent_snapshot + environment_snapshot + title + status + timestamps).
  const session = {
    id: sessionRow.id,
    agent_id: sessionRow.agent_id,
    environment_id: sessionRow.environment_id,
    title: sessionRow.title,
    status: sessionRow.status,
    created_at: sessionRow.created_at,
    updated_at: sessionRow.updated_at ?? undefined,
    archived_at: sessionRow.archived_at ?? undefined,
    vault_ids: sessionRow.vault_ids ?? undefined,
    metadata: sessionRow.metadata ?? undefined,
    agent_snapshot: sessionRow.agent_snapshot ?? undefined,
    environment_snapshot: sessionRow.environment_snapshot ?? undefined,
  } as SessionRecord;

  const sbRes = await getSandboxBinding(c.env, session.environment_id, t);
  const binding = sbRes.binding;
  if (!binding) return bindingErrorResponse(c, sbRes);

  // Paginate through all events from sandbox /events (max 1000 per page)
  async function fetchAllEvents(): Promise<StoredEvent[]> {
    const all: StoredEvent[] = [];
    let afterSeq = 0;
    while (true) {
      const res = await forwardToSandbox(
        binding!,
        `/sessions/${id}/events?limit=1000&order=asc&after_seq=${afterSeq}`,
        c.req.raw,
        "GET",
      );
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(
          `events fetch failed: ${res.status} ${errBody.slice(0, 200)} (after_seq=${afterSeq})`,
        );
      }
      const body = (await res.json()) as { data?: StoredEvent[]; has_more?: boolean };
      const batch = body.data || [];
      all.push(...batch);
      if (!body.has_more || batch.length === 0) break;
      const last = batch[batch.length - 1];
      afterSeq = last.seq;
    }
    return all;
  }

  async function fetchFullStatus(): Promise<FullStatus | null> {
    const res = await forwardToSandbox(binding!, `/sessions/${id}/full-status`, c.req.raw, "GET");
    if (!res.ok) return null;
    return (await res.json()) as FullStatus;
  }

  async function fetchEnvironmentConfig(): Promise<EnvironmentConfig | null> {
    const row = await c.var.services.environments.get({
      tenantId: t,
      environmentId: session.environment_id,
    });
    return row ? toEnvironmentConfig(row) : null;
  }

  try {
    const trajectory = await buildTrajectory(session, {
      fetchAllEvents,
      fetchFullStatus,
      fetchEnvironmentConfig,
    });
    return c.json(trajectory);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

// Anthropic-compatible SSE stream path
app.get("/:id/stream", async (c) => handleSSEStream(c, c.req.param("id")));
// Legacy alias
app.get("/:id/events/stream", async (c) => handleSSEStream(c, c.req.param("id")));

// ============================================================
// Session Threads (multi-agent)
// ============================================================

// GET /v1/sessions/:id/threads — list threads
app.get("/:id/threads", async (c) => {
  const id = c.req.param("id");
  const session = await c.var.services.sessions.get({
    tenantId: c.get("tenant_id"),
    sessionId: id,
  });
  if (!session) return c.json({ error: "Session not found" }, 404);

  const sbRes = await getSandboxBinding(c.env, session.environment_id, c.get("tenant_id"));
  const binding = sbRes.binding;
  if (!binding) return bindingErrorResponse(c, sbRes);

  const res = await forwardToSandbox(binding, `/sessions/${id}/threads`, c.req.raw, "GET");
  return c.json(await res.json());
});

// POST /v1/sessions/:id/exec — run a raw shell command in this session's
// sandbox WITHOUT going through the agent. Designed for eval / verifier
// workflows where the harness needs to run pytest (or similar) on the
// post-agent state without trusting the model to invoke a tool. Body:
// { command: string, timeout_ms?: number (default 60000) }
// Returns: { exit_code: number, output: string, truncated: boolean }
app.post("/:id/exec", async (c) => {
  const id = c.req.param("id");
  const t = c.get("tenant_id");
  const session = await c.var.services.sessions.get({ tenantId: t, sessionId: id });
  if (!session) return c.json({ error: "Session not found" }, 404);

  const sbRes = await getSandboxBinding(c.env, session.environment_id, t);
  const binding = sbRes.binding;
  if (!binding) return bindingErrorResponse(c, sbRes);

  const res = await forwardToSandbox(binding, `/sessions/${id}/exec`, c.req.raw, "POST");
  // Pass status through (exec can legitimately return 500 on sandbox error)
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
});

// GET /v1/sessions/:id/threads/:thread_id/events — thread events
app.get("/:id/threads/:thread_id/events", async (c) => {
  const id = c.req.param("id");
  const threadId = c.req.param("thread_id");
  const session = await c.var.services.sessions.get({
    tenantId: c.get("tenant_id"),
    sessionId: id,
  });
  if (!session) return c.json({ error: "Session not found" }, 404);

  const sbRes = await getSandboxBinding(c.env, session.environment_id, c.get("tenant_id"));
  const binding = sbRes.binding;
  if (!binding) return bindingErrorResponse(c, sbRes);

  const res = await forwardToSandbox(binding, `/sessions/${id}/threads/${threadId}/events`, c.req.raw, "GET");
  return c.json(await res.json());
});

// GET /v1/sessions/:id/threads/:thread_id/stream — SSE stream for thread
app.get("/:id/threads/:thread_id/stream", async (c) => {
  // Same as session SSE but filtered by thread_id — for now, use full session stream
  return handleSSEStream(c, c.req.param("id"));
});

// ============================================================
// Session Resources (KV only — stays in main worker)
// ============================================================

app.post("/:id/resources", async (c) => {
  const sessionId = c.req.param("id");
  const t = c.get("tenant_id");

  const body = await c.req.json<{
    type: "file" | "memory_store";
    file_id?: string;
    memory_store_id?: string;
    mount_path?: string;
    access?: "read_write" | "read_only";
    /** Per-attachment guidance for the agent (Anthropic-aligned name). 4096 char cap. */
    instructions?: string;
  }>();

  if (!body.type) {
    return c.json({ error: "type is required" }, 400);
  }

  // Per-resource pre-checks the service can't enforce (file existence is a
  // cross-store concern; memory_store sub-cap stays inside sessions-store).
  if (body.type === "file") {
    if (!body.file_id) {
      return c.json({ error: "file_id is required for file resources" }, 400);
    }
    const file = await c.var.services.files.get({
      tenantId: t,
      fileId: body.file_id,
    });
    if (!file) return c.json({ error: "File not found" }, 404);
  }

  if (body.type === "memory_store" && !body.memory_store_id) {
    return c.json({ error: "memory_store_id is required for memory_store resources" }, 400);
  }

  try {
    const added = await c.var.services.sessions.addResource({
      tenantId: t,
      sessionId,
      resource: {
        type: body.type,
        file_id: body.file_id,
        memory_store_id: body.memory_store_id,
        mount_path: body.mount_path,
        access: body.type === "memory_store"
          ? (body.access === "read_only" ? "read_only" : "read_write")
          : undefined,
        instructions: body.type === "memory_store" && typeof body.instructions === "string"
          ? body.instructions.slice(0, 4096)
          : undefined,
      },
    });
    return c.json(added.resource, 201);
  } catch (err) {
    return mapSessionError(c, err);
  }
});

app.get("/:id/resources", async (c) => {
  const sessionId = c.req.param("id");
  try {
    const resources = await c.var.services.sessions.listResources({
      tenantId: c.get("tenant_id"),
      sessionId,
    });
    return c.json({ data: resources.map((r) => r.resource) });
  } catch (err) {
    return mapSessionError(c, err);
  }
});

// GET /v1/sessions/:id/resources/:resource_id — single resource detail.
// Anthropic SDK calls this via `client.beta.sessions.resources.retrieve(...)`.
// Service layer already exposes getResource; just shape it for the wire.
app.get("/:id/resources/:resource_id", async (c) => {
  try {
    const row = await c.var.services.sessions.getResource({
      tenantId: c.get("tenant_id"),
      sessionId: c.req.param("id"),
      resourceId: c.req.param("resource_id"),
    });
    if (!row) return c.json({ error: "Resource not found" }, 404);
    return c.json(row.resource);
  } catch (err) {
    return mapSessionError(c, err);
  }
});

// POST /v1/sessions/:id/resources/:resource_id — update resource
// (`client.beta.sessions.resources.update(...)`). Body is a full
// SessionResource shape; identity (id / session_id / created_at) is
// re-stamped server-side so the wire payload only needs the mutable
// fields. Sandbox-side remount (mount_path / access changes) is NOT
// triggered by this endpoint — callers wanting a re-mount should
// detach + re-attach the resource via DELETE + POST.
app.post("/:id/resources/:resource_id", async (c) => {
  try {
    const body = await c.req.json<SessionResource>();
    if (!body || typeof body !== "object" || !body.type) {
      return c.json({ error: "resource body with `type` field is required" }, 400);
    }
    const row = await c.var.services.sessions.updateResource({
      tenantId: c.get("tenant_id"),
      sessionId: c.req.param("id"),
      resourceId: c.req.param("resource_id"),
      resource: body,
    });
    return c.json(row.resource);
  } catch (err) {
    return mapSessionError(c, err);
  }
});

// GET /v1/sessions/:id/threads/:thread_id — single thread metadata. Threads
// live in the sandbox worker (DO state); the agent worker only exposes
// /threads (list) + /threads/:tid/events (event log) — not a per-thread
// metadata endpoint. Returning 501 keeps the route catalog complete for
// SDK callers without faking a payload. Follow-up: add the metadata
// endpoint to apps/agent/src/runtime/session-do.ts and forward here.
app.get("/:id/threads/:thread_id", (c) =>
  c.json(
    {
      error: {
        type: "not_implemented",
        message: "thread metadata endpoint not yet implemented on this server",
      },
      type: "error",
    },
    501,
  ),
);

// POST /v1/sessions/:id/threads/:thread_id/archive — archive a thread.
// Same story as the thread metadata endpoint above — sandbox worker has no
// concept of archived threads yet. Follow-up alongside the get.
app.post("/:id/threads/:thread_id/archive", (c) =>
  c.json(
    {
      error: {
        type: "not_implemented",
        message: "thread archive endpoint not yet implemented on this server",
      },
      type: "error",
    },
    501,
  ),
);

app.delete("/:id/resources/:resource_id", async (c) => {
  const sessionId = c.req.param("id");
  const resourceId = c.req.param("resource_id");
  const t = c.get("tenant_id");

  try {
    await c.var.services.sessions.deleteResource({
      tenantId: t,
      sessionId,
      resourceId,
    });
  } catch (err) {
    return mapSessionError(c, err);
  }

  // Best-effort cleanup of the corresponding secret entry (if any).
  // The route doesn't know which resource type this was without re-fetching;
  // a stray delete on a non-existent key is a no-op so this is safe.
  await c.var.services.sessionSecrets.deleteOne({
    tenantId: t,
    sessionId,
    resourceId,
  });

  return c.json({ type: "resource_deleted", id: resourceId });
});

/**
 * Pre-fetch all credentials for the given vaults so they can be passed into
 * SessionDO at /init. Reads from D1 via the credentials-store service.
 * SessionDO consumers only need the id + auth fields, so the extra
 * `tenant_id` on CredentialRow is harmless when serialized.
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

/**
 * Outcome of a pre-session credential refresh attempt. The session start path
 * uses this to decide whether to emit warning events into the session stream
 * (so the user sees something in the console instead of a silent expired token
 * surfacing as a 401 mid-task — see OPE-12).
 */
export interface CredentialRefreshResult {
  /** Total (provider, vault) pairs we tried to refresh. */
  attempted: number;
  /** Successful refreshes. */
  succeeded: number;
  /** Per-failure detail for caller's warning event / log. */
  failures: Array<{
    provider: "github" | "linear";
    vaultId: string;
    error: string;
    httpStatus?: number;
  }>;
  /**
   * Set when the refresh path could not run at all (e.g. integrations binding
   * missing, no user row for tenant). Distinct from per-(provider, vault)
   * failure: the whole pass was skipped.
   */
  skippedReason?: "no_integrations_binding" | "no_auth_db" | "no_user_for_tenant" | "no_provider_credentials";
}

/**
 * Refresh provider-tagged credentials in the given vaults before a session
 * starts using them. Avoids the "user starts a session 90 minutes after the
 * last webhook → installation token already expired → bot 401s on first
 * MCP call" failure mode.
 *
 * Returns a structured result instead of throwing — the caller decides
 * whether to surface failures (e.g. as session.warning events). Per-OPE-12,
 * we never silently swallow.
 */
async function refreshProviderCredentialsForSession(
  env: Env,
  services: Services,
  tenantId: string,
  agentId: string,
  vaultIds: string[],
): Promise<CredentialRefreshResult> {
  const empty = (): CredentialRefreshResult => ({ attempted: 0, succeeded: 0, failures: [] });

  if (!vaultIds.length) return empty();
  if (!env.INTEGRATIONS || !env.INTEGRATIONS_INTERNAL_SECRET) {
    return { ...empty(), skippedReason: "no_integrations_binding" };
  }
  if (!env.AUTH_DB) return { ...empty(), skippedReason: "no_auth_db" };

  // Resolve owning userId for this session via the agent row's tenant + a
  // direct user lookup. We need userId because the integrations gateway
  // scopes refresh per-user.
  const row = await env.AUTH_DB.prepare(
    `SELECT id FROM "user" WHERE tenantId = ? LIMIT 1`,
  )
    .bind(tenantId)
    .first<{ id: string }>();
  const userId = row?.id ?? null;
  if (!userId) return { ...empty(), skippedReason: "no_user_for_tenant" };

  // One SQL round-trip via the partial-index on (tenant_id, vault_id, provider).
  // Replaces the previous N-vault × M-key KV scan.
  const tagged = await services.credentials.listProviderTagged({
    tenantId,
    vaultIds,
  });
  if (!tagged.length) return { ...empty(), skippedReason: "no_provider_credentials" };

  // Dedupe to one refresh per (provider, vault) pair.
  const targets = new Map<string, { provider: "github" | "linear"; vaultId: string }>();
  for (const cred of tagged) {
    const provider = cred.auth.provider;
    if (provider !== "github" && provider !== "linear") continue;
    const key = `${provider}:${cred.vault_id}`;
    if (!targets.has(key)) targets.set(key, { provider, vaultId: cred.vault_id });
  }

  const failures: CredentialRefreshResult["failures"] = [];
  let succeeded = 0;
  await Promise.all(
    Array.from(targets.values()).map(async ({ provider, vaultId }) => {
      try {
        const res = await env.INTEGRATIONS!.fetch(
          `http://gateway/${provider}/internal/refresh-by-vault`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-internal-secret": env.INTEGRATIONS_INTERNAL_SECRET!,
            },
            body: JSON.stringify({ userId, vaultId }),
          },
        );
        if (!res.ok) {
          let bodyText: string | undefined;
          try {
            bodyText = (await res.text()).slice(0, 200);
          } catch (err) {
            // Body-read failure is non-fatal — status code is the load-bearing
            // signal — but log so we don't lose visibility on response shape.
            logWarn(
              { op: "session.start.refresh_body_read", provider, vault_id: vaultId, http_status: res.status, err },
              "refresh body read failed",
            );
          }
          failures.push({
            provider,
            vaultId,
            httpStatus: res.status,
            error: `gateway returned ${res.status}${bodyText ? `: ${bodyText}` : ""}`,
          });
          return;
        }
        succeeded++;
      } catch (err) {
        failures.push({
          provider,
          vaultId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
  // agentId is currently unused (refresh is per-user not per-agent), but
  // we accept it for signature symmetry — future per-agent rate limiting
  // would slot here.
  void agentId;
  return { attempted: targets.size, succeeded, failures };
}

/**
 * Convert refresh failures to session.warning events the SessionDO appends to
 * the event stream at /init. One event per failure so the console can surface
 * each (provider, vault) pair distinctly. Per-OPE-12: never silent — even when
 * the whole refresh pass was skipped (no integrations binding, etc.) we log
 * but don't emit a stream event since that's a config/infrastructure signal
 * not actionable to the end user.
 */
function refreshResultToInitEvents(
  result: CredentialRefreshResult,
  ctx: { sessionId: string; tenantId: string },
): SessionEvent[] {
  if (result.skippedReason) {
    logWarn(
      {
        op: "session.start.credential_refresh.skipped",
        session_id: ctx.sessionId,
        tenant_id: ctx.tenantId,
        reason: result.skippedReason,
      },
      "credential refresh skipped",
    );
    return [];
  }
  if (!result.failures.length) return [];
  logWarn(
    {
      op: "session.start.credential_refresh",
      session_id: ctx.sessionId,
      tenant_id: ctx.tenantId,
      failed: result.failures.length,
      attempted: result.attempted,
      failures: result.failures,
    },
    "credential refresh had failures; tools using these creds may 401 mid-task",
  );
  return result.failures.map((f) => ({
    type: "session.warning",
    source: "credential_refresh",
    message: `${f.provider} credential refresh failed for vault ${f.vaultId} — tools using this credential may 401 mid-task and trigger an on-401 retry. ${f.error}`,
    details: {
      provider: f.provider,
      vault_id: f.vaultId,
      http_status: f.httpStatus,
      error: f.error,
    },
  }));
}

/**
 * Look up a live github binding the tenant owns for the given repo URL. When
 * found, calls the integrations gateway to mint a fresh installation token
 * (~1hr TTL) and returns it alongside the binding's vault id. Returns null
 * when no binding matches or any step fails — caller falls back to PAT.
 */
async function tryGitHubBindingFastPath(
  env: Env,
  tenantId: string,
  repoUrl: string,
): Promise<{ token: string; vaultId: string } | null> {
  if (!env.INTEGRATIONS || !env.INTEGRATIONS_INTERNAL_SECRET || !env.AUTH_DB) return null;
  const org = parseGitHubOrg(repoUrl);
  if (!org) return null;

  // Resolve the user owning this tenant. Single-user-per-tenant assumption
  // matches the rest of the integrations layer.
  const userRow = await env.AUTH_DB.prepare(
    `SELECT id FROM "user" WHERE tenantId = ? LIMIT 1`,
  )
    .bind(tenantId)
    .first<{ id: string }>();
  const userId = userRow?.id;
  if (!userId) return null;

  // Look up active github installations for this user matching the org. The
  // workspace_name field on linear_installations holds the GitHub org login.
  const row = await env.AUTH_DB.prepare(
    `SELECT id, vault_id FROM linear_installations
       WHERE user_id = ? AND provider_id = 'github'
         AND lower(workspace_name) = lower(?)
         AND revoked_at IS NULL AND vault_id IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(userId, org)
    .first<{ id: string; vault_id: string }>();
  if (!row?.vault_id) return null;

  // Mint fresh token via integrations gateway. The gateway holds the
  // App private key — we don't.
  try {
    const res = await env.INTEGRATIONS.fetch(
      `http://gateway/github/internal/refresh-by-vault`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-secret": env.INTEGRATIONS_INTERNAL_SECRET,
        },
        body: JSON.stringify({ userId, vaultId: row.vault_id }),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { token?: string };
    if (!data.token) return null;
    return { token: data.token, vaultId: row.vault_id };
  } catch (err) {
    // Fast-path is best-effort — the regular per-session credential refresh
    // path is the source of truth. But this fires on every Linear→GitHub
    // session start, so persistent failures here mean tokens are rotting.
    logError(
      { op: "session.start.github_fastpath", user_id: userId, org, err },
      "GitHub fast-path token mint failed",
    );
    recordEvent(env.ANALYTICS, {
      op: "session.start.github_fastpath.failed",
      ...errFields(err),
    });
    return null;
  }
}

/**
 * Extract the org login from a GitHub repo URL. Handles
 * `https://github.com/<org>/<repo>(.git)?`, `git@github.com:<org>/<repo>`,
 * and bare `<org>/<repo>` forms. Returns null when unparseable or not GitHub.
 */
function parseGitHubOrg(repoUrl: string): string | null {
  // Try full URL form first
  try {
    const u = new URL(repoUrl);
    if (u.hostname !== "github.com" && u.hostname !== "www.github.com") return null;
    const parts = u.pathname.replace(/^\/+/, "").split("/");
    return parts[0] || null;
  } catch {
    // SSH form: git@github.com:owner/repo
    const ssh = repoUrl.match(/^git@github\.com:([^/]+)\//);
    if (ssh) return ssh[1];
    // Bare owner/repo
    const bare = repoUrl.match(/^([^/]+)\/[^/]+$/);
    if (bare) return bare[1];
    return null;
  }
}

// ---- Session outputs ----------------------------------------------------
//
// AMA-aligned `/mnt/session/outputs/` magic-dir contract:
//
//   1. SessionDO mounts FILES_BUCKET at /mnt/session/outputs/ during
//      doWarmUpSandbox via sandbox.mountSessionOutputs().
//   2. R2 prefix: t/<tenantId>/session-outputs/<sessionId>/
//   3. Agent writes a file using the standard `write` tool — s3fs PUTs
//      synchronously to R2 under the prefix.
//   4. Caller lists via GET /v1/sessions/:id/outputs → R2 list_objects
//   5. Caller downloads via GET /v1/sessions/:id/outputs/:filename → R2 get
//
// No D1 file row needed (different from POST /v1/sessions/:id/files which
// promotes a /workspace path to a first-class file_id). The two surfaces
// can coexist: /outputs/ for transparent agent artefacts, /files for
// explicit "save this for later cross-session reference" promotion.

const SESSION_OUTPUTS_PREFIX = (tenantId: string, sessionId: string) =>
  `t/${tenantId}/session-outputs/${sessionId}/`;

const OUTPUT_MIME_GUESS: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", txt: "text/plain", md: "text/markdown",
  csv: "text/csv", json: "application/json", html: "text/html", htm: "text/html",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
  zip: "application/zip", tar: "application/x-tar", gz: "application/gzip",
};

function guessOutputMime(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() || "";
  return OUTPUT_MIME_GUESS[ext] || "application/octet-stream";
}

// GET /v1/sessions/:id/outputs — list files agent wrote to /mnt/session/outputs/.
app.get("/:id/outputs", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const session = await c.var.services.sessions.get({ tenantId: t, sessionId: id });
  if (!session) return c.json({ error: "Session not found" }, 404);

  const bucket = c.env.FILES_BUCKET;
  if (!bucket) return c.json({ error: "FILES_BUCKET binding not configured" }, 500);

  const prefix = SESSION_OUTPUTS_PREFIX(t, id);
  const list = await bucket.list({ prefix, limit: 1000 });

  const data = list.objects.map((o: R2Object) => {
    const filename = o.key.slice(prefix.length);
    return {
      filename,
      size_bytes: o.size,
      uploaded_at: o.uploaded.toISOString(),
      media_type: o.httpMetadata?.contentType || guessOutputMime(filename),
    };
  });
  return c.json({ data, has_more: list.truncated });
});

// GET /v1/sessions/:id/outputs/:filename — stream raw bytes.
app.get("/:id/outputs/:filename", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const filename = c.req.param("filename");
  // Reject path traversal — filenames come from R2 directly (so they CAN'T
  // contain ".." in our prefix), but the URL param is user-controlled.
  if (filename.includes("..") || filename.includes("/")) {
    return c.json({ error: "Invalid filename" }, 400);
  }

  const session = await c.var.services.sessions.get({ tenantId: t, sessionId: id });
  if (!session) return c.json({ error: "Session not found" }, 404);

  const bucket = c.env.FILES_BUCKET;
  if (!bucket) return c.json({ error: "FILES_BUCKET binding not configured" }, 500);

  const r2Key = `${SESSION_OUTPUTS_PREFIX(t, id)}${filename}`;
  const obj = await bucket.get(r2Key);
  if (!obj) return c.json({ error: "Output file not found" }, 404);

  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || guessOutputMime(filename),
      "Content-Length": String(obj.size),
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});

export default app;

// Test-only re-exports — keep route surface clean by namespacing helpers
// that have no business being a public API but need coverage in unit tests.
export const __test__ = {
  refreshResultToInitEvents,
};
