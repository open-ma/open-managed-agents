import type {
  AcpRuntime,
  SessionOptions,
} from "@open-managed-agents/acp-runtime";
import type {
  SessionCommand,
  SessionStartCommand,
  SessionHostEvent,
} from "@openma/common/session-kernel";

export interface ManagedAgentsSessionSteerCommand {
  type: "session.steer";
  sessionId: string;
  eventId: string;
  text: string;
}

export type ManagedAgentsSessionCommand =
  | SessionCommand
  | ManagedAgentsSessionSteerCommand;

import {
  ManagedAgentsSessionHost,
  type ManagedAgentsDrainOptions,
  type ManagedAgentsDrainReport,
  type ManagedAgentsRuntimeScheduler,
} from "./session-host.js";
import type { ManagedAgentsSessionCheckpointStore } from "./checkpoint.js";

export interface ManagedAgentsSessionPreparationPort {
  prepare(command: SessionStartCommand): Promise<SessionOptions>;
}

export interface ManagedAgentsRuntimeEventSink {
  publish(event: SessionHostEvent): void;
}

export interface ManagedAgentsRuntimeDependencies {
  acpRuntime: AcpRuntime;
  sessionPreparation: ManagedAgentsSessionPreparationPort;
  scheduler?: ManagedAgentsRuntimeScheduler;
  cancelGraceMs?: number;
  checkpointStore?: ManagedAgentsSessionCheckpointStore;
  hostInstanceId?: string;
}

export interface ManagedAgentsRuntime {
  attach(sink: ManagedAgentsRuntimeEventSink): void;
  dispatch(command: ManagedAgentsSessionCommand): Promise<void>;
  drain(options: ManagedAgentsDrainOptions): Promise<ManagedAgentsDrainReport>;
  announceAll(): void;
  hasSession(sessionId: string): boolean;
  sessionCount(): number;
  activeTurnCount(): number;
}

class ManagedAgentsRuntimeLoop implements ManagedAgentsRuntime {
  readonly #sessionPreparation: ManagedAgentsSessionPreparationPort;
  readonly #sessionHost: ManagedAgentsSessionHost;
  #sink: ManagedAgentsRuntimeEventSink | undefined;

  constructor(dependencies: ManagedAgentsRuntimeDependencies) {
    this.#sessionPreparation = dependencies.sessionPreparation;
    this.#sessionHost = new ManagedAgentsSessionHost({
      runtime: dependencies.acpRuntime,
      emit: (event) => this.#sink?.publish(event),
      scheduler: dependencies.scheduler,
      cancelGraceMs: dependencies.cancelGraceMs,
      checkpointStore: dependencies.checkpointStore,
      hostInstanceId: dependencies.hostInstanceId,
    });
  }

  attach(sink: ManagedAgentsRuntimeEventSink): void {
    this.#sink = sink;
    this.#sessionHost.announceAll();
  }

  async dispatch(command: ManagedAgentsSessionCommand): Promise<void> {
    switch (command.type) {
      case "session.start": {
        if (this.#sessionHost.announce(command.sessionId)) return;
        let options: SessionOptions;
        try {
          options = await this.#sessionPreparation.prepare(command);
        } catch (error) {
          this.#sink?.publish({
            type: "session.error",
            sessionId: command.sessionId,
            message: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        await this.#sessionHost.start({ sessionId: command.sessionId, options });
        return;
      }
      case "session.prompt":
        await this.#sessionHost.prompt({
          sessionId: command.sessionId,
          turnId: command.turnId,
          text: command.text,
        });
        return;
      case "session.steer":
        await this.#sessionHost.steer({
          sessionId: command.sessionId,
          eventId: command.eventId,
          text: command.text,
        });
        return;
      case "session.cancel":
        await this.#sessionHost.cancel(command.sessionId, command.turnId);
        return;
      case "session.dispose":
        await this.#sessionHost.dispose(command.sessionId);
        return;
    }
  }

  drain(options: ManagedAgentsDrainOptions): Promise<ManagedAgentsDrainReport> {
    return this.#sessionHost.drain(options);
  }

  announceAll(): void {
    this.#sessionHost.announceAll();
  }

  hasSession(sessionId: string): boolean {
    return this.#sessionHost.has(sessionId);
  }

  sessionCount(): number {
    return this.#sessionHost.sessionCount();
  }

  activeTurnCount(): number {
    return this.#sessionHost.activeTurnCount();
  }
}

export function createManagedAgentsRuntime(
  dependencies: ManagedAgentsRuntimeDependencies,
): ManagedAgentsRuntime {
  return new ManagedAgentsRuntimeLoop(dependencies);
}
