import { formatDuration } from "../../lib/format";
import type { Event } from "../../lib/events";
import type { Span, Turn, TurnTriggerKind } from "./types";

/**
 * Derive a flat list of waterfall spans from a session's event stream.
 *
 * One row per logical "thing that happened" — model call, tool call,
 * scheduled wait, agent message, etc. Paired events (start + end) become
 * a single span with duration; instant events become zero-duration
 * markers. Each span carries its source events so the side detail panel
 * can show the underlying JSON without re-walking the stream.
 *
 * timestamp basis is `processed_at` (millisecond ISO string set by
 * SessionDO at write time). The legacy `ts` field is unix SECONDS and
 * collapses sub-second events together — only used as a fallback for
 * very old sessions that predate processed_at.
 */
export function deriveSpans(events: Event[]): { spans: Span[]; totalMs: number } {
  const tsMs = (e: Event): number | null => {
    const pa = (e.data as { processed_at?: string } | undefined)?.processed_at
      ?? (e as { processed_at?: string }).processed_at;
    if (typeof pa === "string") {
      const t = Date.parse(pa);
      if (Number.isFinite(t)) return t;
    }
    if (typeof e.ts === "number") return e.ts * 1000;
    return null;
  };

  const timed = events.map((e) => ({ e, t: tsMs(e) })).filter((x): x is { e: Event; t: number } => x.t !== null);
  if (timed.length === 0) return { spans: [], totalMs: 0 };

  const t0 = timed[0].t;
  const tEnd = timed[timed.length - 1].t;
  const totalMs = Math.max(1, tEnd - t0);

  const spans: Span[] = [];

  // Index look-ahead pairings. O(1) instead of nested scans. Each map
  // stores both timestamp (for span math) and the source Event (for
  // click-to-expand JSON inspection).
  const toolResults = new Map<string, { t: number; e: Event }>();
  const mcpResults = new Map<string, { t: number; e: Event }>();
  const customResults = new Map<string, { t: number; e: Event }>();
  // model_request_start_id → end's timestamp + usage. Anthropic's wire
  // format pairs the per-call span pair this way (rather than positional
  // FIFO), so multiple parallel or nested model calls stay correctly
  // associated. FIFO fallback below for events that predate the field.
  const modelEndsById = new Map<string, { t: number; e: Event; usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }; finishReason?: string }>();
  const modelEndsFifo: { t: number; e: Event; usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }; finishReason?: string }[] = [];
  // OMA-extension span — pairs to model_request_start the same way the end
  // does. Lets the model bar split into TTFT (start→first_token) and
  // generation (first_token→end). FIFO fallback for events without ids.
  const modelFirstTokensById = new Map<string, { t: number; e: Event }>();
  const modelFirstTokensFifo: { t: number; e: Event }[] = [];
  const compactEnds: { t: number; e: Event }[] = [];
  const outcomeEnds: { t: number; e: Event }[] = [];
  // parent_event_id → child {t, event}. Used to pair span.wakeup_scheduled
  // (parent) with its eventual user.message (child) — same EventBase field
  // tool_result→tool_use uses, so this generalizes to any future
  // schedule→fire / outcome→eval / etc. causal pair without needing
  // custom id fields per kind.
  const childByParent = new Map<string, { t: number; e: Event }>();
  for (const { e, t } of timed) {
    if (e.type === "agent.tool_result" && e.tool_use_id) toolResults.set(e.tool_use_id, { t, e });
    else if (e.type === "agent.mcp_tool_result" && e.mcp_tool_use_id) mcpResults.set(e.mcp_tool_use_id, { t, e });
    else if (e.type === "user.custom_tool_result" && (e as Event).id) customResults.set(String(e.id), { t, e });
    else if (e.type === "span.model_request_end") {
      const data = (e.data as { model_request_start_id?: string; model_usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }; finish_reason?: string } | undefined);
      const sid = (e as { model_request_start_id?: string }).model_request_start_id ?? data?.model_request_start_id;
      const entry = { t, e, usage: data?.model_usage, finishReason: data?.finish_reason };
      modelEndsFifo.push(entry);
      if (sid) modelEndsById.set(sid, entry);
    }
    else if (e.type === "span.model_first_token") {
      modelFirstTokensFifo.push({ t, e });
      const data = (e.data as { model_request_start_id?: string } | undefined);
      const sid = (e as { model_request_start_id?: string }).model_request_start_id ?? data?.model_request_start_id;
      if (sid) modelFirstTokensById.set(sid, { t, e });
    }
    else if (e.type === "span.compaction_summarize_end") compactEnds.push({ t, e });
    else if (e.type === "span.outcome_evaluation_end") outcomeEnds.push({ t, e });
    const pid = (e as { parent_event_id?: string }).parent_event_id
      ?? (e.data as { parent_event_id?: string } | undefined)?.parent_event_id;
    if (pid) childByParent.set(pid, { t, e });
  }

  // FIFO fallback indices for events that lack id-based pairing.
  let modelEndFifoIdx = 0;
  let modelFirstTokenFifoIdx = 0;
  let compactEndIdx = 0;
  let outcomeEndIdx = 0;

  // Streaming chunks (deltas + start/end markers from incremental
  // rendering) are broadcast-only; the canonical event (agent.message /
  // agent.thinking) lands on commit and is what timeline should show.
  const STREAMING_NOISE = new Set([
    "agent.message_chunk",
    "agent.message_stream_start",
    "agent.message_stream_end",
    "agent.thinking_chunk",
    "agent.thinking_stream_start",
    "agent.thinking_stream_end",
    "agent.tool_use_input_chunk",
    "agent.tool_use_input_stream_start",
    "agent.tool_use_input_stream_end",
  ]);

  for (let i = 0; i < timed.length; i++) {
    const { e, t } = timed[i];
    const startMs = t - t0;

    if (STREAMING_NOISE.has(e.type)) continue;

    const sourceEvents: Event[] = [e];
    const pushSpan = (span: Omit<Span, "events">) => spans.push({ ...span, events: sourceEvents });

    if (e.type === "agent.tool_use" || e.type === "agent.custom_tool_use") {
      const result = e.type === "agent.tool_use"
        ? toolResults.get(String(e.id))
        : customResults.get(String(e.id));
      const endMs = result ? result.t - t0 : startMs;
      if (result) sourceEvents.push(result.e);
      pushSpan({
        key: `tool-${e.id ?? i}`,
        family: e.type === "agent.tool_use" ? "tool" : "custom_tool",
        label: String(e.name ?? "tool"),
        detail: result ? "completed" : "no result",
        startMs,
        durationMs: Math.max(0, endMs - startMs),
      });
    } else if (e.type === "agent.mcp_tool_use") {
      const result = mcpResults.get(String(e.id));
      const endMs = result ? result.t - t0 : startMs;
      if (result) sourceEvents.push(result.e);
      pushSpan({
        key: `mcp-${e.id ?? i}`,
        family: "mcp",
        label: `${String(e.mcp_server_name ?? "mcp")}:${String(e.name ?? "?")}`,
        detail: result ? "completed" : "no result",
        startMs,
        durationMs: Math.max(0, endMs - startMs),
      });
    } else if (
      e.type === "agent.tool_result" ||
      e.type === "agent.mcp_tool_result" ||
      e.type === "user.custom_tool_result"
    ) {
      // consumed via pairing above — no row
      continue;
    } else if (e.type === "span.model_request_start") {
      // One pair per ai-sdk step (= one model API call). Pair via the
      // start event id; old data without ids falls back to FIFO order.
      const sid = String((e as { id?: string }).id ?? (e.data as { id?: string } | undefined)?.id ?? "");
      const matched = sid ? modelEndsById.get(sid) : (modelEndsFifo[modelEndFifoIdx++] ?? undefined);
      const ftMatch = sid ? modelFirstTokensById.get(sid) : (modelFirstTokensFifo[modelFirstTokenFifoIdx++] ?? undefined);
      const end = matched?.t ?? t;
      const usage = matched?.usage;
      if (matched?.e) sourceEvents.push(matched.e);
      if (ftMatch?.e) sourceEvents.push(ftMatch.e);
      const tokSummary = usage
        ? `${usage.input_tokens}↓ ${usage.output_tokens}↑${usage.cache_read_input_tokens ? ` ⚡${usage.cache_read_input_tokens}` : ""}`
        : undefined;
      const ttftMs = ftMatch ? Math.max(0, ftMatch.t - t) : undefined;
      const ttftSummary = typeof ttftMs === "number" ? `TTFT ${formatDuration(ttftMs)}` : undefined;
      pushSpan({
        key: `model-${sid || i}`,
        family: "model",
        label: "model call",
        detail: [matched?.finishReason, ttftSummary, tokSummary].filter(Boolean).join(" · ") || undefined,
        startMs,
        durationMs: Math.max(0, end - t0 - startMs),
        ttftMs,
      });
    } else if (e.type === "span.compaction_summarize_start") {
      const matched = compactEnds[compactEndIdx++];
      const end = matched?.t ?? t;
      if (matched?.e) sourceEvents.push(matched.e);
      pushSpan({
        key: `compact-${i}`,
        family: "compaction",
        label: "compaction",
        startMs,
        durationMs: Math.max(0, end - t0 - startMs),
      });
    } else if (e.type === "span.outcome_evaluation_start") {
      const matched = outcomeEnds[outcomeEndIdx++];
      const end = matched?.t ?? t;
      if (matched?.e) sourceEvents.push(matched.e);
      pushSpan({
        key: `outcome-${i}`,
        family: "outcome",
        label: "outcome eval",
        startMs,
        durationMs: Math.max(0, end - t0 - startMs),
      });
    } else if (
      e.type === "span.model_request_end" ||
      e.type === "span.model_first_token" ||
      e.type === "span.compaction_summarize_end" ||
      e.type === "span.outcome_evaluation_end" ||
      e.type === "span.outcome_evaluation_ongoing"
    ) {
      continue; // paired or progress noise
    } else if (e.type === "span.wakeup_scheduled") {
      // Pair via parent_event_id: the eventual wakeup user.message sets its
      // parent_event_id to this span's id (mint-then-emit, see
      // session-do.ts:scheduleWakeup). Bar runs scheduled → fired and
      // visualizes the actual wait, which dwarfs everything else (10s, 1h,
      // 1d…); without it the operator can't see the wait at all on the
      // waterfall.
      const sid = String((e as { id?: string }).id ?? (e.data as { id?: string } | undefined)?.id ?? "");
      const fired = sid ? childByParent.get(sid) : undefined;
      const endMs = fired ? fired.t - t0 : startMs;
      if (fired?.e) sourceEvents.push(fired.e);
      pushSpan({
        key: `sched-${sid || i}`,
        family: "schedule",
        label: "schedule waiting",
        detail: fired ? "fired" : "pending",
        startMs,
        durationMs: Math.max(0, endMs - startMs),
      });
    } else if (e.type === "user.message") {
      const md = (e as { metadata?: { harness?: string; kind?: string } }).metadata;
      const isWakeup = md?.harness === "schedule" && md?.kind === "wakeup";
      pushSpan({
        key: `u-${i}`,
        family: isWakeup ? "wakeup" : "user",
        label: isWakeup ? "user.message (wakeup)" : "user.message",
        startMs,
        durationMs: 0,
      });
    } else if (e.type === "agent.message") {
      pushSpan({ key: `a-${i}`, family: "agent", label: "agent.message", startMs, durationMs: 0 });
    } else if (e.type === "agent.thinking") {
      pushSpan({ key: `think-${i}`, family: "thinking", label: "agent.thinking", startMs, durationMs: 0 });
    } else if (e.type === "aux.model_call") {
      pushSpan({ key: `aux-${i}`, family: "aux", label: "aux.model_call", startMs, durationMs: 0 });
    } else if (
      e.type === "agent.thread_message_sent" ||
      e.type === "agent.thread_message_received" ||
      e.type === "agent.thread_message" ||
      e.type === "session.thread_created" ||
      e.type === "session.thread_idle"
    ) {
      pushSpan({ key: `thread-${i}`, family: "thread", label: e.type.replace(/^.*\./, ""), startMs, durationMs: 0 });
    } else if (e.type === "agent.thread_context_compacted") {
      pushSpan({ key: `compact-marker-${i}`, family: "compaction", label: "thread compacted", startMs, durationMs: 0 });
    } else if (e.type === "session.error") {
      pushSpan({
        key: `err-${i}`,
        family: "error",
        label: "session.error",
        detail: typeof e.error === "string" ? e.error : JSON.stringify(e.error),
        startMs,
        durationMs: 0,
      });
    } else if (e.type === "session.warning") {
      pushSpan({
        key: `warn-${i}`,
        family: "warn",
        label: `warning:${String(e.source ?? "")}`,
        detail: String(e.message ?? ""),
        startMs,
        durationMs: 0,
      });
    } else if (e.type.startsWith("session.")) {
      pushSpan({ key: `s-${i}`, family: "system", label: e.type, startMs, durationMs: 0 });
    } else {
      // Catch-all: surface unknown types as instant markers rather than
      // silently dropping. New event types added later show up immediately
      // and the operator can decide whether to give them dedicated visuals.
      pushSpan({ key: `mk-${i}`, family: "marker", label: e.type, startMs, durationMs: 0 });
    }
  }

  return { spans, totalMs };
}

function parseEventTs(e: Event): number {
  const ts = (e as { processed_at?: string }).processed_at;
  if (typeof ts === "string") {
    const t = new Date(ts).getTime();
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

/**
 * Group a session's flat event stream into per-turn buckets, where a
 * "turn" starts on a user trigger event and ends on the next session
 * status_idle / .status_terminated / .error. Same definition the harness
 * uses internally (see drainEventQueue in session-do.ts).
 */
export function bucketIntoTurns(events: Event[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;

  // user.message metadata.harness === "schedule" + kind === "wakeup" is
  // the wire convention for cron-fired turns (see SessionDO.onScheduledWakeup).
  // Distinguish them in the trigger badge so an operator scanning the
  // timeline can tell at a glance "the agent woke itself" from "the user
  // sent something".
  const triggerKindOf = (e: Event): TurnTriggerKind | null => {
    if (e.type === "user.message") {
      const md = (e as { metadata?: { harness?: string; kind?: string } }).metadata;
      if (md?.harness === "schedule" && md?.kind === "wakeup") return "wakeup";
      return "user_message";
    }
    if (e.type === "user.tool_confirmation") return "tool_confirmation";
    if (e.type === "user.custom_tool_result") return "custom_tool_result";
    return null;
  };

  for (const e of events) {
    const k = triggerKindOf(e);
    if (k) {
      current = {
        id: `turn-${turns.length}`,
        triggerKind: k,
        trigger: e,
        triggerTs: parseEventTs(e),
        events: [e],
        status: "running",
      };
      turns.push(current);
      continue;
    }
    if (!current) {
      // Pre-trigger init events (init_events injected by /init handler,
      // platform reminders, etc.) — bucket into a synthetic init turn so
      // they get a card rather than being silently dropped.
      current = {
        id: `turn-init`,
        triggerKind: "init",
        triggerTs: parseEventTs(e),
        events: [e],
        status: "running",
      };
      turns.push(current);
      continue;
    }
    current.events.push(e);
    if (e.type === "session.status_idle") {
      current.status = "completed";
      current.endedAt = parseEventTs(e);
    } else if (e.type === "session.status_terminated") {
      current.status = "terminated";
      current.endedAt = parseEventTs(e);
    } else if (e.type === "session.error") {
      current.status = "errored";
      current.endedAt = parseEventTs(e);
    }
  }

  return turns;
}
