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

    return fetch(new Request(request, { headers }));
  }

  return fetch(request);
}

/**
 * Look up a credential for a given hostname from the session's linked vaults.
 */
async function findCredentialForHost(
  env: Env,
  sessionId: string,
  hostname: string
): Promise<{ type: string; token?: string; access_token?: string } | null> {
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
