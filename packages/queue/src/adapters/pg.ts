// PG-table-backed Queue + DeadLetterQueue.
//
// Multi-replica safe: subscribers run a poll loop using
//   SELECT ... FOR UPDATE SKIP LOCKED LIMIT N
// inside a serializable transaction so replica A and replica B never
// pick the same row. The selected rows get locked + status="processing",
// the handler runs outside the transaction, then a follow-up tx either
// DELETEs (success) or bumps attempts back to "pending" with a new
// next_visible_at (retry). On attempts > maxRetries the row flips to
// status="dlq" and the DLQ subscriber picks it up via the same SKIP
// LOCKED dance against `WHERE status='dlq'`.
//
// Schema:
//   queue_messages(
//     id PK,
//     queue_name TEXT,
//     payload JSONB,
//     attempts INT DEFAULT 0,
//     next_visible_at TIMESTAMPTZ,
//     status TEXT DEFAULT 'pending',  -- pending | processing | dlq
//     locked_by TEXT,
//     locked_until TIMESTAMPTZ,
//     dlq_reason TEXT,
//     enqueued_at TIMESTAMPTZ
//   )

import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  DeadLetterQueue,
  EnqueueOptions,
  Queue,
  QueueHandler,
  QueueMessage,
  QueueStats,
} from "../ports";

export interface PgQueueOptions {
  /** Logical name partitioning the table — multiple queues can share
   *  one table by tagging each row with the queue's name. */
  name: string;
  sql: SqlClient;
  /** Worker identifier — written to `locked_by` so a stuck row can be
   *  traced back to the replica holding the lease. Default = random. */
  workerId?: string;
  /** Poll interval ms (1000 default). Tight for tests, looser in prod. */
  pollIntervalMs?: number;
  /** How many rows to claim per poll. */
  batchSize?: number;
  /** Max delivery attempts before the message lands in `status='dlq'`. */
  maxRetries?: number;
  /** Visibility window — if a worker dies mid-handler, after this duration
   *  the row becomes selectable again by another replica. */
  visibilityTimeoutMs?: number;
  logger?: { warn: (m: string, err?: unknown) => void };
}

interface PgRow {
  id: string;
  payload: unknown;
  attempts: number;
  enqueued_at_ms: number;
}

/**
 * Create the queue_messages table + indexes. Idempotent. Caller wires this
 * into their schema bootstrap (apps/main-node calls applyQueueSchema during
 * startup; CF doesn't call this since it uses CF Queues, not PG-table).
 */
export async function ensureQueueSchema(sql: SqlClient): Promise<void> {
  // jsonb is PG-only; safe because this adapter is PG-only by name. Cast
  // to text round-trip would also work but jsonb gives the planner help
  // on dlq reason filters etc.
  await sql.exec(`
    CREATE TABLE IF NOT EXISTS "queue_messages" (
      "id"               TEXT PRIMARY KEY NOT NULL,
      "queue_name"       TEXT NOT NULL,
      "payload"          JSONB NOT NULL,
      "attempts"         INTEGER NOT NULL DEFAULT 0,
      "next_visible_at"  BIGINT NOT NULL,
      "status"           TEXT NOT NULL DEFAULT 'pending',
      "locked_by"        TEXT,
      "locked_until"     BIGINT,
      "dlq_reason"       TEXT,
      "enqueued_at"      BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS "idx_queue_messages_pending"
      ON "queue_messages" ("queue_name", "status", "next_visible_at");
    CREATE INDEX IF NOT EXISTS "idx_queue_messages_dlq"
      ON "queue_messages" ("queue_name", "status")
      WHERE "status" = 'dlq';
  `);
}

export function createPgQueue<T>(opts: PgQueueOptions): Queue<T> {
  const workerId = opts.workerId ?? `pg-worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const pollIntervalMs = opts.pollIntervalMs ?? 1000;
  const batchSize = opts.batchSize ?? 10;
  const maxRetries = opts.maxRetries ?? 5;
  const visibilityTimeoutMs = opts.visibilityTimeoutMs ?? 60_000;
  const log = opts.logger ?? { warn: (m, e) => console.warn(m, e) };

  return {
    async enqueue(body, eOpts) {
      await insertOne(opts.sql, opts.name, body, eOpts);
    },
    async enqueueBatch(messages, eOpts) {
      // No bulk INSERT VALUES (multi-row) helper on the SqlStatement port;
      // serial inserts are fine for the realistic batch sizes here (sub-100).
      for (const m of messages) await insertOne(opts.sql, opts.name, m, eOpts);
    },
    subscribe(handler) {
      let stopped = false;
      void (async function loop() {
        while (!stopped) {
          const claimed = await claimBatch<T>(opts.sql, opts.name, workerId, batchSize, visibilityTimeoutMs);
          if (claimed.length === 0) {
            await sleep(pollIntervalMs);
            continue;
          }
          for (const row of claimed) {
            await runOne(opts.sql, opts.name, row, handler, maxRetries, log);
          }
        }
      })();
      return () => { stopped = true; };
    },
    async getStats(): Promise<QueueStats> {
      const r = await opts.sql
        .prepare(
          `SELECT
              COUNT(*) FILTER (WHERE status = 'pending') AS pending,
              COUNT(*) FILTER (WHERE status = 'processing') AS inflight
           FROM queue_messages WHERE queue_name = ?`,
        )
        .bind(opts.name)
        .first<{ pending: number | string; inflight: number | string }>();
      return {
        pending: Number(r?.pending ?? 0),
        inflight: Number(r?.inflight ?? 0),
      };
    },
  };
}

export function createPgDlq<T>(opts: PgQueueOptions): DeadLetterQueue<T> {
  const workerId = opts.workerId ?? `pg-dlq-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const pollIntervalMs = opts.pollIntervalMs ?? 5000;
  const batchSize = opts.batchSize ?? 10;
  const visibilityTimeoutMs = opts.visibilityTimeoutMs ?? 30_000;
  const log = opts.logger ?? { warn: (m, e) => console.warn(m, e) };

  return {
    subscribe(handler) {
      let stopped = false;
      void (async function loop() {
        while (!stopped) {
          const claimed = await claimDlqBatch<T>(opts.sql, opts.name, workerId, batchSize, visibilityTimeoutMs);
          if (claimed.length === 0) {
            await sleep(pollIntervalMs);
            continue;
          }
          for (const row of claimed) {
            const msg: QueueMessage<T> = {
              id: row.id,
              body: row.payload as T,
              attempts: row.attempts,
              enqueuedAt: row.enqueued_at_ms,
            };
            try {
              await handler(msg);
              // DLQ ack = delete row. Subscriber chose to handle it.
              await opts.sql.prepare(`DELETE FROM queue_messages WHERE id = ?`).bind(row.id).run();
            } catch (e) {
              // DLQ handler threw — release the lock so another worker
              // (or the same one on next poll) can retry. We do NOT
              // re-DLQ; this stays in `status='dlq'` until handled.
              log.warn(`[pg-dlq:${opts.name}] handler threw for id=${row.id}`, e);
              await opts.sql
                .prepare(`UPDATE queue_messages SET locked_by = NULL, locked_until = NULL WHERE id = ?`)
                .bind(row.id)
                .run();
            }
          }
        }
      })();
      return () => { stopped = true; };
    },
    async replay(ids) {
      if (ids.length === 0) return 0;
      // Reset to pending; re-uses the row, no new id. visibility=now so
      // a subscriber picks it up immediately.
      const placeholders = ids.map(() => "?").join(",");
      const r = await opts.sql
        .prepare(
          `UPDATE queue_messages
              SET status = 'pending', attempts = 0, next_visible_at = ?,
                  locked_by = NULL, locked_until = NULL, dlq_reason = NULL
            WHERE queue_name = ? AND status = 'dlq' AND id IN (${placeholders})`,
        )
        .bind(Date.now(), opts.name, ...ids)
        .run();
      return r.meta?.changes ?? 0;
    },
  };
}

// ---------- internals ----------

async function insertOne<T>(
  sql: SqlClient,
  name: string,
  body: T,
  opts: EnqueueOptions | undefined,
): Promise<void> {
  const id = `qm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  const visibleAt = now + (opts?.delaySec ?? 0) * 1000;
  await sql
    .prepare(
      `INSERT INTO queue_messages
         (id, queue_name, payload, attempts, next_visible_at, status, enqueued_at)
        VALUES (?, ?, ?::jsonb, 0, ?, 'pending', ?)`,
    )
    .bind(id, name, JSON.stringify(body), visibleAt, now)
    .run();
}

async function claimBatch<T>(
  sql: SqlClient,
  name: string,
  workerId: string,
  batchSize: number,
  visibilityTimeoutMs: number,
): Promise<PgRow[]> {
  // SKIP LOCKED guarantees two replicas never select the same row; the
  // UPDATE inside the same logical step (CTE) flips status to "processing"
  // and stamps the lease, so a subsequent poll on a third replica also
  // skips it.
  const lockedUntil = Date.now() + visibilityTimeoutMs;
  const r = await sql
    .prepare(
      `WITH claimed AS (
         SELECT id FROM queue_messages
          WHERE queue_name = ?
            AND status = 'pending'
            AND next_visible_at <= ?
          ORDER BY next_visible_at ASC
          LIMIT ?
          FOR UPDATE SKIP LOCKED
       )
       UPDATE queue_messages q
          SET status = 'processing',
              locked_by = ?,
              locked_until = ?,
              attempts = attempts + 1
         FROM claimed
        WHERE q.id = claimed.id
       RETURNING q.id, q.payload, q.attempts, q.enqueued_at AS enqueued_at_ms`,
    )
    .bind(name, Date.now(), batchSize, workerId, lockedUntil)
    .all<PgRow>();
  return r.results ?? [];
}

async function claimDlqBatch<T>(
  sql: SqlClient,
  name: string,
  workerId: string,
  batchSize: number,
  visibilityTimeoutMs: number,
): Promise<PgRow[]> {
  const lockedUntil = Date.now() + visibilityTimeoutMs;
  const r = await sql
    .prepare(
      `WITH claimed AS (
         SELECT id FROM queue_messages
          WHERE queue_name = ?
            AND status = 'dlq'
            AND (locked_until IS NULL OR locked_until <= ?)
          ORDER BY enqueued_at ASC
          LIMIT ?
          FOR UPDATE SKIP LOCKED
       )
       UPDATE queue_messages q
          SET locked_by = ?,
              locked_until = ?
         FROM claimed
        WHERE q.id = claimed.id
       RETURNING q.id, q.payload, q.attempts, q.enqueued_at AS enqueued_at_ms`,
    )
    .bind(name, Date.now(), batchSize, workerId, lockedUntil)
    .all<PgRow>();
  return r.results ?? [];
}

async function runOne<T>(
  sql: SqlClient,
  name: string,
  row: PgRow,
  handler: QueueHandler<T>,
  maxRetries: number,
  log: { warn: (m: string, err?: unknown) => void },
): Promise<void> {
  const msg: QueueMessage<T> = {
    id: row.id,
    body: row.payload as T,
    attempts: row.attempts,
    enqueuedAt: row.enqueued_at_ms,
  };
  try {
    await handler(msg);
    // Success — drop the row so SELECTs stay cheap.
    await sql.prepare(`DELETE FROM queue_messages WHERE id = ?`).bind(row.id).run();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (row.attempts >= maxRetries) {
      // Exhaust → DLQ. Keep the row, flip status, clear the lease so
      // the DLQ subscriber can claim it.
      await sql
        .prepare(
          `UPDATE queue_messages
              SET status = 'dlq', locked_by = NULL, locked_until = NULL,
                  dlq_reason = ?
            WHERE id = ?`,
        )
        .bind(reason.slice(0, 1000), row.id)
        .run();
      log.warn(`[pg-queue:${name}] message ${row.id} DLQed after ${row.attempts} attempts: ${reason}`);
    } else {
      // Retry: bounce back to pending with a small backoff to avoid
      // tight-loop on a poison message.
      const backoffMs = 1000 * row.attempts;
      await sql
        .prepare(
          `UPDATE queue_messages
              SET status = 'pending', locked_by = NULL, locked_until = NULL,
                  next_visible_at = ?
            WHERE id = ?`,
        )
        .bind(Date.now() + backoffMs, row.id)
        .run();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
