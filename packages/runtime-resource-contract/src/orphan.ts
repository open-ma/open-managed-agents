import type { ManagedSandboxLease } from "./sandbox";
import type { RuntimeResourceScope } from "./scope";

export type RuntimeOrphanReason = "completed" | "failed" | "lease_lost";

/** Persisted cleanup work. Fencing tokens are intentionally excluded. */
export interface RuntimeOrphanRecord {
  id: string;
  scope: RuntimeResourceScope;
  generation: number;
  ownerId: string;
  sandbox: ManagedSandboxLease;
  reason: RuntimeOrphanReason;
  attempts: number;
  lastError: string;
}

export interface RuntimeOrphanPort {
  enqueue(input: {
    scope: RuntimeResourceScope;
    generation: number;
    ownerId: string;
    sandbox: ManagedSandboxLease;
    reason: RuntimeOrphanReason;
    error: unknown;
  }): Promise<void>;
  list(input: { limit: number }): Promise<readonly RuntimeOrphanRecord[]>;
  failed(input: { id: string; error: unknown }): Promise<void>;
  resolve(input: { id: string }): Promise<void>;
}

export function runtimeOrphanId(input: {
  scope: RuntimeResourceScope;
  generation: number;
  sandbox: ManagedSandboxLease;
}): string {
  return JSON.stringify([
    input.scope.workspaceId,
    input.scope.environmentId,
    input.scope.sessionId,
    input.scope.workId,
    input.generation,
    input.sandbox.provider,
    input.sandbox.runtimeId,
  ]);
}
