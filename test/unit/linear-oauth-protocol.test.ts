import { describe, it, expect } from "vitest";
import {
  buildAuthorizeUrl,
  buildTokenExchangeBody,
  parseTokenResponse,
} from "../../packages/linear/src/oauth/protocol";

describe("Linear OAuth protocol helpers", () => {
  describe("buildAuthorizeUrl", () => {
    it("constructs URL with all required params", () => {
      const url = buildAuthorizeUrl({
        clientId: "abc123",
        redirectUri: "https://gw.example/linear/oauth/shared/callback",
        scopes: ["read", "write", "app:assignable"],
        state: "state_jwt",
        actor: "app",
      });
      const parsed = new URL(url);
      expect(parsed.origin + parsed.pathname).toBe("https://linear.app/oauth/authorize");
      expect(parsed.searchParams.get("client_id")).toBe("abc123");
      expect(parsed.searchParams.get("redirect_uri")).toBe(
        "https://gw.example/linear/oauth/shared/callback",
      );
      expect(parsed.searchParams.get("scope")).toBe("read,write,app:assignable");
      expect(parsed.searchParams.get("state")).toBe("state_jwt");
      expect(parsed.searchParams.get("actor")).toBe("app");
      expect(parsed.searchParams.get("response_type")).toBe("code");
    });

    it("omits actor param when not specified", () => {
      const url = buildAuthorizeUrl({
        clientId: "x",
        redirectUri: "https://x/cb",
        scopes: ["read"],
        state: "s",
      });
      expect(new URL(url).searchParams.has("actor")).toBe(false);
    });
  });

  describe("buildTokenExchangeBody", () => {
    it("uses correct token endpoint and form body", () => {
      const req = buildTokenExchangeBody({
        code: "AUTH_CODE",
        redirectUri: "https://gw/cb",
        clientId: "cid",
        clientSecret: "csecret",
      });
      expect(req.url).toBe("https://api.linear.app/oauth/token");
      expect(req.contentType).toBe("application/x-www-form-urlencoded");
      const params = new URLSearchParams(req.body);
      expect(params.get("code")).toBe("AUTH_CODE");
      expect(params.get("redirect_uri")).toBe("https://gw/cb");
      expect(params.get("client_id")).toBe("cid");
      expect(params.get("client_secret")).toBe("csecret");
      expect(params.get("grant_type")).toBe("authorization_code");
    });
  });

  describe("parseTokenResponse", () => {
    it("parses a well-formed response", () => {
      const r = parseTokenResponse(
        JSON.stringify({
          access_token: "lin_abc",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "read write",
        }),
      );
      expect(r.access_token).toBe("lin_abc");
      expect(r.scope).toBe("read write");
    });

    it("throws when access_token is missing", () => {
      expect(() =>
        parseTokenResponse(JSON.stringify({ token_type: "Bearer" })),
      ).toThrow(/missing access_token/);
    });
  });
});
