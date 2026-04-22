import { describe, it, expect } from "vitest";
import {
  buildInstallUrl,
  buildInstallationTokenRequest,
  parseInstallationTokenResponse,
} from "../../packages/github/src/oauth/protocol";

describe("GitHub OAuth/install protocol helpers", () => {
  it("buildInstallUrl produces a github.com/apps/<slug>/installations/new URL with state", () => {
    const url = buildInstallUrl({ appSlug: "my-app", state: "abc.def.ghi" });
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://github.com");
    expect(parsed.pathname).toBe("/apps/my-app/installations/new");
    expect(parsed.searchParams.get("state")).toBe("abc.def.ghi");
  });

  it("buildInstallUrl URL-encodes a slug containing safe-but-special characters", () => {
    const url = buildInstallUrl({ appSlug: "my app", state: "s" });
    expect(url).toContain("/apps/my%20app/installations/new");
  });

  it("buildInstallationTokenRequest targets /app/installations/<id>/access_tokens with App-JWT bearer", () => {
    const req = buildInstallationTokenRequest("APPJWT", "987654");
    expect(req.url).toBe(
      "https://api.github.com/app/installations/987654/access_tokens",
    );
    expect(req.headers.authorization).toBe("Bearer APPJWT");
    expect(req.headers.accept).toBe("application/vnd.github+json");
    expect(req.headers["x-github-api-version"]).toBe("2022-11-28");
    expect(req.body).toBe("");
  });

  it("parseInstallationTokenResponse extracts token + expiry + permissions", () => {
    const r = parseInstallationTokenResponse(
      JSON.stringify({
        token: "ghs_abc",
        expires_at: "2026-04-21T13:00:00Z",
        permissions: { issues: "write", contents: "read" },
        repository_selection: "all",
      }),
    );
    expect(r.token).toBe("ghs_abc");
    expect(r.expiresAt).toBe("2026-04-21T13:00:00Z");
    expect(r.permissions).toEqual({ issues: "write", contents: "read" });
    expect(r.repositorySelection).toBe("all");
  });

  it("parseInstallationTokenResponse throws when token is missing", () => {
    expect(() =>
      parseInstallationTokenResponse(
        JSON.stringify({ expires_at: "2026-04-21T13:00:00Z" }),
      ),
    ).toThrow(/missing token/);
  });

  it("parseInstallationTokenResponse throws when expires_at is missing", () => {
    expect(() =>
      parseInstallationTokenResponse(JSON.stringify({ token: "ghs_x" })),
    ).toThrow(/missing expires_at/);
  });

  it("parseInstallationTokenResponse defaults repository_selection to selected when omitted", () => {
    const r = parseInstallationTokenResponse(
      JSON.stringify({ token: "ghs_x", expires_at: "2026-04-21T13:00:00Z" }),
    );
    expect(r.repositorySelection).toBe("selected");
    expect(r.permissions).toEqual({});
  });
});
