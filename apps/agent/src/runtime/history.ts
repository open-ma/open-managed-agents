import type { ModelMessage, ToolModelMessage, AssistantModelMessage } from "ai";
import type { HistoryStore } from "../harness/interface";
import { CfDoEventLog, ensureSchema as ensureCfDoSchema } from "@open-managed-agents/event-log/cf-do";
import { InMemoryEventLog } from "@open-managed-agents/event-log/memory";
import type {
  SessionEvent,
  AgentMessageEvent,
  AgentThinkingEvent,
  AgentToolUseEvent,
  AgentToolResultEvent,
  AgentMcpToolUseEvent,
  AgentMcpToolResultEvent,
  AgentCustomToolUseEvent,
  AgentThreadContextCompactedEvent,
  ContentBlock,
  UserMessageEvent,
} from "@open-managed-agents/shared";
import { generateEventId } from "@open-managed-agents/shared";

/**
 * Convert SessionEvent[] → ModelMessage[]. The strict inverse of
 * default-loop.ts onStepFinish writes — together they form the bijection
 * that prompt-cache determinism rests on.
 *
 * Invariant: write(read(events)) === events at the byte level for every
 * event sequence produced by onStepFinish (modulo lifecycle/span/notification
 * events, which are intentionally not in model context). Any byte drift here
 * busts Anthropic's cache from the drift point onward.
 *
 * Determinism rules:
 *   - Pre-pass once to build toolCallId → toolName, so tool-result events can
 *     resolve toolName even when the matching tool_use lies in a different
 *     "flush window" (the old `pendingToolCalls.find` failed on that case
 *     and produced "unknown" — a permanent cache miss).
 *   - Iterate events strictly by storage order (caller's job to sort by seq).
 *   - Honor the LAST agent.thread_context_compacted boundary that carries a
 *     `summary` payload: build pre-boundary and post-boundary messages
 *     separately, inject the summary, pick a CC-style tail of the
 *     pre-boundary messages by token budget, then output
 *     `[summary, ...tail, ...post-boundary]`. Boundary events without a
 *     summary are pure UI signals (no effect here).
 *   - Skip lifecycle.* / span.* / notification.* / agent.thread_message_*
 *     and bare (summary-less) compaction events.
 */
export function eventsToMessages(events: SessionEvent[]): ModelMessage[] {
  // Pre-pass: gather toolName for every toolCallId emitted by ANY tool_use
  // event. Resolves the cross-window lookup problem.
  const toolNameById = new Map<string, string>();
  for (const event of events) {
    if (
      event.type === "agent.tool_use" ||
      event.type === "agent.mcp_tool_use" ||
      event.type === "agent.custom_tool_use"
    ) {
      const e = event as AgentToolUseEvent | AgentMcpToolUseEvent | AgentCustomToolUseEvent;
      const name = event.type === "agent.mcp_tool_use"
        ? `mcp_${(e as AgentMcpToolUseEvent).mcp_server_name}_call`
        : (e as AgentToolUseEvent | AgentCustomToolUseEvent).name;
      toolNameById.set(e.id, name);
    }
  }

  // Find the last compaction boundary that actually carries a summary —
  // that's the one we honor. Earlier boundaries get superseded.
  //
  // "Carries a summary" means: at least one block contains real content.
  // A bare array-length check (`summary.length > 0`) is NOT sufficient —
  // a strategy that returns `[{type:"text", text:""}]` would still pass
  // it and silently drop the entire pre-boundary history downstream.
  // This is the downstream half of the empty-summary defense; the
  // upstream half lives in DefaultHarness.compact() where the boundary
  // event is written.
  let boundaryIdx = -1;
  let boundarySummary: ContentBlock[] | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "agent.thread_context_compacted") {
      const ce = e as AgentThreadContextCompactedEvent;
      const hasContent = ce.summary?.some(
        (b) => (b.type === "text" && b.text.trim().length > 0)
          || b.type === "image"
          || b.type === "document",
      );
      if (hasContent) {
        boundaryIdx = i;
        boundarySummary = ce.summary;
        break;
      }
    }
  }

  // No boundary → walk everything straight through.
  if (boundaryIdx < 0) {
    return buildMessages(events, 0, events.length, toolNameById);
  }

  // Boundary exists. Build pre/post separately; pick CC-style tail from pre.
  const preBoundary = buildMessages(events, 0, boundaryIdx, toolNameById);
  const postBoundary = buildMessages(events, boundaryIdx + 1, events.length, toolNameById);
  const tail = pickPreservedTail(preBoundary, {
    minTokens: TAIL_MIN_TOKENS,
    maxTokens: TAIL_MAX_TOKENS,
    minMessages: TAIL_MIN_MESSAGES,
  });

  // Inject the boundary summary as a synthesized user message that opens
  // the post-compaction view. Wrapped in <conversation-summary> tags so the
  // model recognizes it as platform-injected context.
  const summaryMessage: ModelMessage = {
    role: "user",
    content: [{ type: "text", text: serializeSummaryAsText(boundarySummary!) }],
  };

  return [summaryMessage, ...tail, ...postBoundary];
}

/**
 * Walk events[fromIdx..toIdx) into ModelMessage[]. Maintains pending
 * assistant + tool state internally, flushes at the end. Used by
 * eventsToMessages on either the full stream, the pre-boundary range, or
 * the post-boundary range.
 */
function buildMessages(
  events: SessionEvent[],
  fromIdx: number,
  toIdx: number,
  toolNameById: Map<string, string>,
): ModelMessage[] {
  const messages: ModelMessage[] = [];
  let pendingAssistantContent: AssistantModelMessage["content"] = [];
  let pendingToolContent: ToolModelMessage["content"] = [];

  const flushAssistant = () => {
    if (pendingAssistantContent.length > 0) {
      messages.push({ role: "assistant", content: pendingAssistantContent });
      pendingAssistantContent = [];
    }
  };
  const flushTools = () => {
    if (pendingToolContent.length > 0) {
      messages.push({ role: "tool", content: pendingToolContent });
      pendingToolContent = [];
    }
  };

  for (let i = fromIdx; i < toIdx; i++) {
    const event = events[i];
    // AMA `user.interrupt` flushes pending user inputs by setting
    // `cancelled_at` on their event-log row. Adapter (`getEvents` in
    // packages/event-log/src/cf-do/index.ts) stashes that as
    // `cancelled_at_ms` on the parsed event. Skip everything that's
    // been cancelled so the LLM context never sees a flushed input.
    // Only user.* events are ever cancelled today; the guard is
    // type-agnostic so future cancellation kinds (e.g. partial
    // assistant message rollback) inherit the same behavior.
    if ((event as unknown as { cancelled_at_ms?: number }).cancelled_at_ms != null) {
      continue;
    }
    switch (event.type) {
      case "user.message": {
        flushAssistant();
        flushTools();
        messages.push({
          role: "user",
          content: userContentToParts((event as UserMessageEvent).content),
        });
        break;
      }
      case "agent.thinking": {
        flushTools();
        const e = event as AgentThinkingEvent;
        if (e.text != null) {
          pendingAssistantContent.push({
            type: "reasoning",
            text: e.text,
            ...(e.providerOptions ? { providerOptions: e.providerOptions as Record<string, any> } : {}),
          });
        }
        break;
      }
      case "agent.message": {
        flushTools();
        const e = event as AgentMessageEvent;
        for (const block of e.content) {
          if (block.type === "text") {
            pendingAssistantContent.push({ type: "text", text: block.text });
          }
        }
        break;
      }
      case "agent.tool_use":
      case "agent.mcp_tool_use":
      case "agent.custom_tool_use": {
        flushTools();
        const e = event as AgentToolUseEvent | AgentMcpToolUseEvent | AgentCustomToolUseEvent;
        const toolName = event.type === "agent.mcp_tool_use"
          ? `mcp_${(e as AgentMcpToolUseEvent).mcp_server_name}_call`
          : (e as AgentToolUseEvent | AgentCustomToolUseEvent).name;
        pendingAssistantContent.push({
          type: "tool-call",
          toolCallId: e.id,
          toolName,
          input: e.input,
        });
        break;
      }
      case "agent.tool_result":
      case "agent.mcp_tool_result": {
        flushAssistant();
        const e = event as AgentToolResultEvent | AgentMcpToolResultEvent;
        const toolCallId = event.type === "agent.tool_result"
          ? (e as AgentToolResultEvent).tool_use_id
          : (e as AgentMcpToolResultEvent).mcp_tool_use_id;
        const toolName = toolNameById.get(toolCallId) ?? "unknown";
        const output = wireContentToToolOutput((e as AgentToolResultEvent).content);
        pendingToolContent.push({
          type: "tool-result",
          toolCallId,
          toolName,
          output: output as any,
        });
        break;
      }
    }
  }

  flushAssistant();
  flushTools();
  return messages;
}

// Tail preservation params (Claude Code-style defaults — observed values
// that work well for multi-turn coding sessions):
//   minTokens: 10_000  maxTokens: 40_000  minTextMessages: 5
const TAIL_MIN_TOKENS = 10_000;
const TAIL_MAX_TOKENS = 40_000;
const TAIL_MIN_MESSAGES = 5;
// Industry-standard heuristic: image blocks bill at a flat ~2K tokens each.
const IMAGE_TOKEN_SIZE = 2_000;

/**
 * Per-content-part token estimate. Text uses length/4; image/file blocks
 * use a flat 2K; tool-use counts name + JSON input but not the id;
 * reasoning counts the text but not the signature.
 */
function estimateContentPartTokens(part: unknown): number {
  if (typeof part === "string") return Math.round(part.length / 4);
  if (!part || typeof part !== "object") return 0;
  const p = part as { type?: string; [k: string]: unknown };
  switch (p.type) {
    case "text":
      return Math.round(((p.text as string) ?? "").length / 4);
    case "reasoning":
      // Count thinking text only; signature is metadata, not tokenized.
      return Math.round(((p.text as string) ?? "").length / 4);
    case "tool-call":
      return Math.round((((p.toolName as string) ?? "") + JSON.stringify(p.input ?? {})).length / 4);
    case "tool-result":
      return estimateToolResultTokens(p.output);
    case "image":
    case "file":
      return IMAGE_TOKEN_SIZE;
    default:
      return Math.round(JSON.stringify(part).length / 4);
  }
}

function estimateToolResultTokens(output: unknown): number {
  if (!output || typeof output !== "object") return 0;
  const o = output as { type?: string; value?: unknown };
  if (o.type === "text") return Math.round((((o.value as string) ?? "")).length / 4);
  if (o.type === "content" && Array.isArray(o.value)) {
    let sum = 0;
    for (const item of o.value) {
      if (item && typeof item === "object") {
        const it = item as { type?: string; text?: string };
        if (it.type === "text") sum += Math.round((it.text ?? "").length / 4);
        else if (it.type === "image-data" || it.type === "image-url" || it.type === "file-data" || it.type === "file-url") sum += IMAGE_TOKEN_SIZE;
        else sum += Math.round(JSON.stringify(item).length / 4);
      }
    }
    return sum;
  }
  return Math.round(JSON.stringify(output).length / 4);
}

/**
 * Per-message estimate. Final result is padded by 4/3 to be conservative,
 * matching the heuristic Claude Code uses so our tail-picking budget aligns
 * with what users have come to expect from CC sessions.
 */
function estimateMessageTokensCC(m: ModelMessage): number {
  let total = 0;
  if (typeof m.content === "string") {
    total = Math.round(m.content.length / 4);
  } else if (Array.isArray(m.content)) {
    for (const part of m.content) total += estimateContentPartTokens(part);
  }
  return Math.ceil((total * 4) / 3);
}

/**
 * Walk messages backward, accumulating tokens, picking the largest tail
 * that satisfies (min tokens AND min text-block messages, capped at max
 * tokens). Tail must START on a user message — otherwise we'd send orphan
 * assistant/tool messages without their preceding user turn.
 */
function pickPreservedTail(
  messages: ModelMessage[],
  opts: { minTokens: number; maxTokens: number; minMessages: number },
): ModelMessage[] {
  let tokens = 0;
  let textMsgs = 0;
  let tailStart = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    const t = estimateMessageTokensCC(messages[i]);
    // Hard cap: don't grow past max once we've selected at least one msg.
    if (tailStart < messages.length && tokens + t > opts.maxTokens) break;

    tokens += t;
    if (messages[i].role === "user" || messages[i].role === "assistant") textMsgs++;
    tailStart = i;

    // Both minimums met AND we're on a user message → stop here so the tail
    // starts cleanly on a user turn.
    if (tokens >= opts.minTokens && textMsgs >= opts.minMessages && messages[i].role === "user") {
      break;
    }
  }

  // Final alignment: tail must START at a user message; walk forward to
  // the next user message if we landed on something else.
  while (tailStart < messages.length && messages[tailStart].role !== "user") tailStart++;

  return messages.slice(tailStart);
}

/**
 * Wire `string | ContentBlock[]` → AI SDK ToolResultOutput.
 * Strict inverse of normalizeToolOutputForWire in default-loop.ts.
 */
function wireContentToToolOutput(
  content: string | ContentBlock[],
): { type: "text"; value: string } | { type: "content"; value: any[] } {
  if (typeof content === "string") {
    return { type: "text", value: content };
  }
  return {
    type: "content",
    value: content.map((b) => {
      if (b.type === "text") return { type: "text", text: b.text };
      if (b.type === "image" && b.source.type === "base64") {
        return { type: "image-data", data: b.source.data ?? "", mediaType: b.source.media_type ?? "image/png" };
      }
      if (b.type === "image" && b.source.type === "url") {
        return { type: "image-url", url: b.source.url ?? "", mediaType: b.source.media_type };
      }
      if (b.type === "document" && b.source.type === "base64") {
        return { type: "file-data", data: b.source.data ?? "", mediaType: b.source.media_type ?? "application/pdf" };
      }
      if (b.type === "document" && b.source.type === "url") {
        return { type: "file-url", url: b.source.url ?? "", mediaType: b.source.media_type };
      }
      return { type: "text", text: JSON.stringify(b) };
    }),
  };
}

/**
 * UserMessageEvent.content → AI SDK user message content[].
 * Kept simple — image/document mapping mirrors the writer's normalizations.
 */
function userContentToParts(blocks: ContentBlock[]): any[] {
  return blocks.map((b): any => {
    if (b.type === "text") return { type: "text", text: b.text };
    if (b.type === "image") {
      if (b.source.type === "url" && b.source.url) {
        return { type: "image", image: new URL(b.source.url), mediaType: b.source.media_type };
      }
      return { type: "image", image: b.source.data ?? "", mediaType: b.source.media_type };
    }
    if (b.type === "document") {
      const providerOptions = (b.citations || b.title || b.context)
        ? {
            anthropic: {
              ...(b.citations ? { citations: b.citations } : {}),
              ...(b.title ? { title: b.title } : {}),
              ...(b.context ? { context: b.context } : {}),
            },
          }
        : undefined;
      if (b.source.type === "url" && b.source.url) {
        return {
          type: "file",
          data: new URL(b.source.url),
          mediaType: b.source.media_type,
          ...(providerOptions ? { providerOptions } : {}),
        };
      }
      if (b.source.type === "text") {
        const prefix = b.title ? `[${b.title}]\n` : "";
        return { type: "text", text: prefix + (b.source.data ?? "") };
      }
      return {
        type: "file",
        data: b.source.data ?? "",
        mediaType: b.source.media_type ?? "application/pdf",
        ...(providerOptions ? { providerOptions } : {}),
      };
    }
    return { type: "text", text: JSON.stringify(b) };
  });
}

/**
 * Render boundary summary as a single text block with a structural marker.
 * The model recognizes <conversation-summary> from training data; we tag
 * the marker so it knows the preceding history is no longer in its window.
 *
 * Determinism: this serialization MUST be a pure function of `summary` —
 * no timestamps, no IDs, no key reordering. The summary itself is stored
 * verbatim in the boundary event, so its bytes are stable across turns.
 */
function serializeSummaryAsText(summary: ContentBlock[]): string {
  const parts: string[] = ["<conversation-summary>"];
  for (const block of summary) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "image") parts.push("[image elided]");
    else if (block.type === "document") parts.push(block.title ? `[document: ${block.title}]` : "[document]");
  }
  parts.push("</conversation-summary>");
  return parts.join("\n");
}

/**
 * Stamp an event with id and processed_at if not already set.
 *
 * AMA spec: `processed_at` is null until the agent actually processes the
 * event. For inbound user-side events (user.message / user.tool_confirmation /
 * user.custom_tool_result) that means "drained from the queue and handed to
 * the model", which happens later in `SessionDO.drainEventQueue`. For all
 * other events (agent output, tool output, system, lifecycle) the act of
 * appending IS the processing, so we stamp at append time.
 */
function stampEvent(event: SessionEvent): SessionEvent {
  if (!event.id) {
    event.id = generateEventId();
  }
  const isPendingUntilDrain =
    event.type === "user.message" ||
    event.type === "user.tool_confirmation" ||
    event.type === "user.custom_tool_result";
  if (!event.processed_at && !isPendingUntilDrain) {
    event.processed_at = new Date().toISOString();
  }
  return event;
}

/**
 * SqliteHistory now composes the self-host `CfDoEventLog` adapter from
 * @open-managed-agents/event-log/cf-do — kept the class name for back-
 * compat with existing call sites in SessionDO. To swap backends
 * (Postgres / in-memory / etc.) construct an `InMemoryHistory` or a
 * future `PgHistory` instead — they all expose the same `HistoryStore`
 * interface (append + getEvents + getMessages).
 *
 * `getMessages` lives on the consumer side rather than in the event-log
 * port because the events→messages projection is harness-specific
 * (different harnesses may want different projections — see
 * eventsToMessages above for the canonical OMA mapping).
 */
export class SqliteHistory implements HistoryStore {
  private repo: CfDoEventLog;

  constructor(sql: SqlStorage, r2: R2Bucket | null = null, r2KeyPrefix: string = "") {
    this.repo = new CfDoEventLog(sql, stampEvent, r2, r2KeyPrefix);
    // Idempotent — first construction in a DO bootstraps the schema; later
    // ones see CREATE TABLE IF NOT EXISTS as a no-op.
    ensureCfDoSchema(sql);
  }

  append(event: SessionEvent): void {
    this.repo.append(event);
  }

  getEvents(afterSeq?: number): SessionEvent[] {
    return this.repo.getEvents(afterSeq);
  }

  /** Resolve any `_spilled` references back to full events via R2. */
  async resolveSpilledEvents(events: SessionEvent[]): Promise<SessionEvent[]> {
    return this.repo.resolveSpilledEvents(events);
  }

  getMessages(): ModelMessage[] {
    return eventsToMessages(this.getEvents());
  }
}

/**
 * Lightweight in-memory history for sub-agent threads.
 * No SQLite dependency — thread history lives only for the duration
 * of the sub-agent run and is discarded afterwards.
 */
export class InMemoryHistory implements HistoryStore {
  private repo = new InMemoryEventLog(stampEvent);

  append(event: SessionEvent): void {
    this.repo.append(event);
  }

  getEvents(afterSeq?: number): SessionEvent[] {
    return this.repo.getEvents(afterSeq);
  }

  getMessages(): ModelMessage[] {
    return eventsToMessages(this.getEvents());
  }
}
