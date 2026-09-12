import type {
  WorkspacePersistenceCapabilities,
  WorkspaceStrategy,
} from "./capabilities";
import type {
  RuntimePublicationCandidate,
  RuntimeResourceFence,
} from "./fence";
import type { RuntimeResourceScope } from "./scope";
import type { ManagedSandboxLease } from "./sandbox";

export interface WorkspaceBinding {
  bindingId: string;
  mountPath: "/workspace";
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

/** Immutable candidate. It is not active until FencePort.publish succeeds. */
export interface WorkspaceCheckpointCandidate {
  id: string;
  contentHash: string;
  revision: number;
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface WorkspacePersistencePort {
  capabilities(
    scope: RuntimeResourceScope,
  ): Promise<WorkspacePersistenceCapabilities>;
  materialize(input: {
    scope: RuntimeResourceScope;
    fence: RuntimeResourceFence;
    strategy: WorkspaceStrategy;
    activeCheckpoint: RuntimePublicationCandidate | null;
    idempotencyKey: string;
    signal: AbortSignal;
  }): Promise<WorkspaceBinding>;
  attach(input: {
    scope: RuntimeResourceScope;
    fence: RuntimeResourceFence;
    strategy: WorkspaceStrategy;
    binding: WorkspaceBinding;
    sandbox: ManagedSandboxLease;
    signal: AbortSignal;
  }): Promise<void>;
  checkpoint(input: {
    scope: RuntimeResourceScope;
    fence: RuntimeResourceFence;
    strategy: WorkspaceStrategy;
    binding: WorkspaceBinding;
    sandbox: ManagedSandboxLease;
    idempotencyKey: string;
    signal: AbortSignal;
  }): Promise<WorkspaceCheckpointCandidate>;
  release(input: {
    scope: RuntimeResourceScope;
    fence: RuntimeResourceFence;
    binding: WorkspaceBinding;
  }): Promise<void>;
}
