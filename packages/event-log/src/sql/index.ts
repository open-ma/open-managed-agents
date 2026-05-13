// SqlClient-backed adapter for EventLogRepo + StreamRepo. Works with any
// SqlClient (D1 / better-sqlite3 / postgres.js) — schema is plain SQLite-
// flavoured DDL with portable types, with two narrow PG branches noted
// below (json_insert vs jsonb concat, PRAGMA vs information_schema).
//
// This is the self-host cousin of cf-do/index.ts, which scopes everything to a
// per-DO SQLite namespace. Here we share one SqlClient across all sessions
// in a process, so every table carries an explicit `session_id` column and
// every read/write is filtered by it. The repo instance is bound to one
// session_id at construction.

import type { SessionEvent } from "@open-managed-agents/shared";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { EventLogRepo, StreamRepo, StreamRow } from "../ports";

export type SqlDialect = "sqlite" | "postgres";

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
    // Mirror cf-do/index.ts: user.* are pending until drained;
    // everything else is "ingested" at write time. session_thread_id
    // defaults to primary; events from sub-agent threads carry their
    // own session_thread_id on the wire.
    const isPending =
      event.type === "user.message" ||
      event.type === "user.tool_confirmation" ||
      event.type === "user.custom_tool_result";
    const processedAt = isPending ? null : ts;
    const threadId =
      (event as unknown as { session_thread_id?: string }).session_thread_id ??
      "sthr_primary";
    await this.sql
      .prepare(
        `INSERT INTO session_events (session_id, seq, type, data, ts, processed_at, session_thread_id)
         SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ?
           FROM session_events WHERE session_id = ?`,
      )
      .bind(
        this.sessionId,
        event.type,
        JSON.stringify(event),
        ts,
        processedAt,
        threadId,
        this.sessionId,
      )
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
        ? `SELECT seq, type, data, ts, processed_at, cancelled_at, session_thread_id FROM session_events
           WHERE session_id = ? AND seq > ? ORDER BY seq`
        : `SELECT seq, type, data, ts, processed_at, cancelled_at, session_thread_id FROM session_events
           WHERE session_id = ? ORDER BY seq`;
    const stmt =
      afterSeq !== undefined
        ? this.sql.prepare(sql).bind(this.sessionId, afterSeq)
        : this.sql.prepare(sql).bind(this.sessionId);
    const r = await stmt.all<{
      seq: number; type: string; data: string; ts: number;
      processed_at: number | null; cancelled_at: number | null; session_thread_id: string | null;
    }>();
    return (r.results ?? []).map((row) => {
      const ev = JSON.parse(row.data) as SessionEvent & Record<string, unknown>;
      ev.seq = row.seq;
      ev.ts = row.ts;
      // Stash row-level pending lifecycle onto the event object — same
      // contract as cf-do/index.ts so eventsToMessages can skip cancelled
      // events without a separate query path.
      if (row.processed_at !== null) ev.processed_at_ms = row.processed_at;
      if (row.cancelled_at !== null) ev.cancelled_at_ms = row.cancelled_at;
      if (row.session_thread_id != null) ev.session_thread_id = row.session_thread_id;
      return ev as SessionEvent;
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
    /** Set to "postgres" when the underlying SqlClient is postgres.js;
     *  controls the json-array append SQL (no portable equivalent of
     *  json_insert across SQLite + PG). Defaults to "sqlite". */
    private dialect: SqlDialect = "sqlite",
  ) {}

  async start(messageId: string, startedAt: number): Promise<void> {
    // ON CONFLICT … DO NOTHING is the portable upsert no-op; both
    // SQLite and PG accept it (replaces the prior INSERT OR IGNORE).
    await this.sql
      .prepare(
        `INSERT INTO session_streams
           (session_id, message_id, status, chunks_json, started_at)
         VALUES (?, ?, 'streaming', '[]', ?)
         ON CONFLICT (session_id, message_id) DO NOTHING`,
      )
      .bind(this.sessionId, messageId, startedAt)
      .run();
  }

  async appendChunk(messageId: string, delta: string): Promise<void> {
    // Atomic JSON-array append. SQLite has json_insert with the '$[#]'
    // selector; PG has no equivalent on TEXT columns, so we round-trip
    // through jsonb. The harness already serialises broadcasts per
    // session via writeChain, so concurrent writers on the same row
    // aren't an issue in practice.
    const updateSql =
      this.dialect === "postgres"
        ? `UPDATE session_streams
             SET chunks_json = ((chunks_json::jsonb) || jsonb_build_array(?::text))::text
           WHERE session_id = ? AND message_id = ? AND status = 'streaming'`
        : `UPDATE session_streams
             SET chunks_json = json_insert(chunks_json, '$[#]', ?)
           WHERE session_id = ? AND message_id = ? AND status = 'streaming'`;
    await this.sql
      .prepare(updateSql)
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
export async function ensureSchema(
  sql: SqlClient,
  dialect: SqlDialect = "sqlite",
): Promise<void> {
  await sql.exec(`
    CREATE TABLE IF NOT EXISTS session_events (
      session_id TEXT NOT NULL,
      seq BIGINT NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL,
      ts BIGINT NOT NULL,
      -- Mirror of cf-do/index.ts pending lifecycle. processed_at is NULL
      -- for queued user.* events, set to wall-clock ms when the harness
      -- ingests them. cancelled_at is set by user.interrupt's flush
      -- UPDATE. session_thread_id defaults to 'sthr_primary'; sub-agent
      -- threads use 'sthr_*' ids spawned by SessionStateMachine when
      -- it grows multi-thread support.
      processed_at BIGINT,
      cancelled_at BIGINT,
      session_thread_id TEXT,
      PRIMARY KEY (session_id, seq)
    );
  `);
  // Idempotent ALTER for pre-existing schemas. Neither SQLite nor PG has
  // ADD COLUMN IF NOT EXISTS in our supported versions; probe with the
  // dialect-appropriate catalog query (PRAGMA on sqlite,
  // information_schema on postgres) and add only what's missing.
  const cols = await readSessionEventColumns(sql, dialect);
  if (!cols.has("processed_at")) {
    await sql.exec(`ALTER TABLE session_events ADD COLUMN processed_at BIGINT`);
    await sql.exec(`UPDATE session_events SET processed_at = ts WHERE processed_at IS NULL`);
  }
  if (!cols.has("cancelled_at")) {
    await sql.exec(`ALTER TABLE session_events ADD COLUMN cancelled_at BIGINT`);
  }
  if (!cols.has("session_thread_id")) {
    await sql.exec(`ALTER TABLE session_events ADD COLUMN session_thread_id TEXT`);
    await sql.exec(`UPDATE session_events SET session_thread_id = 'sthr_primary' WHERE session_thread_id IS NULL`);
  }
  await sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_events_type
      ON session_events (session_id, type, seq DESC);
  `);
  // Pending hot-path index. Both SQLite and PG support partial indexes
  // with WHERE clauses. Mirrors cf-do/index.ts idx_events_pending.
  await sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_events_pending
      ON session_events (session_id, session_thread_id, seq)
      WHERE processed_at IS NULL AND cancelled_at IS NULL
        AND (type = 'user.message' OR type = 'user.tool_confirmation' OR type = 'user.custom_tool_result');
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

async function readSessionEventColumns(
  sql: SqlClient,
  dialect: SqlDialect,
): Promise<Set<string>> {
  const cols = new Set<string>();
  if (dialect === "postgres") {
    const r = await sql
      .prepare(
        `SELECT column_name AS name FROM information_schema.columns
         WHERE table_name = 'session_events'`,
      )
      .all<{ name: string }>();
    for (const row of r.results ?? []) cols.add(row.name);
  } else {
    const r = await sql
      .prepare(`PRAGMA table_info(session_events)`)
      .all<{ name: string }>();
    for (const row of r.results ?? []) cols.add(row.name);
  }
  return cols;
}
