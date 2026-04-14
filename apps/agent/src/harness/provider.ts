import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";

const KNOWN_CLAUDE_PREFIX = "claude-";

/**
 * Fetch wrapper that strips max_tokens from request body.
 * @ai-sdk/anthropic defaults to max_tokens=4096 for models not in its
 * internal capabilities map. Removing it lets the provider API decide.
 */
async function stripMaxTokensFetch(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (init?.body && typeof init.body === "string") {
    try {
      const body = JSON.parse(init.body);
      delete body.max_tokens;
      return globalThis.fetch(url, { ...init, body: JSON.stringify(body) });
    } catch {}
  }
  return globalThis.fetch(url, init);
}

export function resolveModel(
  model: string | { id: string; speed?: "standard" | "fast" },
  apiKey: string,
  baseURL?: string
): LanguageModel {
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
    // which truncates thinking+tool_use. Strip it for non-Claude providers
    // so the API uses its own default (MiniMax supports up to 196608).
    ...(!isKnownClaude && { fetch: stripMaxTokensFetch }),
  });

  if (speed === "fast") {
    // Speed is passed as providerOptions in generateText calls, not at model creation
    return anthropic(modelId);
  }

  return anthropic(modelId);
}
