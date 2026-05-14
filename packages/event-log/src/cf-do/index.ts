// CF Durable Object SQLite adapter for EventLogRepo + StreamRepo.
//
// Wraps `ctx.storage.sql` — fast (regional, no network), transactional
// with the rest of DO storage, and what SessionDO has historically used
// directly via SqliteHistory. Lifting it behind the port costs nothing
// in CF deployments and lets non-CF deployments (Postgres, in-memory
// for tests) plug in alternative impls.

import type { SessionEvent } from "@open-managed-agents/shared";
import type {
  EventLogRepo,
  PendingQueueRepo,
  PendingRow,
  StreamRepo,
  StreamRow,
} from "../ports";

/**
 * Caller is responsible for ensuring the schema exists before
 * constructing — see `ensureSchema(sql)` below for the canonical DDL.
 *
 * `stampEvent` is injected so this adapter doesn't import the agent's
 * id-generation utilities — keeps the dependency direction clean.
 *
 * R2 spill: when an event JSON exceeds `SPILL_THRESHOLD_BYTES`, the full
 * event is written to R2 and SQL only stores a small reference. Read path
 * resolves the reference back lazily. This avoids both the DO SQLite
 * cell-size limit (~2 MB) AND avoids data loss / silent corruption.
 *
 * If `r2` is null (test mode, non-CF deploy), the spill path falls back
 * to writing the full event to SQL directly — caller bears the risk of
 * cell-size errors on huge events.
 */
const SPILL_THRESHOLD_BYTES = 500_000;

export class CfDoEventLog implements EventLogRepo {
  constructor(
    private sql: SqlStorage,
    private stamp: (e: SessionEvent) => void,
    private r2: R2Bucket | null = null,
    private r2KeyPrefix: string = "",
  ) {}

  /**
   * Append a SessionEvent to the canonical `events` table. seq is assigned
   * via AUTOINCREMENT, so seq order = INSERT order = drain order for
   * promoted user.* events (their INSERT is delayed until the drain pulls
   * them off `pending_events`).
   *
   * No queue routing lives here. Queue-input events (user.message /
   * user.tool_confirmation / user.custom_tool_result) are enqueued by the
   * caller via `PendingQueueRepo.enqueue` and only land in `events` after
   * the drain promotes them. See SessionDO POST `/event` and
   * `drainEventQueue` for the full path.
   */
  append(event: SessionEvent): void {
    this.stamp(event);
    const fullData = JSON.stringify(event);
    // session_thread_id lives on the wire (per AMA spec, EventBase optionally
    // carries it). Default to primary so legacy emitters that don't set it
    // still land in the primary thread's view.
    const threadId =
      (event as unknown as { session_thread_id?: string }).session_thread_id ??
      "sthr_primary";

    // processed_at semantics: integer ms in the SQL column = "this event has
    // been ingested by the agent". For server-emitted events (agent.*,
    // span.*, session.*) the act of appending IS the processing, so we
    // stamp now. Drain-promoted user.* events arrive here with
    // event.processed_at already set on the JSON payload (drain stamps it
    // before INSERT), and the row column gets the same wall-clock.
    const processedAt = Date.now();

    if (fullData.length <= SPILL_THRESHOLD_BYTES || !this.r2) {
      // Small enough OR no R2 binding (in-memory tests, non-CF deploys).
      this.sql.exec(
        "INSERT INTO events (type, data, processed_at, session_thread_id) VALUES (?, ?, ?, ?)",
        event.type,
        fullData,
        processedAt,
        threadId,
      );
      return;
    }

    // Spill: write small reference to SQL immediately so callers (sync)
    // see the event in the right slot. R2 PUT is fire-and-forget — the
    // DO is kept alive by other concurrent work (broadcastEvent + the
    // active fiber) so the put will land. Worst case (DO dies before R2
    // ack) the reader sees `_spilled` but R2.get returns null; the read
    // path treats that as a "spilled but lost" event with the metadata
    // intact (no silent corruption).
    const r2Key = `${this.r2KeyPrefix}/events/${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    this.sql.exec(
      "INSERT INTO events (type, data, processed_at, session_thread_id) VALUES (?, ?, ?, ?)",
      event.type,
      JSON.stringify({
        type: event.type,
        _spilled: { r2_key: r2Key, original_bytes: fullData.length },
      }),
      processedAt,
      threadId,
    );
    void this.r2.put(r2Key, fullData).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[event-log] R2 spill PUT failed (${r2Key}): ${msg}`);
    });
  }

  /**
   * Async helper that resolves `_spilled` references back to full events
   * by reading from R2. Sync `getEvents()` returns rows verbatim — call
   * this after if you need full payloads. Missing R2 objects (race or
   * lost) come back with `_spill_lost: true` instead of throwing.
   */
  async resolveSpilledEvents(events: SessionEvent[]): Promise<SessionEvent[]> {
    if (!this.r2) return events;
    return Promise.all(
      events.map(async (e) => {
        const meta = (e as unknown as { _spilled?: { r2_key: string; original_bytes: number } })._spilled;
        if (!meta || !this.r2) return e;
        try {
          const obj = await this.r2.get(meta.r2_key);
          if (!obj) {
            return {
              ...e,
              _spill_lost: true,
              _spill_meta: meta,
            } as unknown as SessionEvent;
          }
          const text = await obj.text();
          return JSON.parse(text) as SessionEvent;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            ...e,
            _spill_resolve_error: msg.slice(0, 200),
            _spill_meta: meta,
          } as unknown as SessionEvent;
        }
      }),
    );
  }

  getEvents(afterSeq?: number): SessionEvent[] {
    const cursor =
      afterSeq !== undefined
        ? this.sql.exec(
            "SELECT seq, type, data, ts, processed_at, cancelled_at, session_thread_id FROM events WHERE seq > ? ORDER BY seq",
            afterSeq,
          )
        : this.sql.exec(
            "SELECT seq, type, data, ts, processed_at, cancelled_at, session_thread_id FROM events ORDER BY seq",
          );
    const out: SessionEvent[] = [];
    for (const row of cursor) {
      const ev = JSON.parse(row.data as string) as SessionEvent &
        Record<string, unknown>;
      // Stash row-level pending bookkeeping back onto the parsed event so
      // the projection layer (eventsToMessages) can skip cancelled events
      // and the SDK/UI can surface pending state. JSON inside `data` is
      // the wire payload from the original `append()`; these three fields
      // are the row's authoritative state, which the wire payload may not
      // reflect (cancelled_at is set post-write by user.interrupt).
      if (row.processed_at !== null && row.processed_at !== undefined) {
        ev.processed_at_ms = row.processed_at as number;
      }
      if (row.cancelled_at !== null && row.cancelled_at !== undefined) {
        ev.cancelled_at_ms = row.cancelled_at as number;
      }
      if (row.session_thread_id != null) {
        ev.session_thread_id = row.session_thread_id as string;
      }
      out.push(ev as SessionEvent);
    }
    return out;
  }

  getLastEventSeq(type: string): number {
    const cursor = this.sql.exec(
      "SELECT seq FROM events WHERE type = ? ORDER BY seq DESC LIMIT 1",
      type,
    );
    for (const row of cursor) return row.seq as number;
    return -1;
  }

  getFirstEventAfter(
    afterSeq: number,
    types: string[],
  ): { seq: number; data: string } | null {
    if (types.length === 0) return null;
    const placeholders = types.map(() => "?").join(",");
    const cursor = this.sql.exec(
      `SELECT seq, data FROM events WHERE seq > ? AND type IN (${placeholders}) ORDER BY seq LIMIT 1`,
      afterSeq,
      ...types,
    );
    for (const row of cursor) {
      return { seq: row.seq as number, data: row.data as string };
    }
    return null;
  }
}

// ─── Stream repo ─────────────────────────────────────────────────────────
//
// One row per in-flight (or recently-completed) LLM stream. Multi-row
// indexed by message_id so sub-agents + parallel turns can each have
// their own. DO SQLite is the perfect home: same atomicity domain as
// the events table, ms-level write latency, no network.
//
// Append uses SQLite's json_insert with the '$[#]' selector to atomically
// append to the chunks_json array — no read-modify-write race even when
// onChunk fires from many overlapping async callbacks.

export class CfDoStreamRepo implements StreamRepo {
  constructor(private sql: SqlStorage) {}

  async start(messageId: string, startedAt: number): Promise<void> {
    // INSERT OR IGNORE: idempotent on duplicate start (e.g. redundant
    // broadcastStreamStart from the harness reset path).
    this.sql.exec(
      `INSERT OR IGNORE INTO streams (message_id, status, chunks_json, started_at)
       VALUES (?, 'streaming', '[]', ?)`,
      messageId,
      startedAt,
    );
  }

  async appendChunk(messageId: string, delta: string): Promise<void> {
    this.sql.exec(
      `UPDATE streams
         SET chunks_json = json_insert(chunks_json, '$[#]', ?)
       WHERE message_id = ? AND status = 'streaming'`,
      delta,
      messageId,
    );
  }

  async finalize(
    messageId: string,
    status: "completed" | "aborted" | "interrupted",
    errorText?: string,
  ): Promise<void> {
    this.sql.exec(
      `UPDATE streams
         SET status = ?, completed_at = ?, error_text = ?
       WHERE message_id = ?`,
      status,
      Date.now(),
      errorText ?? null,
      messageId,
    );
  }

  async get(messageId: string): Promise<StreamRow | null> {
    const cursor = this.sql.exec(
      `SELECT message_id, status, chunks_json, started_at, completed_at, error_text
         FROM streams WHERE message_id = ?`,
      messageId,
    );
    for (const row of cursor) return this.toRow(row);
    return null;
  }

  async listByStatus(status: StreamRow["status"]): Promise<StreamRow[]> {
    const cursor = this.sql.exec(
      `SELECT message_id, status, chunks_json, started_at, completed_at, error_text
         FROM streams WHERE status = ?
         ORDER BY started_at`,
      status,
    );
    const out: StreamRow[] = [];
    for (const row of cursor) out.push(this.toRow(row));
    return out;
  }

  private toRow(row: Record<string, unknown>): StreamRow {
    return {
      message_id: row.message_id as string,
      status: row.status as StreamRow["status"],
      chunks: JSON.parse(row.chunks_json as string) as string[],
      started_at: row.started_at as number,
      completed_at: (row.completed_at as number | null) ?? undefined,
      error_text: (row.error_text as string | null) ?? undefined,
    };
  }
}

// ─── Pending queue repo ───────────────────────────────────────────────────
//
// The AMA-spec "pending" queue. Holds the three turn-input event types
// (user.message / user.tool_confirmation / user.custom_tool_result) until
// drainEventQueue picks them up and promotes them into the events log
// (DELETE here + INSERT into events with a fresh seq + processed_at = now).
//
// Separating the queue from the event log gives us:
//   - Monotonic seq order in `events` that mirrors what the model actually
//     saw (drain order). Today we sort the timeline by `seq` and get the
//     right shape without a client-side processed_at sort.
//   - A clean `/v1/sessions/:id/pending` surface so SDK / console can
//     observe what's queued vs what's been ingested.
//   - user.interrupt cancellation lives on a separate column from the
//     processed bit; cancelled rows stay for audit but never promote.

export class CfDoPendingQueue implements PendingQueueRepo {
  constructor(private sql: SqlStorage) {}

  /**
   * Append a queue-input event (user.message / user.tool_confirmation /
   * user.custom_tool_result) to `pending_events`. The caller (SessionDO
   * POST `/event` handler) is responsible for choosing what events go to
   * the queue vs the canonical events log — adapters don't decide. The
   * row stays here until `drainEventQueue` peeks it, INSERTs into events,
   * then deletes it.
   */
  enqueue(event: SessionEvent): void {
    const threadId =
      (event as unknown as { session_thread_id?: string }).session_thread_id ??
      "sthr_primary";
    const eventId = (event as unknown as { id?: string }).id ?? "";
    const fullData = JSON.stringify(event);
    this.sql.exec(
      `INSERT INTO pending_events
         (enqueued_at, session_thread_id, type, event_id, data)
       VALUES (?, ?, ?, ?, ?)`,
      Date.now(),
      threadId,
      event.type,
      eventId,
      fullData,
    );
  }

  /**
   * Read the next active (uncancelled) pending row for a thread WITHOUT
   * deleting it. Returns null when nothing's queued. The caller is
   * responsible for INSERTing the matching event into the `events` table
   * AND THEN calling `delete(pending_seq)`. This insert-then-delete order
   * is the crash-safety guarantee — a process death between INSERT and
   * DELETE leaves a duplicate-promote case (mitigated by event-id dedup
   * in the events table) instead of losing the event.
   *
   * Non-transactional: drainEventQueue's per-thread mutex (`_draining`)
   * guarantees only one drainer runs per thread at a time, so peek +
   * append + delete can't race within the same thread.
   */
  peek(threadId: string): PendingRow | null {
    for (const r of this.sql.exec(
      `SELECT pending_seq, enqueued_at, session_thread_id, type, event_id, data
         FROM pending_events
         WHERE session_thread_id = ? AND cancelled_at IS NULL
         ORDER BY pending_seq ASC LIMIT 1`,
      threadId,
    )) {
      return {
        pending_seq: r.pending_seq as number,
        enqueued_at: r.enqueued_at as number,
        session_thread_id: r.session_thread_id as string,
        type: r.type as string,
        event_id: r.event_id as string,
        data: r.data as string,
        cancelled_at: null,
      };
    }
    return null;
  }

  /**
   * Delete a pending row by its pending_seq. Idempotent — deleting a row
   * that doesn't exist (e.g. because a previous drain promoted but
   * crashed before deleting; recovery's dedup path then re-deletes the
   * stale row) is a no-op.
   */
  delete(pendingSeq: number): void {
    this.sql.exec(
      `DELETE FROM pending_events WHERE pending_seq = ?`,
      pendingSeq,
    );
  }

  /**
   * Mark every active pending row for a thread as cancelled. Used by
   * user.interrupt. Returns the cancelled rows so the caller can
   * broadcast `system.user_message_cancelled` per row (clients use
   * the broadcast to strike-through the outbox bubble).
   */
  cancelAllForThread(threadId: string, cancelledAtMs: number): PendingRow[] {
    const rows: PendingRow[] = [];
    for (const r of this.sql.exec(
      `SELECT pending_seq, enqueued_at, session_thread_id, type, event_id, data
         FROM pending_events
         WHERE session_thread_id = ? AND cancelled_at IS NULL
         ORDER BY pending_seq ASC`,
      threadId,
    )) {
      rows.push({
        pending_seq: r.pending_seq as number,
        enqueued_at: r.enqueued_at as number,
        session_thread_id: r.session_thread_id as string,
        type: r.type as string,
        event_id: r.event_id as string,
        data: r.data as string,
        cancelled_at: cancelledAtMs,
      });
    }
    if (rows.length > 0) {
      this.sql.exec(
        `UPDATE pending_events SET cancelled_at = ?
           WHERE session_thread_id = ? AND cancelled_at IS NULL`,
        cancelledAtMs,
        threadId,
      );
    }
    return rows;
  }

  /**
   * List pending rows for a thread. Default: only active (non-cancelled).
   * Pass `includeCancelled = true` to include cancelled-but-not-yet-pruned
   * rows. Used by GET /v1/sessions/:id/pending.
   */
  list(threadId: string, includeCancelled = false): PendingRow[] {
    const cursor = includeCancelled
      ? this.sql.exec(
          `SELECT pending_seq, enqueued_at, session_thread_id, type,
                  event_id, data, cancelled_at
             FROM pending_events
             WHERE session_thread_id = ?
             ORDER BY pending_seq ASC`,
          threadId,
        )
      : this.sql.exec(
          `SELECT pending_seq, enqueued_at, session_thread_id, type,
                  event_id, data, cancelled_at
             FROM pending_events
             WHERE session_thread_id = ? AND cancelled_at IS NULL
             ORDER BY pending_seq ASC`,
          threadId,
        );
    const out: PendingRow[] = [];
    for (const r of cursor) {
      out.push({
        pending_seq: r.pending_seq as number,
        enqueued_at: r.enqueued_at as number,
        session_thread_id: r.session_thread_id as string,
        type: r.type as string,
        event_id: r.event_id as string,
        data: r.data as string,
        cancelled_at: (r.cancelled_at as number | null) ?? null,
      });
    }
    return out;
  }

  /**
   * Total count of active pending rows across all threads. Used by
   * deriveStatus / orphan recovery to detect "session has work left to
   * do" conditions.
   */
  countActive(): number {
    for (const r of this.sql.exec(
      `SELECT COUNT(*) AS n FROM pending_events WHERE cancelled_at IS NULL`,
    )) {
      return r.n as number;
    }
    return 0;
  }

  /**
   * Distinct thread ids with active (non-cancelled) pending rows.
   * Used on cold-start to re-fire drainEventQueue for every thread that
   * has work queued. Without this, queued events from before the
   * eviction would sit forever until something else triggered drain.
   */
  threadsWithPending(): string[] {
    const out: string[] = [];
    for (const r of this.sql.exec(
      `SELECT DISTINCT session_thread_id FROM pending_events
         WHERE cancelled_at IS NULL`,
    )) {
      out.push(r.session_thread_id as string);
    }
    return out;
  }
}

/**
 * Idempotent schema bootstrap. Call once from the consumer's
 * `ensureSchema()` — typically the SessionDO's. Safe to call repeatedly.
 *
 * `events` is the existing OMA event log shape; `streams` is the new
 * in-flight LLM stream state. Both share the DO SQLite namespace, so
 * appends + buffer writes land in the same atomicity domain.
 */
export function ensureSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      data TEXT NOT NULL,
      ts INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      -- Per-event pending bookkeeping. Added 2026-05.
      -- processed_at:      NULL = pending (drainEventQueue picks up)
      --                    integer ms = ingested by a turn (or auto-stamped
      --                    for non-user events that have no "process" step)
      -- cancelled_at:      NULL or integer ms = flushed by user.interrupt
      -- session_thread_id: 'sthr_primary' for the main thread; 'sthr_*'
      --                    for sub-agent threads spawned via runSubAgent
      processed_at INTEGER,
      cancelled_at INTEGER,
      session_thread_id TEXT
    )
  `);
  // Idempotent ALTER for DOs that have the v1 schema (no new columns).
  // PRAGMA table_info returns one row per column; we add what's missing.
  // SQLite's ALTER TABLE ADD COLUMN is O(1) — just metadata, no rewrite.
  const cols = new Set<string>();
  for (const row of sql.exec(`PRAGMA table_info(events)`)) {
    cols.add(row.name as string);
  }
  if (!cols.has("processed_at")) {
    sql.exec(`ALTER TABLE events ADD COLUMN processed_at INTEGER`);
    // Pre-existing rows: treat as "already processed" so the new
    // drainEventQueue partial-index query doesn't pick them up and
    // re-run the LLM on every legacy user.message in the log.
    sql.exec(`UPDATE events SET processed_at = ts WHERE processed_at IS NULL`);
  }
  if (!cols.has("cancelled_at")) {
    sql.exec(`ALTER TABLE events ADD COLUMN cancelled_at INTEGER`);
  }
  if (!cols.has("session_thread_id")) {
    sql.exec(`ALTER TABLE events ADD COLUMN session_thread_id TEXT`);
    // Backfill: legacy events all belong to the primary thread.
    sql.exec(`UPDATE events SET session_thread_id = 'sthr_primary' WHERE session_thread_id IS NULL`);
  }
  sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, seq)
  `);
  // Expression index on the embedded event id (data.id JSON path). Used
  // by the drain dedup check: SELECT 1 FROM events WHERE
  // json_extract(data, '$.id') = ? LIMIT 1. Without it the dedup query
  // is a full table scan; with it, sub-millisecond on bounded sessions.
  // SQLite supports expression indexes since 3.9 (DO storage SQL is well
  // past that). The index population on first-creation walks the table
  // once; cheap on bounded sessions and a one-shot cost.
  sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_event_id
      ON events(json_extract(data, '$.id'))
  `);
  // Hot path: drainEventQueue's "next pending user.* event for this thread".
  // Partial index — only user.* rows where processed_at IS NULL — keeps
  // the index tiny (typically 0-5 rows) and lets the lookup hit O(log n)
  // even on sessions with thousands of historical events.
  sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_pending
      ON events(session_thread_id, seq)
      WHERE processed_at IS NULL AND cancelled_at IS NULL
        AND (type = 'user.message' OR type = 'user.tool_confirmation' OR type = 'user.custom_tool_result')
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS streams (
      message_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      chunks_json TEXT NOT NULL DEFAULT '[]',
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      error_text TEXT
    )
  `);
  sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_streams_status ON streams(status, started_at)
  `);
  // Idempotent cleanup of the previous single-row stream buffer table
  // that the prior StreamBufferRepo adapter created. Safe no-op when the
  // DO never had it.
  sql.exec(`DROP TABLE IF EXISTS stream_buffer`);

  // ─── pending_events table — AMA-spec turn-input queue ────────────────
  //
  // Holds user.message / user.tool_confirmation / user.custom_tool_result
  // events between events.send() and drainEventQueue picking them up.
  // On promotion: DELETE here + INSERT into events with a freshly-assigned
  // seq, so events.seq order = drain order = what the model actually saw.
  //
  //   pending_seq:        AUTOINCREMENT, FIFO order within the queue
  //   enqueued_at:        wall-clock ms when events.send() landed
  //   session_thread_id:  'sthr_primary' or sub-agent 'sthr_*'
  //   type:               only the three turn-input types
  //   event_id:           === data.id, lets the client correlate the
  //                       pending bubble with the event-log row at
  //                       promotion time
  //   cancelled_at:       set by user.interrupt — cancelled rows are
  //                       kept for audit but never promoted
  //   data:               full event JSON
  sql.exec(`
    CREATE TABLE IF NOT EXISTS pending_events (
      pending_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      enqueued_at INTEGER NOT NULL,
      session_thread_id TEXT NOT NULL,
      type TEXT NOT NULL,
      event_id TEXT NOT NULL,
      cancelled_at INTEGER,
      data TEXT NOT NULL
    )
  `);
  sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_pending_thread_seq
      ON pending_events(session_thread_id, pending_seq)
  `);
  sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_pending_active
      ON pending_events(session_thread_id, pending_seq)
      WHERE cancelled_at IS NULL
  `);
}
