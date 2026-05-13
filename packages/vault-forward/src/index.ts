// Pure functions for credential resolution + outbound injection.
//
// Three call sites today:
//   - apps/main/src/routes/mcp-proxy.ts (CF MCP proxy + outbound RPC)
//   - apps/main-node /v1/mcp-proxy/* if it ever grows one
//   - apps/oma-vault MITM proxy (self-host outbound for sandbox)
//
// All three share: hostname-match a credential, build the right header,
// and on 401 with mcp_oauth refresh and retry once. Pulling the logic
// here means each caller is ~20 lines of "fetch credentials, call us".

import type { CredentialAuth, CredentialConfig } from "@open-managed-agents/shared";

export interface ResolvedCredential {
  /** Internal id for log correlation; never sent on the wire. */
  credentialId: string;
  vaultId: string;
  /** Auth payload as stored. Refresh metadata extracted by the caller
   *  via {@link refreshMetadataOf}. */
  auth: CredentialAuth;
}

export interface AuthHeader {
  name: string;
  value: string;
}

export interface OauthRefreshMetadata {
  refreshToken: string;
  tokenEndpoint: string;
  clientId?: string;
  clientSecret?: string;
}

/**
 * Build the Authorization (or other) header for a credential. Returns
 * null when the credential isn't header-injectable (e.g. cap_cli in
 * exec_helper mode — its outbound path goes through cap.handleHttp,
 * not a simple header inject).
 */
export function buildAuthHeader(auth: CredentialAuth): AuthHeader | null {
  switch (auth.type) {
    case "static_bearer":
      if (typeof auth.token === "string" && auth.token.length > 0) {
        return { name: "authorization", value: `Bearer ${auth.token}` };
      }
      return null;
    case "cap_cli":
      // Header-mode CLIs (gh, glab, fly) all emit Authorization: Bearer.
      // metadata_ep / exec_helper modes need cap.handleHttp — caller owns
      // detection of those.
      if (typeof auth.token === "string" && auth.token.length > 0) {
        return { name: "authorization", value: `Bearer ${auth.token}` };
      }
      return null;
    case "mcp_oauth": {
      const t = (auth as { access_token?: string; bearer_token?: string; token?: string })
        .access_token ??
        (auth as { bearer_token?: string }).bearer_token ??
        (auth as { token?: string }).token;
      if (typeof t === "string" && t.length > 0) {
        return { name: "authorization", value: `Bearer ${t}` };
      }
      return null;
    }
    default:
      return null;
  }
}

/** Extract refresh metadata from an mcp_oauth credential. Returns null
 *  for any other type, or when the refresh fields are absent. */
export function refreshMetadataOf(auth: CredentialAuth): OauthRefreshMetadata | null {
  if (auth.type !== "mcp_oauth") return null;
  const a = auth as {
    refresh_token?: string;
    token_endpoint?: string;
    client_id?: string;
    client_secret?: string;
  };
  if (!a.refresh_token || !a.token_endpoint) return null;
  return {
    refreshToken: a.refresh_token,
    tokenEndpoint: a.token_endpoint,
    clientId: a.client_id,
    clientSecret: a.client_secret,
  };
}

/**
 * Find the active credential whose mcp_server_url host matches `host`.
 * Hostname-only match — caller may also pass a path-aware preselector for
 * cap_cli (registry.byHostname) by handing in a pre-filtered grouped list.
 *
 * `groupedCredentials` is the shape services.credentials.listByVaults
 * returns: [{ vault_id, credentials: [...] }, ...]. Pass an empty array
 * when no vaults are bound (we return null without iterating).
 */
export function pickCredentialByHost(
  groupedCredentials: Array<{
    vault_id: string;
    credentials: Array<{ id: string; auth: CredentialAuth | unknown }>;
  }>,
  host: string,
): ResolvedCredential | null {
  for (const g of groupedCredentials) {
    for (const c of g.credentials) {
      const auth = c.auth as CredentialAuth | undefined;
      const url = (auth as { mcp_server_url?: string } | undefined)?.mcp_server_url;
      if (!url) continue;
      let credHost: string;
      try {
        credHost = new URL(url).host;
      } catch {
        continue;
      }
      if (credHost !== host) continue;
      return { credentialId: c.id, vaultId: g.vault_id, auth: auth as CredentialAuth };
    }
  }
  return null;
}

/**
 * POST refresh_token to the token_endpoint, return the new tokens.
 * Pure: no DB writes, no logging. Caller persists the rotated value
 * (services.credentials.refreshAuth or equivalent) and decides whether
 * to retry the upstream request.
 */
export interface RefreshedTokens {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

export async function refreshMcpOAuth(
  meta: OauthRefreshMetadata,
  fetcher: typeof fetch = fetch,
): Promise<RefreshedTokens | null> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: meta.refreshToken,
    client_id: meta.clientId || "open-managed-agents",
  });
  if (meta.clientSecret) body.set("client_secret", meta.clientSecret);

  let res: Response;
  try {
    res = await fetcher(meta.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
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
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? meta.refreshToken,
    expires_in: tokens.expires_in,
  };
}

/**
 * Forward a request to upstream with auth injection, refresh on 401 once
 * if the credential supports it. Pluggable transport (`fetcher`) so CF
 * can pass a service-binding-backed fetch and Node can pass globalThis.fetch.
 *
 * `body` MUST be pre-buffered (string | ArrayBuffer | null) so we can
 * replay it on the retry. CF's MCP proxy already pre-buffers via
 * c.req.text(); the oma-vault proxy already has the raw bytes in
 * memory from mockttp's CompletedRequest.
 */
export interface ForwardOpts {
  upstreamUrl: string;
  method: string;
  inboundHeaders: Headers;
  body: string | ArrayBuffer | Uint8Array | null;
  /** Active access token from the credential (or `auth.token`). Used as
   *  the first attempt. */
  accessToken: string;
  /** When set, a 401 triggers refresh + retry once. Caller persists the
   *  rotated tokens via `onRefreshed`. */
  refresh?: OauthRefreshMetadata;
  /** Called after a successful refresh so the runtime can persist the
   *  new tokens (re-encrypted) back to the canonical credential row. */
  onRefreshed?: (t: RefreshedTokens) => Promise<void>;
  /** Pluggable transport. Defaults to globalThis.fetch. */
  fetcher?: typeof fetch;
  /** Headers to scrub from the upstream request. Default: edge-injected
   *  CF headers + host (caller may want to override on Node). */
  scrubHeaders?: string[];
}

const DEFAULT_SCRUB = [
  "host",
  "cf-connecting-ip",
  "cf-ray",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
];

function buildUpstreamHeaders(
  inbound: Headers,
  bearer: string,
  scrub: string[],
): Headers {
  const out = new Headers(inbound);
  out.set("authorization", `Bearer ${bearer}`);
  for (const h of scrub) out.delete(h);
  return out;
}

export async function forwardWithRefresh(opts: ForwardOpts): Promise<Response> {
  const fetcher = opts.fetcher ?? fetch;
  const scrub = opts.scrubHeaders ?? DEFAULT_SCRUB;

  const send = async (token: string): Promise<Response> => {
    const headers = buildUpstreamHeaders(opts.inboundHeaders, token, scrub);
    const isGetHead = ["GET", "HEAD"].includes(opts.method.toUpperCase());
    const init: RequestInit = {
      method: opts.method,
      headers,
      body: isGetHead ? undefined : (opts.body as BodyInit | null | undefined),
    };
    return fetcher(opts.upstreamUrl, init);
  };

  const first = await send(opts.accessToken);
  if (first.status !== 401 || !opts.refresh) return first;

  // Drain the body so we can return a fresh Response without two
  // outstanding streams.
  try {
    await first.body?.cancel();
  } catch {
    /* already consumed / closed */
  }

  const refreshed = await refreshMcpOAuth(opts.refresh, fetcher);
  if (!refreshed) {
    // Refresh failed — re-issue with the original token to surface the
    // upstream's actual 401 (matches old apps/main behavior).
    return send(opts.accessToken);
  }
  if (opts.onRefreshed) {
    try {
      await opts.onRefreshed(refreshed);
    } catch {
      // Best-effort; caller has the new token regardless.
    }
  }
  return send(refreshed.access_token);
}

// Re-export the credentials-store's CredentialConfig for convenience —
// callers usually have it from services.credentials.listByVaults.
export type { CredentialConfig };
