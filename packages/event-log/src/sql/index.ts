// SqlClient-backed adapter for EventLogRepo + StreamRepo. Works with any
// SqlClient (D1 / better-sqlite3 / postgres.js when wired) — schema is plain
// SQLite-flavoured DDL with portable types.
//
// This is the CFless cousin of cf-do/index.ts, which scopes everything to a
// per-DO SQLite namespace. Here we share one SqlClient across all sessions
// in a process, so every table carries an explicit `session_id` column and
// every read/write is filtered by it. The repo instance is bound to one
// session_id at construction.

import type { SessionEvent } from "@open-managed-agents/shared";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { EventLogRepo, StreamRepo, StreamRow } from "../ports";

/**
 * Per-session event log backed by a shared SQL store.
 *
 * `seq` is per-session; we mint it on insert via a subquery instead of
 * relying on AUTOINCREMENT. SQLite doesn't expose per-partition
 * autoincrement, and the cross-session global counter that AUTOINCREMENT
 * would give us is not what we want (a session's seq should start at 1).
 *
 * The subquery is racy under concurrent writers, but a Node-side
 * SessionRegistry serialises events for one session through a per-session
 * drainPromise (or its equivalent), so within a session this is the only
 * writer. Cross-session writes don't collide because they hit different
 * (session_id) partitions of the PRIMARY KEY.
 */
export class SqlEventLog implements EventLogRepo {
  constructor(
    private sql: SqlClient,
    private sessionId: string,
    /** Stamps event.id and event.processed_at; mirrors cf-do/index.ts. */
    private stamp: (e: SessionEvent) => void,
  ) {}

  /**
   * append() is documented as sync in the EventLogRepo port to match the
   * CF DO adapter's free synchronous SQL. The SQL impl wraps async work
   * inside a fire-and-forget Promise; callers that need durability before
   * returning should use {@link appendAsync} instead. Lost-write window:
   * < 1ms in practice (better-sqlite3 sync underneath an async wrap).
   */
  append(event: SessionEvent): void {
    this.stamp(event);
    void this.appendAsync(event);
  }

  async appendAsync(event: SessionEvent): Promise<void> {
    const ts = Date.now();
    await this.sql
      .prepare(
        `INSERT INTO session_events (session_id, seq, type, data, ts)
         SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?
           FROM session_events WHERE session_id = ?`,
      )
      .bind(this.sessionId, event.type, JSON.stringify(event), ts, this.sessionId)
      .run();
  }

  /**
   * Synchronous read in the port contract — implemented as a deopt: we
   * cache last results in `eventsCache` and refresh via {@link refresh}.
   * Code paths that need fresh reads call {@link getEventsAsync} directly.
   *
   * In practice today (Phase B-resume PoC) all callers are async-friendly,
   * so we route sync `getEvents` to the cache and let async readers refresh
   * explicitly. SessionDO's CF impl gets sync because DO storage is in-isolate.
   */
  private eventsCache: SessionEvent[] = [];

  getEvents(afterSeq?: number): SessionEvent[] {
    if (afterSeq === undefined) return this.eventsCache.slice();
    // Each event has its own .seq stamped during refresh; filter the cache.
    return this.eventsCache.filter((e) => (e as { seq?: number }).seq! > afterSeq);
  }

  async refresh(): Promise<void> {
    this.eventsCache = await this.getEventsAsync();
  }

  /** Fresh read from the database. Use this when you can await. */
  async getEventsAsync(afterSeq?: number): Promise<SessionEvent[]> {
    const sql =
      afterSeq !== undefined
        ? `SELECT seq, type, data, ts FROM session_events
           WHERE session_id = ? AND seq > ? ORDER BY seq`
        : `SELECT seq, type, data, ts FROM session_events
           WHERE session_id = ? ORDER BY seq`;
    const stmt =
      afterSeq !== undefined
        ? this.sql.prepare(sql).bind(this.sessionId, afterSeq)
        : this.sql.prepare(sql).bind(this.sessionId);
    const r = await stmt.all<{ seq: number; type: string; data: string; ts: number }>();
    return (r.results ?? []).map((row) => {
      const ev = JSON.parse(row.data) as SessionEvent & { seq?: number; ts?: number };
      ev.seq = row.seq;
      ev.ts = row.ts;
      return ev;
    });
  }

  getLastEventSeq(_type: string): number {
    // Synchronous interface deopt — return -1 if nothing cached. Async users
    // call getLastEventSeqAsync.
    let max = -1;
    for (const e of this.eventsCache) {
      const s = (e as { seq?: number }).seq;
      if (s !== undefined && s > max && e.type === _type) max = s;
    }
    return max;
  }

  async getLastEventSeqAsync(type: string): Promise<number> {
    const r = await this.sql
      .prepare(
        `SELECT seq FROM session_events
         WHERE session_id = ? AND type = ?
         ORDER BY seq DESC LIMIT 1`,
      )
      .bind(this.sessionId, type)
      .first<{ seq: number }>();
    return r?.seq ?? -1;
  }

  getFirstEventAfter(
    afterSeq: number,
    types: string[],
  ): { seq: number; data: string } | null {
    if (types.length === 0) return null;
    for (const e of this.eventsCache) {
      const s = (e as { seq?: number }).seq;
      if (s !== undefined && s > afterSeq && types.includes(e.type)) {
        return { seq: s, data: JSON.stringify(e) };
      }
    }
    return null;
  }
}

/**
 * Per-session in-flight LLM stream state. Mirrors CfDoStreamRepo + the
 * recovery semantics in apps/agent/src/runtime/recovery.ts. Schema mirrors
 * the cf-do version with an added `session_id` column.
 */
export class SqlStreamRepo implements StreamRepo {
  constructor(
    private sql: SqlClient,
    private sessionId: string,
  ) {}

  async start(messageId: string, startedAt: number): Promise<void> {
    await this.sql
      .prepare(
        `INSERT OR IGNORE INTO session_streams
           (session_id, message_id, status, chunks_json, started_at)
         VALUES (?, ?, 'streaming', '[]', ?)`,
      )
      .bind(this.sessionId, messageId, startedAt)
      .run();
  }

  async appendChunk(messageId: string, delta: string): Promise<void> {
    // SQLite supports json_insert / json_array_append (in newer versions).
    // For broad compatibility (and because better-sqlite3 ships its own
    // SQLite which always has JSON1), we use json_insert with the '$[#]'
    // selector to atomically append.
    await this.sql
      .prepare(
        `UPDATE session_streams
           SET chunks_json = json_insert(chunks_json, '$[#]', ?)
         WHERE session_id = ? AND message_id = ? AND status = 'streaming'`,
      )
      .bind(delta, this.sessionId, messageId)
      .run();
  }

  async finalize(
    messageId: string,
    status: "completed" | "aborted" | "interrupted",
    errorText?: string,
  ): Promise<void> {
    await this.sql
      .prepare(
        `UPDATE session_streams
           SET status = ?, completed_at = ?, error_text = ?
         WHERE session_id = ? AND message_id = ?`,
      )
      .bind(status, Date.now(), errorText ?? null, this.sessionId, messageId)
      .run();
  }

  async get(messageId: string): Promise<StreamRow | null> {
    const r = await this.sql
      .prepare(
        `SELECT message_id, status, chunks_json, started_at, completed_at, error_text
           FROM session_streams
           WHERE session_id = ? AND message_id = ?`,
      )
      .bind(this.sessionId, messageId)
      .first<DbStream>();
    return r ? toStreamRow(r) : null;
  }

  async listByStatus(status: StreamRow["status"]): Promise<StreamRow[]> {
    const r = await this.sql
      .prepare(
        `SELECT message_id, status, chunks_json, started_at, completed_at, error_text
           FROM session_streams
           WHERE session_id = ? AND status = ?
           ORDER BY started_at`,
      )
      .bind(this.sessionId, status)
      .all<DbStream>();
    return (r.results ?? []).map(toStreamRow);
  }
}

interface DbStream {
  message_id: string;
  status: string;
  chunks_json: string;
  started_at: number;
  completed_at: number | null;
  error_text: string | null;
}

function toStreamRow(r: DbStream): StreamRow {
  return {
    message_id: r.message_id,
    status: r.status as StreamRow["status"],
    chunks: JSON.parse(r.chunks_json) as string[],
    started_at: r.started_at,
    completed_at: r.completed_at ?? undefined,
    error_text: r.error_text ?? undefined,
  };
}

/**
 * Idempotent schema bootstrap. Call once at app startup (before any
 * SessionRegistry / repo construction).
 *
 * Schema notes:
 *  - PK (session_id, seq) on events: per-session monotone, queried by seq.
 *  - PK (session_id, message_id) on streams: matches CF DO's per-DO PK
 *    semantics with an explicit session scope column added.
 *  - JSON1 functions are assumed available; better-sqlite3 bundles SQLite
 *    with JSON1 enabled, D1 also has JSON1, and Postgres has native JSONB
 *    so a future PG flavour will swap to that.
 */
export async function ensureSchema(sql: SqlClient): Promise<void> {
  await sql.exec(`
    CREATE TABLE IF NOT EXISTS session_events (
      session_id TEXT NOT NULL,
      seq BIGINT NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL,
      ts BIGINT NOT NULL,
      PRIMARY KEY (session_id, seq)
    );
  `);
  await sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_events_type
      ON session_events (session_id, type, seq DESC);
  `);
  await sql.exec(`
    CREATE TABLE IF NOT EXISTS session_streams (
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      status TEXT NOT NULL,
      chunks_json TEXT NOT NULL DEFAULT '[]',
      started_at BIGINT NOT NULL,
      completed_at BIGINT,
      error_text TEXT,
      PRIMARY KEY (session_id, message_id)
    );
  `);
  await sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_streams_status
      ON session_streams (session_id, status);
  `);
}
