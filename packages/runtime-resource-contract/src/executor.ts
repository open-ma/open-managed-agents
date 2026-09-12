import type { RuntimeResourceFence } from "./fence";
import type { ManagedSandboxLease } from "./sandbox";
import type { RuntimeResourceScope } from "./scope";
import type {
  HarnessDriverDeclaration,
  RuntimeProcessDeclaration,
} from "./profile";
import type { SandboxHarnessDriverCapabilities } from "./capabilities";

export type ManagedWorkExecutionResult =
  | { type: "completed" }
  | { type: "aborted" };

export type HarnessSupervisorCommand =
  | {
      type: "start";
      scope: RuntimeResourceScope;
      harness: { id: string; version: string };
      workspacePath: "/workspace";
      outputPath: "/mnt/session/outputs" | null;
    }
  | { type: "drain" }
  | { type: "checkpoint.commit"; checkpointId: string }
  | { type: "checkpoint.reject"; checkpointId: string; message: string }
  | { type: "stop"; reason: "aborted" | "failed" };

export type HarnessSupervisorEvent =
  | { type: "ready"; protocol: "openma-harness-supervisor-v1" }
  | { type: "heartbeat"; sequence: number }
  | {
      type: "checkpoint";
      checkpointId: string;
      sessionId: string;
      turnId?: string;
    }
  | { type: "completed"; exitCode: number }
  | { type: "drained" }
  | { type: "error"; message: string };

export interface HarnessSupervisorChannel {
  send(command: HarnessSupervisorCommand): Promise<void>;
  events(signal: AbortSignal): AsyncIterable<HarnessSupervisorEvent>;
  close(): Promise<void>;
}

/** Provider transport for the same supervisor protocol (stdio, RPC, etc.). */
export interface HarnessSupervisorTransportPort {
  open(input: {
    scope: RuntimeResourceScope;
    sandbox: ManagedSandboxLease;
    process: RuntimeProcessDeclaration;
    signal: AbortSignal;
  }): Promise<HarnessSupervisorChannel>;
}

/** Runs the hand/harness in already-prepared compute. */
export interface SandboxHarnessDriverPort {
  driverCapabilities(
    scope: RuntimeResourceScope,
  ): Promise<SandboxHarnessDriverCapabilities>;
  run(input: {
    scope: RuntimeResourceScope;
    fence: RuntimeResourceFence;
    sandbox: ManagedSandboxLease;
    workspacePath: "/workspace";
    outputPath: "/mnt/session/outputs" | null;
    driver: HarnessDriverDeclaration;
    /** Commit a live turn boundary under the current resource fence. */
    checkpoint?(input: {
      checkpointId: string;
      sessionId: string;
      turnId?: string;
    }): Promise<void>;
    signal: AbortSignal;
  }): Promise<ManagedWorkExecutionResult>;
}

/** @deprecated Use SandboxHarnessDriverPort. */
export type ManagedWorkExecutorPort = SandboxHarnessDriverPort;
