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
