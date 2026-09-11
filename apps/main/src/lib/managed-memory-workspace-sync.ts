import type {
  MemoriesApplicationPort,
} from "@open-managed-agents/managed-agents-application";
import {
  ManagedMemoryBlobWorkspaceSynchronizer,
  ManagedMemoryWorkspaceReconciler,
  type ManagedMemoryWorkspaceBlobPort,
} from "@open-managed-agents/managed-agents-adapters-runtime";

interface ManagedSessionMemorySource {
  find(input: {
    workspaceId: string;
    sessionId: string;
  }): Promise<{
    resources: readonly (Readonly<Record<string, unknown>> & { type: string })[];
  } | null>;
}

export interface ManagedMemoryExecutionFence {
  executionId: string;
  workspaceId: string;
  sessionId: string;
  attemptId: string;
  ownerId: string;
  generation: number;
  expiresAt: string;
}

export type SynchronizeManagedSessionMemoryResult =
  | {
      type: "synchronized";
      created: number;
      updated: number;
      deleted: number;
      conflicts: Array<{ memoryStoreId: string; path: string; reason: "changed_both" }>;
      recoveredWipes: string[];
    }
  | { type: "not_found" }
  | { type: "fence_lost" };

/** Session authorization plus provider-neutral writable Memory reconciliation.
 * The caller supplies an authority check backed by its execution store; the
 * check runs once up front and again immediately before every API mutation. */
export async function synchronizeManagedSessionMemoryWorkspaces(
  source: ManagedSessionMemorySource,
  memories: MemoriesApplicationPort,
  blobs: ManagedMemoryWorkspaceBlobPort,
  input: {
    workspaceId: string;
    sessionId: string;
    runtimeGeneration: string;
    executionFence: ManagedMemoryExecutionFence;
    isFenceActive(fence: ManagedMemoryExecutionFence): Promise<boolean>;
  },
): Promise<SynchronizeManagedSessionMemoryResult> {
  const session = await source.find({
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
  });
  if (session === null) return { type: "not_found" };
  if (!await input.isFenceActive(input.executionFence)) {
    return { type: "fence_lost" };
  }
  const writable = session.resources.filter((resource) =>
    resource.type === "memory_store"
    && resource.access === "read_write"
    && typeof resource.memoryStoreId === "string"
  );
  const reconciler = new ManagedMemoryWorkspaceReconciler(memories);
  const synchronizer = new ManagedMemoryBlobWorkspaceSynchronizer(
    blobs,
    reconciler,
    memories,
  );
  let created = 0;
  let updated = 0;
  let deleted = 0;
  const conflicts: Array<{
    memoryStoreId: string;
    path: string;
    reason: "changed_both";
  }> = [];
  const recoveredWipes: string[] = [];
  for (const resource of writable) {
    const memoryStoreId = resource.memoryStoreId as string;
    const result = await synchronizer.synchronize({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      runtimeGeneration: input.runtimeGeneration,
      memoryStoreId,
      authorize: () => input.isFenceActive(input.executionFence),
    });
    if (result.type === "fence_lost") return result;
    if (result.type === "distrusted") {
      recoveredWipes.push(memoryStoreId);
      continue;
    }
    created += result.created;
    updated += result.updated;
    deleted += result.deleted;
    conflicts.push(...result.conflicts.map((conflict) => ({
      memoryStoreId,
      ...conflict,
    })));
  }
  return {
    type: "synchronized",
    created,
    updated,
    deleted,
    conflicts,
    recoveredWipes,
  };
}
