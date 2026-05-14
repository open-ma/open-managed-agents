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
  /** Append a SessionEvent to the canonical events log. Implementation
   *  MUST stamp seq + processed_at. The adapter doesn't decide where
   *  rows go — queue routing for user.message / user.tool_confirmation /
   *  user.custom_tool_result is the caller's responsibility (see
   *  PendingQueueRepo). Calling `append` for a queue-input event from
   *  an arbitrary code path puts that event directly in the events log
   *  with the next AUTOINCREMENT seq, bypassing the queue — only the
   *  drain path should do this (after `peek`, before `delete`). */
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

/**
 * One row of the AMA-spec pending queue. Carries everything the
 * promotion broadcast needs to correlate the pending bubble (rendered
 * client-side from `system.user_message_pending`) with the event-log
 * row that lands at drain time.
 *
 *   pending_seq:        FIFO order within the queue. NOT the seq of the
 *                       eventual events-table row (that's assigned at
 *                       INSERT-into-events time, hence the rename).
 *   event_id:           === parsed(data).id. Client matches by this on
 *                       both pending broadcasts and event-log rows.
 *   cancelled_at:       set by user.interrupt; cancelled rows never
 *                       promote.
 */
export interface PendingRow {
  pending_seq: number;
  enqueued_at: number;
  session_thread_id: string;
  type: string;
  event_id: string;
  data: string;
  cancelled_at: number | null;
}

export interface PendingQueueRepo {
  /** Append a queue-input SessionEvent (user.message /
   *  user.tool_confirmation / user.custom_tool_result) to the pending
   *  queue. SessionDO POST `/event` calls this; the row stays here
   *  until `drainEventQueue` peeks, the caller appends to the events
   *  log, then calls `delete(pending_seq)`. */
  enqueue(event: SessionEvent): void;
  /** Read the next active (non-cancelled) row for a thread WITHOUT
   *  deleting it. Caller must INSERT the matching event into the
   *  events log first, then call `delete(pending_seq)` — this
   *  insert-then-delete order is the crash-safety guarantee. */
  peek(threadId: string): PendingRow | null;
  /** Delete a pending row by pending_seq. Idempotent. */
  delete(pendingSeq: number): void;
  /** Cancel every active row for a thread. Returns the cancelled rows
   *  so the caller can broadcast per-row notifications. */
  cancelAllForThread(threadId: string, cancelledAtMs: number): PendingRow[];
  /** List rows for a thread (active by default). */
  list(threadId: string, includeCancelled?: boolean): PendingRow[];
  /** Cross-thread count of active rows. */
  countActive(): number;
  /** Distinct thread ids with at least one active row. */
  threadsWithPending(): string[];
}
