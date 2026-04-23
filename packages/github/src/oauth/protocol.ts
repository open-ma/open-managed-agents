// GitHub App OAuth + token-exchange helpers.
//
// Pure logic — no storage, no HTTP. Builds URLs and JWT payloads; mints the
// short-lived App JWT used to call GitHub's `/app/*` endpoints; constructs the
// request that exchanges that JWT for an installation token.
//
// GitHub Apps differ from Linear's OAuth-app model:
//   1. App identity is asserted via an RS256 JWT signed with the App's private
//      key (PEM, RSA, downloaded once at registration).
//   2. Each org install gets a numeric `installation_id`. To act on behalf of
//      that install, exchange the App JWT for a 1-hour `installation_token`.
//   3. Webhook signatures use HMAC-SHA-256 with a user-chosen secret (not
//      auto-generated like Linear's `lin_wh_…`).

const GITHUB_API = "https://api.github.com";

export interface BuildInstallUrlInput {
  /** Public URL slug of the App (from `GET /app` after the user creates it). */
  appSlug: string;
  /** Opaque state we'll receive back at the setup URL after install. */
  state: string;
}

/**
 * URL the publisher (or workspace admin) opens to install the GitHub App on
 * their org. After clicking through, GitHub redirects to the App's setup URL
 * (which we pre-set to our gateway's callback) carrying `installation_id`.
 */
export function buildInstallUrl(input: BuildInstallUrlInput): string {
  const params = new URLSearchParams();
  params.set("state", input.state);
  return `https://github.com/apps/${encodeURIComponent(input.appSlug)}/installations/new?${params.toString()}`;
}

export interface AppJwtClaims {
  /** App's numeric ID (`iss` claim per GitHub spec). */
  appId: string;
  /** Unix seconds. Defaults to `now()`. */
  iat?: number;
  /** TTL seconds (max 600 per GitHub limit). Defaults to 540 (9 min). */
  ttlSeconds?: number;
}

/**
 * Sign a JWT (RS256) with the App's PEM private key for use against
 * `Authorization: Bearer <jwt>` on the `/app/*` endpoints.
 *
 * GitHub clamps the App JWT lifetime to 10 minutes — we default to 9 minutes
 * to leave a 60s buffer for clock skew.
 */
export async function mintAppJwt(
  privateKeyPem: string,
  claims: AppJwtClaims,
): Promise<string> {
  const now = claims.iat ?? Math.floor(Date.now() / 1000);
  const ttl = Math.min(claims.ttlSeconds ?? 540, 600);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 30, // GitHub's clock can run behind ours; back-date 30s.
    exp: now + ttl,
    iss: claims.appId,
  };

  const enc = new TextEncoder();
  const headerB64 = base64UrlEncode(enc.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(enc.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    enc.encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(sig))}`;
}

export interface InstallationTokenExchangeRequest {
  url: string;
  headers: Record<string, string>;
  /** No body — POST with empty body. */
  body: string;
}

/**
 * Build the request that exchanges an App JWT for an installation access token.
 * Caller POSTs this and parses the response with `parseInstallationTokenResponse`.
 */
export function buildInstallationTokenRequest(
  appJwt: string,
  installationId: string,
): InstallationTokenExchangeRequest {
  return {
    url: `${GITHUB_API}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    headers: {
      authorization: `Bearer ${appJwt}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "open-managed-agents",
    },
    body: "",
  };
}

export interface InstallationTokenResponse {
  token: string;
  /** ISO-8601 UTC. ~1 hour after issue. */
  expiresAt: string;
  /** Permissions granted on the install (subset; we re-check at call time). */
  permissions: Record<string, string>;
  /** Repository selection at install time: "all" or "selected". */
  repositorySelection: "all" | "selected";
}

export function parseInstallationTokenResponse(
  body: string,
): InstallationTokenResponse {
  const parsed = JSON.parse(body) as Partial<{
    token: string;
    expires_at: string;
    permissions: Record<string, string>;
    repository_selection: "all" | "selected";
  }>;
  if (!parsed.token || typeof parsed.token !== "string") {
    throw new Error(`GitHub installation token: missing token in response: ${body.slice(0, 200)}`);
  }
  if (!parsed.expires_at) {
    throw new Error("GitHub installation token: missing expires_at");
  }
  return {
    token: parsed.token,
    expiresAt: parsed.expires_at,
    permissions: parsed.permissions ?? {},
    repositorySelection: parsed.repository_selection ?? "selected",
  };
}

// ─── PEM ↔ ArrayBuffer helpers ────────────────────────────────────────

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const cleaned = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(cleaned);
  const buf = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i += 1) view[i] = bin.charCodeAt(i);
  return buf;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
