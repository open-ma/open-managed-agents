export type ExecutionLeaseRenewal<Fence extends object> =
  | {
      type: "renewed";
      fence: Fence;
      stopRequested?: boolean;
      reason?: unknown;
    }
  | { type: "retry"; error: unknown }
  | { type: "lost"; reason?: unknown };

export interface ExecutionLeaseScheduler {
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export interface ExecutionLeaseTimers {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface ExecutionLeaseControllerOptions<Fence extends object> {
  /** Kept by identity and refreshed in place after every accepted renewal. */
  fence: Fence;
  heartbeatIntervalMs: number;
  renew(
    fence: Fence,
    signal: AbortSignal,
  ): Promise<ExecutionLeaseRenewal<Fence>>;
  signal?: AbortSignal;
  scheduler?: ExecutionLeaseScheduler;
  timers?: ExecutionLeaseTimers;
  now?: () => number;
  /** Required when transient renewal failures may be retried. */
  leaseExpiresAt?: (fence: Fence) => number;
  onFenceChanged?: (fence: Fence) => void;
  onRetry?: (error: unknown) => void | Promise<void>;
}

const scheduler: ExecutionLeaseScheduler = {
  sleep(milliseconds, signal) {
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(finish, milliseconds);
      signal.addEventListener("abort", finish, { once: true });
      function finish() {
        clearTimeout(timeout);
        signal.removeEventListener("abort", finish);
        resolve();
      }
    });
  },
};

/**
 * Protocol-neutral lease/heartbeat controller shared by Session executors and
 * Environment executors. Stores and wire protocols remain separate adapters;
 * this class owns only the common liveness rule: a rejected/expired lease
 * aborts the one executor currently carrying the fence.
 */
export class ExecutionLeaseController<Fence extends object> {
  readonly #controller = new AbortController();
  readonly #now: () => number;
  readonly #detachExternal: () => void;
  #renewal: Promise<void> = Promise.resolve();
  #monitor: Promise<void> | null = null;
  #lost = false;
  #stopRequested = false;

  constructor(
    private readonly options: ExecutionLeaseControllerOptions<Fence>,
  ) {
    if (
      !Number.isFinite(options.heartbeatIntervalMs)
      || options.heartbeatIntervalMs <= 0
    ) {
      throw new TypeError("execution lease heartbeatIntervalMs must be positive");
    }
    if (options.scheduler !== undefined && options.timers !== undefined) {
      throw new TypeError("execution lease accepts either scheduler or timers, not both");
    }
    this.#now = options.now ?? Date.now;
    const abortFromExternal = () => this.#controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abortFromExternal();
    else options.signal?.addEventListener("abort", abortFromExternal, { once: true });
    this.#detachExternal = () =>
      options.signal?.removeEventListener("abort", abortFromExternal);
  }

  get fence(): Fence {
    return this.options.fence;
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get lost(): boolean {
    return this.#lost;
  }

  get stopRequested(): boolean {
    return this.#stopRequested;
  }

  start(input: { immediate?: boolean } = {}): Promise<void> {
    if (this.#monitor !== null) return this.#monitor;
    if (this.options.timers !== undefined) {
      const renew = () => {
        void this.#renewOrLose();
      };
      if (input.immediate === true) renew();
      const handle = this.options.timers.setInterval(
        renew,
        this.options.heartbeatIntervalMs,
      );
      this.#monitor = new Promise<void>((resolve) => {
        if (this.signal.aborted) resolve();
        else this.signal.addEventListener("abort", () => resolve(), { once: true });
      }).finally(() => this.options.timers!.clearInterval(handle));
      return this.#monitor;
    }

    const selectedScheduler = this.options.scheduler ?? scheduler;
    this.#monitor = (async () => {
      if (input.immediate === true) await this.#renewOrLose();
      while (!this.signal.aborted) {
        try {
          await selectedScheduler.sleep(
            this.options.heartbeatIntervalMs,
            this.signal,
          );
        } catch (error) {
          if (this.signal.aborted) return;
          this.#lose(error);
          return;
        }
        if (this.signal.aborted) return;
        await this.#renewOrLose();
      }
    })();
    return this.#monitor;
  }

  renewNow(input: { allowAborted?: boolean } = {}): Promise<void> {
    const next = this.#renewal.then(async () => {
      if (this.signal.aborted && input.allowAborted !== true) return;
      let renewal: ExecutionLeaseRenewal<Fence>;
      try {
        renewal = await this.options.renew(this.fence, this.signal);
      } catch (error) {
        renewal = { type: "lost", reason: error };
      }
      if (renewal.type === "lost") {
        this.#lose(renewal.reason);
        return;
      }
      if (renewal.type === "retry") {
        await this.options.onRetry?.(renewal.error);
        const expiry = this.options.leaseExpiresAt?.(this.fence);
        if (expiry !== undefined && this.#now() >= expiry) {
          this.#lose(renewal.error);
        }
        return;
      }
      Object.assign(this.fence, renewal.fence);
      this.options.onFenceChanged?.(this.fence);
      if (renewal.stopRequested === true) {
        this.requestStop(renewal.reason);
      }
    });
    this.#renewal = next.catch(() => undefined);
    return next;
  }

  requestStop(reason: unknown = new Error("execution stop requested")): void {
    this.#stopRequested = true;
    this.#controller.abort(reason);
  }

  async close(reason: unknown = new Error("execution lease monitor closed")): Promise<void> {
    this.#controller.abort(reason);
    await this.#renewal;
    await this.#monitor;
    this.#detachExternal();
  }

  async #renewOrLose(): Promise<void> {
    try {
      await this.renewNow();
    } catch (error) {
      this.#lose(error);
    }
  }

  #lose(reason: unknown): void {
    this.#lost = true;
    this.#controller.abort(reason ?? new Error("execution lease lost"));
  }
}
