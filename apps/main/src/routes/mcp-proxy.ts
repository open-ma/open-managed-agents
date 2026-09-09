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
 *                 ├── HTTP via API key or current Work bearer
 *                 │   /v1/oma/mcp-proxy/<sid>/<server_name>
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
 *     keys created via /v1/oma/api_keys use). Resolves to (tenant_id, user_id).
 *   - Bearer sk-ant-req-v1.*: sealed self-hosted Work capability; the top-level
 *     middleware validates expiry, exact current claim, heartbeat TTL, and the
 *     Session-scoped proxy path before this router runs.
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
import type { KvStore } from "@open-managed-agents/kv-store";
import { builtinSpecs, createSpecRegistry } from "@open-managed-agents/cap";
import { SqlSessionSource } from "@open-managed-agents/managed-agents-adapters-sql";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";

// Module-level: the cap spec registry is pure data + immutable. Building
// once amortises validation across every outbound request.
const capRegistry = createSpecRegistry(builtinSpecs);

const app = new Hono<{
  Bindings: Env;
  Variables: { services: Services; tenantDb: D1Database };
}>();

export interface McpProxySessionSource {
  find(input: { workspaceId: string; sessionId: string }): Promise<{
    archivedAt: string | null;
    vaultIds: string[];
    agent: {
      mcpServers: Array<{
        name: string;
        url: string;
        authorizationToken?: string;
      }>;
    };
  } | null>;
}

export interface ProxyTarget {
  /** Real upstream MCP server URL (e.g. https://integrations.openma.dev/.../mcp). */
  upstreamUrl: string;
  /** Bearer token to inject on the upstream request. */
  upstreamToken: string;
  /** Set when the matched credential has the bits needed to refresh on
   *  401 (refresh_token + token_endpoint). Used by `forwardWithRefresh`
   *  to retry once with a fresh token if the upstream rejects the
   *  bearer. Stays internal to main — never leaves through any RPC
   *  return value or HTTP response body. */
  refresh?: {
    refreshToken: string;
    tokenEndpoint: string;
    clientId?: string;
    clientSecret?: string;
    credentialId: string;
    vaultId: string;
    /** Where in the credential's `auth` blob the rotated access token
     *  is read from + written back to. mcp_oauth uses `access_token`;
     *  cap_cli uses `token`. Defaults to `access_token` to keep
     *  pre-cap callers working unchanged. */
    tokenField?: "access_token" | "token";
  };
}

export interface ForwardHttpMcpProxyRequestInput {
  env: Env;
  services: Services;
  /** Current v1 Session source. Omit only for legacy embedders/tests. */
  sessionSource?: McpProxySessionSource;
  tenantId: string;
  sessionId: string;
  serverName: string;
  request: Request;
}

async function sha256(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Resolve apiKey → tenant_id via the existing KV `apikey:<sha256>`
 * index. Exported so the HTTP endpoint can do its auth step before handing
 * off to `resolveProxyTargetByTenant`. Returns null on miss / malformed row.
 */
export async function apiKeyToTenantId(kv: KvStore, apiKey: string): Promise<string | null> {
  const hash = await sha256(apiKey);
  const keyData = await kv.get(`apikey:${hash}`);
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
  sessionSource?: McpProxySessionSource,
): Promise<ProxyTarget | null> {
  // 1. Session must exist, belong to the same tenant, not archived.
  const session = sessionSource
    ? await sessionSource.find({ workspaceId: tenantId, sessionId: sid }).catch(() => null)
    : await services.sessions.get({ tenantId, sessionId: sid }).catch(() => null);
  if (!session) return null;
  const legacySession = session as {
    archived_at?: string | null;
    vault_ids?: string[] | null;
    agent_snapshot?: AgentConfig;
  };
  const managedSession = session as {
    archivedAt?: string | null;
    vaultIds?: string[] | null;
    agent?: {
      mcpServers?: Array<{
        name: string;
        url: string;
        authorizationToken?: string;
      }>;
    };
  };
  if (legacySession.archived_at || managedSession.archivedAt) return null;

  // 2. agent_snapshot must declare the requested mcp server.
  const legacyAgent = legacySession.agent_snapshot;
  const server = legacyAgent
    ? (legacyAgent.mcp_servers ?? []).find((candidate) => candidate.name === serverName)
    : (managedSession.agent?.mcpServers ?? []).find(
        (candidate) => candidate.name === serverName,
      );
  if (!server || !server.url) return null;

  // 3. Resolve credential. agent.mcp_servers[].authorization_token, if set,
  //    is the literal token we should inject. Otherwise look up an active
  //    credential matching the server URL across the session's vault_ids.
  const inlineToken = (server as {
    authorization_token?: string;
    authorizationToken?: string;
  }).authorization_token ?? (server as { authorizationToken?: string }).authorizationToken;
  if (inlineToken) {
    return { upstreamUrl: server.url, upstreamToken: inlineToken };
  }

  const vaultIds = legacySession.vault_ids ?? managedSession.vaultIds ?? [];
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
  sessionSource?: McpProxySessionSource,
): Promise<ProxyTarget | null> {
  const session = sessionSource
    ? await sessionSource.find({ workspaceId: tenantId, sessionId: sid }).catch(() => null)
    : await services.sessions.get({ tenantId, sessionId: sid }).catch(() => null);
  if (!session) return null;
  const legacySession = session as {
    archived_at?: string | null;
    vault_ids?: string[] | null;
  };
  const managedSession = session as {
    archivedAt?: string | null;
    vaultIds?: string[] | null;
  };
  if (legacySession.archived_at || managedSession.archivedAt) return null;

  const vaultIds = legacySession.vault_ids ?? managedSession.vaultIds ?? [];
  if (vaultIds.length === 0) return null;
  const grouped = await services.credentials
    .listByVaults({ tenantId, vaultIds })
    .catch(() => []);

  // First pass: cap_cli credentials matched via cap's spec registry.
  // Cap owns the per-CLI knowledge — endpoints (`api.github.com`,
  // `*.amazonaws.com`, …), header shape, OAuth refresh metadata. Here we
  // just match by hostname → cli_id and find a cap_cli credential whose
  // cli_id matches. Header rewrite happens later in forwardWithRefresh.
  //
  // Selection rule when the vault has more than one matching cap_cli
  // (typical after a re-auth): pick the newest non-archived row by
  // `updated_at`. listByVaults returns `created_at ASC` and includes
  // archived rows, so a naive "first match wins" loop kept injecting
  // the OLDEST (= staler) token for sessions whose user re-ran
  // `cap login` to refresh — observed in prod 2026-05-13: gh `repo list`
  // returned 401 even immediately after a successful re-auth.
  const capSpec = capRegistry.byHostname(hostname);
  if (capSpec) {
    let best: { c: typeof grouped[number]["credentials"][number]; vaultId: string; ts: number } | null = null;
    for (const g of grouped) {
      for (const c of g.credentials) {
        if ((c as { archived_at?: string | null }).archived_at) continue;
        const auth = (c as unknown as CredentialConfig).auth as
          | {
              type?: string;
              cli_id?: string;
              token?: string;
              refresh_token?: string;
            }
          | undefined;
        if (auth?.type !== "cap_cli") continue;
        if (auth.cli_id !== capSpec.cli_id) continue;
        if (!auth.token) continue;
        const meta = c as { updated_at?: string | number; created_at?: string | number };
        const tsRaw = meta.updated_at ?? meta.created_at ?? 0;
        const ts = typeof tsRaw === "number" ? tsRaw : Date.parse(String(tsRaw)) || 0;
        if (!best || ts > best.ts) best = { c, vaultId: g.vault_id, ts };
      }
    }
    if (best) {
      const auth = (best.c as unknown as CredentialConfig).auth as {
        token?: string;
        refresh_token?: string;
      };
      // Treat every cap_cli credential as a static bearer for the
      // matched hostname. Header-mode CLIs (gh, glab, fly, …) all
      // emit `Authorization: Bearer <token>` which matches existing
      // forwardWithRefresh behaviour. metadata_ep / exec_helper modes
      // need the full cap.handleHttp pipeline — wired in PR 2.
      const target: ProxyTarget = {
        upstreamUrl: `https://${hostname}/`,
        upstreamToken: auth.token!,
      };
      // Wire OAuth refresh for cap_cli when the spec declares a
      // device_flow (so we know the token_endpoint + client_id) AND
      // the credential carries a refresh_token. Without this, an
      // expired cap_cli token returns 401 every turn and the user
      // has to manually re-run `cap login` — same problem
      // mcp_oauth had pre-fix. Persistence writes back to
      // `auth.token` (cap_cli's field name), not `auth.access_token`.
      const deviceFlow = capSpec.oauth?.device_flow;
      if (auth.refresh_token && deviceFlow?.token_url) {
        target.refresh = {
          refreshToken: auth.refresh_token,
          tokenEndpoint: deviceFlow.token_url,
          clientId: deviceFlow.client_id,
          credentialId: (best.c as { id: string }).id,
          vaultId: best.vaultId,
          tokenField: "token",
        };
      }
      return target;
    }
  }

  // Second pass: legacy mcp_oauth / static_bearer matched by mcp_server_url.
  // Kept for MCP server credentials (Linear / Slack / Notion etc.) that
  // aren't routed through cap — those are MCP-OAuth, not CLI.
  // Same skip-archived + pick-newest rule as the cap_cli pass above.
  let bestMcp: {
    c: typeof grouped[number]["credentials"][number];
    vaultId: string;
    ts: number;
  } | null = null;
  for (const g of grouped) {
    for (const c of g.credentials) {
      if ((c as { archived_at?: string | null }).archived_at) continue;
      const auth = (c as unknown as CredentialConfig).auth as
        | {
            type?: string;
            mcp_server_url?: string;
            bearer_token?: string;
            token?: string;
            access_token?: string;
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
      const meta = c as { updated_at?: string | number; created_at?: string | number };
      const tsRaw = meta.updated_at ?? meta.created_at ?? 0;
      const ts = typeof tsRaw === "number" ? tsRaw : Date.parse(String(tsRaw)) || 0;
      if (!bestMcp || ts > bestMcp.ts) bestMcp = { c, vaultId: g.vault_id, ts };
    }
  }
  if (bestMcp) {
    const auth = (bestMcp.c as unknown as CredentialConfig).auth as {
      type?: string;
      mcp_server_url: string;
      bearer_token?: string;
      token?: string;
      access_token?: string;
      refresh_token?: string;
      token_endpoint?: string;
      client_id?: string;
      client_secret?: string;
    };
    const token = auth.bearer_token ?? auth.token ?? auth.access_token!;
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
        credentialId: (bestMcp.c as { id: string }).id,
        vaultId: bestMcp.vaultId,
      };
    }
    return target;
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
  upstreamHeaders.delete("x-api-key");
  upstreamHeaders.delete("proxy-authorization");
  upstreamHeaders.delete("cookie");
  upstreamHeaders.delete("x-active-tenant");

  const upstreamReq = new Request(target.upstreamUrl, {
    method,
    headers: upstreamHeaders,
    body: ["GET", "HEAD"].includes(method) ? undefined : body,
    // A redirect is a new destination and must be re-authorized explicitly;
    // never let fetch replay a Vault bearer automatically.
    redirect: "manual",
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
 * already pass body as a string; the public HTTP /v1/oma/mcp-proxy endpoint
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
  // Trigger refresh on either 401 (canonical "your token is expired /
  // invalid") or 403 (some MCP servers — observed on mcp.airtable.com,
  // mcp.asana.com, mcp.sentry.dev — return Forbidden instead of
  // Unauthorized when the bearer is expired or revoked, presumably
  // because their auth layer treats "no usable identity" as a
  // permission failure rather than an auth failure). 403 is ambiguous
  // — it could also mean "scope removed" or "plan tier downgrade", in
  // which case refresh succeeds + retry still 403s, and we surface that
  // genuine error to the caller. The cost of an extra refresh call in
  // the false-positive case is one HTTP round-trip + D1 write, which is
  // cheap relative to the user-visible breakage of "token expired and
  // nothing ever recovers" (the actual symptom — staging 2026-05-20
  // sess-pvdx9d16zitzhw39 saw all three of airtable/asana/sentry
  // permanently 403 across multiple sessions until manual SQL cleanup).
  const refreshableStatus = first.status === 401 || first.status === 403;
  if (!refreshableStatus || !target.refresh) {
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
  const tokenField = refresh.tokenField ?? "access_token";
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
  // Read the current row WITH its raw ciphertext. We need the bytes to
  // CAS the post-refresh write — AES-GCM uses a random IV so two
  // encrypts of the same plaintext produce different ciphertexts; the
  // only way to predicate "the row hasn't moved since I read it" is on
  // the exact ciphertext bytes.
  let expectedAuthCipher: string | null = null;
  try {
    const fresh = await services.credentials
      .getRawForRefresh({ tenantId, vaultId: refresh.vaultId, credentialId: refresh.credentialId })
      .catch(() => null);
    if (fresh) {
      const liveAccessToken = (fresh.row.auth as unknown as Record<string, unknown>)?.[tokenField];
      if (typeof liveAccessToken === "string" && liveAccessToken !== staleAccessToken) {
        // Another in-flight refresh (or a manual /v1/oma/oauth/refresh) has
        // already rotated the token between our caller's first 401/403
        // and us reaching this re-read. Use the live token, skip the
        // token_endpoint roundtrip + the CAS write entirely.
        return liveAccessToken;
      }
      expectedAuthCipher = fresh.authCipher;
    }
  } catch {
    // D1 unreachable — fall through to token_endpoint refresh without CAS.
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
  if (!res.ok) {
    // token_endpoint rejected our refresh_token. Two distinct cases:
    //   (a) Real failure: refresh_token revoked / scopes removed → no
    //       way forward, return null and the caller surfaces the
    //       upstream error.
    //   (b) Race we lost: a parallel refresh on this same credential
    //       beat us, the provider rotated refresh_token, ours is now
    //       invalid. The winner persisted a fresh access_token to D1.
    //       Re-read and route the caller's retry through it.
    try {
      const after = await services.credentials
        .get({ tenantId, vaultId: refresh.vaultId, credentialId: refresh.credentialId })
        .catch(() => null);
      const winnerAuth = (after as { auth?: Record<string, unknown> } | null)?.auth;
      const winnerAccessToken = winnerAuth?.[tokenField];
      if (typeof winnerAccessToken === "string" && winnerAccessToken !== staleAccessToken) {
        return winnerAccessToken;
      }
    } catch {
      /* fall through */
    }
    return null;
  }

  let tokens: { access_token?: string; refresh_token?: string; expires_in?: number };
  try {
    tokens = (await res.json()) as typeof tokens;
  } catch {
    return null;
  }
  if (!tokens.access_token) return null;

  // Persist back to D1 via CAS. Two parallel refreshes that both made it
  // through token_endpoint successfully (the provider didn't one-shot
  // its refresh_token) end up here with potentially different new tokens.
  // CAS picks a winner. Loser re-reads and uses winner's token — the
  // ones we just got back from token_endpoint get dropped on the floor,
  // which is fine because both are valid (the provider didn't invalidate
  // either) and consistency-of-stored-state matters more than which
  // valid-token-we-got is "ours".
  if (expectedAuthCipher) {
    const updated = await services.credentials
      .refreshAuthCAS({
        tenantId,
        vaultId: refresh.vaultId,
        credentialId: refresh.credentialId,
        expectedAuthCipher,
        auth: {
          [tokenField]: tokens.access_token,
          refresh_token: tokens.refresh_token ?? refresh.refreshToken,
          expires_at: tokens.expires_in
            ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
            : undefined,
        } as Partial<import("@open-managed-agents/shared").CredentialAuth>,
      })
      .catch(() => null);
    if (!updated) {
      // CAS lost — winner already wrote. Re-read and return their token.
      try {
        const after = await services.credentials
          .get({ tenantId, vaultId: refresh.vaultId, credentialId: refresh.credentialId })
          .catch(() => null);
        const winnerToken = (after as { auth?: Record<string, unknown> } | null)?.auth?.[tokenField];
        if (typeof winnerToken === "string") return winnerToken;
      } catch {
        /* fall through */
      }
      // Couldn't read the winner — return our just-acquired token
      // anyway, the caller's retry will at least use a valid bearer.
      return tokens.access_token;
    }
  } else {
    // No expectedAuthCipher (D1 was unreachable when we tried to read).
    // Fall back to non-CAS update — accepts the small "two writers
    // clobber" risk in exchange for persisting at all when D1 was
    // briefly unavailable on the read but recovered for the write.
    try {
      await services.credentials.refreshAuth({
        tenantId,
        vaultId: refresh.vaultId,
        credentialId: refresh.credentialId,
        auth: {
          [tokenField]: tokens.access_token,
          refresh_token: tokens.refresh_token ?? refresh.refreshToken,
          expires_at: tokens.expires_in
            ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
            : undefined,
        } as Partial<import("@open-managed-agents/shared").CredentialAuth>,
      });
    } catch {
      /* best-effort */
    }
  }

  return tokens.access_token;
}

// HTTP endpoint — used by local-runtime ACP via API key and by an official
// self-hosted Work/harness-in-sandbox via its current sessions_token. Cloud
// host-side agents may instead use the WorkerEntrypoint RPC (see McpProxyRpc).
export async function forwardHttpMcpProxyRequest(
  input: ForwardHttpMcpProxyRequestInput,
): Promise<Response> {
  const target = await resolveProxyTargetByTenant(
    input.env,
    input.services,
    input.tenantId,
    input.sessionId,
    input.serverName,
    input.sessionSource,
  );
  if (!target) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  // Buffer the body so forwardWithRefresh can replay it after rotating an
  // expired upstream credential.  The caller's Work/API bearer is always
  // overwritten by forwardToUpstream and therefore never leaves OpenMA.
  const method = input.request.method;
  const body = ["GET", "HEAD"].includes(method)
    ? null
    : await input.request.text();
  return forwardWithRefresh(
    input.services,
    input.tenantId,
    target,
    method,
    input.request.headers,
    body,
    {
      sessionId: input.sessionId,
      serverName: input.serverName,
      callerKind: "http",
    },
  );
}

app.all("/:sid/:server", async (c) => {
  const sid = c.req.param("sid");
  const serverName = c.req.param("server");
  // authMiddleware resolves both a workspace API key (local bridge) and a
  // current sealed Work sessions_token (sandbox worker) before this route.
  // Keep the legacy fallback for isolated route tests/embedders which mount
  // this sub-app without the top-level middleware.
  let tenantId = (c.var as { tenant_id?: string }).tenant_id;
  if (!tenantId) {
    const auth = c.req.header("authorization") ?? "";
    const apiKey = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
    if (!apiKey) return c.json({ error: "missing bearer" }, 401);
    tenantId = await apiKeyToTenantId(c.var.services.kv, apiKey) ?? undefined;
    if (!tenantId) return c.json({ error: "forbidden" }, 403);
  }
  const services = c.get("services");
  const sessionSource = new SqlSessionSource(new CfD1SqlClient(c.get("tenantDb")));
  return forwardHttpMcpProxyRequest({
    env: c.env,
    services,
    sessionSource,
    tenantId,
    sessionId: sid,
    serverName,
    request: c.req.raw,
  });
});

export default app;
