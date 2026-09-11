import { describe, expect, it } from "vitest";
import { bindStoredModelCardCredentials } from "../src/harness/model-card-credentials";

describe("bindStoredModelCardCredentials", () => {
  it("does not leak the Anthropic environment endpoint into an official provider card", () => {
    expect(bindStoredModelCardCredentials(
      {
        model: "deepseek-card",
        apiKey: "anthropic-fallback-key",
        baseURL: "https://api.minimaxi.com/anthropic/v1",
      },
      {
        model: "deepseek-v4-flash",
        provider: "deepseek",
        base_url: null,
        custom_headers: null,
        pi_config: null,
      },
      "deepseek-card-key",
    )).toEqual({
      model: "deepseek-v4-flash",
      apiKey: "deepseek-card-key",
      baseURL: undefined,
      provider: "deepseek",
      customHeaders: undefined,
      piConfig: undefined,
    });
  });

  it("preserves an explicit custom provider endpoint", () => {
    expect(bindStoredModelCardCredentials(
      {
        model: "custom-card",
        apiKey: "fallback-key",
        baseURL: "https://fallback.invalid/v1",
      },
      {
        model: "custom-model",
        provider: "my-provider",
        base_url: "https://models.example.test/v1",
        custom_headers: { "x-tenant": "tenant-1" },
        pi_config: { api: "openai-completions" },
      },
      "custom-key",
    )).toMatchObject({
      model: "custom-model",
      apiKey: "custom-key",
      baseURL: "https://models.example.test/v1",
      provider: "my-provider",
      customHeaders: { "x-tenant": "tenant-1" },
      piConfig: { api: "openai-completions" },
    });
  });
});
