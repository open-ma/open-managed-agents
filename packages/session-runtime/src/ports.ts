// Runtime ports for the session state machine.
//
// Phase 1: skeleton — types only. The single `RuntimeAdapter` interface
// here will be implemented once (RuntimeAdapterImpl in Phase 2) and used
// identically by both the CF SessionDO shell and the Node
// SessionRegistry shell. Per-platform behaviour collapses into:
//
//   - SQL access via the platform's SqlClient (already a port)
//   - Optional `hintTurnInFlight` callback the per-platform shell can use
//     to schedule its own keep-alive (CF: setAlarm; Node: no-op)
//   - The eventLog/streams/sandbox/hub fields are platform-neutral
//
// See nifty-prancing-flamingo.md → "RuntimeAdapter interface" for the
// design rationale (one adapter, two thin shells).

import type { SqlClient } from "@open-managed-agents/sql-client";
import type { EventLogRepo, StreamRepo } from "@open-managed-agents/event-log";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";

/** Opaque per-turn id (nanoid). Stored on the sessions row while a turn is
 *  in flight so cold starts can detect orphans. */
export type TurnId = string;

/** A turn that was marked running by a previous runtime instance and never
 *  reached endTurn. Returned by RuntimeAdapter.listOrphanTurns and handed
 *  to the recovery routine. */
export interface OrphanTurn {
  session_id: string;
  turn_id: TurnId;
  /** ms — when the dead turn began. Used for stuck-turn telemetry. */
  turn_started_at: number;
}

/**
 * Single runtime adapter used identically on CF DO and Node.
 *
 * Per-platform thin shells (apps/agent/src/runtime/session-do.ts and
 * apps/main-node/src/registry.ts) construct one of these with the right
 * SqlClient / SandboxExecutor / hub for that platform, then hand it to a
 * `SessionStateMachine`. The state machine has no platform branches.
 *
 * Why no per-platform interface: every method here either delegates to a
 * port that's already platform-agnostic (SqlClient, EventLogRepo,
 * StreamRepo, SandboxExecutor) or writes/reads the unified `sessions`
 * table. The only knowledge a per-platform shell needs is "how do I want
 * to react when a turn starts?" — that's the optional `hintTurnInFlight`
 * callback wired by the shell at construction.
 */
export interface RuntimeAdapter {
  readonly sql: SqlClient;
  readonly eventLog: EventLogRepo;
  readonly streams: StreamRepo;
  /** Optional — only callers that actually need to hand a sandbox to
   *  the harness (SessionStateMachine.runHarnessTurn) require this.
   *  turn-runtime.ts only uses lifecycle methods. */
  readonly sandbox?: SandboxExecutor;

  /**
   * Mark a turn as in flight on the sessions row. Atomic with respect to
   * concurrent reads via listOrphanTurns. Implementation:
   *   UPDATE sessions
   *      SET status='running', turn_id=?, turn_started_at=?
   *    WHERE id=?
   */
  beginTurn(sessionId: string, turnId: TurnId): Promise<void>;

  /**
   * Mark a turn complete (status='idle') or the whole session destroyed.
   * Idempotent — calling endTurn twice with the same turnId is a no-op
   * the second time (the WHERE clause filters by current turn_id).
   */
  endTurn(
    sessionId: string,
    turnId: TurnId,
    status: "idle" | "destroyed",
  ): Promise<void>;

  /**
   * Find sessions with status='running' that don't match the caller's
   * known active turn id. Caller is the SessionStateMachine; it filters
   * out its own in-progress turn before treating each row as an orphan
   * and calling recoverInterruptedState on it.
   *
   * On CF the lookup is scoped to the calling DO (only ever one row).
   * On Node the lookup is scoped to a sessionId from the registry. Both
   * cases SELECT from the same `sessions` table.
   */
  listOrphanTurns(sessionId: string): Promise<OrphanTurn[]>;

  /**
   * Optional hook the per-platform shell wires up. Called by the state
   * machine right after beginTurn. CF impl uses it to set a 30s self-
   * rearming alarm (so the DO doesn't get evicted mid-turn). Node impl is
   * unset — fly/k8s won't evict an in-flight HTTP request, so no
   * keepAlive equivalent is needed.
   *
   * MUST NOT block the turn — fire-and-forget only.
   */
  hintTurnInFlight?(sessionId: string): void;
}
