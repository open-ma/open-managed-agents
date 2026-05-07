/**
 * MCP proxy — gateway between an OMA agent (cloud or local-runtime) and the
 * upstream MCP servers configured on that agent. The credential lives in
 * a vault on the cloud side; this proxy is the only layer that ever holds
 * the plaintext token, mirroring Anthropic's Managed Agents design (the
 * sandbox / harness never sees credentials, only references to them).
 *
 *   ┌────────────────────────────────┐
 *   │  ACP child  /  Cloud agent DO  │   "调 server X，sid=Y"
 *   │  (the harness — no creds)      │
 *   └─────────────┬──────────────────┘
 *                 │
 *                 ├── HTTP via Bearer oma_*  (local-runtime path)
 *                 │   /v1/mcp-proxy/<sid>/<server_name>
 *                 │
 *                 └── WorkerEntrypoint RPC via service binding
 *                     (cloud agent path — see apps/main/src/index.ts:McpProxyRpc)
 *                 │
 *   ┌─────────────▼──────────────────┐
 *   │  resolveProxyTarget(...)        │   ← only function that touches creds
 *   │  + forwardToUpstream(...)       │
 *   └─────────────┬──────────────────┘
 *                 │  Authorization: Bearer <real-token>
 *                 ▼
 *           upstream MCP server
 *
 * Auth surface (HTTP path):
 *   - Bearer omak_*: hashed in CONFIG_KV `apikey:<sha256>` (same row API
 *     keys created via /v1/api_keys use). Resolves to (tenant_id, user_id).
 *   - sid in URL: must reference a row in `sessions` belonging to the same
 *     tenant. session.archived_at IS NULL gates "this session is still alive";
 *     deletion → proxy returns 403 immediately, no token revocation needed.
 *   - server_name in URL: must match one of agent.mcp_servers[].name on the
 *     session's agent_snapshot.
 *
 * Auth surface (RPC path): tenant_id is established by the binding itself —
 * only configured Workers can RPC into us, and the caller (agent worker)
 * already authenticated the session out-of-band. The same session/server
 * checks below run, just without the apiKey lookup step.
 *
 * Auth flow is intentionally cache-friendly: a single function
 * `resolveProxyTargetByTenant(env, services, tenantId, sid, serverName) →
 * ProxyTarget | null` isolates the lookup so a future KV cache layer can
 * drop in around it without changing call sites. We don't add the cache
 * yet — current scale runs sub-ms per call, KV round-trip would be slower.
 */

import { Hono } from "hono";
import type { Env, AgentConfig, CredentialConfig } from "@open-managed-agents/shared";
import { log, logWarn } from "@open-managed-agents/shared";
import type { Services } from "@open-managed-agents/services";

const app = new Hono<{ Bindings: Env; Variables: { services: Services } }>();

export interface ProxyTarget {
  /** Real upstream MCP server URL (e.g. https://integrations.openma.dev/.../mcp). */
  upstreamUrl: string;
  /** Bearer token to inject on the upstream request. */
  upstreamToken: string;
  /** Set when the matched credential is `mcp_oauth` and has the bits
   *  needed to refresh on 401 (refresh_token + token_endpoint). Used by
   *  `forwardWithRefresh` to retry once with a fresh token if the upstream
   *  rejects the bearer. Stays internal to main — never leaves through
   *  any RPC return value or HTTP response body. */
  refresh?: {
    refreshToken: string;
    tokenEndpoint: string;
    clientId?: string;
    clientSecret?: string;
    credentialId: string;
    vaultId: string;
  };
}

async function sha256(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Resolve apiKey → tenant_id via the existing CONFIG_KV `apikey:<sha256>`
 * index. Exported so the HTTP endpoint can do its auth step before handing
 * off to `resolveProxyTargetByTenant`. Returns null on miss / malformed row.
 */
export async function apiKeyToTenantId(env: Env, apiKey: string): Promise<string | null> {
  const hash = await sha256(apiKey);
  const keyData = await env.CONFIG_KV.get(`apikey:${hash}`);
  if (!keyData) return null;
  const { tenant_id: tenantId } = JSON.parse(keyData) as { tenant_id: string; user_id?: string };
  return tenantId || null;
}

/**
 * Validate the (tenantId, sid, serverName) triple and resolve the upstream
 * URL + injection token. Returns null if anything fails — the caller turns
 * that into a 403 with a generic message.
 *
 * Used by both the HTTP endpoint (auth via apiKey → tenantId) and the RPC
 * entrypoint (auth via service binding; tenantId comes from the agent
 * worker's session context). Keeping the cred-resolution step apiKey-free
 * is what lets cloud agents skip the apiKey-bootstrap problem.
 */
export async function resolveProxyTargetByTenant(
  env: Env,
  services: Services,
  tenantId: string,
  sid: string,
  serverName: string,
): Promise<ProxyTarget | null> {
  // 1. Session must exist, belong to the same tenant, not archived.
  const session = await services.sessions.get({ tenantId, sessionId: sid }).catch(() => null);
  if (!session) return null;
  const sessionAny = session as {
    archived_at?: string | null;
    vault_ids?: string[] | null;
    agent_snapshot?: AgentConfig;
  };
  if (sessionAny.archived_at) return null;

  // 2. agent_snapshot must declare the requested mcp server.
  const agent = sessionAny.agent_snapshot;
  if (!agent) return null;
  const server = (agent.mcp_servers ?? []).find((s) => s.name === serverName);
  if (!server || !server.url) return null;

  // 3. Resolve credential. agent.mcp_servers[].authorization_token, if set,
  //    is the literal token we should inject. Otherwise look up an active
  //    credential matching the server URL across the session's vault_ids.
  if (server.authorization_token) {
    return { upstreamUrl: server.url, upstreamToken: server.authorization_token };
  }

  const vaultIds = sessionAny.vault_ids ?? [];
  if (vaultIds.length === 0) return null;
  const grouped = await services.credentials
    .listByVaults({ tenantId, vaultIds })
    .catch(() => []);
  for (const g of grouped) {
    for (const c of g.credentials) {
      const auth = (c as unknown as CredentialConfig).auth as
        | {
            type?: string;
            mcp_server_url?: string;
            bearer_token?: string;
            token?: string;
            access_token?: string;
            refresh_token?: string;
            token_endpoint?: string;
            client_id?: string;
            client_secret?: string;
          }
        | undefined;
      if (auth?.mcp_server_url !== server.url) continue;
      const token = auth?.bearer_token ?? auth?.token ?? auth?.access_token;
      if (!token) continue;
      const target: ProxyTarget = { upstreamUrl: server.url, upstreamToken: token };
      // Surface refresh metadata for mcp_oauth so 401 can trigger an
      // automatic token refresh + retry. static_bearer creds skip this.
      if (auth.type === "mcp_oauth" && auth.refresh_token && auth.token_endpoint) {
        target.refresh = {
          refreshToken: auth.refresh_token,
          tokenEndpoint: auth.token_endpoint,
          clientId: auth.client_id,
          clientSecret: auth.client_secret,
          credentialId: (c as { id: string }).id,
          vaultId: g.vault_id,
        };
      }
      return target;
    }
  }
  return null;
}

/**
 * Outbound counterpart to `resolveProxyTargetByTenant`: pick a vault bearer
 * token whose `auth.mcp_server_url` shares a hostname with the request the
 * sandbox is about to make. Returns null when the session has no matching
 * credential — caller forwards the request without injection (works for
 * unauthenticated upstreams and matches the pre-refactor "pass through if
 * no match" behavior).
 *
 * Hostname-based match (rather than full URL like the MCP path) because
 * the sandbox container hits arbitrary upstream paths — e.g. the agent
 * configures an MCP server at `https://api.linear.app/mcp` and then
 * fetches `https://api.linear.app/v1/issues/...` from a script. Both
 * should get the same Bearer.
 *
 * Live read on every call: no DO-side snapshot, no KV blob in agent
 * worker. If a vault credential is rotated mid-session, the next outbound
 * call sees the new token without any session-side invalidation.
 */
export async function resolveOutboundCredentialByHost(
  env: Env,
  services: Services,
  tenantId: string,
  sid: string,
  hostname: string,
): Promise<ProxyTarget | null> {
  const session = await services.sessions.get({ tenantId, sessionId: sid }).catch(() => null);
  if (!session) return null;
  const sessionAny = session as {
    archived_at?: string | null;
    vault_ids?: string[] | null;
  };
  if (sessionAny.archived_at) return null;

  const vaultIds = sessionAny.vault_ids ?? [];
  if (vaultIds.length === 0) return null;
  const grouped = await services.credentials
    .listByVaults({ tenantId, vaultIds })
    .catch(() => []);
  for (const g of grouped) {
    for (const c of g.credentials) {
      const auth = (c as unknown as CredentialConfig).auth as
        | {
            type?: string;
            mcp_server_url?: string;
            bearer_token?: string;
            token?: string;
            access_token?: string;
            refresh_token?: string;
            token_endpoint?: string;
            client_id?: string;
            client_secret?: string;
          }
        | undefined;
      if (!auth?.mcp_server_url) continue;
      let credUrl: URL;
      try {
        credUrl = new URL(auth.mcp_server_url);
      } catch {
        continue;
      }
      if (credUrl.hostname !== hostname) continue;
      const token = auth.bearer_token ?? auth.token ?? auth.access_token;
      if (!token) continue;
      // upstreamUrl on this target is just for forward bookkeeping; the
      // outbound RPC caller passes the actual destination URL it wants
      // hit. We thread the cred's mcp_server_url through so log messages
      // / refresh persistence can correlate, but it's not used by
      // forwardWithRefresh's fetch (which uses caller's URL).
      const target: ProxyTarget = { upstreamUrl: auth.mcp_server_url, upstreamToken: token };
      if (auth.type === "mcp_oauth" && auth.refresh_token && auth.token_endpoint) {
        target.refresh = {
          refreshToken: auth.refresh_token,
          tokenEndpoint: auth.token_endpoint,
          clientId: auth.client_id,
          clientSecret: auth.client_secret,
          credentialId: (c as { id: string }).id,
          vaultId: g.vault_id,
        };
      }
      return target;
    }
  }
  return null;
}

/**
 * Forward an MCP request to the upstream server, swapping the authorization
 * header for the resolved upstream token. Strips any session-/proxy-specific
 * CF headers so the upstream sees only what it would have if the agent had
 * called it directly with the real credential.
 *
 * Streams the response back as-is — MCP-over-HTTP clients expect to read
 * the body progressively (SSE / chunked NDJSON). Both the HTTP endpoint
 * and the RPC entrypoint share this code path.
 */
export async function forwardToUpstream(
  target: ProxyTarget,
  method: string,
  inboundHeaders: Headers,
  body: BodyInit | null,
): Promise<Response> {
  const upstreamHeaders = new Headers(inboundHeaders);
  upstreamHeaders.set("authorization", `Bearer ${target.upstreamToken}`);
  upstreamHeaders.delete("host");
  upstreamHeaders.delete("cf-connecting-ip");
  upstreamHeaders.delete("cf-ray");
  upstreamHeaders.delete("x-forwarded-for");
  upstreamHeaders.delete("x-forwarded-proto");
  upstreamHeaders.delete("x-real-ip");

  const upstreamReq = new Request(target.upstreamUrl, {
    method,
    headers: upstreamHeaders,
    body: ["GET", "HEAD"].includes(method) ? undefined : body,
  });

  return fetch(upstreamReq);
}

/**
 * Forward + auto-refresh on 401 for `mcp_oauth` credentials. Wraps
 * `forwardToUpstream` with: if the first response is 401 AND the
 * resolved credential carries refresh metadata, hit `token_endpoint`
 * with the `refresh_token`, persist the rotated token back to D1 (via
 * services.credentials.refreshAuth so the next session sees the new
 * token immediately), and retry the upstream call once with the fresh
 * bearer. Returns whatever the retry produced — including another 401
 * if refresh itself was rejected (revoked refresh_token, scopes
 * removed) — so the caller's UI can surface the genuine auth failure.
 *
 * Body must be pre-buffered (string | null) because the request stream
 * gets consumed by the first fetch and we need to replay it on retry.
 * For Worker-to-Worker traffic both `mcpForward` and `outboundForward`
 * already pass body as a string; the public HTTP /v1/mcp-proxy endpoint
 * pre-buffers via `c.req.text()` for the same reason.
 *
 * Replaces the old apps/agent/src/outbound.ts:tryRefreshToken path,
 * which lived in the agent worker and updated a per-session KV
 * snapshot. The KV snapshot is gone (see previous commit); refresh
 * persistence is now D1-direct so the canonical credential row is the
 * single source of truth and stays consistent across sessions.
 */
export async function forwardWithRefresh(
  services: Services,
  tenantId: string,
  target: ProxyTarget,
  method: string,
  inboundHeaders: Headers,
  body: BodyInit | null,
  /** Audit context — surfaces in structured log lines so production
   *  incidents have a "who called what when" trail without us having to
   *  thread it through every call. tenantId comes from the function arg
   *  above; this just adds the session/server discriminators that vary
   *  per call. */
  audit?: {
    sessionId?: string;
    serverName?: string;
    callerKind: "http" | "rpc-mcp" | "rpc-outbound";
  },
): Promise<Response> {
  const started = Date.now();
  let upstreamHost: string | undefined;
  try {
    upstreamHost = new URL(target.upstreamUrl).hostname;
  } catch {
    /* never */
  }

  const first = await forwardToUpstream(target, method, inboundHeaders, body);
  if (first.status !== 401 || !target.refresh) {
    log(
      {
        op: "mcp_proxy.forward",
        caller: audit?.callerKind ?? "unknown",
        tenant_id: tenantId,
        session_id: audit?.sessionId,
        server: audit?.serverName,
        host: upstreamHost,
        method,
        status: first.status,
        refreshed: false,
        ms: Date.now() - started,
      },
      "mcp_proxy forward",
    );
    return first;
  }

  // Drain so we can return a fresh Response without two outstanding
  // streams. We don't read the body — its content is irrelevant once
  // we've decided to refresh.
  try {
    await first.body?.cancel();
  } catch {
    /* already consumed / closed */
  }

  const fresh = await tryRefreshOauth(services, tenantId, target.refresh, target.upstreamToken);
  if (!fresh) {
    // Refresh failed: re-issue the original request unchanged so the
    // caller gets the upstream's actual 401 (matches old behavior).
    const retry = await forwardToUpstream(target, method, inboundHeaders, body);
    logWarn(
      {
        op: "mcp_proxy.refresh_failed",
        caller: audit?.callerKind ?? "unknown",
        tenant_id: tenantId,
        session_id: audit?.sessionId,
        server: audit?.serverName,
        host: upstreamHost,
        status: retry.status,
        ms: Date.now() - started,
      },
      "mcp_proxy refresh failed; surfacing upstream 401",
    );
    return retry;
  }

  const retried = await forwardToUpstream(
    { ...target, upstreamToken: fresh },
    method,
    inboundHeaders,
    body,
  );
  log(
    {
      op: "mcp_proxy.forward",
      caller: audit?.callerKind ?? "unknown",
      tenant_id: tenantId,
      session_id: audit?.sessionId,
      server: audit?.serverName,
      host: upstreamHost,
      method,
      status: retried.status,
      refreshed: true,
      ms: Date.now() - started,
    },
    "mcp_proxy forward (after refresh)",
  );
  return retried;
}

async function tryRefreshOauth(
  services: Services,
  tenantId: string,
  refresh: NonNullable<ProxyTarget["refresh"]>,
  staleAccessToken: string,
): Promise<string | null> {
  // Double-checked locking against concurrent refresh: if N parallel
  // calls all 401 at the same instant (typical when access_token TTL
  // hits boundary mid-multi-tool-call), they'll all enter this path.
  // Re-fetch the canonical credential from D1 first; if its access_token
  // has already moved past the stale one we just got 401'd with, another
  // call already refreshed — return the live token, skip the
  // token_endpoint call entirely. This isn't a perfect mutex (two calls
  // can both re-fetch BEFORE either persists), but it cuts the race
  // window from "every 401" to "two 401s landing in the same low
  // single-digit ms". Good enough for current scale; perfect mutex
  // would need a per-credential Durable Object and isn't worth it
  // until we see real concurrent-refresh damage in production logs.
  try {
    const fresh = await services.credentials
      .get({ tenantId, vaultId: refresh.vaultId, credentialId: refresh.credentialId })
      .catch(() => null);
    const liveAccessToken = (fresh as { auth?: { access_token?: string } } | null)?.auth?.access_token;
    if (liveAccessToken && liveAccessToken !== staleAccessToken) {
      // Someone (another in-flight call, or a manual refresh via
      // /v1/oauth/refresh) already rotated. Use the fresh token; don't
      // burn another token_endpoint roundtrip.
      return liveAccessToken;
    }
  } catch {
    // D1 unreachable — fall through to token_endpoint refresh.
  }

  const tokenBody = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refresh.refreshToken,
    client_id: refresh.clientId || "open-managed-agents",
  });
  if (refresh.clientSecret) tokenBody.set("client_secret", refresh.clientSecret);

  let res: Response;
  try {
    res = await fetch(refresh.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let tokens: { access_token?: string; refresh_token?: string; expires_in?: number };
  try {
    tokens = (await res.json()) as typeof tokens;
  } catch {
    return null;
  }
  if (!tokens.access_token) return null;

  // Best-effort persist back to D1. If the write fails we still return
  // the new access_token — the current request gets through, future
  // sessions just may take one extra refresh hop.
  try {
    await services.credentials.refreshAuth({
      tenantId,
      vaultId: refresh.vaultId,
      credentialId: refresh.credentialId,
      auth: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? refresh.refreshToken,
        expires_at: tokens.expires_in
          ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
          : undefined,
      },
    });
  } catch {
    /* best-effort */
  }

  return tokens.access_token;
}

// HTTP endpoint — used by the local-runtime ACP child via apiKey auth.
// Cloud agent path uses the WorkerEntrypoint RPC instead (see McpProxyRpc
// in apps/main/src/index.ts).
app.all("/:sid/:server", async (c) => {
  const sid = c.req.param("sid");
  const serverName = c.req.param("server");
  const auth = c.req.header("authorization") ?? "";
  const apiKey = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  if (!apiKey) return c.json({ error: "missing bearer" }, 401);

  const tenantId = await apiKeyToTenantId(c.env, apiKey);
  if (!tenantId) return c.json({ error: "forbidden" }, 403);

  const services = c.get("services");
  const target = await resolveProxyTargetByTenant(
    c.env,
    services,
    tenantId,
    sid,
    serverName,
  );
  if (!target) return c.json({ error: "forbidden" }, 403);

  // Buffer the body so forwardWithRefresh can replay it on a 401 retry.
  // For typical MCP clients body is a small JSON-RPC payload — fine to
  // hold in memory. Streamed uploads aren't a thing on this endpoint.
  const method = c.req.method;
  const body = ["GET", "HEAD"].includes(method) ? null : await c.req.text();

  return forwardWithRefresh(
    services,
    tenantId,
    target,
    method,
    c.req.raw.headers,
    body,
    { sessionId: sid, serverName: serverName, callerKind: "http" },
  );
});

export default app;
