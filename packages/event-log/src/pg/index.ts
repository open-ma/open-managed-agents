// Postgres adapter — interface declared so consumers can wire it via
// factory but the actual implementation lands when a self-hosted
// deployment actually needs it.
//
// Schema notes (suggested):
//
//   CREATE TABLE session_events (
//     session_id        TEXT NOT NULL,
//     seq               INTEGER NOT NULL,             -- per-session counter
//     type              TEXT NOT NULL,
//     data              JSONB NOT NULL,
//     ts                BIGINT NOT NULL,              -- unix ms
//     processed_at      BIGINT,                       -- NULL = pending user.* event
//     cancelled_at      BIGINT,                       -- set by user.interrupt flush
//     session_thread_id TEXT,                         -- 'sthr_primary' or 'sthr_*'
//     PRIMARY KEY (session_id, seq)
//   );
//   CREATE INDEX idx_session_events_type
//     ON session_events (session_id, type, seq DESC);
//   CREATE INDEX idx_session_events_pending
//     ON session_events (session_id, session_thread_id, seq)
//     WHERE processed_at IS NULL AND cancelled_at IS NULL
//       AND type IN ('user.message', 'user.tool_confirmation', 'user.custom_tool_result');
//
//   -- seq via per-session subquery on insert; OK race for OMA's single-
//   -- threaded SessionDO equivalent. Acceptable conflict semantics:
//   -- INSERT ... ON CONFLICT (session_id, seq) DO NOTHING + retry.
//
//   CREATE TABLE session_streams (
//     session_id   TEXT NOT NULL,
//     message_id   TEXT NOT NULL,
//     status       TEXT NOT NULL,
//     chunks_json  JSONB NOT NULL DEFAULT '[]'::JSONB,
//     started_at   BIGINT NOT NULL,
//     completed_at BIGINT,
//     error_text   TEXT,
//     PRIMARY KEY (session_id, message_id)
//   );
//   CREATE INDEX idx_session_streams_status
//     ON session_streams (session_id, status);
//
//   -- appendChunk via:
//   --   UPDATE session_streams
//   --      SET chunks_json = chunks_json || to_jsonb($1::TEXT)
//   --    WHERE session_id = $2 AND message_id = $3 AND status = 'streaming';
//
// The PG adapter is free to batch appendChunk internally to amortize the
// cross-network roundtrip cost; the contract is "the latest put wins,
// eventually". In CF's case the cf-do adapter has ms-level latency so
// batching is unnecessary; in PG with a 50ms roundtrip, batching every
// 100ms keeps streaming feel intact.

import type { EventLogRepo, StreamRepo } from "../ports";

export class PgEventLog implements EventLogRepo {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_dbUrl: string, _sessionId: string) {
    throw new Error(
      "PgEventLog: not implemented yet — see packages/event-log/src/pg/index.ts header for schema notes",
    );
  }

  append(): void { throw new Error("not implemented"); }
  getEvents(): never { throw new Error("not implemented"); }
  getLastEventSeq(): never { throw new Error("not implemented"); }
  getFirstEventAfter(): never { throw new Error("not implemented"); }
}

export class PgStreamRepo implements StreamRepo {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_dbUrl: string, _sessionId: string) {
    throw new Error(
      "PgStreamRepo: not implemented yet — see packages/event-log/src/pg/index.ts header for schema notes",
    );
  }

  async start(): Promise<void> { throw new Error("not implemented"); }
  async appendChunk(): Promise<void> { throw new Error("not implemented"); }
  async finalize(): Promise<void> { throw new Error("not implemented"); }
  async get(): Promise<never> { throw new Error("not implemented"); }
  async listByStatus(): Promise<never> { throw new Error("not implemented"); }
}
