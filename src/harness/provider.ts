import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModelV1 } from "ai";

export function resolveModel(
  model: string | { id: string; speed?: "standard" | "fast" },
  apiKey: string,
  baseURL?: string
): LanguageModelV1 {
  const modelString = typeof model === "string" ? model : model.id;

  // Strip provider prefix if present: "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6"
  const modelId = modelString.includes("/")
    ? modelString.split("/").slice(1).join("/")
    : modelString;

  const anthropic = createAnthropic({
    apiKey,
    baseURL: baseURL || undefined,
    headers: baseURL ? { "X-Sub-Module": "managed-agents" } : undefined,
  });
  return anthropic(modelId);
}
