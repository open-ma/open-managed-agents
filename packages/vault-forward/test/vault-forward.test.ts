import { describe, it, expect } from "vitest";
import {
  buildAuthHeader,
  refreshMetadataOf,
  pickCredentialByHost,
  forwardWithRefresh,
} from "../src/index";
import type { CredentialAuth } from "@open-managed-agents/shared";

describe("@open-managed-agents/vault-forward", () => {
  it("buildAuthHeader handles static_bearer", () => {
    const h = buildAuthHeader({ type: "static_bearer", token: "abc" } as CredentialAuth);
    expect(h).toEqual({ name: "authorization", value: "Bearer abc" });
  });

  it("buildAuthHeader handles cap_cli with token", () => {
    const h = buildAuthHeader({ type: "cap_cli", cli_id: "gh", token: "ghp_x" } as unknown as CredentialAuth);
    expect(h).toEqual({ name: "authorization", value: "Bearer ghp_x" });
  });

  it("buildAuthHeader handles mcp_oauth using access_token", () => {
    const h = buildAuthHeader({
      type: "mcp_oauth",
      access_token: "tok",
      mcp_server_url: "https://x.example/mcp",
    } as unknown as CredentialAuth);
    expect(h).toEqual({ name: "authorization", value: "Bearer tok" });
  });

  it("buildAuthHeader returns null when no token", () => {
    expect(buildAuthHeader({ type: "static_bearer", token: "" } as CredentialAuth)).toBeNull();
  });

  it("refreshMetadataOf surfaces oauth refresh fields", () => {
    const meta = refreshMetadataOf({
      type: "mcp_oauth",
      refresh_token: "r",
      token_endpoint: "https://x/oauth/token",
      client_id: "id",
    } as unknown as CredentialAuth);
    expect(meta).toEqual({
      refreshToken: "r",
      tokenEndpoint: "https://x/oauth/token",
      clientId: "id",
      clientSecret: undefined,
    });
  });

  it("refreshMetadataOf null for static_bearer", () => {
    expect(refreshMetadataOf({ type: "static_bearer", token: "x" } as CredentialAuth)).toBeNull();
  });

  it("pickCredentialByHost matches mcp_server_url host exactly", () => {
    const grouped = [
      {
        vault_id: "v1",
        credentials: [
          {
            id: "c1",
            auth: { type: "static_bearer", mcp_server_url: "https://api.x.dev/mcp", token: "t" } as unknown as CredentialAuth,
          },
        ],
      },
    ];
    const r = pickCredentialByHost(grouped, "api.x.dev");
    expect(r?.credentialId).toBe("c1");
    expect(pickCredentialByHost(grouped, "other.example")).toBeNull();
  });

  it("forwardWithRefresh refreshes on 401 + onRefreshed fires", async () => {
    let calls = 0;
    const fakeFetch: typeof fetch = async (input, init) => {
      calls++;
      const headers = new Headers(init?.headers);
      const auth = headers.get("authorization");
      if (calls === 1) {
        // First call: 401
        return new Response("nope", { status: 401 });
      }
      if (calls === 2) {
        // Token-endpoint refresh (POST refresh_token)
        return new Response(
          JSON.stringify({ access_token: "new-tok", refresh_token: "new-r", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // Retry with new token
      expect(auth).toBe("Bearer new-tok");
      return new Response("ok", { status: 200 });
    };

    let persisted: { access_token: string; refresh_token: string } | null = null;
    const res = await forwardWithRefresh({
      upstreamUrl: "https://api.example/api",
      method: "POST",
      inboundHeaders: new Headers({ "content-type": "application/json" }),
      body: '{"x":1}',
      accessToken: "stale",
      refresh: {
        refreshToken: "old-r",
        tokenEndpoint: "https://api.example/token",
        clientId: "id",
      },
      onRefreshed: async (t) => {
        persisted = { access_token: t.access_token, refresh_token: t.refresh_token };
      },
      fetcher: fakeFetch,
    });
    expect(res.status).toBe(200);
    expect(persisted).toEqual({ access_token: "new-tok", refresh_token: "new-r" });
  });
});
