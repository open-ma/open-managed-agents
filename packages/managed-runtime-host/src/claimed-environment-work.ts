export interface ClaimedEnvironmentWorkHeartbeat {
  last_heartbeat: string;
  lease_extended: boolean;
  state: string;
  ttl_seconds: number;
}

export interface ClaimedEnvironmentWorkLifecycleClient {
  ack(
    workId: string,
    params: { environment_id: string },
    options?: { signal?: AbortSignal },
  ): PromiseLike<unknown>;
  heartbeat(
    workId: string,
    params: {
      environment_id: string;
      desired_ttl_seconds?: number;
      expected_last_heartbeat?: string;
    },
    options?: { signal?: AbortSignal },
  ): PromiseLike<ClaimedEnvironmentWorkHeartbeat>;
  stop(
    workId: string,
    params: { environment_id: string; force?: boolean },
    options?: { signal?: AbortSignal },
  ): PromiseLike<unknown>;
}

export interface ClaimedEnvironmentWorkScheduler {
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export interface ClaimedEnvironmentWorkRunnerOptions {
  client: ClaimedEnvironmentWorkLifecycleClient;
  heartbeatIntervalMs?: number;
  heartbeatTtlSeconds?: number;
  scheduler?: ClaimedEnvironmentWorkScheduler;
  now?: () => number;
  onError?(error: unknown): void | Promise<void>;
}

export interface ClaimedEnvironmentWorkRunInput<T> {
  environmentId: string;
  sessionId: string;
  workId: string;
  signal?: AbortSignal;
  execute(signal: AbortSignal): Promise<T>;
}

export interface ClaimedEnvironmentWorkRunner {
  run<T>(input: ClaimedEnvironmentWorkRunInput<T>): Promise<T>;
}

export class ClaimedEnvironmentWorkLeaseLostError extends Error {
  readonly name = "ClaimedEnvironmentWorkLeaseLostError";
}

const defaultScheduler: ClaimedEnvironmentWorkScheduler = {
  sleep(milliseconds, signal) {
    signal.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);
      const onAbort = () => {
        clearTimeout(timeout);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  },
};

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function nonEmpty(value: string, name: string): string {
  if (value.trim() === "") throw new TypeError(`${name} must not be empty`);
  return value;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof DOMException && error.name === "AbortError");
}

/**
 * Own one already-reserved Managed Agents Work item from inside its sandbox.
 *
 * The dispatcher deliberately leaves the item unacknowledged. This runner is
 * therefore the single owner of ACK, the optimistic-concurrency heartbeat,
 * execution cancellation, and terminal stop. A 412 fences the local process
 * immediately and suppresses stop because the Work may already belong to a
 * replacement.
 */
export function createClaimedEnvironmentWorkRunner(
  options: ClaimedEnvironmentWorkRunnerOptions,
): ClaimedEnvironmentWorkRunner {
  if (typeof options?.client?.ack !== "function"
    || typeof options.client.heartbeat !== "function"
    || typeof options.client.stop !== "function") {
    throw new TypeError("Claimed Work runner requires a lifecycle client");
  }
  const heartbeatIntervalMs = positiveInteger(
    options.heartbeatIntervalMs ?? 30_000,
    "heartbeatIntervalMs",
  );
  const heartbeatTtlSeconds = positiveInteger(
    options.heartbeatTtlSeconds ?? 90,
    "heartbeatTtlSeconds",
  );
  const scheduler = options.scheduler ?? defaultScheduler;
  const now = options.now ?? Date.now;

  return {
    async run<T>(input: ClaimedEnvironmentWorkRunInput<T>): Promise<T> {
      const environmentId = nonEmpty(input.environmentId, "environmentId");
      nonEmpty(input.sessionId, "sessionId");
      const workId = nonEmpty(input.workId, "workId");
      input.signal?.throwIfAborted();

      const execution = new AbortController();
      const heartbeat = new AbortController();
      const onExternalAbort = () => {
        execution.abort(input.signal?.reason);
        heartbeat.abort(input.signal?.reason);
      };
      input.signal?.addEventListener("abort", onExternalAbort, { once: true });

      let ownership: "unacknowledged" | "held" | "lost" = "unacknowledged";
      let lastHeartbeat = "NO_HEARTBEAT";
      let lastSuccessAt = now();
      let ttlMs = heartbeatTtlSeconds * 1_000;
      let leaseFailure: ClaimedEnvironmentWorkLeaseLostError | null = null;

      const loseLease = (message: string, cause?: unknown) => {
        if (ownership === "lost") return;
        ownership = "lost";
        leaseFailure = new ClaimedEnvironmentWorkLeaseLostError(message, { cause });
        execution.abort(leaseFailure);
        heartbeat.abort(leaseFailure);
      };

      const beat = async (initial: boolean): Promise<void> => {
        try {
          const response = await options.client.heartbeat(
            workId,
            {
              environment_id: environmentId,
              desired_ttl_seconds: heartbeatTtlSeconds,
              expected_last_heartbeat: lastHeartbeat,
            },
            { signal: heartbeat.signal },
          );
          if (!Number.isFinite(response.ttl_seconds) || response.ttl_seconds <= 0) {
            loseLease("Managed Environment Work heartbeat returned an invalid lease TTL");
            return;
          }
          lastHeartbeat = response.last_heartbeat;
          lastSuccessAt = now();
          ttlMs = response.ttl_seconds * 1_000;
          ownership = "held";
          if (
            !response.lease_extended
            || response.state === "stopping"
            || response.state === "stopped"
          ) {
            execution.abort(new Error(`Managed Environment Work entered ${response.state}`));
            heartbeat.abort(execution.signal.reason);
          }
        } catch (error) {
          if (statusOf(error) === 412) {
            loseLease("Managed Environment Work lease was lost", error);
            return;
          }
          if (isAbort(error, heartbeat.signal)) return;
          if (initial || now() - lastSuccessAt >= ttlMs) {
            loseLease("Managed Environment Work lease could not be established or renewed", error);
            return;
          }
          await options.onError?.(error);
        }
      };

      let monitor: Promise<void> | null = null;
      try {
        await options.client.ack(
          workId,
          { environment_id: environmentId },
          { signal: execution.signal },
        );
        await beat(true);
        if (leaseFailure !== null) throw leaseFailure;
        execution.signal.throwIfAborted();

        monitor = (async () => {
          while (!heartbeat.signal.aborted) {
            try {
              await scheduler.sleep(heartbeatIntervalMs, heartbeat.signal);
            } catch (error) {
              if (heartbeat.signal.aborted) return;
              throw error;
            }
            if (heartbeat.signal.aborted) return;
            await beat(false);
          }
        })();
        void monitor.catch((error: unknown) => {
          loseLease("Managed Environment Work heartbeat loop failed", error);
        });

        let result: T;
        try {
          result = await input.execute(execution.signal);
        } catch (error) {
          if (leaseFailure !== null) throw leaseFailure;
          throw error;
        }
        if (leaseFailure !== null) throw leaseFailure;
        execution.signal.throwIfAborted();
        return result;
      } finally {
        heartbeat.abort(new Error("Managed Environment Work execution finished"));
        await monitor?.catch(() => undefined);
        input.signal?.removeEventListener("abort", onExternalAbort);
        if ((ownership as "unacknowledged" | "held" | "lost") === "held") {
          await Promise.resolve(options.client.stop(
            workId,
            { environment_id: environmentId, force: true },
            { signal: new AbortController().signal },
          )).catch(options.onError);
        }
      }
    },
  };
}
