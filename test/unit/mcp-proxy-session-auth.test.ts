import { afterEach, describe, expect, it, vi } from "vitest";

import { forwardHttpMcpProxyRequest } from "../../apps/main/src/routes/mcp-proxy";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HTTP MCP proxy with a managed Work claim", () => {
  it("resolves MCP configuration from the v1 managed Session source", async () => {
    const upstream = vi.fn(async (request: Request) => {
      expect(request.url).toBe("https://linear.example/mcp");
      expect(request.headers.get("authorization")).toBe("Bearer managed-vault-token");
      return new Response("proxied-v1", { status: 200 });
    });
    vi.stubGlobal("fetch", upstream);

    const services = {
      sessions: {
        get: vi.fn(async () => {
          throw new Error("the v1 proxy must not read the legacy sessions store");
        }),
      },
      credentials: {
        listByVaults: vi.fn(async ({ tenantId, vaultIds }: any) => {
          expect(tenantId).toBe("workspace_01");
          expect(vaultIds).toEqual(["vault_01"]);
          return [{
            vault_id: "vault_01",
            credentials: [{
              id: "cred_01",
              auth: {
                type: "static_bearer",
                mcp_server_url: "https://linear.example/mcp",
                bearer_token: "managed-vault-token",
              },
            }],
          }];
        }),
      },
    };
    const sessionSource = {
      find: vi.fn(async ({ workspaceId, sessionId }: any) => {
        expect(workspaceId).toBe("workspace_01");
        expect(sessionId).toBe("session_01");
        return {
          id: "session_01",
          archivedAt: null,
          vaultIds: ["vault_01"],
          agent: {
            mcpServers: [{
              type: "url",
              name: "linear",
              url: "https://linear.example/mcp",
            }],
          },
        };
      }),
    };

    const response = await forwardHttpMcpProxyRequest({
      env: {} as any,
      services: services as any,
      sessionSource,
      tenantId: "workspace_01",
      sessionId: "session_01",
      serverName: "linear",
      request: new Request("https://openma.test/v1/oma/mcp-proxy/session_01/linear", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("proxied-v1");
    expect(sessionSource.find).toHaveBeenCalledTimes(1);
    expect(services.sessions.get).not.toHaveBeenCalled();
  });

  it("uses the tenant authenticated by middleware and never forwards the Work bearer upstream", async () => {
    const upstream = vi.fn(async (request: Request) => {
      expect(request.url).toBe("https://linear.example/mcp");
      expect(request.headers.get("authorization")).toBe("Bearer upstream-vault-token");
      expect(request.headers.has("x-api-key")).toBe(false);
      expect(request.headers.has("cookie")).toBe(false);
      expect(request.redirect).toBe("manual");
      return new Response("proxied", { status: 200 });
    });
    vi.stubGlobal("fetch", upstream);

    const services = {
      // Deliberately throws: a current Work bearer has already been resolved by
      // authMiddleware and must not be reinterpreted as a long-lived API key.
      kv: { get: vi.fn(async () => { throw new Error("KV API-key lookup must not run"); }) },
      sessions: {
        get: vi.fn(async ({ tenantId, sessionId }: any) => {
          expect(tenantId).toBe("workspace_01");
          expect(sessionId).toBe("session_01");
          return {
            archived_at: null,
            vault_ids: [],
            agent_snapshot: {
              mcp_servers: [{
                name: "linear",
                url: "https://linear.example/mcp",
                authorization_token: "upstream-vault-token",
              }],
            },
          };
        }),
      },
      credentials: { listByVaults: vi.fn(async () => []) },
    };
    const response = await forwardHttpMcpProxyRequest({
      env: {} as any,
      services: services as any,
      tenantId: "workspace_01",
      sessionId: "session_01",
      serverName: "linear",
      request: new Request("https://openma.test/v1/oma/mcp-proxy/session_01/linear", {
        method: "POST",
        headers: {
          authorization: "Bearer sk-ant-req-v1.current-work-claim",
          "x-api-key": "openma-control-key",
          cookie: "openma-session=must-not-leak",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("proxied");
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
