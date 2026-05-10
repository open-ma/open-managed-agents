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
  /** Optional — only SessionStateMachine.runHarnessTurn uses this.
   *  turn-runtime.ts callers (CF SessionDO today) leave it unset. */
  sandbox?: SandboxExecutor;
  /** Per-platform shell hook. CF: setAlarm(now+30s) AND register turnId
   *  into the local active-turn set so _checkOrphanTurns can filter
   *  out the caller's own active turns (port contract; see ports.ts).
   *  Node: leave unset (SessionStateMachine tracks activeTurnId
   *  directly in runTurn). */
  onTurnInFlight?: (sessionId: string, turnId: TurnId) => void;
  /** Symmetric hook fired after endTurn's UPDATE lands. CF uses it to
   *  remove turnId from the local active-turn set so the next
   *  _checkOrphanTurns pass treats a row left behind by an out-of-band
   *  crash as a real orphan. Node leaves it unset. */
  onTurnEnded?: (sessionId: string, turnId: TurnId) => void;
  /** Long-running keep-alive wrapper. CF: setAlarm-based heartbeat that
   *  refreshes the eviction horizon for the duration of fn. Node: leave
   *  unset (identity passthrough at the call site). See ports.ts for the
   *  contract. */
  keepAliveWhile?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export class RuntimeAdapterImpl implements RuntimeAdapter {
  readonly sql: SqlClient;
  readonly eventLog: EventLogRepo;
  readonly streams: StreamRepo;
  readonly sandbox?: SandboxExecutor;
  private readonly onTurnInFlight?: (sessionId: string, turnId: TurnId) => void;
  private readonly onTurnEnded?: (sessionId: string, turnId: TurnId) => void;
  private readonly _keepAliveWhile?: <T>(fn: () => Promise<T>) => Promise<T>;

  constructor(opts: RuntimeAdapterOptions) {
    this.sql = opts.sql;
    this.eventLog = opts.eventLog;
    this.streams = opts.streams;
    this.sandbox = opts.sandbox;
    this.onTurnInFlight = opts.onTurnInFlight;
    this.onTurnEnded = opts.onTurnEnded;
    this._keepAliveWhile = opts.keepAliveWhile;
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
    this.onTurnEnded?.(sessionId, turnId);
  }

  async terminate(sessionId: string, _reason: string): Promise<void> {
    const now = Date.now();
    // Idempotent: second call is a no-op because the WHERE filter only
    // matches rows that aren't already terminated. Also clears any
    // in-flight turn marker so listOrphanTurns doesn't see a ghost row.
    await this.sql
      .prepare(
        `UPDATE sessions
            SET status='terminated', terminated_at=?, turn_id=NULL,
                turn_started_at=NULL, updated_at=?
          WHERE id=? AND terminated_at IS NULL`,
      )
      .bind(now, now, sessionId)
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

  hintTurnInFlight(sessionId: string, turnId: TurnId): void {
    this.onTurnInFlight?.(sessionId, turnId);
  }

  hintTurnEnded(sessionId: string, turnId: TurnId): void {
    this.onTurnEnded?.(sessionId, turnId);
  }

  async keepAliveWhile<T>(fn: () => Promise<T>): Promise<T> {
    // Default to identity when no platform hook is wired (Node, tests).
    // CF wires opts.keepAliveWhile to a setAlarm-based heartbeat.
    return this._keepAliveWhile ? this._keepAliveWhile(fn) : fn();
  }
}
