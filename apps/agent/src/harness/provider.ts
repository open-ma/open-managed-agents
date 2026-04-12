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
    // For non-Claude models (MiniMax, etc.): @ai-sdk/anthropic defaults to
    // max_tokens=4096 for unknown models, which is far too low (thinking
    // alone can consume 3000+ tokens). Strip max_tokens from the request
    // body so the provider API uses its own default.
    ...(!isKnownClaude && {
      transformRequestBody: (body: Record<string, unknown>) => {
        const { max_tokens: _, ...rest } = body;
        return rest;
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
