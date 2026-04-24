import { describe, it, expect } from "vitest";
import {
  buildAuthorizeUrl,
  buildTokenExchangeBody,
  parseTokenResponse,
} from "../../packages/slack/src/oauth/protocol";

describe("Slack OAuth protocol helpers", () => {
  describe("buildAuthorizeUrl", () => {
    it("constructs URL with bot scopes in scope= and user scopes in user_scope=", () => {
      const url = buildAuthorizeUrl({
        clientId: "abc123",
        redirectUri: "https://gw.example/slack/oauth/app/app_1/callback",
        botScopes: ["app_mentions:read", "chat:write"],
        userScopes: ["search:read.public", "channels:history"],
        state: "state_jwt",
      });
      const parsed = new URL(url);
      expect(parsed.origin + parsed.pathname).toBe("https://slack.com/oauth/v2/authorize");
      expect(parsed.searchParams.get("client_id")).toBe("abc123");
      expect(parsed.searchParams.get("redirect_uri")).toBe(
        "https://gw.example/slack/oauth/app/app_1/callback",
      );
      expect(parsed.searchParams.get("scope")).toBe("app_mentions:read,chat:write");
      expect(parsed.searchParams.get("user_scope")).toBe("search:read.public,channels:history");
      expect(parsed.searchParams.get("state")).toBe("state_jwt");
    });
  });

  describe("buildTokenExchangeBody", () => {
    it("uses correct token endpoint and form body (no grant_type — Slack ignores it)", () => {
      const req = buildTokenExchangeBody({
        code: "AUTH_CODE",
        redirectUri: "https://gw/cb",
        clientId: "cid",
        clientSecret: "csecret",
      });
      expect(req.url).toBe("https://slack.com/api/oauth.v2.access");
      expect(req.contentType).toBe("application/x-www-form-urlencoded");
      const params = new URLSearchParams(req.body);
      expect(params.get("code")).toBe("AUTH_CODE");
      expect(params.get("redirect_uri")).toBe("https://gw/cb");
      expect(params.get("client_id")).toBe("cid");
      expect(params.get("client_secret")).toBe("csecret");
    });
  });

  describe("parseTokenResponse", () => {
    function validResponse(): Record<string, unknown> {
      return {
        ok: true,
        access_token: "xoxb-bot-token",
        token_type: "bot",
        scope: "app_mentions:read,chat:write",
        bot_user_id: "U07BOT",
        app_id: "A07APP",
        team: { id: "T07TEAM", name: "Acme" },
        enterprise: null,
        authed_user: {
          id: "U07USER",
          scope: "search:read.public,channels:history",
          access_token: "xoxp-user-token",
          token_type: "user",
        },
      };
    }

    it("parses a well-formed response with both bot + user tokens", () => {
      const r = parseTokenResponse(JSON.stringify(validResponse()));
      expect(r.access_token).toBe("xoxb-bot-token");
      expect(r.bot_user_id).toBe("U07BOT");
      expect(r.team).toEqual({ id: "T07TEAM", name: "Acme" });
      expect(r.authed_user.access_token).toBe("xoxp-user-token");
      expect(r.authed_user.id).toBe("U07USER");
      expect(r.enterprise).toBeNull();
    });

    it("preserves enterprise info when present (Grid orgs)", () => {
      const body = validResponse();
      body.enterprise = { id: "E07ENT", name: "BigCo" };
      const r = parseTokenResponse(JSON.stringify(body));
      expect(r.enterprise).toEqual({ id: "E07ENT", name: "BigCo" });
    });

    it("throws when ok:false with the Slack-supplied error", () => {
      expect(() =>
        parseTokenResponse(JSON.stringify({ ok: false, error: "invalid_code" })),
      ).toThrow(/invalid_code/);
    });

    it("throws when access_token isn't xoxb-", () => {
      const body = validResponse();
      body.access_token = "not-a-bot-token";
      expect(() => parseTokenResponse(JSON.stringify(body))).toThrow(/invalid bot access_token/);
    });

    it("throws when authed_user.access_token isn't xoxp- (no user scopes granted)", () => {
      const body = validResponse();
      (body.authed_user as { access_token: string }).access_token = "xoxb-bot-token";
      expect(() => parseTokenResponse(JSON.stringify(body))).toThrow(/authed_user\.access_token/);
    });

    it("throws when team.{id,name} is missing", () => {
      const body = validResponse();
      body.team = { id: "T07TEAM" };
      expect(() => parseTokenResponse(JSON.stringify(body))).toThrow(/team\.\{id,name\}/);
    });
  });
});
