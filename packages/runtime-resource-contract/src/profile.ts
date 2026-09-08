import type {
  OutputStrategy,
  RuntimeCheckpointKind,
  WorkspaceStrategy,
} from "./capabilities";

export interface RuntimeProcessDeclaration {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
}

export type HarnessDriverDeclaration =
  | {
      /** Runs an official or community AMA self-host worker unmodified. */
      type: "ama_worker";
      process: RuntimeProcessDeclaration;
    }
  | {
      /** Optional enhanced lifecycle; never required for AMA compatibility. */
      type: "openma_supervised";
      protocol: "openma-harness-supervisor-v1";
      supervisor: RuntimeProcessDeclaration;
      harness: { id: string; version: string };
      readyTimeoutMs: number;
      heartbeatTimeoutMs: number;
      drainTimeoutMs: number;
    };

export interface ManagedRuntimeProfile {
  workspace: {
    requirement: "durable" | "continuable" | "ephemeral";
    preferredStrategies?: readonly WorkspaceStrategy[];
  };
  outputs: {
    requirement: "durable" | "best_effort" | "disabled";
    preferredStrategies?: readonly OutputStrategy[];
  };
  runtimeCheckpoint: "required" | "optional" | "disabled";
  /** OpenMA Runtime Host extension. Omitted means disabled so an unmodified
   * official/community Environment Worker remains protocol-compatible. */
  credentialEgress?: {
    requirement: "required" | "best_effort" | "disabled";
  };
  driver: HarnessDriverDeclaration;
}

export interface ManagedRuntimePlan {
  workspaceStrategy: WorkspaceStrategy;
  outputStrategy: OutputStrategy | null;
  runtimeCheckpoint: RuntimeCheckpointKind | null;
  driver: HarnessDriverDeclaration;
}
