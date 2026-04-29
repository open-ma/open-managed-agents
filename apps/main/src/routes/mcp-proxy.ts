/**
 * MCP proxy — gateway between an ACP child running on a user's machine and
 * the upstream MCP servers configured on an OMA agent. Lets the agent's
 * model use Linear / GitHub / etc. tools without ever sending the upstream
 * credentials to the user's machine.
 *
 *   ACP child (user's laptop)
 *     │  HTTP w/ Bearer oma_*
 *     ▼
 *   /v1/mcp-proxy/<sid>/<server_name>   ← here
 *     │  Same MCP-over-HTTP protocol the upstream speaks; we
 *     │  only swap the auth header before forwarding
 *     ▼
 *   upstream MCP server (integrations.openma.dev or third-party)
 *
 * Auth surface:
 *   - Bearer omak_*: hashed in CONFIG_KV `apikey:<sha256>` (same row API
 *     keys created via /v1/api_keys use). Resolves to (tenant_id, user_id).
 *   - sid in URL: must reference a row in `sessions` belonging to the same
 *     tenant. session.archived_at IS NULL gates "this session is still alive";
 *     deletion → proxy returns 403 immediately, no token revocation needed.
 *   - server_name in URL: must match one of agent.mcp_servers[].name on the
 *     session's agent_snapshot.
 *
 * Auth flow is intentionally cache-friendly: a single function
 * `resolveProxyTarget(env, token, sid, serverName) → ProxyTarget | error`
 * isolates the lookup so a future KV cache layer can drop in around it
 * without changing call sites. We don't add the cache yet — current scale
 * runs sub-ms per call, KV rounds-trip would be slower.
 */

import { Hono } from "hono";
import type { Env, AgentConfig, CredentialConfig } from "@open-managed-agents/shared";
import type { Services } from "@open-managed-agents/services";

const app = new Hono<{ Bindings: Env; Variables: { services: Services } }>();

interface ProxyTarget {
  /** Real upstream MCP server URL (e.g. https://integrations.openma.dev/.../mcp). */
  upstreamUrl: string;
  /** Bearer token to inject on the upstream request. */
  upstreamToken: string;
}

async function sha256(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Validate the (api key, session id, mcp server name) triple and resolve
 * the upstream URL + injection token. Returns null if anything fails — the
 * caller turns that into a 401/403/404 with a generic message.
 *
 * Single function on purpose: when we add a KV cache for the (token+sid+server)
 * tuple, the wrapper goes here, signature stays.
 */
async function resolveProxyTarget(
  env: Env,
  services: Services,
  apiKey: string,
  sid: string,
  serverName: string,
): Promise<ProxyTarget | null> {
  // 1. Token → tenant_id, user_id (KV: apikey:<sha256>)
  const hash = await sha256(apiKey);
  const keyData = await env.CONFIG_KV.get(`apikey:${hash}`);
  if (!keyData) return null;
  const { tenant_id: tenantId } = JSON.parse(keyData) as { tenant_id: string; user_id?: string };
  if (!tenantId) return null;

  // 2. Session must exist, belong to the same tenant, not archived.
  const session = await services.sessions.get({ tenantId, sessionId: sid }).catch(() => null);
  if (!session) return null;
  const sessionAny = session as {
    archived_at?: string | null;
    vault_ids?: string[] | null;
    agent_snapshot?: AgentConfig;
  };
  if (sessionAny.archived_at) return null;

  // 3. agent_snapshot must declare the requested mcp server.
  const agent = sessionAny.agent_snapshot;
  if (!agent) return null;
  const server = (agent.mcp_servers ?? []).find((s) => s.name === serverName);
  if (!server || !server.url) return null;

  // 4. Resolve credential. agent.mcp_servers[].authorization_token, if set,
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
        | { mcp_server_url?: string; bearer_token?: string; token?: string }
        | undefined;
      if (auth?.mcp_server_url !== server.url) continue;
      const token = auth?.bearer_token ?? auth?.token;
      if (token) return { upstreamUrl: server.url, upstreamToken: token };
    }
  }
  return null;
}

// Forward both POST and GET for the MCP HTTP transport (depending on which
// upstream protocol — JSON-RPC / SSE / etc. — the server speaks).
app.all("/:sid/:server", async (c) => {
  const sid = c.req.param("sid");
  const serverName = c.req.param("server");
  const auth = c.req.header("authorization") ?? "";
  const apiKey = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  if (!apiKey) return c.json({ error: "missing bearer" }, 401);

  const target = await resolveProxyTarget(c.env, c.get("services"), apiKey, sid, serverName);
  if (!target) return c.json({ error: "forbidden" }, 403);

  // Build the upstream request: clone method + body, replace URL, swap
  // authorization header. Strip any session-/proxy-specific headers so the
  // upstream server only sees what it would have if the agent had called
  // it directly with the real credential.
  const upstreamHeaders = new Headers(c.req.raw.headers);
  upstreamHeaders.set("authorization", `Bearer ${target.upstreamToken}`);
  upstreamHeaders.delete("host");
  upstreamHeaders.delete("cf-connecting-ip");
  upstreamHeaders.delete("cf-ray");
  upstreamHeaders.delete("x-forwarded-for");
  upstreamHeaders.delete("x-forwarded-proto");
  upstreamHeaders.delete("x-real-ip");

  const upstreamReq = new Request(target.upstreamUrl, {
    method: c.req.method,
    headers: upstreamHeaders,
    body: ["GET", "HEAD"].includes(c.req.method) ? undefined : c.req.raw.body,
  });

  // Stream the upstream response back as-is — MCP-over-HTTP clients
  // expect to read the body progressively (SSE / chunked NDJSON).
  return fetch(upstreamReq);
});

export default app;
