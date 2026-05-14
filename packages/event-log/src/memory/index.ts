// In-memory adapters — for unit tests and the in-memory thread history
// case (sub-agent runs that don't need persistence). Faster than the CF
// SQLite adapter in tests because there's no SQL round-trip; same shape
// so consumer code is identical.

import type { SessionEvent } from "@open-managed-agents/shared";
import type {
  EventLogRepo,
  PendingQueueRepo,
  PendingRow,
  StreamRepo,
  StreamRow,
} from "../ports";

interface MemRow {
  seq: number;
  type: string;
  data: string;
  processed_at: number | null;
  cancelled_at: number | null;
  session_thread_id: string;
}

export class InMemoryEventLog implements EventLogRepo {
  // Exposed as readonly to tests + the in-memory thread storage path; do
  // not mutate from outside the repo.
  readonly _rows: MemRow[] = [];
  private nextSeq = 1;

  constructor(private stamp: (e: SessionEvent) => void) {}

  /**
   * Append a SessionEvent to the in-memory log. Mirrors the cf-do
   * adapter: this is a primitive "write a row" operation. Queue-input
   * events (user.message / user.tool_confirmation /
   * user.custom_tool_result) are NOT auto-routed to a queue here —
   * sub-agent and test code that uses InMemoryHistory needs the user
   * message to be visible immediately to `getEvents()`/`getMessages()`,
   * since sub-agents run synchronously without a drain step.
   *
   * SessionDO routes its primary-thread queue-input events through
   * `InMemoryPendingQueue.enqueue` (or `CfDoPendingQueue.enqueue`)
   * separately. The two paths are now independent.
   */
  append(event: SessionEvent): void {
    this.stamp(event);
    const threadId =
      (event as unknown as { session_thread_id?: string }).session_thread_id ??
      "sthr_primary";
    this._rows.push({
      seq: this.nextSeq++,
      type: event.type,
      data: JSON.stringify(event),
      processed_at: Date.now(),
      cancelled_at: null,
      session_thread_id: threadId,
    });
  }

  getEvents(afterSeq?: number): SessionEvent[] {
    const filtered =
      afterSeq !== undefined ? this._rows.filter((e) => e.seq > afterSeq) : this._rows;
    return filtered.map((r) => {
      const ev = JSON.parse(r.data) as SessionEvent & Record<string, unknown>;
      if (r.processed_at !== null) ev.processed_at_ms = r.processed_at;
      if (r.cancelled_at !== null) ev.cancelled_at_ms = r.cancelled_at;
      ev.session_thread_id = r.session_thread_id;
      return ev as SessionEvent;
    });
  }

  getLastEventSeq(type: string): number {
    for (let i = this._rows.length - 1; i >= 0; i--) {
      if (this._rows[i].type === type) return this._rows[i].seq;
    }
    return -1;
  }

  getFirstEventAfter(
    afterSeq: number,
    types: string[],
  ): { seq: number; data: string } | null {
    const set = new Set(types);
    for (const e of this._rows) {
      if (e.seq > afterSeq && set.has(e.type)) {
        return { seq: e.seq, data: e.data };
      }
    }
    return null;
  }
}

/**
 * In-memory pending queue, parallel to (not embedded in) InMemoryEventLog.
 * Mirrors CfDoPendingQueue's contract.
 *
 * Self-contained: holds its own rows array + counter. The queue is
 * structurally separate from the canonical event log — same as the
 * dual-table SQL design — so accidental crosswiring is impossible.
 */
export class InMemoryPendingQueue implements PendingQueueRepo {
  private rows: Array<{
    pending_seq: number;
    enqueued_at: number;
    session_thread_id: string;
    type: string;
    event_id: string;
    data: string;
    cancelled_at: number | null;
  }> = [];
  private nextPendingSeq = 1;

  enqueue(event: SessionEvent): void {
    const threadId =
      (event as unknown as { session_thread_id?: string }).session_thread_id ??
      "sthr_primary";
    const eventId = (event as unknown as { id?: string }).id ?? "";
    this.rows.push({
      pending_seq: this.nextPendingSeq++,
      enqueued_at: Date.now(),
      session_thread_id: threadId,
      type: event.type,
      event_id: eventId,
      data: JSON.stringify(event),
      cancelled_at: null,
    });
  }

  peek(threadId: string): PendingRow | null {
    const r = this.rows.find(
      (r) => r.session_thread_id === threadId && r.cancelled_at == null,
    );
    return r ? { ...r } : null;
  }

  delete(pendingSeq: number): void {
    const idx = this.rows.findIndex((r) => r.pending_seq === pendingSeq);
    if (idx >= 0) this.rows.splice(idx, 1);
  }

  cancelAllForThread(threadId: string, cancelledAtMs: number): PendingRow[] {
    const out: PendingRow[] = [];
    for (const r of this.rows) {
      if (r.session_thread_id === threadId && r.cancelled_at == null) {
        r.cancelled_at = cancelledAtMs;
        out.push({ ...r });
      }
    }
    return out;
  }

  list(threadId: string, includeCancelled = false): PendingRow[] {
    return this.rows
      .filter(
        (r) =>
          r.session_thread_id === threadId &&
          (includeCancelled || r.cancelled_at == null),
      )
      .map((r) => ({ ...r }));
  }

  countActive(): number {
    return this.rows.filter((r) => r.cancelled_at == null).length;
  }

  threadsWithPending(): string[] {
    const set = new Set<string>();
    for (const r of this.rows) {
      if (r.cancelled_at == null) set.add(r.session_thread_id);
    }
    return [...set];
  }
}

export class InMemoryStreamRepo implements StreamRepo {
  private rows = new Map<string, StreamRow>();

  async start(messageId: string, startedAt: number): Promise<void> {
    if (this.rows.has(messageId)) return; // idempotent
    this.rows.set(messageId, {
      message_id: messageId,
      status: "streaming",
      chunks: [],
      started_at: startedAt,
    });
  }

  async appendChunk(messageId: string, delta: string): Promise<void> {
    const row = this.rows.get(messageId);
    if (!row || row.status !== "streaming") return;
    row.chunks.push(delta);
  }

  async finalize(
    messageId: string,
    status: "completed" | "aborted" | "interrupted",
    errorText?: string,
  ): Promise<void> {
    const row = this.rows.get(messageId);
    if (!row) return;
    row.status = status;
    row.completed_at = Date.now();
    row.error_text = errorText;
  }

  async get(messageId: string): Promise<StreamRow | null> {
    const r = this.rows.get(messageId);
    if (!r) return null;
    return { ...r, chunks: [...r.chunks] };
  }

  async listByStatus(status: StreamRow["status"]): Promise<StreamRow[]> {
    return [...this.rows.values()]
      .filter((r) => r.status === status)
      .sort((a, b) => a.started_at - b.started_at)
      .map((r) => ({ ...r, chunks: [...r.chunks] }));
  }
}
