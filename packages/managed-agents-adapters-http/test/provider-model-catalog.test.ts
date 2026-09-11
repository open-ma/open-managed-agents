import { describe, expect, it, vi } from "vitest";

import * as adapter from "../src/provider-model-catalog";

type Catalog = {
  list(input: { provider: string; apiKey?: string }): Promise<unknown>;
};

const HttpProviderModelCatalog = (
  adapter as unknown as {
    HttpProviderModelCatalog: new (dependencies: {
      fetch(input: string, init?: RequestInit): Promise<Response>;
    }) => Catalog;
  }
).HttpProviderModelCatalog;

describe("HTTP provider model catalog adapter", () => {
  it("maps Anthropic and OpenAI HTTP responses into the outbound Port", async () => {
    const fetch = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.startsWith("https://api.anthropic.com")) {
        expect(init?.headers).toEqual({
          "x-api-key": "ant-secret",
          "anthropic-version": "2023-06-01",
        });
        return Response.json({
          data: [{ id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" }],
        });
      }
      expect(input).toBe("https://api.openai.com/v1/models");
      expect(init?.headers).toEqual({ Authorization: "Bearer oai-secret" });
      return Response.json({
        data: [{ id: "text-embedding-3-large" }, { id: "gpt-5.2" }],
      });
    });
    const catalog = new HttpProviderModelCatalog({ fetch });

    await expect(catalog.list({
      provider: "ant",
      apiKey: "ant-secret",
    })).resolves.toEqual({
      type: "success",
      models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }],
    });
    await expect(catalog.list({
      provider: "oai",
      apiKey: "oai-secret",
    })).resolves.toEqual({
      type: "success",
      models: [{ id: "gpt-5.2", name: "gpt-5.2" }],
    });
  });

  it("lists every Pi provider catalog without proxying tenant credentials", async () => {
    const fetch = vi.fn();
    const catalog = new HttpProviderModelCatalog({ fetch });

    await expect(catalog.list({
      provider: "deepseek",
    })).resolves.toMatchObject({
      type: "success",
      models: expect.arrayContaining([
        expect.objectContaining({
          id: "deepseek-v4-flash",
          name: expect.any(String),
          provider: "deepseek",
          api: "openai-completions",
          reasoning: true,
          context_window: expect.any(Number),
          max_tokens: expect.any(Number),
        }),
      ]),
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
