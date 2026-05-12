/**
 * Two-primitive turn runtime for the OMA agent harness.
 *
 * Replaces the tangled mix of withRetry + per-attempt keepAliveWhile +
 * stale-chunk + heartbeat + ctx.waitUntil-backup that grew up inside
 * default-loop.ts and session-do.ts. The contract is:
 *
 *   1. **runAgentTurn**  — mark the turn in flight on the unified
 *      `sessions` table (status='running', turn_id=...) so cold starts
 *      can detect orphans, and synchronously persist workspace state
 *      before returning success or surfacing a typed `TurnError`. NO
 *      internal retry — the caller (eval-runner / app) decides what to
 *      do. Stall detection lives in the harness next to streamText
 *      (default-loop.ts), not here.
 *
 *   2. **recoverAgentTurn** — after a process death (DO eviction, Node
 *      restart, container OOM kill), read SQL events + streams to
 *      reconstruct the state at the moment of interruption, then hand a
 *      typed `RecoveryContext` to the caller's resume function. The
 *      caller decides whether to persist any partials and whether to
 *      continue. We cap recovery attempts per turn to bound runaway
 *      loops.
 *
 * Background on the design:
 *   - Lifecycle is now expressed as RuntimeAdapter.beginTurn /
 *     hintTurnInFlight / endTurn — the same shape used by Node
 *     (apps/main-node) and CF (apps/agent SessionDO). The cf-agents
 *     `keepAliveWhile { runFiber { fn } }` chain that lived here in
 *     v0.x has been ripped out: marker rows live on `sessions.turn_id`
 *     not in `cf_agents_runs`; CF's keep-alive (setAlarm 30s) is now
 *     a callback the per-platform shell wires via
 *     adapter.hintTurnInFlight.
 *   - Workspace persistence remains OMA-original: synchronous backup
 *     before runAgentTurn returns.
 *   - We deliberately do NOT carry a per-turn snapshot. OMA's events
 *     and streams tables already carry richer state than any blob; the
 *     recovery path reconstructs from those.
 */

import { nanoid } from "nanoid";
import type { SessionEvent } from "@open-managed-agents/shared";
import type { RuntimeAdapter, TurnId } from "@open-managed-agents/session-runtime";

// ─── Adapter interface ──────────────────────────────────────────────────
//
// `agent.ctx` is `protected` on cf-agents Agent so we can't reach into it
// from this module. The adapter exposes the methods we need from the
// outside; SessionDO constructs one bound to itself and passes it in.

export interface TurnRuntimeAgent {
  /** Unified runtime adapter — beginTurn / endTurn / listOrphanTurns + the
   *  underlying eventLog/streams used by recovery. CF SessionDO and Node
   *  registry both build one of these the same way. */
  adapter: RuntimeAdapter;
  /** Session id this adapter is bound to — passed to beginTurn/endTurn. */
  sessionId: string;
  /** Subset of DurableObjectStorage we use for the recovery counter. */
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put<T = unknown>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<void>;
  };
}

// ─── Errors ──────────────────────────────────────────────────────────────

export type TurnError =
  | { kind: "rate_limited"; provider?: string; retry_after_ms?: number; raw?: string }
  | { kind: "do_evicted"; recoveries_used: number }
  | { kind: "stream_stall"; ms_since_last_chunk: number }
  | { kind: "model_timeout"; ms: number }
  | { kind: "model_error"; status?: number; message: string }
  | { kind: "backup_failed"; message: string }
  | { kind: "user_aborted" }
  | { kind: "unexpected"; message: string };

export class TurnAborted extends Error {
  constructor(public readonly cause: TurnError) {
    super(`${cause.kind}: ${JSON.stringify(cause).slice(0, 200)}`);
    this.name = "TurnAborted";
  }
}

// ─── Primitive 1: runAgentTurn ───────────────────────────────────────────

export interface TurnContext {
  /** Stable name for this turn — same value passed to runAgentTurn. */
  readonly turnName: string;
  /** AbortSignal — currently just the caller-provided parentSignal (or never-aborts default). */
  readonly signal: AbortSignal;
}

export interface RunAgentTurnOptions {
  /**
   * Synchronous workspace persistence. Called once at end of turn (success
   * or failure) before runAgentTurn returns. Failure is fatal — surfaced
   * as `TurnError.backup_failed`. Caller passes a function that does
   * whatever durable-state work is needed (e.g. await maybeBackupWorkspace).
   */
  persistWorkspace?: () => Promise<void>;
  /**
   * Optional caller-provided abort signal — exposed verbatim on TurnContext.signal.
   */
  parentSignal?: AbortSignal;
}

/**
 * Run an agent turn with end-to-end lifetime guarantee.
 *
 * Wraps the body in cf-agents `keepAliveWhile { runFiber }` so the DO
 * stays alive for the full turn duration. Stall detection lives inside
 * the harness (default-loop.ts) next to the streamText call — the
 * runtime no longer composes a stall AbortController. Workspace
 * persistence runs synchronously at end of turn. Errors are typed and
 * thrown as `TurnAborted`. NO internal retry — caller catches
 * TurnAborted and decides next steps.
 *
 * @returns whatever `fn` returns on success
 * @throws TurnAborted on any failure
 */
export async function runAgentTurn<T>(
  agent: TurnRuntimeAgent,
  turnName: string,
  fn: (ctx: TurnContext) => Promise<T>,
  opts: RunAgentTurnOptions = {},
): Promise<T> {
  const turnStartedAt = Date.now();
  const turnId: TurnId = nanoid();

  const ctx: TurnContext = {
    turnName,
    signal: opts.parentSignal ?? new AbortController().signal,
  };

  // Mark the turn in flight on the unified `sessions` table. Cold-start
  // detection (CF: alarm; Node: registry.bootstrap) finds these via
  // adapter.listOrphanTurns. The hint callback is the per-platform
  // shell's keep-alive — CF wires setAlarm(now+30s) here so the DO
  // doesn't get evicted mid-turn; Node leaves it unset (fly/k8s won't
  // evict in-flight HTTP).
  await agent.adapter.beginTurn(agent.sessionId, turnId);
  agent.adapter.hintTurnInFlight?.(agent.sessionId, turnId);

  try {
    let result: T;
    try {
      result = await fn(ctx);
    } catch (err) {
      // Try to persist whatever partial state landed before re-throwing
      // so the next turn / verifier / debugger doesn't lose evidence.
      if (opts.persistWorkspace) {
        try {
          await opts.persistWorkspace();
        } catch (persistErr) {
          console.warn(
            `[turn] persistWorkspace also failed during error path: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
          );
        }
      }
      throw classifyError(err, {
        sinceTurnStart: Date.now() - turnStartedAt,
      });
    }
    // Happy path: persist before returning. Failure here is a real
    // turn failure — caller deserves to know the agent finished but its
    // state didn't land.
    if (opts.persistWorkspace) {
      try {
        await opts.persistWorkspace();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new TurnAborted({ kind: "backup_failed", message: msg });
      }
    }
    return result;
  } finally {
    try {
      await agent.adapter.endTurn(agent.sessionId, turnId, "idle");
    } catch (err) {
      console.warn(`[turn] endTurn failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Symmetric to hintTurnInFlight above. CF shell uses this to drop
    // turnId from its local active set; Node shell no-ops (machine.ts
    // tracks via activeTurnId). Fired before the elapsed-time log so
    // any orphan-detection that runs concurrently sees the up-to-date
    // membership.
    agent.adapter.hintTurnEnded?.(agent.sessionId, turnId);
    const totalElapsed = Date.now() - turnStartedAt;
    console.log(`[turn] END name=${turnName} elapsed=${totalElapsed}ms`);
  }
}

function classifyError(
  err: unknown,
  state: { sinceTurnStart: number },
): TurnAborted {
  if (err instanceof TurnAborted) return err;
  const msg = err instanceof Error ? err.message : String(err);
  // Stall: the harness's in-closure setTimeout fires AbortController.abort()
  // when no chunk arrives for STALE_CHUNK_THRESHOLD_MS. ai-sdk surfaces
  // that as either a generic abort error or one with "stalled" in the
  // message — match both.
  if (/stall/i.test(msg)) {
    return new TurnAborted({
      kind: "stream_stall",
      ms_since_last_chunk: state.sinceTurnStart,
    });
  }
  // Pattern-match common provider error shapes. Best-effort classification.
  if (/\b429\b|rate.?limit|too many requests/i.test(msg)) {
    const m = msg.match(/retry-after[:\s]+(\d+)/i);
    return new TurnAborted({
      kind: "rate_limited",
      retry_after_ms: m ? parseInt(m[1], 10) * 1000 : undefined,
      raw: msg.slice(0, 300),
    });
  }
  if (/timeout|timed out|aborted/i.test(msg)) {
    return new TurnAborted({ kind: "model_timeout", ms: 0 });
  }
  if (/^abort/i.test(msg)) {
    return new TurnAborted({ kind: "user_aborted" });
  }
  const status = (err as { status?: number; statusCode?: number })?.status
    ?? (err as { statusCode?: number })?.statusCode;
  if (typeof status === "number") {
    return new TurnAborted({ kind: "model_error", status, message: msg.slice(0, 300) });
  }
  return new TurnAborted({ kind: "unexpected", message: msg.slice(0, 300) });
}

// ─── Primitive 2: recoverAgentTurn ───────────────────────────────────────

export interface PartialStream {
  message_id: string;
  partial_text: string;
  status: "streaming" | "interrupted";
}

export interface RecoveryContext {
  /** Same name passed to the original runAgentTurn. */
  readonly turnName: string;
  /** Events strictly after the last `user.message` — what the agent had emitted. */
  readonly history: SessionEvent[];
  /** Streams that were in flight when the DO died. */
  readonly partialStreams: PartialStream[];
  /** Cumulative recovery attempts on THIS turn — survives across DO restarts via DO storage. */
  readonly recoveryCount: number;
}

export interface RecoveryDecision {
  /** Re-enter the turn (caller resumes processing). Default false. */
  continue: boolean;
  /**
   * If true, persist any partial agent.message extracted from
   * partialStreams as a canonical event so the user / next turn sees what
   * was already streamed. Default false.
   */
  persistPartial?: boolean;
}

export interface RecoverAgentTurnOptions {
  /** Hard upper bound on recoveries per turn. Default 5. */
  maxRecoveries?: number;
  /** Caller-provided event sink for emitting agent.error / status updates. */
  emitEvent?: (event: SessionEvent) => void;
  /** Synchronously persist partial agent.message when decision.persistPartial=true. */
  persistAgentMessage?: (text: string, message_id: string) => void;
  /** Force the session into idle state — emitted when we hit the recovery cap. */
  forceIdle?: () => void;
}

/**
 * Read-side counterpart to runAgentTurn. Called from cf-agents
 * onFiberRecovered when the library detects an orphan fiber row left
 * behind by DO eviction.
 *
 * We pass the caller a typed RecoveryContext built from SQL events and
 * streams (NOT from cf-agents stash — OMA's tables already carry richer
 * state). The caller decides:
 *   - whether to persist any partial agent.message that was streamed
 *     before the eviction (so users see "what the agent was saying" even
 *     though it didn't finish),
 *   - whether to re-enter the turn (resume processing the unfinished
 *     user.message).
 *
 * If recoveryCount exceeds maxRecoveries we stop trying — emit a
 * session.error + force idle so the trial / caller can see a terminal
 * state instead of waiting forever.
 *
 * @returns the caller's RecoveryDecision (after applying persist/continue)
 */
export async function recoverAgentTurn(
  agent: TurnRuntimeAgent,
  ctx: { id: string; name: string; snapshot: unknown },
  loadRecoveryContext: () => Promise<{
    history: SessionEvent[];
    partialStreams: PartialStream[];
  }>,
  resumeFn: (rctx: RecoveryContext) => Promise<RecoveryDecision>,
  opts: RecoverAgentTurnOptions = {},
): Promise<RecoveryDecision> {
  const maxRecoveries = opts.maxRecoveries ?? 5;
  const recoveryKey = `turn_recovery:${ctx.name}`;

  // recoveryCount is persisted to DO storage so survives across restarts.
  const prevCount = (await agent.storage.get<number>(recoveryKey)) ?? 0;
  const nextCount = prevCount + 1;
  await agent.storage.put(recoveryKey, nextCount);

  console.warn(`[recover] turn=${ctx.name} fiber=${ctx.id} count=${nextCount}/${maxRecoveries}`);

  if (nextCount > maxRecoveries) {
    console.error(`[recover] turn=${ctx.name} exceeded ${maxRecoveries} recoveries — aborting`);
    try {
      opts.emitEvent?.({
        type: "session.error",
        error: `turn aborted: exceeded ${maxRecoveries} eviction recoveries on ${ctx.name}. Either DO is being evicted faster than the model call can complete, or the model call itself is hanging.`,
      } as SessionEvent);
    } catch {}
    try {
      opts.forceIdle?.();
    } catch {}
    // Reset for next user.message
    await agent.storage.delete(recoveryKey);
    return { continue: false };
  }

  const { history, partialStreams } = await loadRecoveryContext();
  const decision = await resumeFn({
    turnName: ctx.name,
    history,
    partialStreams,
    recoveryCount: nextCount,
  });

  if (decision.persistPartial && opts.persistAgentMessage) {
    for (const s of partialStreams) {
      if (s.partial_text) {
        try {
          opts.persistAgentMessage(s.partial_text, s.message_id);
        } catch (err) {
          console.warn(`[recover] persistAgentMessage failed for ${s.message_id}: ${err}`);
        }
      }
    }
  }

  if (!decision.continue) {
    // Reset count — the turn is being abandoned, next user.message starts fresh
    await agent.storage.delete(recoveryKey);
  }

  return decision;
}

/**
 * Helper: clear the recovery counter for a turn that just completed
 * successfully via runAgentTurn. Call from the success path so a
 * subsequent eviction on the next turn doesn't inherit stale count.
 */
export async function clearTurnRecoveryCount(
  agent: TurnRuntimeAgent,
  turnName: string,
): Promise<void> {
  await agent.storage.delete(`turn_recovery:${turnName}`);
}
