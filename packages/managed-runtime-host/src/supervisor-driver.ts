import type {
  HarnessSupervisorChannel,
  HarnessSupervisorEvent,
  HarnessSupervisorTransportPort,
  SandboxHarnessDriverPort,
} from "@open-managed-agents/runtime-resource-contract";

export interface SupervisedSandboxHarnessDriverOptions {
  transport: HarnessSupervisorTransportPort;
}

class SupervisorProtocolError extends Error {
  readonly name = "SupervisorProtocolError";
}

export class SupervisedSandboxHarnessDriver
  implements SandboxHarnessDriverPort
{
  readonly #transport: HarnessSupervisorTransportPort;

  constructor(options: SupervisedSandboxHarnessDriverOptions) {
    this.#transport = options.transport;
  }

  async driverCapabilities() {
    return { drivers: ["openma_supervised"] as const };
  }

  async run(input: Parameters<SandboxHarnessDriverPort["run"]>[0]) {
    const driver = input.driver;
    if (driver.type !== "openma_supervised") {
      throw new SupervisorProtocolError(
        `Supervised driver cannot run ${driver.type}`,
      );
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort(input.signal.reason);
    if (input.signal.aborted) onAbort();
    else input.signal.addEventListener("abort", onAbort, { once: true });
    let channel: HarnessSupervisorChannel | null = null;

    const sendStop = async (reason: "aborted" | "failed") => {
      if (channel === null) return;
      await channel.send({ type: "stop", reason }).catch(() => {});
    };

    try {
      controller.signal.throwIfAborted();
      channel = await this.#transport.open({
        scope: input.scope,
        sandbox: input.sandbox,
        process: driver.supervisor,
        signal: controller.signal,
      });
      const events = channel.events(controller.signal)[Symbol.asyncIterator]();
      await channel.send({
        type: "start",
        scope: input.scope,
        harness: driver.harness,
        workspacePath: input.workspacePath,
        outputPath: input.outputPath,
      });

      await this.#waitFor(
        events,
        driver.readyTimeoutMs,
        controller.signal,
        (event) => {
          if (event.type === "ready") {
            if (event.protocol !== driver.protocol) {
              throw new SupervisorProtocolError(
                `Supervisor protocol mismatch: ${event.protocol}`,
              );
            }
            return true;
          }
          return false;
        },
        "ready",
      );

      let completed = false;
      while (!completed) {
        const event = await nextWithDeadline(
          events,
          driver.heartbeatTimeoutMs,
          controller.signal,
          "harness heartbeat",
        );
        if (event.type === "heartbeat") continue;
        if (event.type === "checkpoint") {
          if (
            event.checkpointId.length === 0
            || event.sessionId !== input.scope.sessionId
            || input.checkpoint === undefined
          ) {
            throw new SupervisorProtocolError("Supervisor checkpoint request is invalid");
          }
          try {
            await input.checkpoint({
              checkpointId: event.checkpointId,
              sessionId: event.sessionId,
              ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
            });
            await channel.send({
              type: "checkpoint.commit",
              checkpointId: event.checkpointId,
            });
          } catch (error) {
            await channel.send({
              type: "checkpoint.reject",
              checkpointId: event.checkpointId,
              message: error instanceof Error ? error.message : String(error),
            }).catch(() => {});
            throw error;
          }
          continue;
        }
        if (event.type === "error") throw new SupervisorProtocolError(event.message);
        if (event.type === "completed") {
          if (event.exitCode !== 0) {
            throw new SupervisorProtocolError(
              `Harness exited with code ${event.exitCode}`,
            );
          }
          completed = true;
          continue;
        }
        throw new SupervisorProtocolError(
          `Unexpected supervisor event before completion: ${event.type}`,
        );
      }

      await channel.send({ type: "drain" });
      await this.#waitFor(
        events,
        driver.drainTimeoutMs,
        controller.signal,
        (event) => {
          if (event.type === "error") throw new SupervisorProtocolError(event.message);
          return event.type === "drained";
        },
        "drain",
      );
      return { type: "completed" } as const;
    } catch (error) {
      if (controller.signal.aborted) {
        await sendStop("aborted");
        return { type: "aborted" } as const;
      }
      await sendStop("failed");
      throw error;
    } finally {
      controller.abort(new Error("Supervisor driver closed"));
      input.signal.removeEventListener("abort", onAbort);
      await channel?.close().catch(() => {});
    }
  }

  async #waitFor(
    events: AsyncIterator<HarnessSupervisorEvent>,
    timeoutMs: number,
    signal: AbortSignal,
    accept: (event: HarnessSupervisorEvent) => boolean,
    phase: string,
  ): Promise<void> {
    while (true) {
      const event = await nextWithDeadline(events, timeoutMs, signal, phase);
      if (accept(event)) return;
    }
  }
}

async function nextWithDeadline(
  events: AsyncIterator<HarnessSupervisorEvent>,
  timeoutMs: number,
  signal: AbortSignal,
  phase: string,
): Promise<HarnessSupervisorEvent> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new SupervisorProtocolError(`${phase} timeout must be a positive integer`);
  }
  signal.throwIfAborted();
  return new Promise<HarnessSupervisorEvent>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new SupervisorProtocolError(`${phase} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void events.next().then(
      (result) => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        if (result.done) {
          reject(new SupervisorProtocolError(`Supervisor closed before ${phase}`));
        } else {
          resolve(result.value);
        }
      },
      (error) => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
