import type { RuntimeCheckpointKind } from "./capabilities";
import type { RuntimeResourceFence } from "./fence";
import type { ManagedSandboxLease } from "./sandbox";
import type { RuntimeResourceScope } from "./scope";

export interface RuntimeCheckpointRef {
  provider: string;
  checkpointId: string;
  kind: RuntimeCheckpointKind;
  sourceRuntimeId: string;
  sessionId: string;
  workGeneration: number;
  workspaceRevision: number;
  harnessVersion: string;
  runtimeIdentity: string;
}

/** Optional warm-start optimization; never the canonical recovery store. */
export interface RuntimeCheckpointPort {
  create(input: {
    scope: RuntimeResourceScope;
    fence: RuntimeResourceFence;
    sandbox: ManagedSandboxLease;
    kind: RuntimeCheckpointKind;
    workspaceRevision: number;
    harnessVersion: string;
    runtimeIdentity: string;
  }): Promise<RuntimeCheckpointRef>;
  restore(input: {
    scope: RuntimeResourceScope;
    fence: RuntimeResourceFence;
    checkpoint: RuntimeCheckpointRef;
  }): Promise<ManagedSandboxLease>;
}
