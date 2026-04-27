// CF Durable Object SQLite adapter for EventLogRepo + StreamRepo.
//
// Wraps `ctx.storage.sql` — fast (regional, no network), transactional
// with the rest of DO storage, and what SessionDO has historically used
// directly via SqliteHistory. Lifting it behind the port costs nothing
// in CF deployments and lets non-CF deployments (Postgres, in-memory
// for tests) plug in alternative impls.

import type { SessionEvent } from "@open-managed-agents/shared";
import type { EventLogRepo, StreamRepo, StreamRow } from "../ports";

/**
 * Caller is responsible for ensuring the schema exists before
 * constructing — see `ensureSchema(sql)` below for the canonical DDL.
 *
 * `stampEvent` is injected so this adapter doesn't import the agent's
 * id-generation utilities — keeps the dependency direction clean.
 */
export class CfDoEventLog implements EventLogRepo {
  constructor(
    private sql: SqlStorage,
    private stamp: (e: SessionEvent) => void,
  ) {}

  append(event: SessionEvent): void {
    this.stamp(event);
    this.sql.exec(
      "INSERT INTO events (type, data) VALUES (?, ?)",
      event.type,
      JSON.stringify(event),
    );
  }

  getEvents(afterSeq?: number): SessionEvent[] {
    const cursor =
      afterSeq !== undefined
        ? this.sql.exec(
            "SELECT seq, type, data, ts FROM events WHERE seq > ? ORDER BY seq",
            afterSeq,
          )
        : this.sql.exec("SELECT seq, type, data, ts FROM events ORDER BY seq");
    const out: SessionEvent[] = [];
    for (const row of cursor) {
      out.push(JSON.parse(row.data as string) as SessionEvent);
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
      ts INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    )
  `);
  sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, seq)
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
}
