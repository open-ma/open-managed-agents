import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { buildOmaModelRoutes } from "../src/index";

type OmaModelsApplicationPort = {
  listProviderModels(input: {
    provider: string;
    apiKey?: string;
  }): Promise<
    | { type: "success"; models: Array<{ id: string; name: string }> }
    | { type: "upstream_error"; message: string }
  >;
};

describe("OMA model discovery contract", () => {
  it("keeps provider discovery on /v1/oma/models/list and delegates through a Port", async () => {
    const listProviderModels = vi.fn(async () => ({
      type: "success" as const,
      models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }],
    }));
    const app = new Hono();
    app.route("/v1/oma/models", buildOmaModelRoutes({ listProviderModels }));

    const response = await app.request("/v1/oma/models/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "ant", api_key: "secret" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }],
    });
    expect(listProviderModels).toHaveBeenCalledWith({
      provider: "ant",
      apiKey: "secret",
    });

    const officialNamespace = await app.request("/v1/models/list", {
      method: "POST",
    });
    expect(officialNamespace.status).toBe(404);
  });

  it("allows provider catalog discovery without an API key", async () => {
    const listProviderModels = vi.fn(async () => ({
      type: "success" as const,
      models: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }],
    }));
    const app = new Hono();
    app.route("/v1/oma/models", buildOmaModelRoutes({ listProviderModels }));

    const response = await app.request("/v1/oma/models/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "deepseek" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }],
    });
    expect(listProviderModels).toHaveBeenCalledWith({
      provider: "deepseek",
    });
  });
});
