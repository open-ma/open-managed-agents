import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModelV1 } from "ai";

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

  const anthropic = createAnthropic({
    apiKey,
    baseURL: baseURL || undefined,
    headers: baseURL ? { "X-Sub-Module": "managed-agents" } : undefined,
  });

  // @ai-sdk/anthropic supports providerOptions for model-level settings
  // Speed "fast" is passed as a provider-specific option if supported
  if (speed === "fast") {
    return anthropic(modelId, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      speed: "fast" as any,
    });
  }

  return anthropic(modelId);
}
