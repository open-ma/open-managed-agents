import type {
  ClaimSessionExecutionResult,
  SessionExecution,
  SessionExecutionFence,
  SessionExecutionStorePort,
  SettleSessionExecutionResult,
} from "@open-managed-agents/session-runtime-contract/coordination";

export interface SessionExecutionHostTimers {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

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

const defaultTimers: SessionExecutionHostTimers = {
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

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
  readonly #timers: SessionExecutionHostTimers;

  constructor(private readonly dependencies: SessionExecutionHostDependencies) {
    this.#leaseTtlMs = dependencies.leaseTtlMs ?? 30_000;
    this.#heartbeatIntervalMs = dependencies.heartbeatIntervalMs ?? 10_000;
    this.#timers = dependencies.timers ?? defaultTimers;
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
    const controller = new AbortController();
    let lost = false;
    let interrupted = claimed.execution.interruptRequestedAt !== null;
    let heartbeat: Promise<void> = Promise.resolve();
    const tick = () => {
      heartbeat = heartbeat.then(async () => {
        if (lost) return;
        const renewed = await this.dependencies.store.renew({
          fence: claimed.fence,
          renewedAt: this.dependencies.clock.now().toISOString(),
          leaseTtlMs: this.#leaseTtlMs,
        });
        if (renewed.type === "lost") {
          lost = true;
          controller.abort(new Error("session execution lease lost"));
          return;
        }
        // Keep the fence object identity stable for the running callback.
        // Harnesses and output adapters receive the object once at run start;
        // mutating it in place lets those long-lived references use the
        // renewed expiry proof instead of attempting a commit with the
        // pre-heartbeat (already expired) object.
        Object.assign(claimed.fence, renewed.fence);
        this.dependencies.onFenceChanged?.(claimed.fence);
        if (renewed.interruptRequestedAt !== null) {
          interrupted = true;
          controller.abort(new Error("session execution interrupted"));
        }
      }).catch((error) => {
        lost = true;
        controller.abort(asError(error));
      });
    };
    const timer = this.#timers.setInterval(tick, this.#heartbeatIntervalMs);
    try {
      if (interrupted) controller.abort(new Error("session execution interrupted"));
      let error: Error | null = null;
      try {
        await run(claimed.execution, claimed.fence, controller.signal);
      } catch (caught) {
        error = asError(caught);
      }
      await heartbeat;
      if (!lost) {
        // A final renewal closes the interval→settle race. A run that ends
        // exactly as its lease expires must not write under a stale fence.
        const renewed = await this.dependencies.store.renew({
          fence: claimed.fence,
          renewedAt: this.dependencies.clock.now().toISOString(),
          leaseTtlMs: this.#leaseTtlMs,
        });
        if (renewed.type === "lost") {
          lost = true;
        } else {
          Object.assign(claimed.fence, renewed.fence);
          this.dependencies.onFenceChanged?.(claimed.fence);
          interrupted ||= renewed.interruptRequestedAt !== null;
        }
      }
      if (lost) {
        return { type: "lost", execution: claimed.execution, fence: claimed.fence };
      }
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
      this.#timers.clearInterval(timer);
    }
  }
}
