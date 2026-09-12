export type WorkspaceStrategy =
  | "durable_mount"
  | "retained_runtime"
  | "checkpoint_restore"
  | "ephemeral";

export type OutputStrategy =
  | "durable_mount"
  | "watch_and_upload"
  | "final_collect";

export type RuntimeCheckpointKind = "filesystem" | "process";
export type HarnessDriverType = "ama_worker" | "openma_supervised";

export interface SandboxResourceCapabilities {
  suspendResume: "supported" | "unsupported";
  hardTerminate: "supported" | "best_effort";
  runtimeCheckpoints: readonly RuntimeCheckpointKind[];
}

export interface WorkspacePersistenceCapabilities {
  strategies: readonly WorkspaceStrategy[];
}

export interface SessionOutputCapability {
  strategy: OutputStrategy;
  durability: "durable" | "best_effort";
}

export interface SessionOutputCapabilities {
  strategies: readonly SessionOutputCapability[];
}

export interface SandboxHarnessDriverCapabilities {
  drivers: readonly HarnessDriverType[];
}

export interface ManagedRuntimeResourceCapabilities {
  sandbox: SandboxResourceCapabilities;
  workspace: WorkspacePersistenceCapabilities;
  outputs: SessionOutputCapabilities;
  harness: SandboxHarnessDriverCapabilities;
}
