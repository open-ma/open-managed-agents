import type {
  ClaimSessionExecutionResult,
  SessionExecution,
  SessionExecutionFence,
  SessionExecutionStorePort,
  SettleSessionExecutionResult,
} from "@open-managed-agents/session-runtime-contract/coordination";
import {
  ExecutionLeaseController,
  type ExecutionLeaseTimers,
} from "@open-managed-agents/execution-control";

export type SessionExecutionHostTimers = ExecutionLeaseTimers;

export interface SessionExecutionHostDependencies {
  store: SessionExecutionStorePort;
  scope: {
    workspaceId: string;
    sessionId: string;
    laneId?: string;
  };
  ownerId: string;
  clock: { now(): Date };
  ids: { nextAttemptId(): string };
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  timers?: SessionExecutionHostTimers;
  /** Observe the current generation so side-effect adapters can refresh
   * their local guard without owning execution state themselves. */
  onFenceChanged?: (fence: SessionExecutionFence) => void;
}

export type SessionExecutionHostResult =
  | { type: "empty" }
  | { type: "completed"; execution: SessionExecution }
  | { type: "failed"; execution: SessionExecution; error: Error }
  | { type: "cancelled"; execution: SessionExecution }
  | { type: "lost"; execution: SessionExecution; fence: SessionExecutionFence };

export type SessionExecutionRun = (
  execution: SessionExecution,
  fence: SessionExecutionFence,
  signal: AbortSignal,
) => Promise<void>;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Runs exactly one claimed execution generation. The host intentionally owns
 * no queue state: admission/order/recovery stay in SessionExecutionStorePort.
 * A heartbeat can only shorten a run (abort on loss/interrupt), never extend
 * authority after the store rejects the fence.
 */
export class SessionExecutionHost {
  readonly #leaseTtlMs: number;
  readonly #heartbeatIntervalMs: number;

  constructor(private readonly dependencies: SessionExecutionHostDependencies) {
    this.#leaseTtlMs = dependencies.leaseTtlMs ?? 30_000;
    this.#heartbeatIntervalMs = dependencies.heartbeatIntervalMs ?? 10_000;
    if (!Number.isSafeInteger(this.#leaseTtlMs) || this.#leaseTtlMs <= 0) {
      throw new Error("Session Execution leaseTtlMs must be a positive integer");
    }
    if (!Number.isSafeInteger(this.#heartbeatIntervalMs) ||
        this.#heartbeatIntervalMs <= 0 ||
        this.#heartbeatIntervalMs >= this.#leaseTtlMs) {
      throw new Error("Session Execution heartbeat must be positive and shorter than its lease");
    }
  }

  async runOne(run: SessionExecutionRun): Promise<SessionExecutionHostResult> {
    const claimed = await this.dependencies.store.claim({
      ...this.dependencies.scope,
      ownerId: this.dependencies.ownerId,
      attemptId: this.dependencies.ids.nextAttemptId(),
      claimedAt: this.dependencies.clock.now().toISOString(),
      leaseTtlMs: this.#leaseTtlMs,
    });
    if (claimed.type === "empty") return { type: "empty" };
    this.dependencies.onFenceChanged?.(claimed.fence);
    return this.#runClaimed(claimed, run);
  }

  async #runClaimed(
    claimed: Extract<ClaimSessionExecutionResult, { type: "claimed" }>,
    run: SessionExecutionRun,
  ): Promise<SessionExecutionHostResult> {
    const lease = new ExecutionLeaseController({
      fence: claimed.fence,
      heartbeatIntervalMs: this.#heartbeatIntervalMs,
      ...(this.dependencies.timers === undefined
        ? {}
        : { timers: this.dependencies.timers }),
      renew: async (fence) => {
        try {
          const renewed = await this.dependencies.store.renew({
            fence,
            renewedAt: this.dependencies.clock.now().toISOString(),
            leaseTtlMs: this.#leaseTtlMs,
          });
          if (renewed.type === "lost") {
            return {
              type: "lost" as const,
              reason: new Error("session execution lease lost"),
            };
          }
          return {
            type: "renewed" as const,
            fence: renewed.fence,
            stopRequested: renewed.interruptRequestedAt !== null,
            ...(renewed.interruptRequestedAt === null
              ? {}
              : { reason: new Error("session execution interrupted") }),
          };
        } catch (error) {
          return { type: "lost" as const, reason: asError(error) };
        }
      },
      onFenceChanged: this.dependencies.onFenceChanged,
    });
    let interrupted = claimed.execution.interruptRequestedAt !== null;
    if (interrupted) {
      lease.requestStop(new Error("session execution interrupted"));
    }
    const heartbeat = lease.start();
    try {
      let error: Error | null = null;
      try {
        await run(claimed.execution, claimed.fence, lease.signal);
      } catch (caught) {
        error = asError(caught);
      }
      if (!lease.lost) {
        // A final renewal closes the interval→settle race. A run that ends
        // exactly as its lease expires must not write under a stale fence.
        await lease.renewNow({ allowAborted: true });
      }
      if (lease.lost) {
        return { type: "lost", execution: claimed.execution, fence: claimed.fence };
      }
      interrupted ||= lease.stopRequested;
      const outcome = interrupted ? "cancelled" : error === null ? "completed" : "failed";
      const settled: SettleSessionExecutionResult = await this.dependencies.store.settle({
        fence: claimed.fence,
        settledAt: this.dependencies.clock.now().toISOString(),
        outcome,
        ...(error !== null && { failure: error.message }),
      });
      if (settled.type === "lost") {
        return { type: "lost", execution: claimed.execution, fence: claimed.fence };
      }
      // The store is the final arbiter for an interrupt that races the
      // final renewal. A request may set interrupt_requested_at_ms after the
      // heartbeat observed the row but before settle(); the SQL adapter then
      // atomically records `cancelled`. Return the committed state, not the
      // pre-settlement local intent.
      if (settled.execution.state === "cancelled") {
        return { type: "cancelled", execution: settled.execution };
      }
      if (error !== null) return { type: "failed", execution: settled.execution, error };
      return { type: "completed", execution: settled.execution };
    } finally {
      await lease.close();
      await heartbeat;
    }
  }
}
