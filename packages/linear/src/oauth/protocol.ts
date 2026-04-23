// OAuth helpers for Linear's authorization-code flow.
//
// Pure logic — no storage, no Linear API calls. Builds URLs and parses
// payloads. The provider orchestrates these helpers with the GraphQL client
// and persistence ports.

const LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";

export interface BuildAuthorizeUrlInput {
  clientId: string;
  redirectUri: string;
  scopes: ReadonlyArray<string>;
  state: string;
  /** Linear's actor parameter; "app" makes the install grant `actor=app`. */
  actor?: "app" | "user";
}

export function buildAuthorizeUrl(input: BuildAuthorizeUrlInput): string {
  const params = new URLSearchParams();
  params.set("client_id", input.clientId);
  params.set("redirect_uri", input.redirectUri);
  params.set("response_type", "code");
  params.set("scope", input.scopes.join(","));
  params.set("state", input.state);
  if (input.actor) params.set("actor", input.actor);
  // Linear ignores `prompt=consent` but defaults to consent on first install.
  return `${LINEAR_AUTHORIZE_URL}?${params.toString()}`;
}

export interface ExchangeCodeInput {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  /**
   * Linear's authorization-code flow returns a refresh_token alongside the
   * 24-hour access_token. We persist it (encrypted) so the gateway can refresh
   * silently when Linear returns 401 instead of forcing a reinstall.
   */
  refresh_token: string | null;
}

/** Build the token-exchange request body. POSTed by the caller. */
export function buildTokenExchangeBody(input: ExchangeCodeInput): {
  url: string;
  body: string;
  contentType: string;
} {
  const params = new URLSearchParams();
  params.set("code", input.code);
  params.set("redirect_uri", input.redirectUri);
  params.set("client_id", input.clientId);
  params.set("client_secret", input.clientSecret);
  params.set("grant_type", "authorization_code");
  return {
    url: LINEAR_TOKEN_URL,
    body: params.toString(),
    contentType: "application/x-www-form-urlencoded",
  };
}

export interface RefreshTokenInput {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}

/** Build the refresh-token request body for Linear's `/oauth/token`. Same
 *  endpoint as the initial code exchange; only the grant_type + payload
 *  differ. Linear rotates refresh_token on each call, so the parsed response
 *  must be persisted in full. */
export function buildRefreshTokenBody(input: RefreshTokenInput): {
  url: string;
  body: string;
  contentType: string;
} {
  const params = new URLSearchParams();
  params.set("grant_type", "refresh_token");
  params.set("refresh_token", input.refreshToken);
  params.set("client_id", input.clientId);
  params.set("client_secret", input.clientSecret);
  return {
    url: LINEAR_TOKEN_URL,
    body: params.toString(),
    contentType: "application/x-www-form-urlencoded",
  };
}

export function parseTokenResponse(body: string): TokenResponse {
  const parsed = JSON.parse(body) as Partial<TokenResponse>;
  if (!parsed.access_token || typeof parsed.access_token !== "string") {
    throw new Error("Linear OAuth: token response missing access_token");
  }
  return {
    access_token: parsed.access_token,
    token_type: parsed.token_type ?? "Bearer",
    expires_in: parsed.expires_in ?? 0,
    scope: parsed.scope ?? "",
    refresh_token:
      typeof parsed.refresh_token === "string" && parsed.refresh_token.length > 0
        ? parsed.refresh_token
        : null,
  };
}
