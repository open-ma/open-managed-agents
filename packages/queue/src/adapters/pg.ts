// SQL-table-backed Queue + DeadLetterQueue.
//
// Multi-replica safe: PostgreSQL claims use SKIP LOCKED; MySQL and SQLite
// use an atomic conditional UPDATE. Every claim receives an opaque token.
// ACK, retry, DLQ, and heartbeat mutations require that exact token, so an
// expired owner cannot settle a row after a replacement has reclaimed it.
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
//     claim_token TEXT,
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

export interface SqlQueueOptions {
  /** Logical name partitioning the table — multiple queues can share
   *  one table by tagging each row with the queue's name. */
  name: string;
  sql: SqlClient;
  /** SQL claim dialect. `postgres` keeps the SKIP LOCKED fast path; MySQL
   *  and SQLite use the same conditional UPDATE/RETURNING lease contract. */
  dialect: SqlQueueDialect;
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

export type SqlQueueDialect = "postgres" | "mysql" | "sqlite";

interface SqlQueueRow {
  id: string;
  payload_json: unknown;
  attempts: number;
  enqueued_at_ms: number;
  locked_by: string;
  claim_token: string;
}

const consoleLogger = {
  warn(message: string, error?: unknown): void {
    if (error === undefined) console.warn(message);
    else console.warn(message, error);
  },
};

function messageBody<T>(row: SqlQueueRow): T {
  return typeof row.payload_json === "string"
    ? JSON.parse(row.payload_json) as T
    : row.payload_json as T;
}

/**
 * Create the queue_messages table + indexes. Idempotent. Caller wires this
 * into their schema bootstrap (apps/main-node calls this during queue startup;
 * startup; CF doesn't call this since it uses CF Queues, not SQL tables).
 */
export async function ensureSqlQueueSchema(
  sql: SqlClient,
  dialect: SqlQueueDialect,
): Promise<void> {
  if (dialect === "sqlite") {
    await sql.exec(`
      CREATE TABLE IF NOT EXISTS "queue_messages" (
        "id"               TEXT PRIMARY KEY NOT NULL,
        "queue_name"       TEXT NOT NULL,
        "payload"          TEXT NOT NULL,
        "attempts"         INTEGER NOT NULL DEFAULT 0,
        "next_visible_at"  BIGINT NOT NULL,
        "status"           TEXT NOT NULL DEFAULT 'pending',
        "locked_by"        TEXT,
        "locked_until"     BIGINT,
        "claim_token"      TEXT,
        "dlq_reason"       TEXT,
        "enqueued_at"      BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS "idx_queue_messages_pending"
        ON "queue_messages" ("queue_name", "status", "next_visible_at");
      CREATE INDEX IF NOT EXISTS "idx_queue_messages_processing"
        ON "queue_messages" ("queue_name", "status", "locked_until");
      CREATE INDEX IF NOT EXISTS "idx_queue_messages_dlq"
        ON "queue_messages" ("queue_name", "status");
    `);
    const columns = await sql.prepare(`PRAGMA table_info("queue_messages")`)
      .all<{ name: string }>();
    if (!(columns.results ?? []).some((column) => column.name === "claim_token")) {
      await sql.exec(`ALTER TABLE "queue_messages" ADD COLUMN "claim_token" TEXT`);
    }
    return;
  }
  if (dialect === "mysql") {
    await sql.exec(`
      CREATE TABLE IF NOT EXISTS queue_messages (
        id               VARCHAR(191) PRIMARY KEY NOT NULL,
        queue_name       VARCHAR(191) NOT NULL,
        payload          LONGTEXT NOT NULL,
        attempts         INTEGER NOT NULL DEFAULT 0,
        next_visible_at  BIGINT NOT NULL,
        status           VARCHAR(32) NOT NULL DEFAULT 'pending',
        locked_by        VARCHAR(191),
        locked_until     BIGINT,
        claim_token      VARCHAR(191),
        dlq_reason       TEXT,
        enqueued_at      BIGINT NOT NULL,
        INDEX idx_queue_messages_pending
          (queue_name, status, next_visible_at),
        INDEX idx_queue_messages_processing
          (queue_name, status, locked_until),
        INDEX idx_queue_messages_dlq
          (queue_name, status)
      )
    `);
    return;
  }
  // PostgreSQL keeps payloads as JSONB. The double cast prevents the
  // postgres.js adapter from encoding an already-stringified payload as a
  // JSON string instead of a JSON object.
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
      "claim_token"      TEXT,
      "dlq_reason"       TEXT,
      "enqueued_at"      BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS "idx_queue_messages_pending"
      ON "queue_messages" ("queue_name", "status", "next_visible_at");
    CREATE INDEX IF NOT EXISTS "idx_queue_messages_processing"
      ON "queue_messages" ("queue_name", "status", "locked_until")
      WHERE "status" = 'processing';
    CREATE INDEX IF NOT EXISTS "idx_queue_messages_dlq"
      ON "queue_messages" ("queue_name", "status")
      WHERE "status" = 'dlq';
  `);
  await sql.exec(
    `ALTER TABLE "queue_messages" ADD COLUMN IF NOT EXISTS "claim_token" TEXT`,
  );
}

export function createSqlQueue<T>(opts: SqlQueueOptions): Queue<T> {
  const workerId = opts.workerId ?? `sql-worker-${crypto.randomUUID()}`;
  const pollIntervalMs = opts.pollIntervalMs ?? 1000;
  const batchSize = opts.batchSize ?? 10;
  const maxRetries = opts.maxRetries ?? 5;
  const visibilityTimeoutMs = opts.visibilityTimeoutMs ?? 60_000;
  const log = opts.logger ?? consoleLogger;
  const dialect = opts.dialect;

  return {
    async enqueue(body, eOpts) {
      await insertOne(opts.sql, dialect, opts.name, body, eOpts);
    },
    async enqueueBatch(messages, eOpts) {
      // No bulk INSERT VALUES (multi-row) helper on the SqlStatement port;
      // serial inserts are fine for the realistic batch sizes here (sub-100).
      for (const m of messages) {
        await insertOne(opts.sql, dialect, opts.name, m, eOpts);
      }
    },
    subscribe(handler) {
      let stopped = false;
      const subscription = new AbortController();
      const loop = (async function runSubscription() {
        while (!stopped) {
          const claimed = await claimBatch<T>(
            opts.sql,
            dialect,
            opts.name,
            workerId,
            batchSize,
            visibilityTimeoutMs,
          );
          if (claimed.length === 0) {
            await sleep(pollIntervalMs, subscription.signal);
            continue;
          }
          await runClaimedBatch(
            opts.sql,
            opts.name,
            claimed,
            handler,
            maxRetries,
            visibilityTimeoutMs,
            log,
          );
        }
      })().catch((error: unknown) => {
        if (!subscription.signal.aborted) {
          log.warn(`[sql-queue:${opts.name}] subscriber stopped after polling failure`, error);
        }
      });
      return async () => {
        stopped = true;
        subscription.abort();
        await loop;
      };
    },
    async getStats(): Promise<QueueStats> {
      const r = await opts.sql
        .prepare(
          `SELECT
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS inflight
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

export function createSqlDlq<T>(opts: SqlQueueOptions): DeadLetterQueue<T> {
  const workerId = opts.workerId ?? `sql-dlq-${crypto.randomUUID()}`;
  const pollIntervalMs = opts.pollIntervalMs ?? 5000;
  const batchSize = opts.batchSize ?? 10;
  const visibilityTimeoutMs = opts.visibilityTimeoutMs ?? 30_000;
  const log = opts.logger ?? consoleLogger;
  const dialect = opts.dialect;

  return {
    subscribe(handler) {
      let stopped = false;
      const subscription = new AbortController();
      const loop = (async function runDlqSubscription() {
        while (!stopped) {
          const claimed = await claimDlqBatch<T>(
            opts.sql,
            dialect,
            opts.name,
            workerId,
            batchSize,
            visibilityTimeoutMs,
          );
          if (claimed.length === 0) {
            await sleep(pollIntervalMs, subscription.signal);
            continue;
          }
          await runClaimedDlqBatch(
            opts.sql,
            opts.name,
            claimed,
            handler,
            visibilityTimeoutMs,
            log,
          );
        }
      })().catch((error: unknown) => {
        if (!subscription.signal.aborted) {
          log.warn(`[sql-dlq:${opts.name}] subscriber stopped after polling failure`, error);
        }
      });
      return async () => {
        stopped = true;
        subscription.abort();
        await loop;
      };
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
                  locked_by = NULL, locked_until = NULL, claim_token = NULL,
                  dlq_reason = NULL
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
  dialect: SqlQueueDialect,
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
        VALUES (?, ?, ${dialect === "postgres" ? "CAST(CAST(? AS TEXT) AS JSONB)" : "?"}, 0, ?, 'pending', ?)`,
    )
    .bind(id, name, JSON.stringify(body), visibleAt, now)
    .run();
}

async function claimBatch<T>(
  sql: SqlClient,
  dialect: SqlQueueDialect,
  name: string,
  workerId: string,
  batchSize: number,
  visibilityTimeoutMs: number,
): Promise<SqlQueueRow[]> {
  // SKIP LOCKED guarantees two replicas never select the same row; the
  // UPDATE inside the same logical step (CTE) flips status to "processing"
  // and stamps the lease, so a subsequent poll on a third replica also
  // skips it.
  const lockedUntil = Date.now() + visibilityTimeoutMs;
  const claimToken = crypto.randomUUID();
  const now = Date.now();
  if (dialect !== "postgres") {
    const result = await sql.prepare(
      `UPDATE queue_messages
          SET status = 'processing', locked_by = ?, locked_until = ?,
              claim_token = ?, attempts = attempts + 1
        WHERE id IN (
          SELECT candidate_id FROM (
            SELECT candidate.id AS candidate_id
              FROM queue_messages AS candidate
             WHERE candidate.queue_name = ?
               AND (
                 (candidate.status = 'pending' AND candidate.next_visible_at <= ?)
                 OR (candidate.status = 'processing' AND candidate.locked_until <= ?)
               )
             ORDER BY CASE WHEN candidate.status = 'pending'
                       THEN candidate.next_visible_at ELSE candidate.locked_until END,
                      candidate.id
             LIMIT ?
          ) AS claimable
        )
          AND queue_name = ?
          AND (
            (status = 'pending' AND next_visible_at <= ?)
            OR (status = 'processing' AND locked_until <= ?)
          )
      RETURNING id, payload AS payload_json, attempts,
                enqueued_at AS enqueued_at_ms, locked_by, claim_token`,
    ).bind(
      workerId,
      lockedUntil,
      claimToken,
      name,
      now,
      now,
      batchSize,
      name,
      now,
      now,
    ).all<SqlQueueRow>();
    return result.results ?? [];
  }
  const r = await sql
    .prepare(
      `WITH claimed AS (
       SELECT id FROM queue_messages
          WHERE queue_name = ?
            AND (
              (status = 'pending' AND next_visible_at <= ?)
              OR (status = 'processing' AND locked_until <= ?)
            )
          ORDER BY next_visible_at ASC
          LIMIT ?
          FOR UPDATE SKIP LOCKED
       )
       UPDATE queue_messages q
          SET status = 'processing',
              locked_by = ?,
              locked_until = ?,
              claim_token = ?,
              attempts = attempts + 1
         FROM claimed
        WHERE q.id = claimed.id
       RETURNING q.id, q.payload::text AS payload_json, q.attempts,
                 q.enqueued_at AS enqueued_at_ms, q.locked_by, q.claim_token`,
    )
    .bind(
      name,
      now,
      now,
      batchSize,
      workerId,
      lockedUntil,
      claimToken,
    )
    .all<SqlQueueRow>();
  return r.results ?? [];
}

async function claimDlqBatch<T>(
  sql: SqlClient,
  dialect: SqlQueueDialect,
  name: string,
  workerId: string,
  batchSize: number,
  visibilityTimeoutMs: number,
): Promise<SqlQueueRow[]> {
  const lockedUntil = Date.now() + visibilityTimeoutMs;
  const claimToken = crypto.randomUUID();
  const now = Date.now();
  if (dialect !== "postgres") {
    const result = await sql.prepare(
      `UPDATE queue_messages
          SET locked_by = ?, locked_until = ?, claim_token = ?
        WHERE id IN (
          SELECT candidate_id FROM (
            SELECT candidate.id AS candidate_id
              FROM queue_messages AS candidate
             WHERE candidate.queue_name = ? AND candidate.status = 'dlq'
               AND (candidate.locked_until IS NULL OR candidate.locked_until <= ?)
             ORDER BY candidate.enqueued_at, candidate.id
             LIMIT ?
          ) AS claimable
        )
          AND queue_name = ? AND status = 'dlq'
          AND (locked_until IS NULL OR locked_until <= ?)
      RETURNING id, payload AS payload_json, attempts,
                enqueued_at AS enqueued_at_ms, locked_by, claim_token`,
    ).bind(
      workerId,
      lockedUntil,
      claimToken,
      name,
      now,
      batchSize,
      name,
      now,
    ).all<SqlQueueRow>();
    return result.results ?? [];
  }
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
              locked_until = ?,
              claim_token = ?
         FROM claimed
        WHERE q.id = claimed.id
       RETURNING q.id, q.payload::text AS payload_json, q.attempts,
                 q.enqueued_at AS enqueued_at_ms, q.locked_by, q.claim_token`,
    )
    .bind(name, now, batchSize, workerId, lockedUntil, claimToken)
    .all<SqlQueueRow>();
  return r.results ?? [];
}

async function runOne<T>(
  sql: SqlClient,
  name: string,
  row: SqlQueueRow,
  handler: QueueHandler<T>,
  maxRetries: number,
  log: { warn: (m: string, err?: unknown) => void },
): Promise<void> {
  const msg: QueueMessage<T> = {
    id: row.id,
    body: messageBody<T>(row),
    attempts: row.attempts,
    enqueuedAt: row.enqueued_at_ms,
  };
  try {
    await handler(msg);
    // Success — drop the row so SELECTs stay cheap.
    await sql.prepare(
      `DELETE FROM queue_messages
        WHERE id = ? AND status = 'processing'
          AND locked_by = ? AND claim_token = ?`,
    ).bind(row.id, row.locked_by, row.claim_token).run();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (row.attempts >= maxRetries) {
      // Exhaust → DLQ. Keep the row, flip status, clear the lease so
      // the DLQ subscriber can claim it.
      await sql
        .prepare(
          `UPDATE queue_messages
              SET status = 'dlq', locked_by = NULL, locked_until = NULL,
                  claim_token = NULL, dlq_reason = ?
            WHERE id = ? AND status = 'processing'
              AND locked_by = ? AND claim_token = ?`,
        )
        .bind(
          reason.slice(0, 1000),
          row.id,
          row.locked_by,
          row.claim_token,
        )
        .run();
      log.warn(`[sql-queue:${name}] message ${row.id} DLQed after ${row.attempts} attempts: ${reason}`);
    } else {
      // Retry: bounce back to pending with a small backoff to avoid
      // tight-loop on a poison message.
      const backoffMs = 1000 * row.attempts;
      await sql
        .prepare(
          `UPDATE queue_messages
              SET status = 'pending', locked_by = NULL, locked_until = NULL,
                  claim_token = NULL, next_visible_at = ?
            WHERE id = ? AND status = 'processing'
              AND locked_by = ? AND claim_token = ?`,
        )
        .bind(
          Date.now() + backoffMs,
          row.id,
          row.locked_by,
          row.claim_token,
        )
        .run();
    }
  }
}

async function runClaimedBatch<T>(
  sql: SqlClient,
  name: string,
  rows: SqlQueueRow[],
  handler: QueueHandler<T>,
  maxRetries: number,
  visibilityTimeoutMs: number,
  log: { warn: (m: string, err?: unknown) => void },
): Promise<void> {
  const stopHeartbeat = maintainBatchLease({
    sql,
    row: rows[0],
    status: "processing",
    visibilityTimeoutMs,
    log,
  });
  try {
    await Promise.all(
      rows.map((row) => runOne(sql, name, row, handler, maxRetries, log)),
    );
  } finally {
    await stopHeartbeat();
  }
}

async function runClaimedDlqBatch<T>(
  sql: SqlClient,
  name: string,
  rows: SqlQueueRow[],
  handler: QueueHandler<T>,
  visibilityTimeoutMs: number,
  log: { warn: (m: string, err?: unknown) => void },
): Promise<void> {
  const stopHeartbeat = maintainBatchLease({
    sql,
    row: rows[0],
    status: "dlq",
    visibilityTimeoutMs,
    log,
  });
  try {
    await Promise.all(rows.map(async (row) => {
      const msg: QueueMessage<T> = {
        id: row.id,
        body: messageBody<T>(row),
        attempts: row.attempts,
        enqueuedAt: row.enqueued_at_ms,
      };
      try {
        await handler(msg);
        await sql.prepare(
          `DELETE FROM queue_messages
            WHERE id = ? AND status = 'dlq'
              AND locked_by = ? AND claim_token = ?`,
        ).bind(row.id, row.locked_by, row.claim_token).run();
      } catch (error) {
        log.warn(`[sql-dlq:${name}] handler threw for id=${row.id}`, error);
        await sql.prepare(
          `UPDATE queue_messages
              SET locked_by = NULL, locked_until = NULL, claim_token = NULL
            WHERE id = ? AND status = 'dlq'
              AND locked_by = ? AND claim_token = ?`,
        ).bind(row.id, row.locked_by, row.claim_token).run();
      }
    }));
  } finally {
    await stopHeartbeat();
  }
}

function maintainBatchLease(input: {
  sql: SqlClient;
  row: SqlQueueRow | undefined;
  status: "processing" | "dlq";
  visibilityTimeoutMs: number;
  log: { warn: (m: string, err?: unknown) => void };
}): () => Promise<void> {
  if (input.row === undefined) return async () => {};
  let stopped = false;
  let heartbeat = Promise.resolve();
  const stop = () => {
    stopped = true;
    clearInterval(interval);
  };
  const interval = setInterval(() => {
    if (stopped) return;
    heartbeat = heartbeat.then(async () => {
      if (stopped) return;
      const now = Date.now();
      await input.sql.prepare(
        `UPDATE queue_messages
            SET locked_until = ?
          WHERE status = ? AND locked_by = ? AND claim_token = ?
            AND locked_until > ?`,
      ).bind(
        now + input.visibilityTimeoutMs,
        input.status,
        input.row!.locked_by,
        input.row!.claim_token,
        now,
      ).run();
    }).catch((error: unknown) => {
      input.log.warn("[sql-queue] batch lease renewal failed", error);
    });
  }, Math.max(1, Math.floor(input.visibilityTimeoutMs / 3)));
  interval.unref?.();
  return async () => {
    stop();
    await heartbeat;
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** @deprecated Use SqlQueueOptions with dialect: "postgres". */
export type PgQueueOptions = Omit<SqlQueueOptions, "dialect"> & {
  dialect?: "postgres";
};
/** @deprecated Use ensureSqlQueueSchema. */
export function ensureQueueSchema(sql: SqlClient): Promise<void> {
  return ensureSqlQueueSchema(sql, "postgres");
}
/** @deprecated Use createSqlQueue. */
export function createPgQueue<T>(opts: PgQueueOptions): Queue<T> {
  return createSqlQueue({ ...opts, dialect: "postgres" });
}
/** @deprecated Use createSqlDlq. */
export function createPgDlq<T>(opts: PgQueueOptions): DeadLetterQueue<T> {
  return createSqlDlq({ ...opts, dialect: "postgres" });
}
