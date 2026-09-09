import type { MemoriesApplicationPort } from "@open-managed-agents/managed-agents-application";

export interface MaterializeManagedMemorySnapshot {
  workspaceId: string;
  sessionId: string;
  memoryStoreId: string;
}

export interface ManagedMemorySnapshot {
  mountStoreId: string;
}

export interface ManagedMemorySnapshotPort {
  materialize(
    input: MaterializeManagedMemorySnapshot,
  ): Promise<ManagedMemorySnapshot>;
}

export interface ManagedMemorySnapshotBlobPort {
  put(key: string, content: string): Promise<unknown | null>;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

/**
 * Projects the Managed Memory API's current document view into the immutable
 * blob-prefix shape consumed by sandbox memory mounts. The application stays
 * authoritative; a content-addressed prefix prevents deleted or renamed
 * documents from surviving as stale files in a later mount.
 */
export class ManagedMemorySnapshotMaterializer
  implements ManagedMemorySnapshotPort
{
  constructor(
    private readonly memories: Pick<MemoriesApplicationPort, "listMemories">,
    private readonly blobs: ManagedMemorySnapshotBlobPort,
  ) {}

  async materialize(
    input: MaterializeManagedMemorySnapshot,
  ): Promise<ManagedMemorySnapshot> {
    const documents: Array<{ path: string; content: string; sha256: string }> = [];
    let cursor: string | undefined;
    do {
      const result = await this.memories.listMemories({
        memoryStoreId: input.memoryStoreId,
        pageSize: 100,
        projection: "full",
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (result.type !== "page") {
        throw new Error(
          `Managed Memory Store ${input.memoryStoreId} could not be snapshotted for Session ${input.sessionId}`,
        );
      }
      for (const item of result.page.items) {
        if (item.kind !== "memory") continue;
        if (item.content === undefined) {
          throw new Error(
            `Managed Memory ${item.id} did not include full content while snapshotting Session ${input.sessionId}`,
          );
        }
        documents.push({
          path: item.path,
          content: item.content ?? "",
          sha256: item.contentSha256,
        });
      }
      cursor = result.page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    documents.sort((left, right) => left.path.localeCompare(right.path));
    const digestInput = JSON.stringify(
      documents.map(({ path, sha256 }) => ({ path, sha256 })),
    );
    const digest = hex(new Uint8Array(await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(digestInput),
    )));
    const mountStoreId = [
      ".openma-managed-memory-snapshots",
      encodeURIComponent(input.workspaceId),
      encodeURIComponent(input.memoryStoreId),
      digest,
    ].join("/");
    for (const document of documents) {
      const key = `${mountStoreId}/${document.path.replace(/^\/+/, "")}`;
      const written = await this.blobs.put(key, document.content);
      if (written === null) {
        throw new Error(
          `Managed Memory ${document.path} could not be written to snapshot ${mountStoreId}`,
        );
      }
    }
    return { mountStoreId };
  }
}
