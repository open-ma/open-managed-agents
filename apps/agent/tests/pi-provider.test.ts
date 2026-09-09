import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { LanguageModel } from "ai";
import { generateText, stepCountIs, streamText, tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as piProviderModule from "../src/harness/pi-provider";
import mockServices, { type Env as MockServicesEnv } from "../../../test/mocks/mock-server/index";

const { createPiModelRuntime } = piProviderModule;

describe("createPiModelRuntime", () => {
  it("binds an Anthropic model card to Pi without exposing its credential", async () => {
    const runtime = createPiModelRuntime({
      model: "claude-sonnet-4-6",
      apiKey: "tenant-secret",
      provider: "ant",
    });

    expect(runtime.model).toMatchObject({
      id: "claude-sonnet-4-6",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
    });
    expect(JSON.stringify(runtime.model)).not.toContain("tenant-secret");
    expect(JSON.stringify(runtime.models.getProvider("anthropic"))).not.toContain(
      "tenant-secret",
    );
    await expect(runtime.models.getAuth(runtime.model)).resolves.toMatchObject({
      auth: { apiKey: "tenant-secret" },
    });
  });

  it("keeps legacy compatible cards as a thin migration mapping", () => {
    const runtime = createPiModelRuntime({
      model: "custom-model",
      apiKey: "secret",
      provider: "oai-compatible",
      baseURL: "https://models.example.test/v1",
      customHeaders: { "x-tenant-model": "custom" },
    });

    expect(runtime.model).toMatchObject({
      id: "custom-model",
      provider: "openai-compatible",
      api: "openai-completions",
      baseUrl: "https://models.example.test/v1",
    });
    expect(runtime.models.getProvider("openai-compatible")?.headers).toEqual({
      "x-tenant-model": "custom",
    });
  });

  it("uses Pi's DeepSeek catalog instead of an OpenMA provider implementation", () => {
    const runtime = createPiModelRuntime({
      model: "deepseek-v4-pro",
      apiKey: "secret",
      provider: "deepseek",
    });

    expect(runtime.model).toMatchObject({
      id: "deepseek-v4-pro",
      provider: "deepseek",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
    });
    expect(runtime.model.contextWindow).toBeGreaterThan(0);
  });

  it("accepts every provider registered by Pi without an OpenMA provider switch", async () => {
    const runtime = createPiModelRuntime({
      model: "aion-labs/aion-2.0",
      apiKey: "openrouter-secret",
      provider: "openrouter",
    });

    expect(runtime.model).toMatchObject({
      id: "aion-labs/aion-2.0",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    await expect(runtime.models.getAuth(runtime.model)).resolves.toMatchObject({
      auth: { apiKey: "openrouter-secret" },
    });
  });

  it("adapts a Pi-registered model to the AI SDK shape used by DefaultHarness", async () => {
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    faux.setResponses([fauxAssistantMessage("default harness via pi")]);
    const models = createModels();
    models.setProvider(faux.provider);

    const candidate = Reflect.get(piProviderModule, "toAiSdkLanguageModel");
    expect(typeof candidate).toBe("function");
    if (typeof candidate !== "function") return;

    const model = candidate({ models, model: faux.getModel() }) as LanguageModel;
    const result = streamText({ model, prompt: "hello" });

    await expect(result.text).resolves.toBe("default harness via pi");
  });

  it("supports the non-streaming AI SDK shape used by compaction and outcome judging", async () => {
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    faux.setResponses([fauxAssistantMessage("generated through pi")]);
    const models = createModels();
    models.setProvider(faux.provider);

    const candidate = Reflect.get(piProviderModule, "toAiSdkLanguageModel");
    expect(typeof candidate).toBe("function");
    if (typeof candidate !== "function") return;
    const model = candidate({ models, model: faux.getModel() }) as LanguageModel;

    await expect(generateText({ model, prompt: "summarize" }).then((result) => result.text))
      .resolves.toBe("generated through pi");
  });

  it("keeps the AI SDK DefaultHarness tool loop above the Pi provider", async () => {
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("echo", { value: "through pi" }, { id: "tool-1" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("tool loop complete"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const execute = vi.fn(async ({ value }: { value: string }) => ({ echoed: value }));

    const candidate = Reflect.get(piProviderModule, "toAiSdkLanguageModel");
    expect(typeof candidate).toBe("function");
    if (typeof candidate !== "function") return;
    const model = candidate({ models, model: faux.getModel() }) as LanguageModel;
    const result = streamText({
      model,
      prompt: "call echo",
      tools: {
        echo: tool({
          description: "Echo a value",
          inputSchema: z.object({ value: z.string() }),
          execute,
        }),
      },
      stopWhen: stepCountIs(2),
    });

    await expect(result.text).resolves.toBe("tool loop complete");
    expect(execute).toHaveBeenCalledWith(
      { value: "through pi" },
      expect.objectContaining({ toolCallId: "tool-1" }),
    );
  });

  it("completes a streamed Anthropic tool loop through the real Pi protocol adapter", async () => {
    const repositorySha = "9e79e0dd41e23a8900b0b4adec5f55e4ecf24529";
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      mockServices.fetch(new Request(input, init), {} as MockServicesEnv));
    try {
      const runtime = createPiModelRuntime({
        model: "openma-e2e-inputs",
        apiKey: "fixture",
        provider: "ant-compatible",
        baseURL: "https://mock.test",
      });
      const candidate = Reflect.get(piProviderModule, "toAiSdkLanguageModel");
      expect(typeof candidate).toBe("function");
      if (typeof candidate !== "function") return;
      const executeBash = vi.fn(async () => "FILES_REPO_SKILL_MEMORY_OUTPUT_OK");
      const executeMcp = vi.fn(async () => "MCP_PROXY_OK");
      const model = candidate(runtime) as LanguageModel;
      const result = streamText({
        model,
        prompt: `Expected repository SHA: ${repositorySha}`,
        tools: {
          bash: tool({
            inputSchema: z.object({ command: z.string() }),
            execute: executeBash,
          }),
          mcp__certification__echo: tool({
            inputSchema: z.object({ value: z.string() }),
            execute: executeMcp,
          }),
        },
        stopWhen: stepCountIs(3),
      });

      await expect(result.text).resolves.toBe("ALL_INPUTS_OK");
      expect(executeBash).toHaveBeenCalledOnce();
      expect(executeMcp).toHaveBeenCalledWith(
        { value: "MCP_INPUT_OK" },
        expect.objectContaining({ toolCallId: "toolu_mock_1" }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
