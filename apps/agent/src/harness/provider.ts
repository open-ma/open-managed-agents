import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModelV1 } from "ai";

const KNOWN_CLAUDE_PREFIX = "claude-";

export function resolveModel(
  model: string | { id: string; speed?: "standard" | "fast" },
  apiKey: string,
  baseURL?: string
): LanguageModelV1 {
  const modelString = typeof model === "string" ? model : model.id;
  const speed = typeof model === "object" ? model.speed : undefined;

  // Strip provider prefix if present: "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6"
  const modelId = modelString.includes("/")
    ? modelString.split("/").slice(1).join("/")
    : modelString;

  const isKnownClaude = modelId.startsWith(KNOWN_CLAUDE_PREFIX);

  const anthropic = createAnthropic({
    apiKey,
    baseURL: baseURL || undefined,
    headers: baseURL ? { "X-Sub-Module": "managed-agents" } : undefined,
    // @ai-sdk/anthropic hard-codes max_tokens=4096 for unknown models,
    // which truncates thinking+tool_use. Strip it for non-Claude providers.
    ...(!isKnownClaude && {
      fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.body && typeof init.body === "string") {
          try {
            const body = JSON.parse(init.body);
            delete body.max_tokens;
            return globalThis.fetch(url, { ...init, body: JSON.stringify(body) });
          } catch {}
        }
        return globalThis.fetch(url, init);
      },
    }),
  });

  if (speed === "fast") {
    return anthropic(modelId, {
      providerOptions: { speed: "fast" },
    } as Record<string, unknown>);
  }

  return anthropic(modelId);
}
