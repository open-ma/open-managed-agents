// Postgres adapter — interface declared so consumers can wire it via
// factory but the actual implementation lands in a follow-up.
//
// Notes for whoever fills this in:
//
// - Schema (suggested): one shared `session_events` table partitioned
//   by session_id, NOT a per-session table. Indexes:
//     PRIMARY KEY (session_id, seq)
//     INDEX idx_session_events_type (session_id, type, seq DESC)
//
// - `seq` should be assigned via a per-session counter, not the global
//   serial — otherwise sessions interleave their seqs which breaks
//   recovery logic that depends on dense seq order. Use a small
//   subquery: `(SELECT COALESCE(MAX(seq),0)+1 FROM session_events
//   WHERE session_id=$1)`. Acceptable race for OMA's use (single-
//   threaded SessionDO equivalents in Postgres deployments).
//
// - Stream buffer should live in a separate table
//   (`session_stream_buffers`) with one row per session — ON CONFLICT
//   DO UPDATE for the put path. Adapter is free to batch puts
//   internally to amortize the network roundtrip cost; the contract
//   is "the latest put wins, eventually".

import type { EventLogRepo, StreamBufferRepo } from "../ports";

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

export class PgStreamBuffer implements StreamBufferRepo {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_dbUrl: string, _sessionId: string) {
    throw new Error(
      "PgStreamBuffer: not implemented yet — see packages/event-log/src/pg/index.ts header for schema notes",
    );
  }

  async put(): Promise<void> { throw new Error("not implemented"); }
  async get(): Promise<never> { throw new Error("not implemented"); }
  async clear(): Promise<void> { throw new Error("not implemented"); }
}
