import { generateText } from "ai";
import type { ModelMessage, LanguageModel } from "ai";
import type { ContentBlock, SessionEvent } from "@open-managed-agents/shared";
import { eventsToMessages } from "../runtime/history";
import type { HarnessRuntime } from "./interface";

/**
 * Compaction strategy contract.
 *
 * Given the full event log + a model + a token budget, decide whether
 * compaction should fire and produce a summary `ContentBlock[]` plus
 * boundary metadata. The harness writes the result as a
 * `agent.thread_context_compacted` event with the summary attached, and
 * `eventsToMessages` honors the latest such boundary on subsequent reads.
 *
 * Strategies are pure with respect to (events, model, system, tools) — same
 * input → same output. The harness handles persistence + broadcast.
 *
 * For cache reuse: the strategy MUST send the same (model, system, tools,
 * messages-prefix) bytes as the main agent's last call so Anthropic's prompt
 * cache hits. The harness threads `applyCacheStrategy` through so the
 * strategy can apply identical provider-specific markers.
 */
export interface CompactionStrategy {
  readonly name: string;
  shouldCompact(events: SessionEvent[], opts: { contextWindowTokens: number }): boolean;
  compact(
    events: SessionEvent[],
    opts: {
      model: LanguageModel;
      contextWindowTokens: number;
      systemPrompt: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: Record<string, any>;
      /**
       * Apply provider-specific cache markers to (system, tools, messages).
       * Strategy calls this on the ORIGINAL messages (without the summarize
       * request appended) so the cache breakpoint lands on the last original
       * message — matching the main agent's last call's cache prefix.
       */
      applyCacheStrategy: (
        systemPrompt: string,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tools: Record<string, any>,
        messages: ModelMessage[],
      ) => CacheStrategyApplied;
      /**
       * Optional runtime — strategy uses it to broadcast span events for the
       * summarize call so callers (probe, logs, dashboards) can see the
       * cache_read / cache_create stats of the compaction call distinctly
       * from the main agent's calls.
       */
      runtime?: HarnessRuntime;
    },
  ): Promise<CompactionResult | null>;
}

export interface CacheStrategyApplied {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  system: string | { role: "system"; content: string; providerOptions?: any } | Array<{ role: "system"; content: string; providerOptions?: any }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: Record<string, any>;
  messages: ModelMessage[];
}

export interface CompactionResult {
  summary: ContentBlock[];
  /** Best-effort estimate of pre-compaction tokens (telemetry). */
  pre_tokens: number;
  /** Original message count (telemetry). */
  original_message_count: number;
  /** Compacted message count after boundary takes effect (telemetry). */
  compacted_message_count: number;
}

// ---------- token estimation ----------
// Cheap 4-chars-per-token heuristic; good enough for compaction triggers.
function estimateMessageTokens(m: ModelMessage): number {
  const s = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
  return Math.ceil(s.length / 4);
}
function estimateMessagesTokens(messages: ModelMessage[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}

// Trigger fraction: shouldCompact fires when estimated tokens exceed
// `triggerFraction * contextWindowTokens`. We pick 0.75 to give headroom
// for long single turns to flush tool results before the trigger.
//
// Tail preservation lives entirely in derive (history.ts) — it walks
// pre-boundary events using the same per-message estimate and renders the
// last K messages verbatim alongside the summary. Strategy doesn't need to
// coordinate; it just produces the summary covering everything.
const TRIGGER_FRACTION = 0.75;

// ============================================================
// SummarizeCompactionStrategy
// ============================================================
//
// CC-style compaction: send the FULL conversation (same model + same system
// + same tools + same messages prefix as main agent's last call) and append
// a single "summarize the above" user message. Anthropic's prompt cache
// matches the prefix and reads it for cheap; we only pay for the tiny
// appended message + summary output. Iterative summarization happens
// naturally — when a prior boundary exists, eventsToMessages already
// renders the prior summary as the leading user message, so the model sees
// `<conversation-summary>...</conversation-summary>` + new activity and
// produces a unified updated summary.
//
// Tail preservation: also CC-style. The strategy picks a recent tail of
// events to keep verbatim alongside the summary (default 10K min tokens / 5
// min text-block messages, capped at 40K). The boundary event records the
// tail event count; eventsToMessages renders the post-compaction view as
// `[summary, ...preserved_tail_messages, ...post_boundary_messages]`.
//
// Cost: 1 extra LLM call per compaction trigger. Most input tokens are
// cache_read (10% of write price). Output is bounded by maxSummaryTokens.

export class SummarizeCompactionStrategy implements CompactionStrategy {
  readonly name = "summarize";

  constructor(
    private opts: {
      headProtectMsgs?: number;
      tailMinTokens?: number;
      tailMaxTokens?: number;
      tailMinMessages?: number;
      triggerFraction?: number;
      summarySystemPrompt?: string;
      maxSummaryTokens?: number;
    } = {},
  ) {}

  shouldCompact(events: SessionEvent[], { contextWindowTokens }: { contextWindowTokens: number }): boolean {
    const messages = eventsToMessages(events);
    const tokens = estimateMessagesTokens(messages);
    return tokens > contextWindowTokens * (this.opts.triggerFraction ?? TRIGGER_FRACTION);
  }

  async compact(
    events: SessionEvent[],
    { model, systemPrompt, tools, applyCacheStrategy, runtime }: {
      model: LanguageModel;
      contextWindowTokens: number;
      systemPrompt: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: Record<string, any>;
      applyCacheStrategy: (
        systemPrompt: string,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tools: Record<string, any>,
        messages: ModelMessage[],
      ) => CacheStrategyApplied;
      runtime?: HarnessRuntime;
    },
  ): Promise<CompactionResult | null> {
    const messages = eventsToMessages(events);
    if (messages.length < 4) return null; // not worth compacting

    // Apply cache markers on the ORIGINAL messages — the breakpoint lands on
    // the original last message, matching the byte-prefix the main agent's
    // last call wrote into Anthropic's cache. Then append the summarize
    // request UNMARKED so we don't write a new cache entry for it
    // (skipCacheWrite-equivalent — the appended user message is so small
    // there's no point caching it).
    const cached = applyCacheStrategy(systemPrompt, tools, messages);

    const summarizeRequest: ModelMessage = {
      role: "user",
      content: this.opts.summarySystemPrompt ?? DEFAULT_SUMMARIZE_PROMPT,
    };

    const modelId = (model as { modelId?: string })?.modelId ?? "unknown";
    runtime?.broadcast({ type: "span.compaction_summarize_start", model: modelId });

    const result = await generateText({
      model,
      system: cached.system,
      tools: cached.tools,
      // Same tools as main agent so cache_key matches (tools is part of
      // Anthropic's cache prefix). toolChoice="none" forbids tool calls so
      // the model produces a text summary instead of trying to do work.
      // Per Anthropic docs, tool_choice is NOT in the cache key — safe.
      toolChoice: "none",
      messages: [...cached.messages, summarizeRequest],
      maxOutputTokens: this.opts.maxSummaryTokens ?? 2000,
    });

    runtime?.broadcast({
      type: "span.compaction_summarize_end",
      model: modelId,
      model_usage: result.usage ? {
        input_tokens: result.usage.inputTokens ?? 0,
        output_tokens: result.usage.outputTokens ?? 0,
        cache_read_input_tokens: result.usage.inputTokenDetails?.cacheReadTokens ?? 0,
        cache_creation_input_tokens: result.usage.inputTokenDetails?.cacheWriteTokens ?? 0,
      } : undefined,
      finish_reason: result.finishReason,
      final_text_length: typeof result.text === "string" ? result.text.length : 0,
    });

    return {
      summary: [{ type: "text", text: result.text }],
      pre_tokens: estimateMessagesTokens(messages),
      original_message_count: messages.length,
      // derive() picks tail at read time, so post-compaction message count
      // depends on the tail picking + post-boundary events. Report 1 here
      // as a lower bound (just the summary); telemetry consumers can compute
      // the actual derived size separately if needed.
      compacted_message_count: 1,
    };
  }
}

const DEFAULT_SUMMARIZE_PROMPT =
  "Summarize the entire conversation above. Preserve key decisions, file paths, tool results (commands run + their output), in-flight tasks, and explicit Next Steps. If the conversation already contains a <conversation-summary> block, produce an updated summary that supersedes it (combining prior summary + new activity). Be concise but specific. Output only the summary text, no preamble.";

// ============================================================
// Image stripping helper
// ============================================================
//
// Walk a message list and replace every image content block (top-level user
// images, image-data/image-url tool_result outputs, raw image parts) with a
// short placeholder. Used by the isolated strategies below to keep the
// summarize call cheap — the summarizer doesn't need to "see" the image
// bytes to know they were rendered, just that an image existed at that
// position.
//
// Pure function: same input → same output bytes. Doesn't mutate input.

const IMAGE_PLACEHOLDER = "[image stripped for compaction]";

function stripImagesFromMessages(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((m): ModelMessage => {
    if (typeof m.content === "string") return m;
    if (!Array.isArray(m.content)) return m;
    const filtered = m.content.map((part) => {
      if (!part || typeof part !== "object" || !("type" in part)) return part;
      const p = part as { type: string; output?: unknown };
      // Top-level image part on a user message
      if (p.type === "image" || p.type === "file") {
        return { type: "text" as const, text: IMAGE_PLACEHOLDER };
      }
      // Tool-result with content[] where individual items can be image-data / image-url
      if (p.type === "tool-result") {
        const out = p.output as { type?: string; value?: unknown } | undefined;
        if (out?.type === "content" && Array.isArray(out.value)) {
          const cleaned = out.value.map((b: { type?: string }) => {
            if (
              b?.type === "image-data" ||
              b?.type === "image-url" ||
              b?.type === "file-data" ||
              b?.type === "file-url"
            ) {
              return { type: "text", text: IMAGE_PLACEHOLDER };
            }
            return b;
          });
          return { ...part, output: { ...out, value: cleaned } };
        }
      }
      return part;
    });
    return { ...m, content: filtered as typeof m.content } as ModelMessage;
  });
}

// ============================================================
// CCStyleCompactionStrategy
// ============================================================
//
// Mirrors what Claude Code does in `compact.ts`: an isolated summarize
// call that does NOT try to reuse the main agent's prompt cache. Concretely:
//
//   - system: hardcoded one-liner ("You are a helpful AI assistant tasked
//     with summarizing conversations.") — NOT the main agent's full system
//   - tools:  empty (or a tiny fixed subset like just `read`) — NOT the
//     main agent's full toolset
//   - toolChoice: undefined — relies on the prompt to keep the model in
//     summarize mode rather than trying to "do work"
//   - messages: stripped of images and post-boundary slice (iterative
//     summarization happens via the existing boundary mechanism in
//     eventsToMessages — prior summary becomes the leading user message)
//   - thinking: not enabled (we don't pass providerOptions for thinking)
//
// Trade-off vs the original SummarizeCompactionStrategy:
//   + Robust across providers — does NOT rely on `tool_choice: "none"`,
//     which ai-sdk silently translates to "drop tools" for Anthropic and
//     which MiniMax doesn't honor reliably either way.
//   + Cheaper per call — short system, empty tools, no images to encode.
//   + Predictable empty-summary behavior — we skip writing the boundary
//     when text is empty so the model doesn't lose the entire history.
//   – Cache miss every time — the request prefix is fundamentally different
//     from the main agent's last call. Summary calls cost full input price.
//     Compaction is rare enough on real workloads that this is acceptable;
//     the original "share the prefix, hit cache" approach was empirically
//     not landing because of provider/SDK quirks anyway.

export class CCStyleCompactionStrategy implements CompactionStrategy {
  readonly name = "cc-style";

  constructor(
    private opts: {
      tailMinTokens?: number;
      tailMaxTokens?: number;
      tailMinMessages?: number;
      triggerFraction?: number;
      summarySystemPrompt?: string;
      maxSummaryTokens?: number;
    } = {},
  ) {}

  shouldCompact(events: SessionEvent[], { contextWindowTokens }: { contextWindowTokens: number }): boolean {
    const messages = eventsToMessages(events);
    const tokens = estimateMessagesTokens(messages);
    return tokens > contextWindowTokens * (this.opts.triggerFraction ?? TRIGGER_FRACTION);
  }

  async compact(
    events: SessionEvent[],
    { model, runtime }: {
      model: LanguageModel;
      contextWindowTokens: number;
      systemPrompt: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: Record<string, any>;
      applyCacheStrategy: (
        systemPrompt: string,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tools: Record<string, any>,
        messages: ModelMessage[],
      ) => CacheStrategyApplied;
      runtime?: HarnessRuntime;
    },
  ): Promise<CompactionResult | null> {
    const allMessages = eventsToMessages(events);
    if (allMessages.length < 4) return null;

    // Strip image bytes from the messages we send to the summarizer. The
    // summarizer doesn't need to see pixel data to summarize what happened —
    // it sees the placeholder and produces text like "the agent rendered a
    // chart showing X". Saves ~2K tokens per image in the conversation.
    const cleanedMessages = stripImagesFromMessages(allMessages);

    const summarizeRequest: ModelMessage = {
      role: "user",
      content: this.opts.summarySystemPrompt ?? CC_STYLE_SUMMARIZE_PROMPT,
    };

    const modelId = (model as { modelId?: string })?.modelId ?? "unknown";
    runtime?.broadcast({ type: "span.compaction_summarize_start", model: modelId });

    // Note what we are NOT passing:
    //   - The main agent's system prompt (we use our own short one)
    //   - The main agent's tools (we pass nothing)
    //   - toolChoice (we don't try to constrain — relies on the prompt)
    //   - applyCacheStrategy (we're not optimizing for cache reuse here)
    const result = await generateText({
      model,
      system: CC_STYLE_SYSTEM_PROMPT,
      messages: [...cleanedMessages, summarizeRequest],
      maxOutputTokens: this.opts.maxSummaryTokens ?? 2000,
    });

    runtime?.broadcast({
      type: "span.compaction_summarize_end",
      model: modelId,
      model_usage: result.usage ? {
        input_tokens: result.usage.inputTokens ?? 0,
        output_tokens: result.usage.outputTokens ?? 0,
        cache_read_input_tokens: result.usage.inputTokenDetails?.cacheReadTokens ?? 0,
        cache_creation_input_tokens: result.usage.inputTokenDetails?.cacheWriteTokens ?? 0,
      } : undefined,
      finish_reason: result.finishReason,
      final_text_length: typeof result.text === "string" ? result.text.length : 0,
    });

    // Empty-summary defense: if the model returned no text (provider quirk,
    // policy refusal, or the conversation was too short to summarize), do
    // NOT write a boundary event. Otherwise downstream eventsToMessages
    // would honor the empty-summary boundary and silently drop the entire
    // pre-boundary history. Caller will retry on the next turn.
    if (typeof result.text !== "string" || result.text.trim().length === 0) {
      return null;
    }

    return {
      summary: [{ type: "text", text: result.text }],
      pre_tokens: estimateMessagesTokens(allMessages),
      original_message_count: allMessages.length,
      compacted_message_count: 1,
    };
  }
}

const CC_STYLE_SYSTEM_PROMPT =
  "You are a helpful AI assistant tasked with summarizing conversations.";

const CC_STYLE_SUMMARIZE_PROMPT =
  "Provide a detailed but concise summary of the older conversation history. The most recent turns may be preserved verbatim outside your summary, so focus on information that would still be needed to continue the work with that recent context available. Cover: what was done, what is currently being worked on, which files are being modified, what needs to be done next, key user requests/constraints/preferences that should persist, and important technical decisions and why they were made. Do not respond to any questions in the conversation, only output the summary.";

// ============================================================
// OpenCodeStyleCompactionStrategy
// ============================================================
//
// Same isolation idea as CCStyleCompactionStrategy, with OpenCode's
// preferred summary template (Goal / Instructions / Discoveries /
// Accomplished / Relevant files). The difference vs CC-style is purely
// the prompt text — the structural choices (own system, no tools, no
// toolChoice, image stripped) are identical.
//
// Pick this one when you want summaries that downstream agents or humans
// can scan structurally rather than narratively.

export class OpenCodeStyleCompactionStrategy implements CompactionStrategy {
  readonly name = "opencode-style";

  constructor(
    private opts: {
      tailMinTokens?: number;
      tailMaxTokens?: number;
      tailMinMessages?: number;
      triggerFraction?: number;
      summarySystemPrompt?: string;
      maxSummaryTokens?: number;
    } = {},
  ) {}

  shouldCompact(events: SessionEvent[], { contextWindowTokens }: { contextWindowTokens: number }): boolean {
    const messages = eventsToMessages(events);
    const tokens = estimateMessagesTokens(messages);
    return tokens > contextWindowTokens * (this.opts.triggerFraction ?? TRIGGER_FRACTION);
  }

  async compact(
    events: SessionEvent[],
    { model, runtime }: {
      model: LanguageModel;
      contextWindowTokens: number;
      systemPrompt: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: Record<string, any>;
      applyCacheStrategy: (
        systemPrompt: string,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tools: Record<string, any>,
        messages: ModelMessage[],
      ) => CacheStrategyApplied;
      runtime?: HarnessRuntime;
    },
  ): Promise<CompactionResult | null> {
    const allMessages = eventsToMessages(events);
    if (allMessages.length < 4) return null;

    const cleanedMessages = stripImagesFromMessages(allMessages);

    const summarizeRequest: ModelMessage = {
      role: "user",
      content: this.opts.summarySystemPrompt ?? OPENCODE_STYLE_SUMMARIZE_PROMPT,
    };

    const modelId = (model as { modelId?: string })?.modelId ?? "unknown";
    runtime?.broadcast({ type: "span.compaction_summarize_start", model: modelId });

    const result = await generateText({
      model,
      system: OPENCODE_STYLE_SYSTEM_PROMPT,
      messages: [...cleanedMessages, summarizeRequest],
      maxOutputTokens: this.opts.maxSummaryTokens ?? 2000,
    });

    runtime?.broadcast({
      type: "span.compaction_summarize_end",
      model: modelId,
      model_usage: result.usage ? {
        input_tokens: result.usage.inputTokens ?? 0,
        output_tokens: result.usage.outputTokens ?? 0,
        cache_read_input_tokens: result.usage.inputTokenDetails?.cacheReadTokens ?? 0,
        cache_creation_input_tokens: result.usage.inputTokenDetails?.cacheWriteTokens ?? 0,
      } : undefined,
      finish_reason: result.finishReason,
      final_text_length: typeof result.text === "string" ? result.text.length : 0,
    });

    if (typeof result.text !== "string" || result.text.trim().length === 0) {
      return null;
    }

    return {
      summary: [{ type: "text", text: result.text }],
      pre_tokens: estimateMessagesTokens(allMessages),
      original_message_count: allMessages.length,
      compacted_message_count: 1,
    };
  }
}

const OPENCODE_STYLE_SYSTEM_PROMPT =
  "You are a helpful AI assistant tasked with summarizing conversations. Output only the summary text, no preamble.";

const OPENCODE_STYLE_SUMMARIZE_PROMPT = `When constructing the summary, try to stick to this template:
---
## Goal

[What goal(s) is the user trying to accomplish?]

## Instructions

- [What important instructions did the user give you that are relevant]
- [If there is a plan or spec, include information about it so next agent can continue using it]

## Discoveries

[What notable things were learned during this conversation that would be useful for the next agent to know when continuing the work]

## Accomplished

[What work has been completed, what work is still in progress, and what work is left?]

## Relevant files / directories

[Construct a structured list of relevant files that have been read, edited, or created that pertain to the task at hand. If all the files in a directory are relevant, include the path to the directory.]
---`;

// ============================================================
// Strategy registry
// ============================================================
//
// Used by DefaultHarness to resolve `agent.metadata.compaction_strategy`.
// Names match the `name` field on each strategy class.

export type CompactionStrategyName = "summarize" | "cc-style" | "opencode-style";

export function resolveCompactionStrategy(
  name: string | undefined,
  opts: {
    headProtectMsgs?: number;
    tailMinTokens?: number;
    tailMaxTokens?: number;
    tailMinMessages?: number;
    triggerFraction?: number;
    summarySystemPrompt?: string;
    maxSummaryTokens?: number;
  } = {},
): CompactionStrategy {
  switch (name) {
    case "cc-style":
      return new CCStyleCompactionStrategy(opts);
    case "opencode-style":
      return new OpenCodeStyleCompactionStrategy(opts);
    case "summarize":
    case undefined:
      return new SummarizeCompactionStrategy(opts);
    default:
      // Unknown name → fall back to default. Don't throw — agent metadata
      // is user-controlled and a typo shouldn't crash the harness.
      console.warn(`[compaction] unknown strategy "${name}", falling back to "summarize"`);
      return new SummarizeCompactionStrategy(opts);
  }
}

// ============================================================
// Backwards-compatible adapter (deprecated)
// ============================================================
// Old API used by anything still importing { SummarizeCompaction } from
// this module. Kept until call sites migrate.
/** @deprecated use SummarizeCompactionStrategy via DefaultHarness */
export class SummarizeCompaction {
  shouldCompact(messages: ModelMessage[], maxTokens: number = 100000): boolean {
    return estimateMessagesTokens(messages) > maxTokens * 0.85;
  }
  async compact(messages: ModelMessage[], model: LanguageModel): Promise<ModelMessage[]> {
    if (messages.length <= 4) return messages;
    const headProtect = 2;
    const keepStart = messages.slice(0, headProtect);
    const keepEnd = messages.slice(-4);
    const toSummarize = messages.slice(headProtect, -4);
    if (toSummarize.length === 0) return messages;
    const summaryContent = toSummarize
      .map((m) => {
        const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `[${m.role}]: ${text.slice(0, 500)}`;
      })
      .join("\n");
    const result = await generateText({
      model,
      system: "Summarize this conversation excerpt concisely. Preserve key decisions, tool results, and file paths. Be brief.",
      messages: [{ role: "user", content: summaryContent }],
      maxOutputTokens: 1000,
    });
    const summaryMessage: ModelMessage = {
      role: "assistant",
      content: `[Conversation summary of ${toSummarize.length} messages]: ${result.text}`,
    };
    return [...keepStart, summaryMessage, ...keepEnd];
  }
}
