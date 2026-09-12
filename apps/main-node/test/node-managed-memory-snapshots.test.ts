import { describe, expect, it, vi } from "vitest";
import * as snapshotsModule from "../src/lib/node-managed-memory-snapshots.js";

describe("NodeManagedMemorySnapshotMaterializer", () => {
  it("projects every current Memory into an immutable content-addressed blob prefix", async () => {
    const listMemories = vi.fn(async ({ cursor }: { cursor?: string }) => cursor === undefined
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
    const Materializer = (snapshotsModule as Record<string, unknown>)
      .NodeManagedMemorySnapshotMaterializer as undefined | (new (...args: any[]) => {
        materialize(input: Record<string, string>): Promise<{ mountStoreId: string }>;
      });
    expect(Materializer).toBeTypeOf("function");
    if (Materializer === undefined) return;
    const materializer = new Materializer({ listMemories }, { put });

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
    expect(put).toHaveBeenCalledWith(
      `${result.mountStoreId}/empty.txt`,
      "",
    );
  });
});
