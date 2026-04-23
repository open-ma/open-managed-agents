import type { Env } from "@open-managed-agents/shared";
import { buildCfServices } from "@open-managed-agents/services";

/**
 * Outbound Worker — intercepts HTTP requests from the Sandbox container.
 * Used for credential injection: vault credentials are transparently added
 * to requests going to MCP server endpoints.
 *
 * This is the Cloudflare Containers Outbound Worker pattern (C.5 in reference.md).
 * Container-internal HTTP → Outbound Worker → credential injection → external service.
 *
 * The outbound worker only knows sessionId from container context — not tenantId.
 * SessionDO publishes a snapshot to the untenanted key `outbound:{sessionId}` at
 * /init time, so we read that here instead of reconstructing tenant-prefixed
 * `t:{tenantId}:cred:...` keys.
 */

interface OutboundSnapshot {
  tenant_id: string;
  vault_ids: string[];
  vault_credentials: Array<{
    vault_id: string;
    credentials: Array<{
      id: string;
      auth?: {
        type: string;
        mcp_server_url?: string;
        token?: string;
        access_token?: string;
        refresh_token?: string;
        token_endpoint?: string;
        client_id?: string;
        client_secret?: string;
        expires_at?: string;
      };
    }>;
  }>;
}

/**
 * Determine if a request to this host should be intercepted.
 * Returns "outbound" to intercept, null to pass through.
 */
export async function outboundByHost(
  host: string,
  env: Env,
  sessionId?: string
): Promise<string | null> {
  console.log(`[outbound] outboundByHost host=${host} session=${sessionId ?? "?"}`);
  if (!sessionId) return null;
  const hasCredential = await findCredentialForHost(env, sessionId, host);
  console.log(`[outbound] outboundByHost host=${host} hasCred=${!!hasCredential}`);
  if (hasCredential) return "outbound";
  return null;
}

/**
 * Intercept and modify outbound requests from the container.
 * Injects vault credentials (OAuth tokens, bearer tokens) for MCP servers.
 * On 401 from mcp_oauth credentials, attempts token refresh and retries.
 */
export async function outbound(
  request: Request,
  env: Env,
  sessionId?: string
): Promise<Response> {
  const url = new URL(request.url);
  console.log(`[outbound] outbound url=${url.href} session=${sessionId ?? "?"}`);
  if (!sessionId) return fetch(request);

  const credential = await findCredentialForHost(env, sessionId, url.hostname);
  console.log(`[outbound] cred for ${url.hostname}: ${credential ? credential.type : "none"}`);

  if (credential) {
    const headers = new Headers(request.headers);

    if (credential.type === "static_bearer" && credential.token) {
      headers.set("Authorization", `Bearer ${credential.token}`);
    } else if (credential.type === "mcp_oauth" && credential.access_token) {
      headers.set("Authorization", `Bearer ${credential.access_token}`);
    }

    const response = await fetch(new Request(request, { headers }));

    // Token refresh: if mcp_oauth and got 401, try refreshing
    if (response.status === 401 && credential.type === "mcp_oauth" && credential.credential_id) {
      const refreshed = await tryRefreshToken(env, sessionId, credential.vault_id, credential.credential_id);
      if (refreshed) {
        const retryHeaders = new Headers(request.headers);
        retryHeaders.set("Authorization", `Bearer ${refreshed}`);
        return fetch(new Request(request, { headers: retryHeaders }));
      }
    }

    return response;
  }

  return fetch(request);
}

/**
 * Look up a credential for a given hostname from the session's snapshot.
 */
async function findCredentialForHost(
  env: Env,
  sessionId: string,
  hostname: string
): Promise<{
  type: string;
  token?: string;
  access_token?: string;
  credential_id?: string;
  vault_id: string;
} | null> {
  try {
    const snapshot = await loadSnapshot(env, sessionId);
    if (!snapshot) return null;

    for (const v of snapshot.vault_credentials) {
      for (const cred of v.credentials) {
        if (!cred.auth?.mcp_server_url) continue;
        try {
          const credUrl = new URL(cred.auth.mcp_server_url);
          if (credUrl.hostname === hostname) {
            return {
              type: cred.auth.type,
              token: cred.auth.token,
              access_token: cred.auth.access_token,
              credential_id: cred.id,
              vault_id: v.vault_id,
            };
          }
        } catch {
          // Invalid URL in credential, skip
        }
      }
    }
  } catch {
    // Snapshot missing or malformed → pass through without injection
  }

  return null;
}

async function loadSnapshot(env: Env, sessionId: string): Promise<OutboundSnapshot | null> {
  const data = await env.CONFIG_KV.get(`outbound:${sessionId}`);
  if (!data) return null;
  try {
    return JSON.parse(data) as OutboundSnapshot;
  } catch {
    return null;
  }
}

/**
 * Refresh an mcp_oauth token via the credential's token endpoint.
 * Updates both the tenant-prefixed cred record and the untenanted outbound
 * snapshot so subsequent requests in this session see the new token.
 * Returns the new access_token on success, null on failure.
 */
async function tryRefreshToken(
  env: Env,
  sessionId: string,
  vaultId: string,
  credentialId: string,
): Promise<string | null> {
  try {
    const snapshot = await loadSnapshot(env, sessionId);
    if (!snapshot) return null;

    const vault = snapshot.vault_credentials.find((v) => v.vault_id === vaultId);
    const cred = vault?.credentials.find((c) => c.id === credentialId);
    if (!cred?.auth?.refresh_token || !cred.auth.token_endpoint) return null;

    const tokenBody = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: cred.auth.refresh_token,
      client_id: cred.auth.client_id || "open-managed-agents",
    });
    if (cred.auth.client_secret) {
      tokenBody.set("client_secret", cred.auth.client_secret);
    }

    const tokenRes = await fetch(cred.auth.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
    if (!tokenRes.ok) return null;

    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    // Update the snapshot in-place and persist back so the next request in
    // this session uses the fresh token without another refresh.
    cred.auth.access_token = tokens.access_token;
    if (tokens.refresh_token) cred.auth.refresh_token = tokens.refresh_token;
    cred.auth.expires_at = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : undefined;
    await env.CONFIG_KV.put(`outbound:${sessionId}`, JSON.stringify(snapshot));

    // Best-effort: also update the canonical D1 row so future sessions
    // inherit the refreshed token. The snapshot remains the source of truth
    // for this session — if the D1 write fails the session still gets the
    // fresh token, just future sessions may take one extra refresh.
    if (snapshot.tenant_id && env.AUTH_DB) {
      try {
        await buildCfServices(env).credentials.refreshAuth({
          tenantId: snapshot.tenant_id,
          vaultId,
          credentialId,
          auth: {
            access_token: cred.auth.access_token,
            refresh_token: cred.auth.refresh_token,
            expires_at: cred.auth.expires_at,
          },
        });
      } catch {
        // best-effort: snapshot is the source of truth this session anyway
      }
    }

    return tokens.access_token;
  } catch {
    return null;
  }
}
