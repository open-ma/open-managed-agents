import { describe, expect, it, vi } from "vitest";
import {
  ManagedMemorySnapshotMaterializer,
  ManagedMemoryBlobWorkspaceSynchronizer,
  ManagedMemoryWorkspaceReconciler,
} from "../src/managed-memory-snapshot";

describe("ManagedMemorySnapshotMaterializer", () => {
  it("projects every current Memory into an immutable content-addressed blob prefix", async () => {
    const listMemories = vi.fn(async ({ cursor }: { cursor?: string }) =>
      cursor === undefined
        ? {
            type: "page" as const,
            page: {
              items: [
                { kind: "prefix" as const, path: "/notes" },
                {
                  kind: "memory" as const,
                  id: "memory_1",
                  content: "ALPHA",
                  contentSha256: "a".repeat(64),
                  contentSizeBytes: 5,
                  createdAt: "2026-09-09T00:00:00.000Z",
                  memoryStoreId: "memstore_1",
                  memoryVersionId: "version_1",
                  path: "/notes/alpha.txt",
                  updatedAt: "2026-09-09T00:00:00.000Z",
                },
              ],
              nextCursor: "next",
            },
          }
        : {
            type: "page" as const,
            page: {
              items: [{
                kind: "memory" as const,
                id: "memory_2",
                content: null,
                contentSha256: "b".repeat(64),
                contentSizeBytes: 0,
                createdAt: "2026-09-09T00:00:00.000Z",
                memoryStoreId: "memstore_1",
                memoryVersionId: "version_2",
                path: "/empty.txt",
                updatedAt: "2026-09-09T00:00:00.000Z",
              }],
              nextCursor: null,
            },
          });
    const put = vi.fn(async () => ({ etag: "etag", size: 1 }));
    const materializer = new ManagedMemorySnapshotMaterializer(
      { listMemories },
      { put, getText: async () => null },
    );

    const result = await materializer.materialize({
      workspaceId: "workspace_1",
      sessionId: "session_1",
      memoryStoreId: "memstore_1",
    });

    expect(result.mountStoreId).toMatch(
      /^\.openma-managed-memory-snapshots\/workspace_1\/memstore_1\/[a-f0-9]{64}$/,
    );
    expect(listMemories).toHaveBeenNthCalledWith(1, {
      memoryStoreId: "memstore_1",
      pageSize: 100,
      projection: "full",
    });
    expect(listMemories).toHaveBeenNthCalledWith(2, {
      memoryStoreId: "memstore_1",
      pageSize: 100,
      projection: "full",
      cursor: "next",
    });
    expect(put).toHaveBeenCalledWith(
      `${result.mountStoreId}/notes/alpha.txt`,
      "ALPHA",
    );
    expect(put).toHaveBeenCalledWith(`${result.mountStoreId}/empty.txt`, "");
  });

  it("gives read-write mounts a private runtime generation and persists their CAS baseline", async () => {
    const put = vi.fn(async () => ({ etag: "etag", size: 1 }));
    const materializer = new ManagedMemorySnapshotMaterializer(
      {
        listMemories: async () => ({
          type: "page" as const,
          page: {
            items: [{
              kind: "memory" as const,
              id: "memory_1",
              content: "before",
              contentSha256: "a".repeat(64),
              contentSizeBytes: 6,
              createdAt: "2026-09-09T00:00:00.000Z",
              memoryStoreId: "memstore_1",
              memoryVersionId: "version_1",
              path: "/notes/one.txt",
              updatedAt: "2026-09-09T00:00:00.000Z",
            }],
            nextCursor: null,
          },
        }),
      },
      { put, getText: async () => null },
    );

    const result = await materializer.materialize({
      workspaceId: "workspace_1",
      sessionId: "session_1",
      memoryStoreId: "memstore_1",
      access: "read_write",
      runtimeGeneration: "sandbox_generation_7",
    });

    expect(result.mountStoreId).toBe(
      ".openma-managed-memory-workspaces/workspace_1/session_1/sandbox_generation_7/memstore_1/data",
    );
    expect(put).toHaveBeenCalledWith(
      ".openma-managed-memory-workspaces/workspace_1/session_1/sandbox_generation_7/memstore_1/manifest.json",
      JSON.stringify({
        version: 1,
        memories: [{ id: "memory_1", path: "/notes/one.txt", sha256: "a".repeat(64) }],
      }),
    );
    expect(put).toHaveBeenCalledWith(
      `${result.mountStoreId}/.openma-memory-store`,
      "openma-memory-store-v1\nmemstore_1",
    );
  });

  it("reuses an existing writable generation without overwriting unsynchronized sandbox edits", async () => {
    const listMemories = vi.fn(async () => ({
      type: "page" as const,
      page: { items: [], nextCursor: null },
    }));
    const put = vi.fn(async () => ({ etag: "etag", size: 1 }));
    const getText = vi.fn(async (key: string) =>
      key.endsWith("/manifest.json")
        ? JSON.stringify({ version: 1, memories: [] })
        : null);
    const materializer = new ManagedMemorySnapshotMaterializer(
      { listMemories },
      { put, getText },
    );

    await expect(materializer.materialize({
      workspaceId: "workspace_1",
      sessionId: "session_1",
      memoryStoreId: "memstore_1",
      access: "read_write",
      runtimeGeneration: "sandbox_generation_7",
    })).resolves.toEqual({
      mountStoreId:
        ".openma-managed-memory-workspaces/workspace_1/session_1/sandbox_generation_7/memstore_1/data",
    });

    expect(getText).toHaveBeenCalledWith(
      ".openma-managed-memory-workspaces/workspace_1/session_1/sandbox_generation_7/memstore_1/manifest.json",
    );
    expect(listMemories).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
});

describe("ManagedMemoryWorkspaceReconciler", () => {
  const before = {
    alpha: { id: "memory_alpha", path: "/alpha.txt", sha256: "a".repeat(64) },
    remove: { id: "memory_remove", path: "/remove.txt", sha256: "b".repeat(64) },
    rename: { id: "memory_rename", path: "/old.txt", sha256: "c".repeat(64) },
  };

  it("commits create, update, delete, and rename through CAS and checks authority before every write", async () => {
    const authorize = vi.fn(async () => true);
    const mutationOrder: string[] = [];
    const createMemory = vi.fn(async ({ path, content }: { path: string; content: string | null }) => {
      mutationOrder.push(`create:${path}`);
      return {
        type: "created" as const,
        memory: {
          kind: "memory" as const,
          id: `created:${path}`,
          path,
          content,
          contentSha256: `sha:${content}`,
          contentSizeBytes: content?.length ?? 0,
          createdAt: "2026-09-10T00:00:00.000Z",
          updatedAt: "2026-09-10T00:00:00.000Z",
          memoryStoreId: "memstore_1",
          memoryVersionId: "version_new",
        },
      };
    });
    const updateMemory = vi.fn(async () => {
      mutationOrder.push("update");
      return { type: "updated" as const, memory: {} as never };
    });
    const deleteMemory = vi.fn(async ({ memoryId }: { memoryId: string }) => {
      mutationOrder.push(`delete:${memoryId}`);
      return { type: "deleted" as const, memoryId };
    });
    const listMemories = vi.fn(async () => ({
      type: "page" as const,
      page: {
        items: [
          { kind: "memory" as const, id: before.alpha.id, path: before.alpha.path, contentSha256: before.alpha.sha256, memoryStoreId: "memstore_1", memoryVersionId: "v1", contentSizeBytes: 1, createdAt: "x", updatedAt: "x" },
          { kind: "memory" as const, id: before.remove.id, path: before.remove.path, contentSha256: before.remove.sha256, memoryStoreId: "memstore_1", memoryVersionId: "v2", contentSizeBytes: 1, createdAt: "x", updatedAt: "x" },
          { kind: "memory" as const, id: before.rename.id, path: before.rename.path, contentSha256: before.rename.sha256, memoryStoreId: "memstore_1", memoryVersionId: "v3", contentSizeBytes: 1, createdAt: "x", updatedAt: "x" },
        ],
        nextCursor: null,
      },
    }));
    const reconciler = new ManagedMemoryWorkspaceReconciler({
      createMemory,
      retrieveMemory: vi.fn(),
      updateMemory,
      listMemories,
      deleteMemory,
    });

    await expect(reconciler.reconcile({
      memoryStoreId: "memstore_1",
      baseline: Object.values(before),
      local: [
        { path: "/alpha.txt", content: "alpha changed", sha256: "d".repeat(64) },
        { path: "/new.txt", content: "new", sha256: "e".repeat(64) },
        { path: "/renamed.txt", content: "renamed", sha256: "f".repeat(64) },
      ],
      authorize,
    })).resolves.toMatchObject({
      type: "reconciled",
      created: 2,
      updated: 1,
      deleted: 2,
      conflicts: [],
    });
    expect(updateMemory).toHaveBeenCalledWith({
      memoryStoreId: "memstore_1",
      memoryId: "memory_alpha",
      content: "alpha changed",
      path: "/alpha.txt",
      contentPrecondition: { expectedSha256: "a".repeat(64) },
    });
    expect(deleteMemory).toHaveBeenCalledWith({
      memoryStoreId: "memstore_1",
      memoryId: "memory_remove",
      expectedContentSha256: "b".repeat(64),
    });
    expect(deleteMemory).toHaveBeenCalledWith({
      memoryStoreId: "memstore_1",
      memoryId: "memory_rename",
      expectedContentSha256: "c".repeat(64),
    });
    expect(authorize).toHaveBeenCalledTimes(5);
    const lastUpsert = mutationOrder.reduce(
      (last, entry, index) =>
        entry.startsWith("create:") || entry === "update" ? index : last,
      -1,
    );
    expect(mutationOrder.findIndex((entry) => entry.startsWith("delete:")))
      .toBeGreaterThan(lastUpsert);
  });

  it("lets the remote winner survive a two-sided edit and is idempotent after a committed retry", async () => {
    const updateMemory = vi.fn();
    const createMemory = vi.fn();
    const deleteMemory = vi.fn();
    const reconciler = new ManagedMemoryWorkspaceReconciler({
      createMemory,
      retrieveMemory: vi.fn(),
      updateMemory,
      deleteMemory,
      listMemories: async () => ({
        type: "page" as const,
        page: {
          items: [{
            kind: "memory" as const,
            id: "memory_alpha",
            path: "/alpha.txt",
            contentSha256: "remote-winner",
            contentSizeBytes: 1,
            createdAt: "x",
            updatedAt: "x",
            memoryStoreId: "memstore_1",
            memoryVersionId: "v2",
          }, {
            kind: "memory" as const,
            id: "memory_new",
            path: "/new.txt",
            contentSha256: "local-new",
            contentSizeBytes: 1,
            createdAt: "x",
            updatedAt: "x",
            memoryStoreId: "memstore_1",
            memoryVersionId: "v3",
          }],
          nextCursor: null,
        },
      }),
    });

    await expect(reconciler.reconcile({
      memoryStoreId: "memstore_1",
      baseline: [before.alpha],
      local: [
        { path: "/alpha.txt", content: "local loser", sha256: "local-loser" },
        { path: "/new.txt", content: "already committed", sha256: "local-new" },
      ],
      authorize: async () => true,
    })).resolves.toMatchObject({
      type: "reconciled",
      created: 0,
      updated: 0,
      deleted: 0,
      conflicts: [{ path: "/alpha.txt", reason: "changed_both" }],
    });
    expect(createMemory).not.toHaveBeenCalled();
    expect(updateMemory).not.toHaveBeenCalled();
    expect(deleteMemory).not.toHaveBeenCalled();
  });

  it("refuses a suspicious whole-folder wipe and a stale fence", async () => {
    const deleteMemory = vi.fn();
    const memories = {
      createMemory: vi.fn(),
      retrieveMemory: vi.fn(),
      updateMemory: vi.fn(),
      deleteMemory,
      listMemories: async () => ({
        type: "page" as const,
        page: {
          items: Object.values(before).map((memory, index) => ({
            kind: "memory" as const,
            id: memory.id,
            path: memory.path,
            contentSha256: memory.sha256,
            memoryStoreId: "memstore_1",
            memoryVersionId: `v${index}`,
            contentSizeBytes: 1,
            createdAt: "x",
            updatedAt: "x",
          })),
          nextCursor: null,
        },
      }),
    };
    const reconciler = new ManagedMemoryWorkspaceReconciler(memories);
    await expect(reconciler.reconcile({
      memoryStoreId: "memstore_1",
      baseline: Object.values(before),
      local: [],
      authorize: async () => true,
    })).resolves.toMatchObject({ type: "distrusted", reason: "whole_folder_missing" });
    expect(deleteMemory).not.toHaveBeenCalled();

    await expect(reconciler.reconcile({
      memoryStoreId: "memstore_1",
      baseline: [before.alpha],
      local: [{ path: "/alpha.txt", content: "changed", sha256: "changed" }],
      authorize: async () => false,
    })).resolves.toEqual({ type: "fence_lost" });
    expect(memories.updateMemory).not.toHaveBeenCalled();
  });

  it("caps corroborated deletes before issuing any canonical mutation", async () => {
    const entries = Array.from({ length: 51 }, (_, index) => ({
      id: `memory_${index}`,
      path: `/memory-${index}.txt`,
      sha256: `${index}`.padStart(64, "0"),
    }));
    const deleteMemory = vi.fn();
    const reconciler = new ManagedMemoryWorkspaceReconciler({
      createMemory: vi.fn(),
      retrieveMemory: vi.fn(),
      updateMemory: vi.fn(),
      deleteMemory,
      listMemories: async () => ({
        type: "page" as const,
        page: {
          items: entries.map((entry) => ({
            kind: "memory" as const,
            id: entry.id,
            path: entry.path,
            contentSha256: entry.sha256,
            memoryStoreId: "memstore_1",
            memoryVersionId: `version_${entry.id}`,
            contentSizeBytes: 1,
            createdAt: "x",
            updatedAt: "x",
          })),
          nextCursor: null,
        },
      }),
    });

    await expect(reconciler.reconcile({
      memoryStoreId: "memstore_1",
      baseline: entries,
      local: [{ path: "/kept.txt", content: "kept", sha256: "kept" }],
      authorize: async () => true,
    })).resolves.toEqual({ type: "distrusted", reason: "delete_limit_exceeded" });
    expect(deleteMemory).not.toHaveBeenCalled();
  });
});

describe("ManagedMemoryBlobWorkspaceSynchronizer", () => {
  it("loads the private snapshot manifest, commits it, then rebases data before advancing the manifest", async () => {
    const root = ".openma-managed-memory-workspaces/workspace/session/generation/store";
    const values = new Map<string, string>([
      [`${root}/manifest.json`, JSON.stringify({
        version: 1,
        memories: [{ id: "memory_1", path: "/one.txt", sha256: "base" }],
      })],
      [`${root}/data/.openma-memory-store`, "openma-memory-store-v1\nstore"],
      [`${root}/data/one.txt`, "changed"],
      [`${root}/data/extra.txt`, "extra"],
    ]);
    const calls: string[] = [];
    const put = vi.fn(async (key: string, value: string) => {
      calls.push(`put:${key}`);
      values.set(key, value);
      return {};
    });
    const reconciler = {
      reconcile: vi.fn(async () => ({
        type: "reconciled" as const,
        created: 1,
        updated: 1,
        deleted: 0,
        conflicts: [],
      })),
    };
    const synchronizer = new ManagedMemoryBlobWorkspaceSynchronizer(
      {
        getText: async (key) => values.get(key) ?? null,
        list: async (prefix) => ({
          keys: [...values.keys()].filter((key) => key.startsWith(prefix)),
          nextCursor: null,
        }),
        put,
        delete: async (key) => {
          calls.push(`delete:${key}`);
          values.delete(key);
        },
      },
      reconciler,
      {
        listMemories: async () => ({
          type: "page" as const,
          page: {
            items: [{
              kind: "memory" as const,
              id: "memory_1",
              path: "/one.txt",
              content: "canonical",
              contentSha256: "canonical-sha",
              contentSizeBytes: 9,
              createdAt: "x",
              updatedAt: "x",
              memoryStoreId: "store",
              memoryVersionId: "v2",
            }],
            nextCursor: null,
          },
        }),
      },
    );

    await expect(synchronizer.synchronize({
      workspaceId: "workspace",
      sessionId: "session",
      runtimeGeneration: "generation",
      memoryStoreId: "store",
      authorize: async () => true,
    })).resolves.toMatchObject({ type: "reconciled", created: 1, updated: 1 });
    expect(reconciler.reconcile).toHaveBeenCalledWith(expect.objectContaining({
      memoryStoreId: "store",
      baseline: [{ id: "memory_1", path: "/one.txt", sha256: "base" }],
      local: [
        expect.objectContaining({ path: "/extra.txt", content: "extra" }),
        expect.objectContaining({ path: "/one.txt", content: "changed" }),
      ],
    }));
    expect(values.get(`${root}/data/one.txt`)).toBe("canonical");
    expect(values.has(`${root}/data/extra.txt`)).toBe(false);
    expect(JSON.parse(values.get(`${root}/manifest.json`)!).memories).toEqual([
      { id: "memory_1", path: "/one.txt", sha256: "canonical-sha" },
    ]);
    expect(calls.at(-1)).toBe(`put:${root}/manifest.json`);
  });

  it("rehydrates a missing marker without presenting the wipe as local deletes", async () => {
    const root = ".openma-managed-memory-workspaces/workspace/session/generation/store";
    const values = new Map<string, string>([[
      `${root}/manifest.json`,
      JSON.stringify({
        version: 1,
        memories: [{ id: "memory_1", path: "/one.txt", sha256: "base" }],
      }),
    ]]);
    const reconciler = { reconcile: vi.fn() };
    const synchronizer = new ManagedMemoryBlobWorkspaceSynchronizer(
      {
        getText: async (key) => values.get(key) ?? null,
        list: async (prefix) => ({
          keys: [...values.keys()].filter((key) => key.startsWith(prefix)),
          nextCursor: null,
        }),
        put: async (key, content) => {
          values.set(key, content);
          return { key };
        },
        delete: async (key) => { values.delete(key); },
      },
      reconciler,
      {
        listMemories: async () => ({
          type: "page" as const,
          page: {
            items: [{
              kind: "memory" as const,
              id: "memory_1",
              path: "/one.txt",
              content: "canonical",
              contentSha256: "canonical-sha",
              contentSizeBytes: 9,
              createdAt: "x",
              updatedAt: "x",
              memoryStoreId: "store",
              memoryVersionId: "v2",
            }],
            nextCursor: null,
          },
        }),
      },
    );

    await expect(synchronizer.synchronize({
      workspaceId: "workspace",
      sessionId: "session",
      runtimeGeneration: "generation",
      memoryStoreId: "store",
      authorize: async () => true,
    })).resolves.toEqual({ type: "distrusted", reason: "whole_folder_missing" });
    expect(reconciler.reconcile).not.toHaveBeenCalled();
    expect(values.get(`${root}/data/one.txt`)).toBe("canonical");
    expect(values.get(`${root}/data/.openma-memory-store`))
      .toBe("openma-memory-store-v1\nstore");
  });

  it("does not let a fenced runtime rebase its writable snapshot", async () => {
    const root = ".openma-managed-memory-workspaces/workspace/session/generation/store";
    const values = new Map<string, string>([[
      `${root}/manifest.json`,
      JSON.stringify({ version: 1, memories: [] }),
    ]]);
    const put = vi.fn(async () => ({}));
    const synchronizer = new ManagedMemoryBlobWorkspaceSynchronizer(
      {
        getText: async (key) => values.get(key) ?? null,
        list: async () => ({ keys: [], nextCursor: null }),
        put,
        delete: vi.fn(async () => undefined),
      },
      { reconcile: vi.fn() },
      { listMemories: vi.fn() },
    );

    await expect(synchronizer.synchronize({
      workspaceId: "workspace",
      sessionId: "session",
      runtimeGeneration: "generation",
      memoryStoreId: "store",
      authorize: async () => false,
    })).resolves.toEqual({ type: "fence_lost" });
    expect(put).not.toHaveBeenCalled();
  });
});
