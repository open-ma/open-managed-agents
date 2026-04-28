import type { Event } from "../../lib/events";

/**
 * Layout constants — kept here as the single source of truth so that
 * Tailwind utility classes (`w-56`, `w-20`) and pixel arithmetic
 * (`224 + chartPx + 80`) stay in sync. Change here, change both.
 */
export const LABEL_COL_W = 224; // === w-56
export const DURATION_COL_W = 80; // === w-20
export const SIDE_PANEL_W = 420;

/**
 * One row in the timeline waterfall. A span can be an instant marker
 * (durationMs === 0) or a paired range (start + end events). Rendering
 * consumes only this shape; deriveSpans converts raw event streams to
 * Span[].
 */
export interface Span {
  key: string;
  family: SpanFamily;
  label: string;
  detail?: string;
  /** ms since the first event */
  startMs: number;
  /** 0 for instants */
  durationMs: number;
  /** Optional: ms from this span's start to first-token (model spans only).
   *  Used to render a TTFT divider inside the bar. */
  ttftMs?: number;
  /** Source events that contributed to this span (1 for instants,
   *  2 for paired spans, possibly more for tool calls with streaming
   *  input chunks). Click-to-expand renders the raw JSON of these. */
  events: Event[];
}

export type SpanFamily =
  | "model"
  | "tool"
  | "mcp"
  | "custom_tool"
  | "user"
  | "agent"
  | "system"
  | "warn"
  | "error"
  | "schedule"     // schedule tool's "waiting for alarm" window (10s, 1h, …)
  | "wakeup"       // user.message synthesized by onScheduledWakeup
  | "compaction"   // span.compaction_summarize_*
  | "outcome"      // span.outcome_evaluation_*
  | "thread"       // sub-agent thread lifecycle / messages
  | "aux"          // aux.model_call (web_fetch summarizer etc.)
  | "thinking"     // agent.thinking marker
  | "marker";      // catch-all for unrecognized event types

export const FAMILY_DOT: Record<SpanFamily, string> = {
  model: "bg-info",
  tool: "bg-emerald-500",
  mcp: "bg-purple-500",
  custom_tool: "bg-amber-500",
  user: "bg-brand",
  agent: "bg-fg-muted",
  system: "bg-fg-subtle",
  warn: "bg-warning",
  error: "bg-danger",
  schedule: "bg-info",
  wakeup: "bg-info",
  compaction: "bg-purple-400",
  outcome: "bg-emerald-400",
  thread: "bg-fg-muted",
  aux: "bg-fg-subtle",
  thinking: "bg-fg-subtle",
  marker: "bg-fg-subtle",
};

export const FAMILY_BAR: Record<SpanFamily, string> = {
  model: "bg-info/70",
  tool: "bg-emerald-500/70",
  mcp: "bg-purple-500/70",
  custom_tool: "bg-amber-500/70",
  user: "bg-brand/70",
  agent: "bg-fg-muted/70",
  system: "bg-fg-subtle/70",
  warn: "bg-warning/70",
  error: "bg-danger/70",
  schedule: "bg-info/40",
  wakeup: "bg-info/70",
  compaction: "bg-purple-400/70",
  outcome: "bg-emerald-400/70",
  thread: "bg-fg-muted/50",
  aux: "bg-fg-subtle/70",
  thinking: "bg-fg-subtle/40",
  marker: "bg-fg-subtle/40",
};

/**
 * A "turn" is the unit of agent work between a user trigger event
 * (user.message / user.tool_confirmation / user.custom_tool_result) and
 * the next session.status_idle / .status_terminated / .error. This is the
 * same definition the harness uses internally (see drainEventQueue in
 * apps/agent/src/runtime/session-do.ts) and matches Conversation view's
 * notion of a turn — so a Timeline burst card lines up 1:1 with a chat
 * exchange.
 */
export type TurnTriggerKind =
  | "user_message"
  | "wakeup"
  | "tool_confirmation"
  | "custom_tool_result"
  | "init";

export type TurnStatus = "completed" | "running" | "errored" | "terminated";

export interface Turn {
  id: string;
  triggerKind: TurnTriggerKind;
  trigger?: Event;
  /** Wall-clock ms epoch of the trigger (or first event for init turn). */
  triggerTs: number;
  /** Inclusive: trigger event + everything until the closing status event. */
  events: Event[];
  status: TurnStatus;
  /** Wall-clock ms epoch when the turn closed; undefined while still running. */
  endedAt?: number;
}

export const TRIGGER_LABEL: Record<TurnTriggerKind, string> = {
  user_message: "user message",
  wakeup: "scheduled wakeup",
  tool_confirmation: "tool confirmation",
  custom_tool_result: "custom tool result",
  init: "session init",
};

export const TRIGGER_DOT: Record<TurnTriggerKind, string> = {
  user_message: "bg-brand",
  wakeup: "bg-info",
  tool_confirmation: "bg-amber-500",
  custom_tool_result: "bg-amber-500",
  init: "bg-fg-subtle",
};

export const STATUS_TEXT: Record<TurnStatus, string> = {
  completed: "text-fg-subtle",
  running: "text-info",
  errored: "text-danger",
  terminated: "text-danger",
};

/**
 * What's currently selected for the side detail panel. Lifted up to
 * TimelineView so a click in any TurnCard updates one shared panel.
 */
export interface TimelineSelection {
  spanKey: string;
  spanLabel: string;
  events: Event[];
}
