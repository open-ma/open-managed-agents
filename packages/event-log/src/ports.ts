// Per-session runtime data: the event log + transient stream buffer.
//
// The two are split into separate repos because they have different
// durability semantics:
//
//   - EventLogRepo: append-only history of the session. Source of truth
//     for "what happened". Written once per logical step (not per stream
//     chunk). Frontends + harness recovery read from here.
//
//   - StreamBufferRepo: transient buffer for the chunks of an in-flight
//     LLM stream. Wiped on completion. Only there so that, on a runtime
//     restart mid-stream, we can either recover the partial or finalize
//     it as a single agent.message event without re-running the LLM.
//
// Both are runtime-agnostic ports — the SessionDO consumes them via
// constructor injection, factories pick the right adapter per
// deployment (CF Workers DO SQLite, Postgres, in-memory for tests).
// This is the same Ports/Adapters pattern used elsewhere in OMA — see
// packages/sessions-store, packages/agents-store, etc.

import type { SessionEvent } from "@open-managed-agents/shared";

export interface EventLogRepo {
  /** Append a SessionEvent to the log. The implementation MUST stamp
   *  the event with a monotonic seq + ts before persisting. Returns
   *  void for back-compat with the existing SqliteHistory shape — the
   *  stamping happens via stampEvent() in the impl. */
  append(event: SessionEvent): void;

  /** Return all events strictly after `afterSeq`, in seq order. Omit
   *  the parameter to get the entire log. Used both by routes (HTTP
   *  paginated event read) and by the harness (to rebuild messages). */
  getEvents(afterSeq?: number): SessionEvent[];

  /** Look up the highest seq for an event of the given type. Used by
   *  detection logic (e.g. "what was the last agent.message?"). Returns
   *  -1 when no such event exists. */
  getLastEventSeq(type: string): number;

  /** First event with one of the given types after `afterSeq`. Returns
   *  null when none exists. Used to find the next event matching a
   *  filter (e.g. recovery: "what's the next event after this tool_use
   *  that could be its result?"). */
  getFirstEventAfter(
    afterSeq: number,
    types: string[],
  ): { seq: number; data: string } | null;
}

/** Snapshot of an in-flight LLM stream — chunks accumulated so far,
 *  keyed by a logical message_id. Wiped when the message finalizes. */
export interface StreamBuffer {
  message_id: string;
  chunks: string[];
  /** Unix ms — when the stream started, useful for idle detection. */
  started_at: number;
}

export interface StreamBufferRepo {
  /** Replace the active buffer (or set it for the first time). The
   *  whole object is overwritten — callers pass the full updated state.
   *  Adapters MAY batch / debounce internally; semantics from the
   *  caller's perspective is "this is the latest known buffer". */
  put(buffer: StreamBuffer): Promise<void>;

  /** Read the current buffer, or null if none. Used on runtime restart
   *  to detect whether a stream was in flight. */
  get(): Promise<StreamBuffer | null>;

  /** Clear the buffer (LLM completed, partial no longer needed). */
  clear(): Promise<void>;
}
