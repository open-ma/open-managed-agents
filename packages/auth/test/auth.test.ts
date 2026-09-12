import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { createAuthMiddleware } from "../src/index";

function dependencies() {
  return {
    disabled: false,
    resolveSession: vi.fn(async () => null),
    resolveApiKey: vi.fn(async (token: string) =>
      token === "environment-key"
        ? {
            tenantId: "workspace_environment",
            credential: { type: "environment" as const, environmentId: "env_01" },
          }
        : token === "workspace-key"
          ? {
              tenantId: "workspace_admin",
              credential: { type: "workspace" as const },
            }
        : null,
    ),
    resolveBearerToken: vi.fn(async ({ token, path }: { token: string; path: string }) => {
      if (token !== "session-token") return null;
      if (
        path !== "/v1/sessions/session_01"
        && path !== "/v1/environments/env_01/work/work_01/heartbeat"
      ) return null;
      return {
        tenantId: "workspace_session",
        credential: {
          type: "environment_work_session" as const,
        },
      };
    }),
    defaultTenantForUser: vi.fn(async () => null),
    hasMembership: vi.fn(async () => false),
    ensureTenantForUser: vi.fn(async () => "workspace_default"),
  };
}

describe("managed worker bearer authentication", () => {
  it("returns Anthropic authentication errors from official Managed Agents routes", async () => {
    const deps = dependencies();
    const app = new Hono();
    app.use("*", createAuthMiddleware(deps));
    app.get("/v1/agents", (context) => context.json({ ok: true }));

    const missing = await app.request("/v1/agents");
    const invalid = await app.request("/v1/agents", {
      headers: { "x-api-key": "invalid" },
    });

    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toEqual({
      type: "error",
      error: { type: "authentication_error", message: "Unauthorized" },
    });
    expect(invalid.status).toBe(401);
    await expect(invalid.json()).resolves.toEqual({
      type: "error",
      error: { type: "authentication_error", message: "Invalid API key" },
    });
  });

  it("keeps OpenMA Console authentication errors on the existing envelope", async () => {
    const deps = dependencies();
    const app = new Hono();
    app.use("*", createAuthMiddleware(deps));
    app.get("/v1/oma/agents", (context) => context.json({ ok: true }));

    const response = await app.request("/v1/oma/agents");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("returns Anthropic permission errors when a credential escapes its official scope", async () => {
    const deps = dependencies();
    const app = new Hono();
    app.use("*", createAuthMiddleware(deps));
    app.get("/v1/agents", (context) => context.json({ ok: true }));

    const response = await app.request("/v1/agents", {
      headers: { Authorization: "Bearer environment-key" },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      type: "error",
      error: {
        type: "permission_error",
        message: "Bearer token is not authorized for this resource",
      },
    });
  });

  it("accepts a scoped session bearer resolution before the API-key fallback", async () => {
    const deps = dependencies();
    const app = new Hono();
    app.use("*", createAuthMiddleware(deps));
    app.get("/v1/sessions/:sessionId", (context) =>
      context.json({ tenantId: context.get("tenant_id") }),
    );

    const response = await app.request("/v1/sessions/session_01", {
      headers: { Authorization: "Bearer session-token" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ tenantId: "workspace_session" });
    expect(deps.resolveApiKey).not.toHaveBeenCalled();
  });

  it("accepts an environment service key as the official environment bearer", async () => {
    const deps = dependencies();
    const app = new Hono();
    app.use("*", createAuthMiddleware(deps));
    app.get("/v1/environments/:environmentId/work/poll", (context) =>
      context.json({ tenantId: context.get("tenant_id") }),
    );

    const response = await app.request("/v1/environments/env_01/work/poll", {
      headers: { Authorization: "Bearer environment-key" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ tenantId: "workspace_environment" });
    expect(deps.resolveBearerToken).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/environments/env_01/work/poll",
      token: "environment-key",
    });
  });

  it("does not accept a workspace key as a standing worker bearer", async () => {
    const deps = dependencies();
    const app = new Hono();
    app.use("*", createAuthMiddleware(deps));
    app.get("/v1/environments/:environmentId/work/poll", (context) =>
      context.json({ tenantId: context.get("tenant_id") }),
    );

    const worker = await app.request("/v1/environments/env_01/work/poll", {
      headers: { Authorization: "Bearer workspace-key" },
    });
    const administrator = await app.request("/v1/environments/env_01/work/poll", {
      headers: { "x-api-key": "workspace-key" },
    });

    expect(worker.status).toBe(403);
    expect(administrator.status).toBe(200);
  });

  it("allows the claimed Work session bearer to maintain its own Work", async () => {
    const deps = dependencies();
    const app = new Hono();
    app.use("*", createAuthMiddleware(deps));
    app.post(
      "/v1/environments/:environmentId/work/:workId/heartbeat",
      (context) => context.json({ tenantId: context.get("tenant_id") }),
    );

    const response = await app.request(
      "/v1/environments/env_01/work/work_01/heartbeat",
      { method: "POST", headers: { Authorization: "Bearer session-token" } },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ tenantId: "workspace_session" });
  });

  it("rejects an environment key outside its exact Work route", async () => {
    const deps = dependencies();
    const app = new Hono();
    app.use("*", createAuthMiddleware(deps));
    app.get("/v1/environments/:environmentId/work/poll", (context) =>
      context.json({ tenantId: context.get("tenant_id") }),
    );
    app.get("/v1/sessions/:sessionId", (context) => context.json({ ok: true }));

    const wrongEnvironment = await app.request(
      "/v1/environments/env_02/work/poll",
      { headers: { Authorization: "Bearer environment-key" } },
    );
    const session = await app.request("/v1/sessions/session_01", {
      headers: { Authorization: "Bearer environment-key" },
    });
    const header = await app.request("/v1/environments/env_01/work/poll", {
      headers: { "x-api-key": "environment-key" },
    });

    expect(wrongEnvironment.status).toBe(403);
    expect(session.status).toBe(403);
    expect(header.status).toBe(403);
  });

  it("rejects an unresolved bearer without falling through to cookie auth", async () => {
    const deps = dependencies();
    const app = new Hono();
    app.use("*", createAuthMiddleware(deps));
    app.get("/v1/sessions/:sessionId", (context) => context.json({ ok: true }));

    const response = await app.request("/v1/sessions/session_01", {
      headers: { Authorization: "Bearer invalid" },
    });

    expect(response.status).toBe(401);
    expect(deps.resolveSession).not.toHaveBeenCalled();
  });
});
