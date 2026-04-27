// Per-session runtime data: the event log + in-flight LLM stream state.
//
// Two separate ports because they have different durability semantics:
//
//   - EventLogRepo: append-only history. Source of truth for "what
//     happened". Written once per logical step (final agent.message,
//     tool_use, tool_result, etc.). Frontends + harness recovery read
//     from here.
//
//   - StreamRepo: in-flight LLM stream state, indexed by message_id.
//     One row per active streaming message — sub-agents and parallel
//     turns can have multiple concurrent streams. On normal completion
//     the row is finalized but kept (for short-window read-after-write
//     by clients reconnecting); on DO restart the recovery scan finds
//     status='streaming' rows and finalizes the partial as a single
//     agent.message event so the events log stays consistent.
//
// Both are runtime-agnostic ports — SessionDO consumes via constructor
// injection, factories pick the right adapter per deployment (CF Workers
// DO SQLite, Postgres, in-memory for tests). Same Ports/Adapters pattern
// as packages/sessions-store, packages/agents-store, etc.

import type { SessionEvent } from "@open-managed-agents/shared";

export interface EventLogRepo {
  /** Append a SessionEvent. Implementation MUST stamp seq + ts. */
  append(event: SessionEvent): void;

  /** All events strictly after `afterSeq` in seq order. Omit for full log. */
  getEvents(afterSeq?: number): SessionEvent[];

  /** Highest seq for an event of this type. Returns -1 when none. */
  getLastEventSeq(type: string): number;

  /** First event of one of these types after `afterSeq`. null when none. */
  getFirstEventAfter(
    afterSeq: number,
    types: string[],
  ): { seq: number; data: string } | null;
}

/** One row of the streams table — represents one in-flight or recently-
 *  completed LLM stream, identified by the eventual agent.message id. */
export interface StreamRow {
  message_id: string;
  status: "streaming" | "completed" | "aborted" | "interrupted";
  chunks: string[];
  started_at: number;
  completed_at?: number;
  error_text?: string;
}

export interface StreamRepo {
  /** Open a new stream. Idempotent — a second start with the same id is
   *  a no-op (handles redundant onChunk-fires-before-state-write race). */
  start(messageId: string, startedAt: number): Promise<void>;

  /** Append a token delta to the in-flight buffer. Adapters MAY batch
   *  internally to amortize write cost (esp. PG); the contract is "all
   *  appended deltas are eventually visible in order via get()". */
  appendChunk(messageId: string, delta: string): Promise<void>;

  /** Transition status away from 'streaming'. completed = LLM finished
   *  cleanly. aborted = explicit abort (user.interrupt or harness retry).
   *  interrupted = recovery-scan detected the runtime was killed mid-stream. */
  finalize(
    messageId: string,
    status: "completed" | "aborted" | "interrupted",
    errorText?: string,
  ): Promise<void>;

  /** Read the current state of one stream, or null if unknown. */
  get(messageId: string): Promise<StreamRow | null>;

  /** All streams currently in this status. The recovery scan calls this
   *  with 'streaming' on cold start to find streams the previous runtime
   *  was in the middle of when it died. */
  listByStatus(status: StreamRow["status"]): Promise<StreamRow[]>;
}
