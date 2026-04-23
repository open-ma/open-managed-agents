// OAuth helpers for Slack's authorization-code flow (OAuth v2).
//
// Slack v2 OAuth is dual-token: bot scopes go in `scope=`, user scopes in
// `user_scope=`. The token-exchange endpoint returns both tokens in one
// response. We need both: the bot token (`xoxb-`) for receiving Events and
// posting as the bot, the user token (`xoxp-`) for `mcp.slack.com/mcp`.
//
// Pure logic — no storage, no Slack API calls. The provider orchestrates these
// helpers with the Web API client and persistence ports.
//
// Reference: https://docs.slack.dev/authentication/installing-with-oauth/
//            https://docs.slack.dev/reference/methods/oauth.v2.access/

const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
const SLACK_TOKEN_URL = "https://slack.com/api/oauth.v2.access";

export interface BuildAuthorizeUrlInput {
  clientId: string;
  redirectUri: string;
  /** Bot scopes — go in `scope=`. */
  botScopes: ReadonlyArray<string>;
  /** User scopes — go in `user_scope=`. Required for mcp.slack.com. */
  userScopes: ReadonlyArray<string>;
  state: string;
}

export function buildAuthorizeUrl(input: BuildAuthorizeUrlInput): string {
  const params = new URLSearchParams();
  params.set("client_id", input.clientId);
  params.set("redirect_uri", input.redirectUri);
  // Slack accepts comma- or space-separated; comma is canonical.
  params.set("scope", input.botScopes.join(","));
  params.set("user_scope", input.userScopes.join(","));
  params.set("state", input.state);
  return `${SLACK_AUTHORIZE_URL}?${params.toString()}`;
}

export interface ExchangeCodeInput {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
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
  return {
    url: SLACK_TOKEN_URL,
    body: params.toString(),
    contentType: "application/x-www-form-urlencoded",
  };
}

export interface SlackTeamInfo {
  id: string;
  name: string;
}

export interface SlackEnterpriseInfo {
  id: string;
  name: string;
}

export interface SlackAuthedUser {
  id: string;
  /** Granted user scopes (comma-separated). */
  scope: string;
  /** xoxp- user token. */
  access_token: string;
  /** Always "user". */
  token_type: string;
}

export interface SlackTokenResponse {
  /** xoxb- bot token. */
  access_token: string;
  /** Always "bot". */
  token_type: string;
  /** Granted bot scopes (comma-separated). */
  scope: string;
  /** Bot user id (e.g. `U07ABC…`). */
  bot_user_id: string;
  /** Slack App id (e.g. `A07ABC…`). */
  app_id: string;
  team: SlackTeamInfo;
  enterprise: SlackEnterpriseInfo | null;
  authed_user: SlackAuthedUser;
}

/**
 * Parse the JSON body from oauth.v2.access. Throws on `ok: false` (with the
 * Slack-supplied error string surfaced) or any missing required field.
 */
export function parseTokenResponse(body: string): SlackTokenResponse {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  if (parsed.ok !== true) {
    const err = typeof parsed.error === "string" ? parsed.error : "unknown_error";
    throw new Error(`Slack OAuth: token exchange failed: ${err}`);
  }
  if (typeof parsed.access_token !== "string" || !parsed.access_token.startsWith("xoxb-")) {
    throw new Error("Slack OAuth: token response missing/invalid bot access_token");
  }
  if (typeof parsed.bot_user_id !== "string") {
    throw new Error("Slack OAuth: token response missing bot_user_id");
  }
  const team = parsed.team as Record<string, unknown> | undefined;
  if (!team || typeof team.id !== "string" || typeof team.name !== "string") {
    throw new Error("Slack OAuth: token response missing team.{id,name}");
  }
  const authedUser = parsed.authed_user as Record<string, unknown> | undefined;
  if (
    !authedUser ||
    typeof authedUser.id !== "string" ||
    typeof authedUser.access_token !== "string" ||
    !authedUser.access_token.startsWith("xoxp-")
  ) {
    throw new Error(
      "Slack OAuth: token response missing/invalid authed_user.access_token (xoxp-) — " +
        "this means no user scopes were requested or granted; mcp.slack.com requires it",
    );
  }
  const enterprise = parsed.enterprise as Record<string, unknown> | null | undefined;
  return {
    access_token: parsed.access_token,
    token_type: typeof parsed.token_type === "string" ? parsed.token_type : "bot",
    scope: typeof parsed.scope === "string" ? parsed.scope : "",
    bot_user_id: parsed.bot_user_id,
    app_id: typeof parsed.app_id === "string" ? parsed.app_id : "",
    team: { id: team.id, name: team.name },
    enterprise:
      enterprise && typeof enterprise.id === "string" && typeof enterprise.name === "string"
        ? { id: enterprise.id, name: enterprise.name }
        : null,
    authed_user: {
      id: authedUser.id,
      scope: typeof authedUser.scope === "string" ? authedUser.scope : "",
      access_token: authedUser.access_token,
      token_type:
        typeof authedUser.token_type === "string" ? authedUser.token_type : "user",
    },
  };
}
