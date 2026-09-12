import { describe, expect, it, vi } from "vitest";

import { synchronizeManagedSessionMemoryWorkspaces } from "../src/lib/managed-memory-workspace-sync";

const fence = {
  executionId: "execution_1",
  workspaceId: "workspace_1",
  sessionId: "session_1",
  attemptId: "attempt_1",
  ownerId: "owner_1",
  generation: 1,
  expiresAt: "2026-09-10T12:00:00.000Z",
};

function blobs(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    port: {
      getText: vi.fn(async (key: string) => values.get(key) ?? null),
      list: vi.fn(async (prefix: string) => ({
        keys: [...values.keys()].filter((key) => key.startsWith(prefix)),
        nextCursor: null,
      })),
      put: vi.fn(async (key: string, content: string) => {
        values.set(key, content);
        return { key };
      }),
      delete: vi.fn(async (key: string) => { values.delete(key); }),
    },
  };
}

function memories() {
  return {
    createMemory: vi.fn(),
    retrieveMemory: vi.fn(),
    updateMemory: vi.fn(),
    deleteMemory: vi.fn(),
    listMemories: vi.fn(async () => ({
      type: "page" as const,
      page: { items: [], nextCursor: null },
    })),
  };
}

describe("synchronizeManagedSessionMemoryWorkspaces", () => {
  it("authorizes the Session and fence before reading writable snapshot state", async () => {
    const memory = memories();
    const storage = blobs();
    const isFenceActive = vi.fn(async () => false);

    await expect(synchronizeManagedSessionMemoryWorkspaces(
      {
        find: vi.fn(async () => ({
          resources: [{
            type: "memory_store",
            memoryStoreId: "memstore_1",
            access: "read_write",
          }],
        })),
      },
      memory as any,
      storage.port,
      {
        workspaceId: fence.workspaceId,
        sessionId: fence.sessionId,
        runtimeGeneration: "runtime_1",
        executionFence: fence,
        isFenceActive,
      },
    )).resolves.toEqual({ type: "fence_lost" });

    expect(isFenceActive).toHaveBeenCalledWith(fence);
    expect(storage.port.getText).not.toHaveBeenCalled();
    expect(memory.listMemories).not.toHaveBeenCalled();
  });

  it("ignores unattached and read-only stores and never opens a write path", async () => {
    const memory = memories();
    const storage = blobs();

    await expect(synchronizeManagedSessionMemoryWorkspaces(
      {
        find: vi.fn(async () => ({
          resources: [{
            type: "memory_store",
            memoryStoreId: "memstore_read_only",
            access: "read_only",
          }],
        })),
      },
      memory as any,
      storage.port,
      {
        workspaceId: fence.workspaceId,
        sessionId: fence.sessionId,
        runtimeGeneration: "runtime_1",
        executionFence: fence,
        isFenceActive: vi.fn(async () => true),
      },
    )).resolves.toEqual({
      type: "synchronized",
      created: 0,
      updated: 0,
      deleted: 0,
      conflicts: [],
      recoveredWipes: [],
    });

    expect(storage.port.getText).not.toHaveBeenCalled();
    expect(memory.listMemories).not.toHaveBeenCalled();
  });

  it("returns not_found before touching canonical Memory state", async () => {
    const memory = memories();
    const storage = blobs();
    await expect(synchronizeManagedSessionMemoryWorkspaces(
      { find: vi.fn(async () => null) },
      memory as any,
      storage.port,
      {
        workspaceId: fence.workspaceId,
        sessionId: fence.sessionId,
        runtimeGeneration: "runtime_1",
        executionFence: fence,
        isFenceActive: vi.fn(async () => true),
      },
    )).resolves.toEqual({ type: "not_found" });
    expect(storage.port.getText).not.toHaveBeenCalled();
    expect(memory.listMemories).not.toHaveBeenCalled();
  });
});
