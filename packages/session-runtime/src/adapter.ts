// Single RuntimeAdapter implementation, shared by CF and Node.
//
// All platform-specific details collapse into:
//   - The SqlClient passed in (CfD1SqlClient over DO storage / better-
//     sqlite3 / postgres.js — the platform decides which)
//   - The optional onTurnInFlight callback the entry shell wires (CF
//     uses it to setAlarm; Node leaves it unset)
//
// The state machine holds one of these per session and never branches on
// platform.

import type { SqlClient } from "@open-managed-agents/sql-client";
import type { EventLogRepo, StreamRepo } from "@open-managed-agents/event-log";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import type { OrphanTurn, RuntimeAdapter, TurnId } from "./ports";

export interface RuntimeAdapterOptions {
  sql: SqlClient;
  eventLog: EventLogRepo;
  streams: StreamRepo;
  sandbox: SandboxExecutor;
  /** Per-platform shell hook. CF: setAlarm(now+30s). Node: leave unset. */
  onTurnInFlight?: (sessionId: string) => void;
}

export class RuntimeAdapterImpl implements RuntimeAdapter {
  readonly sql: SqlClient;
  readonly eventLog: EventLogRepo;
  readonly streams: StreamRepo;
  readonly sandbox: SandboxExecutor;
  private readonly onTurnInFlight?: (sessionId: string) => void;

  constructor(opts: RuntimeAdapterOptions) {
    this.sql = opts.sql;
    this.eventLog = opts.eventLog;
    this.streams = opts.streams;
    this.sandbox = opts.sandbox;
    this.onTurnInFlight = opts.onTurnInFlight;
  }

  async beginTurn(sessionId: string, turnId: TurnId): Promise<void> {
    const now = Date.now();
    await this.sql
      .prepare(
        `UPDATE sessions
            SET status='running', turn_id=?, turn_started_at=?, updated_at=?
          WHERE id=?`,
      )
      .bind(turnId, now, now, sessionId)
      .run();
  }

  async endTurn(
    sessionId: string,
    turnId: TurnId,
    status: "idle" | "destroyed",
  ): Promise<void> {
    const now = Date.now();
    // Filter by turn_id so a stale endTurn (e.g. from a recovery that
    // raced with a new beginTurn) doesn't clobber a fresh run.
    await this.sql
      .prepare(
        `UPDATE sessions
            SET status=?, turn_id=NULL, turn_started_at=NULL, updated_at=?
          WHERE id=? AND turn_id=?`,
      )
      .bind(status, now, sessionId, turnId)
      .run();
  }

  async listOrphanTurns(sessionId: string): Promise<OrphanTurn[]> {
    const r = await this.sql
      .prepare(
        `SELECT id AS session_id, turn_id, turn_started_at
           FROM sessions
          WHERE id=? AND status='running' AND turn_id IS NOT NULL`,
      )
      .bind(sessionId)
      .all<{ session_id: string; turn_id: string; turn_started_at: number }>();
    return (r.results ?? []).map((row) => ({
      session_id: row.session_id,
      turn_id: row.turn_id,
      turn_started_at: row.turn_started_at,
    }));
  }

  hintTurnInFlight(sessionId: string): void {
    this.onTurnInFlight?.(sessionId);
  }
}
