// CF Durable Object SQLite adapter for the event-log + stream-buffer ports.
//
// Wraps `ctx.storage.sql` — fast (regional, no network), transactional
// with the rest of DO storage, and what SessionDO has historically used
// directly via SqliteHistory. Lifting it behind the port costs nothing
// in CF deployments and lets non-CF deployments (Postgres, in-memory
// for tests) plug in alternative impls.

import type { SessionEvent } from "@open-managed-agents/shared";
import type { EventLogRepo, StreamBufferRepo, StreamBuffer } from "../ports";

/**
 * Caller is responsible for ensuring the `events` table exists before
 * constructing — see `ensureSchema(sql)` below for the canonical DDL.
 *
 * `stampEvent` is injected so this adapter doesn't import the agent's
 * id-generation utilities — keeps the dependency direction clean
 * (event-log knows nothing about the agent runtime).
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
    // SQLite parameter binding for IN clause: build placeholders.
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

// ─── Stream buffer ───────────────────────────────────────────────────────
//
// In-flight LLM stream chunks. Single-row scratch table — overwriting is
// the whole point. DO SQLite is the perfect home: same atomicity domain
// as the events table, ms-level write latency, no network. When we go
// multi-backend, this is what the PG adapter has to be careful about
// (network roundtrip per put = perceptible streaming latency unless
// adapter batches internally).

export class CfDoStreamBuffer implements StreamBufferRepo {
  constructor(private sql: SqlStorage) {}

  async put(buffer: StreamBuffer): Promise<void> {
    this.sql.exec(
      `INSERT OR REPLACE INTO stream_buffer (rowid, message_id, chunks_json, started_at)
       VALUES (1, ?, ?, ?)`,
      buffer.message_id,
      JSON.stringify(buffer.chunks),
      buffer.started_at,
    );
  }

  async get(): Promise<StreamBuffer | null> {
    const cursor = this.sql.exec(
      "SELECT message_id, chunks_json, started_at FROM stream_buffer WHERE rowid = 1",
    );
    for (const row of cursor) {
      return {
        message_id: row.message_id as string,
        chunks: JSON.parse(row.chunks_json as string) as string[],
        started_at: row.started_at as number,
      };
    }
    return null;
  }

  async clear(): Promise<void> {
    this.sql.exec("DELETE FROM stream_buffer WHERE rowid = 1");
  }
}

/**
 * Idempotent schema bootstrap. Call once from the consumer's `ensureSchema()`
 * (typically the SessionDO's). Safe to call repeatedly.
 *
 * `events` is the existing OMA event log shape; `stream_buffer` is new
 * for chunk persistence. Both live in the same DO SQLite namespace, so
 * appends + buffer writes share atomicity if needed.
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
    CREATE TABLE IF NOT EXISTS stream_buffer (
      rowid INTEGER PRIMARY KEY,
      message_id TEXT NOT NULL,
      chunks_json TEXT NOT NULL,
      started_at INTEGER NOT NULL
    )
  `);
}
