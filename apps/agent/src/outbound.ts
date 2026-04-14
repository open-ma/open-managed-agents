import type { Env } from "@open-managed-agents/shared";

/**
 * Outbound Worker — intercepts HTTP requests from the Sandbox container.
 * Used for credential injection: vault credentials are transparently added
 * to requests going to MCP server endpoints.
 *
 * This is the Cloudflare Containers Outbound Worker pattern (C.5 in reference.md).
 * Container-internal HTTP → Outbound Worker → credential injection → external service.
 */

/**
 * Determine if a request to this host should be intercepted.
 * Returns "outbound" to intercept, null to pass through.
 */
export async function outboundByHost(
  host: string,
  env: Env,
  sessionId?: string
): Promise<string | null> {
  if (!sessionId) return null;

  // Check if this host matches any MCP server URL configured for the session's agent
  // For now, intercept all HTTPS requests to inject credentials if available
  const hasCredential = await findCredentialForHost(env, sessionId, host);
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
  if (!sessionId) return fetch(request);

  const url = new URL(request.url);
  const credential = await findCredentialForHost(env, sessionId, url.hostname);

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
      const refreshed = await tryRefreshToken(env, credential.vault_id, credential.credential_id);
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
 * Attempt to refresh an OAuth token via the main worker's refresh endpoint.
 * Returns the new access_token on success, null on failure.
 */
async function tryRefreshToken(
  env: Env,
  vaultId: string,
  credentialId: string,
): Promise<string | null> {
  try {
    // Call the main worker's refresh endpoint via service binding
    // The main worker is accessible via internal service binding
    const credKey = `cred:${vaultId}:${credentialId}`;
    const credData = await env.CONFIG_KV.get(credKey);
    if (!credData) return null;

    const cred = JSON.parse(credData);
    const auth = cred.auth;
    if (!auth?.refresh_token || !auth?.token_endpoint) return null;

    // Direct token refresh (we have KV access, no need for HTTP call)
    const tokenBody = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: auth.refresh_token,
      client_id: auth.client_id || "open-managed-agents",
    });
    if (auth.client_secret) {
      tokenBody.set("client_secret", auth.client_secret);
    }

    const tokenRes = await fetch(auth.token_endpoint, {
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

    // Update credential in KV
    auth.access_token = tokens.access_token;
    if (tokens.refresh_token) auth.refresh_token = tokens.refresh_token;
    auth.expires_at = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : undefined;
    cred.updated_at = new Date().toISOString();

    await env.CONFIG_KV.put(credKey, JSON.stringify(cred));

    return tokens.access_token;
  } catch {
    return null;
  }
}

/**
 * Look up a credential for a given hostname from the session's linked vaults.
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
    // Get session to find vault_ids
    const sessionData = await env.CONFIG_KV.get(`session:${sessionId}`);
    if (!sessionData) return null;

    const session = JSON.parse(sessionData);
    const vaultIds: string[] = session.vault_ids || [];
    if (!vaultIds.length) return null;

    // Search each vault's credentials for a matching mcp_server_url
    for (const vaultId of vaultIds) {
      const credList = await env.CONFIG_KV.list({ prefix: `cred:${vaultId}:` });
      for (const key of credList.keys) {
        const credData = await env.CONFIG_KV.get(key.name);
        if (!credData) continue;

        const cred = JSON.parse(credData);
        if (!cred.auth?.mcp_server_url) continue;

        // Check if the credential's MCP server URL matches the request hostname
        try {
          const credUrl = new URL(cred.auth.mcp_server_url);
          if (credUrl.hostname === hostname) {
            return {
              type: cred.auth.type,
              token: cred.auth.token,
              access_token: cred.auth.access_token,
              credential_id: cred.id,
              vault_id: vaultId,
            };
          }
        } catch {
          // Invalid URL in credential, skip
        }
      }
    }
  } catch {
    // Credential lookup failed, pass through without injection
  }

  return null;
}
