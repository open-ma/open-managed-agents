import type { RuntimeResourceScope } from "./scope";
import type { RuntimeCheckpointRef } from "./checkpoint";

export interface RuntimeResourceFence extends RuntimeResourceScope {
  ownerId: string;
  /** Monotonically increasing ownership generation for this work item. */
  generation: number;
  /** Opaque proof of ownership. Must never be logged. */
  token: string;
  expiresAt: string;
}

export interface RuntimePublicationCandidate {
  id: string;
  contentHash: string;
  /** Opaque, non-secret adapter state required to restore the candidate. */
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface RuntimeResourcePublication {
  generation: number;
  revision: number;
  workspaceCandidate: RuntimePublicationCandidate;
  outputCandidate: RuntimePublicationCandidate | null;
  /** Provider-aware process checkpoint, when the composition can create one. */
  runtimeCheckpoint?: RuntimeCheckpointRef | null;
}

export interface AcquireRuntimeFenceInput {
  scope: RuntimeResourceScope;
  ownerId: string;
  ttlMs: number;
}

export type AcquireRuntimeFenceResult =
  | {
      type: "acquired";
      fence: RuntimeResourceFence;
      publication: RuntimeResourcePublication | null;
    }
  | { type: "conflict"; expiresAt: string | null };

export type RenewRuntimeFenceResult =
  | { type: "renewed"; fence: RuntimeResourceFence }
  | { type: "lost" };

export type PublishRuntimeResourcesResult =
  | { type: "published"; revision: number }
  | { type: "lost" };

/**
 * Authoritative control-plane Port. `publish` must atomically validate the
 * fence generation/token and advance the active resource pointer. Checking
 * ownership and publishing in two calls is forbidden because it introduces a
 * time-of-check/time-of-use split-brain window.
 */
export interface RuntimeResourceFencePort {
  acquire(input: AcquireRuntimeFenceInput): Promise<AcquireRuntimeFenceResult>;
  /** Read-only ownership check used immediately before external mutations
   * that cannot participate in the final publication transaction. */
  isCurrent(fence: RuntimeResourceFence): Promise<boolean>;
  renew(input: {
    fence: RuntimeResourceFence;
    ttlMs: number;
  }): Promise<RenewRuntimeFenceResult>;
  publish(input: {
    fence: RuntimeResourceFence;
    workspaceCandidate: RuntimePublicationCandidate;
    outputCandidate: RuntimePublicationCandidate | null;
    runtimeCheckpoint?: RuntimeCheckpointRef | null;
  }): Promise<PublishRuntimeResourcesResult>;
  release(input: {
    fence: RuntimeResourceFence;
    reason: "completed" | "failed" | "lease_lost";
  }): Promise<void>;
}
