import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import {
  buildNodeHttpMcpProxyRoutes,
  createNodeMcpProxyBinding,
} from "../src/lib/http-mcp-proxy";

describe("Node HTTP MCP proxy", () => {
  it("provides an in-process binding for the host harness without exposing vault credentials", async () => {
    const upstream = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(request, init);
      expect(req.url).toBe("https://mcp.example.test/rpc");
      expect(req.headers.get("authorization")).toBe("Bearer vault-token");
      expect(req.headers.get("mcp-session-id")).toBe("upstream-session");
      expect(req.headers.has("x-oma-tenant")).toBe(false);
      expect(req.headers.has("x-oma-session")).toBe(false);
      expect(req.headers.has("x-oma-mcp-server")).toBe(false);
      return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
        status: 200,
        headers: {
          "content-type": "application/json",
          "mcp-session-id": "upstream-session",
        },
      });
    });
    const resolveTarget = vi.fn(async () => ({
      upstreamUrl: "https://mcp.example.test/rpc",
      accessToken: "vault-token",
    }));
    const binding = createNodeMcpProxyBinding({
      resolveTarget,
      fetcher: upstream as typeof fetch,
    });

    const response = await binding.fetch(new Request("https://mcp.example.test/rpc", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-session-id": "upstream-session",
        "x-oma-tenant": "tenant-1",
        "x-oma-session": "session-1",
        "x-oma-mcp-server": "linear",
      },
      body: '{"jsonrpc":"2.0","id":1}',
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBe("upstream-session");
    expect(resolveTarget).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      sessionId: "session-1",
      serverName: "linear",
    });
  });

  it("fails a binding request closed when routing scope is missing", async () => {
    const upstream = vi.fn();
    const binding = createNodeMcpProxyBinding({
      resolveTarget: vi.fn(async () => null),
      fetcher: upstream as typeof fetch,
    });

    const response = await binding.fetch(new Request("https://mcp.example.test/rpc", {
      method: "POST",
      body: "{}",
    }));

    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("uses the authenticated tenant and replaces the Work bearer upstream", async () => {
    const upstream = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(request, init);
      expect(req.url).toBe("https://mcp.example.test/rpc");
      expect(req.headers.get("authorization")).toBe("Bearer vault-token");
      expect(await req.text()).toBe('{"jsonrpc":"2.0"}');
      return new Response("upstream", { status: 202 });
    });
    const resolveTarget = vi.fn(async () => ({
      upstreamUrl: "https://mcp.example.test/rpc",
      accessToken: "vault-token",
    }));
    const app = new Hono<{ Variables: { tenant_id: string } }>();
    app.use("*", async (c, next) => {
      c.set("tenant_id", "tenant-1");
      await next();
    });
    app.route("/v1/oma/mcp-proxy", buildNodeHttpMcpProxyRoutes({
      resolveTarget,
      fetcher: upstream as typeof fetch,
    }));

    const response = await app.request(
      "/v1/oma/mcp-proxy/session-1/linear",
      {
        method: "POST",
        headers: {
          authorization: "Bearer work-sessions-token",
          "content-type": "application/json",
        },
        body: '{"jsonrpc":"2.0"}',
      },
    );

    expect(response.status).toBe(202);
    expect(resolveTarget).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      sessionId: "session-1",
      serverName: "linear",
    });
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("fails closed when the Session/server binding does not resolve", async () => {
    const upstream = vi.fn();
    const app = new Hono<{ Variables: { tenant_id: string } }>();
    app.use("*", async (c, next) => {
      c.set("tenant_id", "tenant-1");
      await next();
    });
    app.route("/v1/oma/mcp-proxy", buildNodeHttpMcpProxyRoutes({
      resolveTarget: vi.fn(async () => null),
      fetcher: upstream as typeof fetch,
    }));

    const response = await app.request("/v1/oma/mcp-proxy/other-session/linear", {
      method: "POST",
      headers: { authorization: "Bearer work-sessions-token" },
      body: "{}",
    });

    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });
});
