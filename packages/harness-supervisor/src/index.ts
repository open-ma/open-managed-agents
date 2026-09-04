import type {
  HarnessSupervisorCommand,
  HarnessSupervisorEvent,
  RuntimeResourceScope,
} from "@open-managed-agents/runtime-resource-contract";

export interface HarnessSupervisorRun {
  completed: Promise<{ exitCode: number }>;
  drain(): Promise<void>;
  stop(reason: "aborted" | "failed"): Promise<void>;
}

export interface HarnessSupervisorHarness {
  start(input: {
    scope: RuntimeResourceScope;
    harness: { id: string; version: string };
    workspacePath: "/workspace";
    outputPath: "/mnt/session/outputs" | null;
    signal: AbortSignal;
  }): Promise<HarnessSupervisorRun>;
}

export interface HarnessSupervisorScheduler {
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export interface HarnessSupervisorOptions {
  heartbeatIntervalMs: number;
  resolveHarness(
    harness: { id: string; version: string },
  ): Promise<HarnessSupervisorHarness | null>;
  emit(event: HarnessSupervisorEvent): Promise<unknown>;
  scheduler?: HarnessSupervisorScheduler;
}

export interface HarnessSupervisor {
  dispatch(command: HarnessSupervisorCommand): Promise<void>;
  waitForCompletion(): Promise<void>;
  close(): Promise<void>;
}

type SupervisorState =
  | "idle"
  | "running"
  | "completed"
  | "drained"
  | "stopped"
  | "failed";

const defaultScheduler: HarnessSupervisorScheduler = {
  sleep(milliseconds, signal) {
    signal.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout>;
      const onAbort = () => {
        clearTimeout(timeout);
        reject(signal.reason);
      };
      timeout = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  },
};

export function createHarnessSupervisor(
  options: HarnessSupervisorOptions,
): HarnessSupervisor {
  if (
    !Number.isSafeInteger(options.heartbeatIntervalMs) ||
    options.heartbeatIntervalMs <= 0
  ) {
    throw new Error("heartbeatIntervalMs must be a positive integer");
  }

  const scheduler = options.scheduler ?? defaultScheduler;
  const controller = new AbortController();
  let state: SupervisorState = "idle";
  let run: HarnessSupervisorRun | null = null;
  let completion: Promise<void> | null = null;
  let heartbeat: Promise<void> | null = null;
  let eventQueue = Promise.resolve();
  let stopped = false;

  const emit = (event: HarnessSupervisorEvent): Promise<void> => {
    const queued = eventQueue.then(async () => {
      await options.emit(event);
    });
    eventQueue = queued.catch(() => {});
    return queued;
  };

  const fail = async (error: unknown): Promise<never> => {
    const normalized = normalizeError(error);
    state = "failed";
    controller.abort(normalized);
    await emit({ type: "error", message: normalized.message });
    throw normalized;
  };

  const startHeartbeat = (): Promise<void> => {
    let sequence = 0;
    return (async () => {
      while (!controller.signal.aborted) {
        try {
          await scheduler.sleep(options.heartbeatIntervalMs, controller.signal);
        } catch (error) {
          if (controller.signal.aborted) return;
          throw error;
        }
        if (controller.signal.aborted) return;
        sequence += 1;
        await emit({ type: "heartbeat", sequence });
      }
    })();
  };

  const start = async (
    command: Extract<HarnessSupervisorCommand, { type: "start" }>,
  ): Promise<void> => {
    if (state !== "idle") {
      throw new Error("Harness supervisor has already started");
    }

    const harness = await options.resolveHarness(command.harness).catch(fail);
    if (harness === null) {
      return fail(
        new Error(
          `Harness ${command.harness.id}@${command.harness.version} is not registered`,
        ),
      );
    }

    try {
      run = await harness.start({
        scope: command.scope,
        harness: command.harness,
        workspacePath: command.workspacePath,
        outputPath: command.outputPath,
        signal: controller.signal,
      });
      state = "running";
      await emit({ type: "ready", protocol: "openma-harness-supervisor-v1" });
      heartbeat = startHeartbeat();
      void heartbeat.catch(() => {});

      completion = (async () => {
        try {
          const result = await run!.completed;
          if (stopped) return;
          if (!Number.isSafeInteger(result.exitCode)) {
            throw new Error("Harness returned an invalid exit code");
          }
          controller.abort(new Error("Harness completed"));
          state = "completed";
          await emit({ type: "completed", exitCode: result.exitCode });
        } catch (error) {
          if (stopped) return;
          await fail(error);
        }
      })();
      void completion.catch(() => {});
    } catch (error) {
      await fail(error);
    }
  };

  const drain = async (): Promise<void> => {
    if (state === "idle") {
      throw new Error("Cannot drain harness before start");
    }
    if (state === "stopped") {
      throw new Error("Cannot drain a stopped harness");
    }
    if (state === "failed") {
      throw new Error("Cannot drain a failed harness");
    }
    if (state === "drained") return;
    await completion;
    await run!.drain().catch(fail);
    await emit({ type: "drained" });
    state = "drained";
  };

  const stop = async (reason: "aborted" | "failed"): Promise<void> => {
    if (state === "idle") {
      throw new Error("Cannot stop harness before start");
    }
    if (state === "stopped") return;
    controller.abort(new Error(`Harness stopped: ${reason}`));
    stopped = true;
    await run?.stop(reason);
    state = "stopped";
    await heartbeat?.catch(() => {});
    await eventQueue;
  };

  return {
    async dispatch(command) {
      switch (command.type) {
        case "start":
          await start(command);
          return;
        case "drain":
          await drain();
          return;
        case "stop":
          await stop(command.reason);
          return;
      }
    },
    async waitForCompletion() {
      if (completion === null) {
        throw new Error("Cannot wait for completion before start");
      }
      await completion;
      await eventQueue;
    },
    async close() {
      if (state === "running") {
        await stop("aborted");
        return;
      }
      controller.abort(new Error("Harness supervisor closed"));
      await heartbeat?.catch(() => {});
      await eventQueue;
    },
  };
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export * from "./jsonl";
