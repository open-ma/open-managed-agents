import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import { logWarn } from "@open-managed-agents/shared";
import type { CredentialAuth } from "@open-managed-agents/shared";
import type { Services } from "@open-managed-agents/services";

const app = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; services: Services };
}>();

// ─── Helpers ───

/** Generate a cryptographically random string for PKCE and state. */
function randomString(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, length);
}

/** SHA-256 hash as base64url (for PKCE S256). */
async function sha256Base64url(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  const bytes = new Uint8Array(hash);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Derive the base URL for this worker from the request. */
function getBaseUrl(c: { req: { url: string } }): string {
  const url = new URL(c.req.url);
  return `${url.protocol}//${url.host}`;
}

// ─── MCP OAuth Metadata Discovery ───

interface ProtectedResourceMeta {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
}

interface AuthServerMeta {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
}

/**
 * Discover OAuth metadata for an MCP server.
 * Follows the MCP spec: fetch Protected Resource Metadata → fetch Auth Server Metadata.
 */
async function discoverOAuthMeta(mcpServerUrl: string): Promise<{
  resource: ProtectedResourceMeta;
  authServer: AuthServerMeta;
}> {
  const url = new URL(mcpServerUrl);
  const origin = url.origin;

  // Step 1: Protected Resource Metadata
  const prmUrl = `${origin}/.well-known/oauth-protected-resource`;
  const prmRes = await fetch(prmUrl);
  if (!prmRes.ok) {
    throw new Error(`Failed to fetch Protected Resource Metadata from ${prmUrl}: ${prmRes.status}`);
  }
  const resource = (await prmRes.json()) as ProtectedResourceMeta;

  if (!resource.authorization_servers?.length) {
    throw new Error("No authorization_servers in Protected Resource Metadata");
  }

  // Step 2: Auth Server Metadata
  const authServerUrl = resource.authorization_servers[0];
  const asmUrl = `${authServerUrl}/.well-known/oauth-authorization-server`;
  const asmRes = await fetch(asmUrl);
  if (!asmRes.ok) {
    throw new Error(`Failed to fetch Auth Server Metadata from ${asmUrl}: ${asmRes.status}`);
  }
  const authServer = (await asmRes.json()) as AuthServerMeta;

  if (!authServer.authorization_endpoint || !authServer.token_endpoint) {
    throw new Error("Auth Server Metadata missing authorization_endpoint or token_endpoint");
  }

  return { resource, authServer };
}

/**
 * Attempt Dynamic Client Registration if the auth server supports it.
 */
async function dynamicClientRegistration(
  registrationEndpoint: string,
  redirectUri: string,
  mcpServerUrl: string,
): Promise<{ client_id: string; client_secret?: string } | null> {
  try {
    const res = await fetch(registrationEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Open Managed Agents",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none", // public client
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { client_id: string; client_secret?: string };
    return { client_id: data.client_id, client_secret: data.client_secret };
  } catch (err) {
    // Dynamic Client Registration is best-effort — caller falls back to a
    // pre-registered client_id. But persistent failures here block per-server
    // OAuth onboarding entirely, so we want visibility.
    logWarn(
      { op: "oauth.dcr_register", err },
      "OAuth DCR register failed; caller will fall back",
    );
    return null;
  }
}

// ─── OAuth State (stored in KV, TTL 10 minutes) ───

interface OAuthState {
  tenant_id: string;
  vault_id: string;
  credential_id?: string;
  mcp_server_url: string;
  code_verifier: string;
  client_id: string;
  client_secret?: string;
  token_endpoint: string;
  authorization_server: string;
  redirect_uri: string;
  resource_uri: string;
}

// ─── Routes ───

/**
 * GET /v1/oauth/authorize
 *
 * Starts the MCP OAuth 2.1 flow. Discovers OAuth endpoints from the
 * MCP server's .well-known metadata, then redirects to the authorization page.
 *
 * Query params:
 *   - mcp_server_url (required): The MCP server URL to authorize with
 *   - vault_id (required): Vault to store the credential in
 *   - credential_id (optional): Update existing credential instead of creating new
 *   - redirect_uri (optional): Where to redirect after auth (defaults to console)
 */
app.get("/authorize", async (c) => {
  const mcpServerUrl = c.req.query("mcp_server_url");
  const vaultId = c.req.query("vault_id");
  const credentialId = c.req.query("credential_id");
  const clientRedirectUri = c.req.query("redirect_uri");

  if (!mcpServerUrl || !vaultId) {
    return c.json({ error: "mcp_server_url and vault_id are required" }, 400);
  }

  // Verify vault exists. Vaults live in D1 (vaults-store) since the
  // KV → D1 migration; this route was missed in that sweep — every
  // OAuth flow returned 404 "Vault not found" because KV was always
  // empty. Read via the service like every other route does.
  const t = c.get("tenant_id");
  const vault = await c.var.services.vaults.get({ tenantId: t, vaultId });
  if (!vault) {
    return c.json({ error: "Vault not found" }, 404);
  }

  const baseUrl = getBaseUrl(c);
  const callbackUri = `${baseUrl}/v1/oauth/callback`;

  // Discover OAuth metadata from the MCP server
  let meta: Awaited<ReturnType<typeof discoverOAuthMeta>>;
  try {
    meta = await discoverOAuthMeta(mcpServerUrl);
  } catch (err) {
    return c.json({ error: `OAuth discovery failed: ${(err as Error).message}` }, 502);
  }

  // Dynamic Client Registration if supported
  let clientId = "open-managed-agents";
  let clientSecret: string | undefined;
  if (meta.authServer.registration_endpoint) {
    const reg = await dynamicClientRegistration(
      meta.authServer.registration_endpoint,
      callbackUri,
      mcpServerUrl,
    );
    if (reg) {
      clientId = reg.client_id;
      clientSecret = reg.client_secret;
    }
  }

  // Generate PKCE pair
  const codeVerifier = randomString(64);
  const codeChallenge = await sha256Base64url(codeVerifier);

  // Generate state
  const state = randomString(32);

  // Store state in KV (10 minute TTL)
  const oauthState: OAuthState = {
    tenant_id: t,
    vault_id: vaultId,
    credential_id: credentialId,
    mcp_server_url: mcpServerUrl,
    code_verifier: codeVerifier,
    client_id: clientId,
    client_secret: clientSecret,
    token_endpoint: meta.authServer.token_endpoint,
    authorization_server: meta.authServer.issuer,
    redirect_uri: clientRedirectUri || `${baseUrl}/`,
    resource_uri: meta.resource.resource,
  };

  await c.var.services.kv.put(
    `oauth_state:${state}`,
    JSON.stringify(oauthState),
    { expirationTtl: 600 },
  );

  // Build authorization URL
  const authUrl = new URL(meta.authServer.authorization_endpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", callbackUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("resource", meta.resource.resource);
  if (meta.resource.scopes_supported?.length) {
    authUrl.searchParams.set("scope", meta.resource.scopes_supported.join(" "));
  }

  return c.redirect(authUrl.toString());
});

/**
 * GET /v1/oauth/callback
 *
 * OAuth callback handler. Exchanges authorization code for tokens,
 * creates/updates credential in vault, redirects user back to console.
 */
app.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");

  if (error) {
    const desc = c.req.query("error_description") || error;
    return c.html(`<html><body><h2>Authorization failed</h2><p>${desc}</p><script>window.close()</script></body></html>`, 400);
  }

  if (!code || !state) {
    return c.json({ error: "code and state are required" }, 400);
  }

  // Look up state
  const stateKey = `oauth_state:${state}`;
  const stateData = await c.var.services.kv.get(stateKey);
  if (!stateData) {
    return c.json({ error: "Invalid or expired OAuth state" }, 400);
  }

  const oauthState: OAuthState = JSON.parse(stateData);

  // Exchange code for tokens
  const baseUrl = getBaseUrl(c);
  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: `${baseUrl}/v1/oauth/callback`,
    client_id: oauthState.client_id,
    code_verifier: oauthState.code_verifier,
    resource: oauthState.resource_uri,
  });
  if (oauthState.client_secret) {
    tokenBody.set("client_secret", oauthState.client_secret);
  }

  const tokenRes = await fetch(oauthState.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenBody.toString(),
  });

  if (!tokenRes.ok) {
    const errBody = await tokenRes.text();
    await c.var.services.kv.delete(stateKey);
    return c.html(`<html><body><h2>Token exchange failed</h2><p>${errBody}</p><script>window.close()</script></body></html>`, 502);
  }

  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
  };

  // Calculate expiry
  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : undefined;

  // Derive display name from URL
  const mcpHost = new URL(oauthState.mcp_server_url).hostname;
  const serverName = mcpHost.replace(/^mcp\./, "").replace(/\.(com|app|dev|io)$/, "");

  // Create or update credential
  const credAuth: CredentialAuth = {
    type: "mcp_oauth",
    mcp_server_url: oauthState.mcp_server_url,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_endpoint: oauthState.token_endpoint,
    client_id: oauthState.client_id,
    client_secret: oauthState.client_secret,
    expires_at: expiresAt,
    authorization_server: oauthState.authorization_server,
  };

  if (oauthState.credential_id) {
    // Update existing credential — refresh on a known credential row. If the
    // row vanished mid-flow (race with delete/archive), swallow: the OAuth
    // dance still completes for UX and the operator can retry attaching.
    await c.var.services.credentials
      .update({
        tenantId: oauthState.tenant_id,
        vaultId: oauthState.vault_id,
        credentialId: oauthState.credential_id,
        auth: credAuth,
      })
      .catch(() => {
        /* not found — leave it; user can re-initiate */
      });
  } else {
    // Create new credential
    await c.var.services.credentials.create({
      tenantId: oauthState.tenant_id,
      vaultId: oauthState.vault_id,
      displayName: `${serverName} (OAuth)`,
      auth: credAuth,
    });
  }

  // Clean up state
  await c.var.services.kv.delete(stateKey);

  // Redirect back to console
  const redirectUrl = new URL(oauthState.redirect_uri);
  redirectUrl.searchParams.set("oauth", "success");
  redirectUrl.searchParams.set("service", serverName);

  // If opened in a popup, close it and notify parent
  return c.html(`
    <html><body>
    <p>Connected to ${serverName}. Redirecting...</p>
    <script>
      if (window.opener) {
        window.opener.postMessage({ type: "oauth_complete", service: "${serverName}", vault_id: "${oauthState.vault_id}" }, "*");
        window.close();
      } else {
        window.location.href = "${redirectUrl.toString()}";
      }
    </script>
    </body></html>
  `);
});

/**
 * POST /v1/oauth/refresh
 *
 * Refresh an OAuth token. Called by the outbound worker when a 401 is received.
 * Body: { vault_id, credential_id }
 * Returns: { access_token, expires_at }
 */
app.post("/refresh", async (c) => {
  const body = await c.req.json<{ vault_id: string; credential_id: string }>();

  if (!body.vault_id || !body.credential_id) {
    return c.json({ error: "vault_id and credential_id are required" }, 400);
  }

  const t = c.get("tenant_id");
  const service = c.var.services.credentials;
  const cred = await service.get({
    tenantId: t,
    vaultId: body.vault_id,
    credentialId: body.credential_id,
  });
  if (!cred) {
    return c.json({ error: "Credential not found" }, 404);
  }

  if (cred.auth.type !== "mcp_oauth") {
    return c.json({ error: "Credential is not mcp_oauth type" }, 400);
  }

  if (!cred.auth.refresh_token || !cred.auth.token_endpoint) {
    return c.json({ error: "No refresh_token or token_endpoint" }, 400);
  }

  // Refresh the token
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

  if (!tokenRes.ok) {
    return c.json({ error: "Token refresh failed", status: tokenRes.status }, 502);
  }

  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : undefined;

  // Merge-update: refreshAuth keeps mcp_server_url, token_endpoint, client_id, etc.
  await service.refreshAuth({
    tenantId: t,
    vaultId: body.vault_id,
    credentialId: body.credential_id,
    auth: {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? cred.auth.refresh_token,
      expires_at: expiresAt,
    },
  });

  return c.json({
    access_token: tokens.access_token,
    expires_at: expiresAt,
  });
});

export default app;
