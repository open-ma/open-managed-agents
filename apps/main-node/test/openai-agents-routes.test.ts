import { Hono } from "hono";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { createAuthMiddleware } from "@open-managed-agents/auth";
import { resourcesFixture } from "../../../packages/openai-agents-compat/test/helpers/resources";
import { buildNodeOpenAIAgentsRoutes } from "../src/openai-agents";

function fixture() {
  const scopes = { a: resourcesFixture(), b: resourcesFixture() };
  const auth = createAuthMiddleware({ disabled: false, resolveSession: async () => null, resolveApiKey: async key => key === "workspace-a" ? { tenantId: "a", credential: { type: "workspace" } } : key === "workspace-b" ? { tenantId: "b", credential: { type: "workspace" } } : key === "executor" ? { tenantId: "a", credential: { type: "environment", environmentId: "env_a" } } : null, defaultTenantForUser: async () => null, hasMembership: async () => false, ensureTenantForUser: async () => { throw new Error("Unexpected session login"); } });
  const app = new Hono().route("/openai", buildNodeOpenAIAgentsRoutes({ authMiddleware: auth, portFor: workspaceId => ({ execute: scopes[workspaceId as "a" | "b"].handler }) }));
  const client = (apiKey = "workspace-a") => new OpenAI({ apiKey, baseURL: "http://openma.test/openai/v1", maxRetries: 0, fetch: async (input, init) => app.fetch(new Request(input, init)) });
  return { app, client, scopes };
}

describe("Node OpenAI mount reuses workspace authentication", () => {
  it("accepts the official SDK bearer header and resolves application scope per request", async () => {
    const { client, scopes } = fixture();
    const created = await client().beta.agents.create({ model: "gpt-5", name: "Private agent" });
    expect(await client().beta.agents.retrieve(created.id)).toEqual(created);
    await expect(client("workspace-b").beta.agents.retrieve(created.id)).rejects.toBeInstanceOf(OpenAI.NotFoundError);
    expect((await client("workspace-b").beta.agents.list()).data).toEqual([]);
    expect(await scopes.a.agents.retrieveAgent({ agentId: created.id })).toMatchObject({ type: "found" });
  });

  it("normalizes existing authentication failures to OpenAI errors without invoking a resource", async () => {
    const { app, client } = fixture();
    await expect(client("invalid").beta.agents.create({ model: "gpt-5" })).rejects.toMatchObject({ status: 401, error: { type: "authentication_error", code: "invalid_api_key", param: null } });
    await expect(client("executor").beta.agents.list()).rejects.toMatchObject({ status: 403, error: { type: "permission_error" } });
    const response = await app.request("/openai/v1/vaults", { headers: { "OpenAI-Beta": "agents=v1" } });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { type: "authentication_error", param: null, code: "invalid_api_key" } });
  });

  it("keeps the OpenAI protocol under its explicit base URL", async () => {
    const { app } = fixture();
    const response = await app.request("/v1/agents", { headers: { Authorization: "Bearer workspace-a", "OpenAI-Beta": "agents=v1" } });
    expect(response.status).toBe(404);
  });

  it("keeps an unknown OpenAI endpoint out of the host's console fallback", async () => {
    const { app } = fixture();
    app.all("*", c => c.html("<main>Console</main>"));
    const response = await app.request("/openai/v1/unknown", { headers: { Authorization: "Bearer workspace-a", "OpenAI-Beta": "agents=v1" } });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { type: "invalid_request_error", code: "resource_not_found", param: null } });
  });
});
