// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  denyCredentialEgressRequest,
  handleCredentialEgressRequest,
  handleOpenmaControlPlaneRequest,
} from "../../apps/agent/src/oma-sandbox";
import { CloudflareSandbox } from "../../apps/agent/src/runtime/sandbox";

const context = {
  containerId: "container-1",
  className: "OmaSandbox",
  params: {
    tenantId: "tenant-1",
    environmentId: "environment-1",
    sessionId: "session-1",
    workId: "work-1",
    ownerId: "worker-1",
    generation: 2,
    fenceToken: "fence-secret",
    required: true,
  },
};

describe("Cloudflare credential egress handler", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("fails closed when the live fenced credential lookup is unavailable", async () => {
    globalThis.fetch = vi.fn(async () => new Response("unexpected"));
    const response = await handleCredentialEgressRequest(
      new Request("https://mcp.example.test/rpc", {
        headers: { authorization: "Bearer sandbox-secret" },
      }),
      {
        MAIN_MCP: {
          lookupOutboundCredential: vi.fn(async () => {
            throw new Error("stale runtime fence");
          }),
        },
      },
      context,
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("credential egress unavailable");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("requires the full runtime fence claim in enforced mode", async () => {
    const lookup = vi.fn();
    globalThis.fetch = vi.fn(async () => new Response("unexpected"));
    const response = await handleCredentialEgressRequest(
      new Request("https://mcp.example.test/rpc"),
      { MAIN_MCP: { lookupOutboundCredential: lookup } },
      { ...context, params: { tenantId: "tenant-1", sessionId: "session-1", required: true } },
    );

    expect(response.status).toBe(403);
    expect(lookup).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("replaces sandbox authorization with the live Vault credential", async () => {
    const lookup = vi.fn(async () => ({ type: "bearer", token: "vault-token" }));
    globalThis.fetch = vi.fn(async (request: Request) => {
      expect(request.headers.get("authorization")).toBe("Bearer vault-token");
      return new Response("ok", { status: 200 });
    });
    const response = await handleCredentialEgressRequest(
      new Request("https://mcp.example.test/rpc", {
        headers: { authorization: "Bearer sandbox-secret" },
      }),
      { MAIN_MCP: { lookupOutboundCredential: lookup } },
      context,
    );

    expect(response.status).toBe(200);
    expect(lookup).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      sessionId: "session-1",
      hostname: "mcp.example.test",
      runtimeFence: {
        environmentId: "environment-1",
        workId: "work-1",
        ownerId: "worker-1",
        generation: 2,
        token: "fence-secret",
      },
    });
  });

  it("drops unmanaged sandbox authorization even when a public host has no Vault match", async () => {
    globalThis.fetch = vi.fn(async (request: Request) => {
      expect(request.headers.has("authorization")).toBe(false);
      expect(request.headers.has("x-api-key")).toBe(false);
      expect(request.headers.has("cookie")).toBe(false);
      return new Response("public", { status: 200 });
    });
    const response = await handleCredentialEgressRequest(
      new Request("https://public.example.test/", {
        headers: {
          authorization: "Bearer sandbox-secret",
          "x-api-key": "openma-control-key",
          cookie: "openma-session=must-not-leak",
        },
      }),
      { MAIN_MCP: { lookupOutboundCredential: vi.fn(async () => null) } },
      context,
    );

    expect(response.status).toBe(200);
  });

  it("denies every request after the binding is revoked", async () => {
    globalThis.fetch = vi.fn(async () => new Response("unexpected"));
    const response = await denyCredentialEgressRequest(
      new Request("https://mcp.example.test/rpc"),
      {},
      { ...context, params: { workId: "work-1", generation: 2, reason: "lease_lost" } },
    );

    expect(response.status).toBe(403);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("passes the Work capability only to the bound OpenMA origin", async () => {
    globalThis.fetch = vi.fn(async (request: Request) => {
      expect(request.headers.get("authorization")).toBe("Bearer sk-ant-req-v1.current");
      expect(request.headers.has("cookie")).toBe(false);
      expect(request.redirect).toBe("manual");
      return new Response("ok");
    });
    const response = await handleOpenmaControlPlaneRequest(
      new Request("https://api.openma.test/v1/oma/mcp-proxy/session-1/linear", {
        method: "POST",
        headers: {
          authorization: "Bearer sk-ant-req-v1.current",
          cookie: "console-session=must-not-leak",
        },
        body: "{}",
      }),
      {},
      {
        ...context,
        params: {
          ...context.params,
          controlPlaneOrigin: "https://api.openma.test",
        },
      },
    );

    expect(response.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it("lets the scoped Work client reach every attached resource API family", async () => {
    const forwarded: string[] = [];
    globalThis.fetch = vi.fn(async (request: Request) => {
      forwarded.push(new URL(request.url).pathname);
      return new Response("ok");
    });
    const boundContext = {
      ...context,
      params: {
        ...context.params,
        controlPlaneOrigin: "https://api.openma.test",
      },
    };

    for (const path of [
      "/v1/sessions/session-1",
      "/v1/sessions/session-1/events",
      "/v1/skills/skill-1/versions",
      "/v1/skills/skill-1/versions/1759178010641129/content",
      "/v1/memory_stores/memory-store-1/memories",
      "/v1/files/file-1",
      "/v1/files/file-1/content",
    ]) {
      const response = await handleOpenmaControlPlaneRequest(
        new Request(`https://api.openma.test${path}`, {
          headers: { authorization: "Bearer sk-ant-req-v1.current" },
        }),
        {},
        boundContext,
      );
      expect(response.status, path).toBe(200);
    }

    expect(forwarded).toEqual([
      "/v1/sessions/session-1",
      "/v1/sessions/session-1/events",
      "/v1/skills/skill-1/versions",
      "/v1/skills/skill-1/versions/1759178010641129/content",
      "/v1/memory_stores/memory-store-1/memories",
      "/v1/files/file-1",
      "/v1/files/file-1/content",
    ]);
  });

  it("rejects a Work capability sent to another origin or unrelated path", async () => {
    globalThis.fetch = vi.fn(async () => new Response("unexpected"));
    const wrongOrigin = await handleOpenmaControlPlaneRequest(
      new Request("https://attacker.test/v1/oma/mcp-proxy/session-1/linear", {
        headers: { authorization: "Bearer sk-ant-req-v1.current" },
      }),
      {},
      { ...context, params: { ...context.params, controlPlaneOrigin: "https://api.openma.test" } },
    );
    const wrongPath = await handleOpenmaControlPlaneRequest(
      new Request("https://api.openma.test/collect", {
        headers: { authorization: "Bearer sk-ant-req-v1.current" },
      }),
      {},
      { ...context, params: { ...context.params, controlPlaneOrigin: "https://api.openma.test" } },
    );

    expect(wrongOrigin.status).toBe(403);
    expect(wrongPath.status).toBe(403);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("refuses a required binding when the credential control plane is absent", async () => {
    const sandbox = new CloudflareSandbox({ SANDBOX: {} } as any, "session-1") as any;
    sandbox.sandboxPromise = Promise.resolve({
      setOutboundHandler: vi.fn(async () => undefined),
      setOutboundByHost: vi.fn(async () => undefined),
    });

    await expect(sandbox.setOutboundContext({
      tenantId: "tenant-1",
      environmentId: "environment-1",
      sessionId: "session-1",
      workId: "work-1",
      ownerId: "worker-1",
      generation: 1,
      fenceToken: "fence-1",
      required: true,
      controlPlaneBaseUrl: "https://api.openma.test",
    })).rejects.toThrow("MAIN_MCP");
  });
});
