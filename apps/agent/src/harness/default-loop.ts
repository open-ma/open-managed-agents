import { generateText, stepCountIs } from "ai";
import type { ContentPart, ModelMessage, LanguageModel, SystemModelMessage } from "ai";
import type { HarnessInterface, HarnessContext, HarnessRuntime } from "./interface";
import type { SessionEvent, ContentBlock, AgentToolUseEvent } from "@open-managed-agents/shared";
import { eventsToMessages } from "../runtime/history";
import { SummarizeCompactionStrategy, resolveCompactionStrategy } from "./compaction";
import type { CompactionStrategy } from "./compaction";

const BUILTIN_TOOLS = new Set(["bash", "read", "write", "edit", "glob", "grep", "web_fetch", "web_search"]);
const isMcpTool = (name: string) => name.startsWith("mcp_");
const isBuiltinTool = (name: string) =>
  BUILTIN_TOOLS.has(name) || isMcpTool(name) || name.startsWith("call_agent_") || name.startsWith("memory_");

// LLM call resilience settings (inspired by Claude Code)
const MAX_RETRIES = 10;
const BASE_RETRY_DELAY = 2000;   // 2s, doubles each retry (capped at 30s)
const API_TIMEOUT_MS = 300000;   // 5 minutes per generateText call

/**
 * Retry an async function with exponential backoff + jitter.
 */
async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  maxRetries: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (parentSignal?.aborted) throw new Error("Aborted");

    // Create a timeout signal for this attempt
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
      const result = await fn(controller.signal);
      clearTimeout(timer);
      return result;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;

      // Don't retry on user abort
      if (parentSignal?.aborted) throw err;

      // Don't retry on non-transient errors
      const msg = describeError(err);
      const isTransient = /timeout|abort|429|529|5\d\d|ECONNRESET|overloaded|rate.limit|fetch failed|silent_stop/i.test(msg);

      console.log(`[retry] attempt ${attempt + 1}/${maxRetries + 1} failed: ${msg.slice(0, 150)} transient=${isTransient}`);

      if (!isTransient) throw err;

      // Don't retry on last attempt
      if (attempt >= maxRetries) break;

      // Exponential backoff with jitter, capped at 30s
      const delay = Math.min(30000, BASE_RETRY_DELAY * Math.pow(2, attempt)) * (0.75 + Math.random() * 0.5);
      console.log(`[retry] waiting ${Math.round(delay)}ms before attempt ${attempt + 2}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

/**
 * Extract a meaningful error description. Handles cases where err.message
 * is empty (e.g. network failures, non-standard API errors).
 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    if (err.message) return err.message;
    // Empty message — include name, cause, or status code if available
    const parts: string[] = [err.name || "Error"];
    if ("cause" in err && err.cause) parts.push(`cause: ${String(err.cause)}`);
    if ("status" in err) parts.push(`status: ${(err as any).status}`);
    if ("statusCode" in err) parts.push(`statusCode: ${(err as any).statusCode}`);
    if ("url" in err) parts.push(`url: ${(err as any).url}`);
    return parts.join(", ");
  }
  return String(err) || "Unknown error";
}

/**
 * Extract the MCP server name from a tool name like "mcp_github_call" or "mcp_github_list_tools".
 */
function extractMcpServerName(toolName: string): string {
  // mcp_{server_name}_{call|list_tools}
  const withoutPrefix = toolName.slice(4); // Remove "mcp_"
  const lastUnderscore = withoutPrefix.lastIndexOf("_");
  // Handle _list_tools (two underscores)
  if (withoutPrefix.endsWith("_list_tools")) {
    return withoutPrefix.slice(0, withoutPrefix.length - "_list_tools".length);
  }
  if (lastUnderscore > 0) {
    return withoutPrefix.slice(0, lastUnderscore);
  }
  return withoutPrefix;
}

/**
 * Map a tool-call ContentPart to the right wire event family
 * (mcp / built-in / custom). Also emits agent.thread_message_sent for
 * call_agent_* sub-agent invocations.
 *
 * Lives outside DefaultHarness so the bijection contract is co-located
 * with `eventsToMessages` — the inverse mapping in history.ts.
 */
function emitToolCallEvent(
  runtime: HarnessContext["runtime"],
  tools: Record<string, any>,
  part: ContentPart<any> & { type: "tool-call" },
): void {
  const callInput = (part.input ?? {}) as Record<string, unknown>;
  const toolName = part.toolName;
  const toolCallId = part.toolCallId;

  if (toolName.startsWith("call_agent_")) {
    runtime.broadcast({
      type: "agent.thread_message_sent",
      to_thread_id: toolCallId,
      content: [{ type: "text", text: String(callInput.message || "") }],
    });
  }

  if (isMcpTool(toolName)) {
    runtime.broadcast({
      type: "agent.mcp_tool_use",
      id: toolCallId,
      mcp_server_name: extractMcpServerName(toolName),
      name: toolName,
      input: callInput,
    });
  } else if (isBuiltinTool(toolName)) {
    const event: AgentToolUseEvent = {
      type: "agent.tool_use",
      id: toolCallId,
      name: toolName,
      input: callInput,
    };
    if (!tools[toolName]?.execute) event.evaluated_permission = "ask";
    runtime.broadcast(event);
  } else {
    runtime.broadcast({
      type: "agent.custom_tool_use",
      id: toolCallId,
      name: toolName,
      input: callInput,
    });
  }
}

/**
 * Map a tool-result (or tool-error) ContentPart to a wire event,
 * normalizing the AI SDK's ToolResultOutput union into the wire's
 * `string | ContentBlock[]` representation. Also emits
 * agent.thread_message_received for call_agent_*.
 *
 * Normalization rules — fixed so that read(write(m)) === m at byte level:
 *   text       → string
 *   content[]  → ContentBlock[] (TextBlock for text parts; image/document
 *                ContentBlocks pass through if already shaped that way)
 *   json/error → JSON-stringified string (lossy for the AI SDK type tag,
 *                but Anthropic only ever sees the string, so derive can
 *                rebuild a {type:"text"} ToolResultOutput equivalently)
 *   already-shaped ContentBlock or ContentBlock[] (legacy tool returns)
 *                → wrap or pass through
 */
function emitToolResultEvent(
  runtime: HarnessContext["runtime"],
  part: ContentPart<any> & { type: "tool-result" | "tool-error" },
): void {
  const toolCallId = part.toolCallId;
  const toolName = part.toolName;
  // tool-error has `error`, tool-result has `output`.
  const raw =
    part.type === "tool-error"
      ? { type: "error-text", value: String((part as any).error ?? "") }
      : ((part as any).output ?? (part as any).result);

  const content = normalizeToolOutputForWire(raw);

  if (isMcpTool(toolName)) {
    runtime.broadcast({
      type: "agent.mcp_tool_result",
      mcp_tool_use_id: toolCallId,
      content: typeof content === "string" ? content : JSON.stringify(content),
    });
  } else {
    runtime.broadcast({
      type: "agent.tool_result",
      tool_use_id: toolCallId,
      content,
    });
  }

  if (toolName.startsWith("call_agent_")) {
    const text = typeof content === "string"
      ? content
      : content.map((b) => (b.type === "text" ? b.text : "")).join("");
    runtime.broadcast({
      type: "agent.thread_message_received",
      from_thread_id: toolCallId,
      content: [{ type: "text", text }],
    });
  }
}

/**
 * AI SDK ToolResultOutput union → wire `string | ContentBlock[]`.
 * Pure function; same input → same output bytes.
 */
function normalizeToolOutputForWire(raw: unknown): string | ContentBlock[] {
  if (typeof raw === "string") return raw;
  if (raw == null) return "";

  // Already wire-shape (single ContentBlock or array)
  if (typeof raw === "object" && "type" in raw) {
    const r = raw as { type: string };
    if (r.type === "text" && "text" in raw) return [raw as ContentBlock];
    if (r.type === "image" && "source" in raw) return [raw as ContentBlock];
    if (r.type === "document" && "source" in raw) return [raw as ContentBlock];

    // AI SDK ToolResultOutput discriminated union
    if (r.type === "text" && "value" in raw) return String((raw as unknown as { value: unknown }).value);
    if (r.type === "json") return JSON.stringify((raw as unknown as { value: unknown }).value);
    if (r.type === "error-text" || r.type === "error-json") {
      const v = (raw as unknown as { value: unknown }).value;
      return typeof v === "string" ? v : JSON.stringify(v);
    }
    if (r.type === "execution-denied") {
      return JSON.stringify({ denied: true, reason: (raw as unknown as { reason?: string }).reason });
    }
    if (r.type === "content" && Array.isArray((raw as unknown as { value: unknown[] }).value)) {
      const parts = (raw as unknown as { value: Array<{ type: string; text?: string; data?: string; mediaType?: string; url?: string }> }).value;
      return parts.map((p): ContentBlock => {
        if (p.type === "text") return { type: "text", text: p.text ?? "" };
        if (p.type === "image-data" || p.type === "media") {
          return {
            type: "image",
            source: { type: "base64", media_type: p.mediaType, data: p.data },
          };
        }
        if (p.type === "image-url") {
          return { type: "image", source: { type: "url", url: p.url, media_type: p.mediaType } };
        }
        if (p.type === "file-data") {
          return {
            type: "document",
            source: { type: "base64", media_type: p.mediaType, data: p.data },
          };
        }
        if (p.type === "file-url") {
          return { type: "document", source: { type: "url", url: p.url, media_type: p.mediaType } };
        }
        return { type: "text", text: JSON.stringify(p) };
      });
    }
  }

  if (Array.isArray(raw) && raw.every((b) => b && typeof b === "object" && "type" in b)) {
    return raw as ContentBlock[];
  }

  return JSON.stringify(raw);
}

export class DefaultHarness implements HarnessInterface {
  /**
   * Compaction strategy resolved from agent config. Cached on the harness
   * instance so shouldCompact / compact (which don't get ctx) can use it.
   * Set in run() before any compaction hook fires.
   */
  private compactionStrategy: CompactionStrategy = new SummarizeCompactionStrategy();

  async run(ctx: HarnessContext): Promise<void> {
    const { agent, userMessage, runtime, tools, model, systemPrompt } = ctx;

    // Resolve compaction params from agent config. Strategy class is
    // selectable via `agent.metadata.compaction_strategy` (defaults to
    // "summarize" for backward compat); shared knobs (tail, trigger
    // fraction) apply to whichever strategy is picked.
    const meta = (agent.metadata ?? {}) as Record<string, unknown>;
    const triggerFraction = typeof meta.compaction_trigger_fraction === "number"
      ? meta.compaction_trigger_fraction as number
      : undefined;
    const tailMinTokens = typeof meta.compaction_tail_min_tokens === "number"
      ? meta.compaction_tail_min_tokens as number
      : undefined;
    const tailMaxTokens = typeof meta.compaction_tail_max_tokens === "number"
      ? meta.compaction_tail_max_tokens as number
      : undefined;
    const tailMinMessages = typeof meta.compaction_tail_min_messages === "number"
      ? meta.compaction_tail_min_messages as number
      : undefined;
    const strategyName = typeof meta.compaction_strategy === "string"
      ? meta.compaction_strategy as string
      : undefined;
    this.compactionStrategy = resolveCompactionStrategy(strategyName, {
      tailMinTokens,
      tailMaxTokens,
      tailMinMessages,
      triggerFraction,
    });

    // --- Harness decides HOW to deliver context to the model ---

    // 1. Compaction check: ask the harness's own shouldCompact + compact
    // hooks. Default impls live below the class. Custom harnesses override.
    // compact() persists its product as a agent.thread_context_compacted
    // event with summary — derive() then sees the boundary and serves the
    // summarized view from this turn forward (NOT recomputed per turn).
    const allEvents = runtime.history.getEvents();
    const ctxWindow = resolveContextWindowTokens(model);
    if (this.shouldCompact && this.compact && this.shouldCompact(allEvents, { contextWindowTokens: ctxWindow })) {
      try {
        await this.compact(allEvents, runtime, { model, systemPrompt, tools });
      } catch (err) {
        // Compaction is best-effort. Log and continue — the next turn will
        // try again. Don't fail the whole turn over a summarize error.
        console.warn(`[compact] failed: ${(err as Error).message}`);
      }
    }

    // 2. Derive ModelMessage[] from events. Default = eventsToMessages
    // (strict bijection inverse of write-side, with boundary handling).
    // Custom harnesses can override for sliding-window / RAG / etc.
    const messages = this.deriveModelContext
      ? this.deriveModelContext(runtime.history.getEvents())
      : runtime.history.getMessages();

    // 3. Apply provider-specific cache strategy. Anthropic: tag system block
    // + last tool + last message + (optional) one mid-conversation breakpoint
    // for long turns. Other providers: no-op (OpenAI prompt caching is
    // automatic; Google uses cachedContent; MiniMax TBD).
    //
    // AI SDK doesn't expose a provider-agnostic cache abstraction — each
    // provider exposes its own knobs via providerOptions. We branch on
    // model.provider here. To add OpenAI/Gemini cache support later, extend
    // the strategy table below; the harness loop above doesn't change.
    const cached = applyProviderCacheStrategy(model, systemPrompt, tools, messages);
    const finalMessages = cached.messages;

    // 4. Emit span event: model request start
    const modelId = typeof agent.model === "string" ? agent.model : agent.model.id;
    runtime.broadcast({ type: "span.model_request_start", model: modelId });

    // 5. Run agent loop with retry + timeout + prompt caching
    const result = await withRetry(async (signal) => {
      const r = await generateText({
      model,
      system: cached.system,
      messages: finalMessages,
      tools: cached.tools,
      stopWhen: stepCountIs(100),
      abortSignal: signal,

      onStepFinish: async (step) => {
        // Iterate step.content[] in order to preserve LLM output ordering
        // (reasoning → text → tool-call interleaving). The previous "reasoning
        // first, text next, tool-calls last" loop assumed an ordering AI SDK
        // doesn't guarantee, breaking byte-determinism on derive().
        //
        // Each part maps to exactly one wire event. The mapping is the inverse
        // of history.ts eventsToMessages — together they form the
        // ModelMessage[] ↔ SessionEvent[] bijection that prompt-cache
        // determinism rests on.
        for (const part of step.content as ReadonlyArray<ContentPart<any>>) {
          switch (part.type) {
            case "reasoning":
              runtime.broadcast({
                type: "agent.thinking",
                text: part.text,
                providerOptions: part.providerMetadata as Record<string, unknown> | undefined,
              });
              break;
            case "text":
              // Trim trailing whitespace at write time. Anthropic's @ai-sdk
              // provider trims the LAST text of the LAST assistant message
              // before sending; without our normalization, the same stored
              // assistant text would render with vs. without `\n` depending on
              // whether it's the tail of the conversation, busting the cache
              // on the next turn.
              runtime.broadcast({
                type: "agent.message",
                content: [{ type: "text", text: part.text.replace(/\s+$/, "") }],
              });
              break;
            case "tool-call":
              emitToolCallEvent(runtime, tools, part);
              break;
            case "tool-result":
            case "tool-error":
              emitToolResultEvent(runtime, part);
              break;
            // source / file / tool-approval-request: not produced by current
            // tool surface; intentionally skipped. Add cases here if those
            // become reachable — the bijection requires every part write a
            // matching wire event.
          }
        }
      },
    });
      // Silent-stop detection: model returned finish_reason="stop" with empty
      // text and no tool calls mid-conversation. Empirically a transient model
      // hiccup (seen on MiniMax). Throw with a "silent_stop" message so withRetry's
      // isTransient regex catches it and retries the call. Same level as a
      // network error; uses the same MAX_RETRIES + backoff budget.
      if (
        r.finishReason === "stop"
        && (!r.text || r.text.trim().length === 0)
        && (!r.toolCalls || r.toolCalls.length === 0)
      ) {
        throw new Error("silent_stop: model returned finish_reason=stop with empty text and no tool calls");
      }
      return r;
    }, MAX_RETRIES, runtime.abortSignal);


    // 8. Detect pending tool confirmations and custom tool results
    if (result.toolCalls?.length) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resultedIds = new Set((result.toolResults as any[])?.map((r: any) => r.toolCallId) ?? []);
      const pending = result.toolCalls
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((c: any) => !resultedIds.has(c.toolCallId))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((c: any) => c.toolCallId);
      if (pending.length && ctx.runtime.pendingConfirmations) {
        ctx.runtime.pendingConfirmations.push(...pending);
      }
    }

    // 9. Emit span event: model request end
    runtime.broadcast({
      type: "span.model_request_end",
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

    // 10. Report token usage
    if (result.usage && runtime.reportUsage) {
      await runtime.reportUsage(
        result.usage.inputTokens ?? 0,
        result.usage.outputTokens ?? 0
      );
    }
  }

  // -- Default hook implementations --
  // Custom harnesses can override any of these by extending DefaultHarness
  // and replacing the method, or by implementing HarnessInterface directly.

  /**
   * Default: simple eventsToMessages (already byte-deterministic + handles
   * agent.thread_context_compacted boundary). Override for sliding window /
   * RAG / hierarchical strategies.
   */
  deriveModelContext(events: SessionEvent[]) {
    return eventsToMessages(events);
  }

  /**
   * Default: delegate to this.compactionStrategy (configured in run() from
   * agent.metadata overrides). Custom harnesses can override by extending
   * DefaultHarness and replacing this method.
   */
  shouldCompact(events: SessionEvent[], ctx: { contextWindowTokens: number }): boolean {
    return this.compactionStrategy.shouldCompact(events, ctx);
  }

  /**
   * Default: run this.compactionStrategy.compact and broadcast the result
   * as an `agent.thread_context_compacted` event with the summary attached.
   * eventsToMessages then honors the boundary marker on subsequent derives.
   *
   * Threads systemPrompt + tools + the provider cache strategy through to
   * the strategy so it can build a same-shape request that matches main
   * agent's prefix bytes (cache reuse).
   */
  async compact(
    events: SessionEvent[],
    runtime: HarnessRuntime,
    ctx: { model: LanguageModel; systemPrompt: string; tools: Record<string, any> },
  ): Promise<void> {
    const ctxWindow = resolveContextWindowTokens(ctx.model);
    const result = await this.compactionStrategy.compact(events, {
      model: ctx.model,
      contextWindowTokens: ctxWindow,
      systemPrompt: ctx.systemPrompt,
      tools: ctx.tools,
      applyCacheStrategy: (sys, tls, msgs) => applyProviderCacheStrategy(ctx.model, sys, tls, msgs),
      runtime,
    });
    if (!result) return;
    runtime.broadcast({
      type: "agent.thread_context_compacted",
      original_message_count: result.original_message_count,
      compacted_message_count: result.compacted_message_count,
      summary: result.summary,
      trigger: "auto",
      pre_tokens: result.pre_tokens,
    });
  }

  /**
   * Default: write each platformReminder as a `<system-reminder>` user.message
   * event. Each reminder lands once at session-init time, becoming part of
   * the cached prefix. The model treats them as user-side context (Claude
   * recognizes <system-reminder> tags from training).
   *
   * SessionDO calls this exactly once per session, before the first turn.
   * Custom harnesses can override to inject differently — or no-op to skip
   * platform reminders entirely (e.g. RAG-based harness builds its own).
   */
  async onSessionInit(ctx: HarnessContext, runtime: HarnessRuntime): Promise<void> {
    for (const r of ctx.platformReminders ?? []) {
      runtime.broadcast({
        type: "user.message",
        content: [
          {
            type: "text",
            text: `<system-reminder source="${r.source}">\n${r.text}\n</system-reminder>`,
          },
        ],
      });
    }
  }
}

// === Token estimation + context-window resolution ===
// Both are best-effort heuristics. The bijection itself doesn't depend on
// these — they only drive WHEN to compact, not what the model sees.

/** Crude: 4 chars ≈ 1 token. Fine for compaction trigger; not for billing. */
function estimateMessageTokens(m: ModelMessage): number {
  const s = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
  return Math.ceil(s.length / 4);
}

function estimateMessagesTokens(messages: ModelMessage[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}

/**
 * Map a LanguageModel to its context window in tokens. ai-sdk doesn't
 * expose this uniformly, so we hand-encode the common cases. Fallback to
 * 200K (Claude 4+ minimum) if unknown.
 */
function resolveContextWindowTokens(model: LanguageModel): number {
  const id = (model as any)?.modelId ?? (typeof model === "string" ? model : "");
  if (typeof id !== "string") return 200_000;
  if (id.includes("opus-4-7") || id.includes("opus-4-6") || id.includes("sonnet-4-6")) return 1_000_000;
  if (id.includes("haiku-4-5")) return 200_000;
  if (id.includes("opus") || id.includes("sonnet")) return 200_000;
  if (id.includes("MiniMax")) return 1_000_000;
  return 200_000;
}

// === Provider-specific prompt cache strategy ===
//
// AI SDK has no provider-agnostic cache abstraction. Each provider exposes
// its own knobs via providerOptions, so we branch on model.provider:
//   anthropic: cache_control breakpoints on system / last tool / mid / last msg
//   openai:    automatic on the API side (no client-side knob to set)
//   google:    cachedContent (different model — explicit cache resource creation)
//   minimax:   TBD
//   others:    no-op
//
// Adding a provider later: add a case below; the calling harness code
// doesn't change.

interface CacheStrategyResult {
  system: string | SystemModelMessage | SystemModelMessage[];
  tools: Record<string, any>;
  messages: ModelMessage[];
}

function applyProviderCacheStrategy(
  model: LanguageModel,
  systemPrompt: string,
  tools: Record<string, any>,
  messages: ModelMessage[],
): CacheStrategyResult {
  const provider = (model as any)?.provider as string | undefined;
  if (typeof provider === "string" && provider.toLowerCase().includes("anthropic")) {
    return applyAnthropicCacheControl(systemPrompt, tools, messages);
  }
  // No-op for other providers — system stays a string, no providerOptions
  // injected, no message mutation. Add cases here when wiring OpenAI /
  // Gemini / MiniMax cache support.
  return { system: systemPrompt, tools, messages };
}

/**
 * Anthropic prompt-cache strategy — up to 4 breakpoints per request.
 *
 * Render order is tools → system → messages. Marks (in priority order):
 *  1. `system` — promote string → SystemModelMessage with cacheControl.
 *     Caches both `tools` (everything before system in the prefix) and
 *     `system` itself.
 *  2. last `tool` — covers the tool block alone if system also contained
 *     dynamic content (defensive — system change shouldn't shift tools).
 *  3. last `message` — the conversation tail breakpoint. Most cache hits
 *     come from this on multi-turn chats.
 *  4. mid-conversation `message` — only if messages.length > 30. Anthropic's
 *     20-block lookback window means long single turns blow past the
 *     boundary; an intermediate breakpoint catches reads inside the turn.
 *
 * All marker bytes are stable (cacheControl object is identical across
 * turns), so adding them doesn't itself bust cache.
 */
function applyAnthropicCacheControl(
  systemPrompt: string,
  tools: Record<string, any>,
  messages: ModelMessage[],
): CacheStrategyResult {
  const ephemeral = { anthropic: { cacheControl: { type: "ephemeral" } } };

  // (1) System block as cached SystemModelMessage. Required for system to
  // cache at all — string-form `system` is wrapped by the provider with no
  // providerOptions, which means cache_control is omitted on the wire.
  const system: SystemModelMessage = {
    role: "system",
    content: systemPrompt,
    providerOptions: ephemeral,
  };

  // (2) Tools: tag the LAST tool's providerOptions so the entire tools
  // block becomes a 2nd cache breakpoint.
  const toolNames = Object.keys(tools);
  let cachedTools: Record<string, any> = tools;
  if (toolNames.length > 0) {
    const lastName = toolNames[toolNames.length - 1];
    const lastTool = tools[lastName];
    cachedTools = {
      ...tools,
      [lastName]: {
        ...lastTool,
        providerOptions: { ...(lastTool?.providerOptions ?? {}), ...ephemeral },
      },
    };
  }

  // (3) Last 1 message — Claude Code style.
  const cachedMessages: ModelMessage[] = messages.map((m) => ({ ...m }));
  if (cachedMessages.length > 0) {
    const last = cachedMessages[cachedMessages.length - 1] as any;
    last.providerOptions = { ...(last.providerOptions ?? {}), ...ephemeral };
  }

  return { system, tools: cachedTools, messages: cachedMessages };
}
