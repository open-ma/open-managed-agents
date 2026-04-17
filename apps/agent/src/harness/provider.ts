import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

/**
 * API compatibility types:
 * - "ant"            — Anthropic official API
 * - "ant-compatible" — Third-party Anthropic-compatible API
 * - "oai"            — OpenAI official API
 * - "oai-compatible" — Third-party OpenAI-compatible API (DeepSeek, Groq, etc.)
 */
export type ApiCompat = "ant" | "ant-compatible" | "oai" | "oai-compatible";

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

function useOpenAI(compat: ApiCompat): boolean {
  return compat === "oai" || compat === "oai-compatible";
}

export function resolveModel(
  model: string | { id: string; speed?: "standard" | "fast" },
  apiKey: string,
  baseURL?: string,
  compat?: ApiCompat,
  customHeaders?: Record<string, string>,
): LanguageModel {
  const modelString = typeof model === "string" ? model : model.id;

  // Strip provider prefix if present: "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6"
  const modelId = modelString.includes("/")
    ? modelString.split("/").slice(1).join("/")
    : modelString;

  const effectiveCompat = compat || "ant";

  if (useOpenAI(effectiveCompat)) {
    const openai = createOpenAI({
      apiKey,
      baseURL: baseURL || undefined,
      headers: customHeaders,
    });
    // Use chat/completions endpoint, not Responses API.
    // Reasons:
    //   - Third-party OpenAI-compat gateways (CF AI Gateway, Groq, DeepSeek,
    //     xAI Grok, etc.) only support /v1/chat/completions
    //   - Responses API requires server-side persistence of function call IDs;
    //     orgs with Zero Data Retention enabled get "Item with id 'fc_...' not
    //     found" errors mid-loop
    //   - chat/completions is the de-facto standard contract for OpenAI-compat
    return openai.chat(modelId);
  }

  // ant / ant-compatible
  const isKnownClaude = modelId.startsWith(KNOWN_CLAUDE_PREFIX);

  const headers: Record<string, string> = {};
  if (baseURL) headers["X-Sub-Module"] = "managed-agents";
  if (customHeaders) Object.assign(headers, customHeaders);

  const anthropic = createAnthropic({
    apiKey,
    baseURL: baseURL || undefined,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    ...(!isKnownClaude && { fetch: stripMaxTokensFetch }),
  });

  return anthropic(modelId);
}
