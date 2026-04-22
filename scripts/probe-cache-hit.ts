// Standalone probe: drive a multi-turn conversation through ai-sdk +
// the @ai-sdk/anthropic provider, applying our cache strategy, and report
// usage.cacheReadInputTokens / usage.cacheCreationInputTokens per turn.
//
// Run from repo root:
//   ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/probe-cache-hit.ts
//
// Expected output:
//   Turn 1: cache_creation HIGH (writes the prefix), cache_read = 0
//   Turn 2: cache_creation small (just the new tail), cache_read HIGH
//   Turn 3: cache_creation small, cache_read HIGHER (prior turn now cached too)
//
// If cache_read stays 0 across turns, something's busting the prefix.

import { generateText } from "ai";
import type { ModelMessage, SystemModelMessage } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";

const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN;
if (!apiKey) {
  console.error("Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN).");
  process.exit(1);
}

function parseHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    // Not JSON — treat as `Header: value` lines (Claude Code env shape).
    const out: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return Object.keys(out).length ? out : undefined;
  }
}

const anthropic = createAnthropic({
  apiKey,
  baseURL: process.env.ANTHROPIC_BASE_URL,
  headers: parseHeaders(process.env.ANTHROPIC_CUSTOM_HEADERS),
});

// Make the system prompt large enough that caching is meaningful.
// Anthropic's minimum cacheable prefix on Sonnet 4.6 is 1024 tokens; on
// Opus 4.7 it's 4096. We pad to ~6K characters (~1.5K tokens) so it crosses
// Sonnet's threshold but still feels like a realistic system prompt.
const PADDING = (
  "You are an exhaustive technical assistant. " +
  "Be precise, be specific, give examples. ".repeat(120)
);
const SYSTEM_PROMPT = `${PADDING}\n\nWhen asked questions, answer in 2 sentences.`;

const ephemeral = { anthropic: { cacheControl: { type: "ephemeral" } } } as const;

function withSystem(): SystemModelMessage {
  return {
    role: "system",
    content: SYSTEM_PROMPT,
    providerOptions: ephemeral,
  };
}

function markLast(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length === 0) return messages;
  const cloned = messages.map((m) => ({ ...m }));
  const last = cloned[cloned.length - 1] as any;
  last.providerOptions = { ...(last.providerOptions ?? {}), ...ephemeral };
  return cloned;
}

const QUESTIONS = [
  "What's the capital of France?",
  "And what about Germany?",
  "What's the population of the German one?",
  "Which country has more historical castles?",
];

async function main() {
  const model = anthropic(process.env.PROBE_MODEL ?? "claude-sonnet-4-6");
  const conversation: ModelMessage[] = [];

  console.log(
    `Model: ${(model as any).modelId ?? "unknown"}  base=${process.env.ANTHROPIC_BASE_URL ?? "default"}`,
  );
  console.log(`System prompt: ${SYSTEM_PROMPT.length} chars (~${Math.round(SYSTEM_PROMPT.length / 4)} tokens)`);
  console.log("---");

  for (let i = 0; i < QUESTIONS.length; i++) {
    conversation.push({ role: "user", content: [{ type: "text", text: QUESTIONS[i] }] });

    const t0 = Date.now();
    const result = await generateText({
      model,
      system: withSystem(),
      messages: markLast(conversation),
      maxOutputTokens: 200,
    });
    const elapsed = Date.now() - t0;

    const u = result.usage as any;
    const inp = u?.inputTokens ?? u?.promptTokens ?? 0;
    const out = u?.outputTokens ?? u?.completionTokens ?? 0;
    const cacheRead = u?.cacheReadInputTokens ?? u?.cache_read_input_tokens ?? 0;
    const cacheCreate = u?.cacheCreationInputTokens ?? u?.cache_creation_input_tokens ?? 0;

    console.log(
      `Turn ${i + 1} (${elapsed}ms): in=${inp} out=${out} cache_read=${cacheRead} cache_create=${cacheCreate}`,
    );

    // Append assistant turn back into conversation
    for (const m of result.response.messages) {
      conversation.push(m);
    }
  }

  console.log("---");
  console.log(
    "Expected: turn 1 cache_create > 0; turn 2+ cache_read >= system prompt size, cache_create small.",
  );
  console.log(
    "If cache_read stays 0: prefix bytes are drifting between turns (system / tools / messages).",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
