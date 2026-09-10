import type { MemoriesApplicationPort } from "@open-managed-agents/managed-agents-application";

const managedMemoryMarkerName = ".openma-memory-store";

function managedMemoryMarker(memoryStoreId: string): string {
  return `openma-memory-store-v1\n${memoryStoreId}`;
}

export interface MaterializeManagedMemorySnapshot {
  workspaceId: string;
  sessionId: string;
  memoryStoreId: string;
  access?: "read_only" | "read_write";
  /** Stable for one concrete sandbox incarnation. Required for writable
   * snapshots so two runtimes never share a mutable blob prefix. */
  runtimeGeneration?: string;
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
  /** Writable snapshots use this so a retained runtime generation can
   * reuse its existing baseline without overwriting unsynchronized edits. */
  getText(key: string): Promise<string | null>;
  put(key: string, content: string): Promise<unknown | null>;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function safeSegment(value: string, label: string): string {
  if (value.length === 0 || value === "." || value === ".." || value.includes("/")) {
    throw new Error(`${label} must be a safe non-empty path segment`);
  }
  return encodeURIComponent(value);
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
    const writable = input.access === "read_write";
    if (writable && input.runtimeGeneration === undefined) {
      throw new Error("Writable Managed Memory snapshots require a runtime generation");
    }
    const writableRoot = writable
      ? [
          ".openma-managed-memory-workspaces",
          safeSegment(input.workspaceId, "workspaceId"),
          safeSegment(input.sessionId, "sessionId"),
          safeSegment(input.runtimeGeneration!, "runtimeGeneration"),
          safeSegment(input.memoryStoreId, "memoryStoreId"),
        ].join("/")
      : undefined;
    if (writable) {
      // manifest.json is written last during initial materialization. Its
      // presence therefore proves this generation already owns a complete
      // workspace. Never project canonical bytes over it: it may contain
      // local edits waiting for the next fenced reconciliation barrier.
      if (await this.blobs.getText(`${writableRoot!}/manifest.json`) !== null) {
        return { mountStoreId: `${writableRoot!}/data` };
      }
    }
    const documents: Array<{
      id: string;
      path: string;
      content: string;
      sha256: string;
    }> = [];
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
        if (item.path.replace(/^\/+/, "") === managedMemoryMarkerName) {
          throw new Error(`Managed Memory path ${item.path} is reserved`);
        }
        documents.push({
          id: item.id,
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
    const root = writable
      ? writableRoot!
      : [
          ".openma-managed-memory-snapshots",
          safeSegment(input.workspaceId, "workspaceId"),
          safeSegment(input.memoryStoreId, "memoryStoreId"),
          digest,
        ].join("/");
    const mountStoreId = writable ? `${root}/data` : root;
    for (const document of documents) {
      const key = `${mountStoreId}/${document.path.replace(/^\/+/, "")}`;
      const written = await this.blobs.put(key, document.content);
      if (written === null) {
        throw new Error(
          `Managed Memory ${document.path} could not be written to snapshot ${mountStoreId}`,
        );
      }
    }
    if (writable) {
      if (
        await this.blobs.put(
          `${mountStoreId}/${managedMemoryMarkerName}`,
          managedMemoryMarker(input.memoryStoreId),
        ) === null
      ) {
        throw new Error(`Managed Memory marker could not be written for ${mountStoreId}`);
      }
      const manifest = JSON.stringify({
        version: 1,
        memories: documents.map(({ id, path, sha256 }) => ({ id, path, sha256 })),
      });
      const written = await this.blobs.put(`${root}/manifest.json`, manifest);
      if (written === null) {
        throw new Error(
          `Managed Memory baseline could not be written for snapshot ${mountStoreId}`,
        );
      }
    }
    return { mountStoreId };
  }
}

export interface ManagedMemoryBaselineEntry {
  id: string;
  path: string;
  sha256: string;
}

export interface ManagedMemoryLocalEntry {
  path: string;
  content: string;
  sha256: string;
}

export interface ReconcileManagedMemoryWorkspace {
  memoryStoreId: string;
  baseline: readonly ManagedMemoryBaselineEntry[];
  local: readonly ManagedMemoryLocalEntry[];
  /** Revalidated immediately before each canonical mutation. */
  authorize(): Promise<boolean>;
}

export type ManagedMemoryWorkspaceReconcileResult =
  | {
      type: "reconciled";
      created: number;
      updated: number;
      deleted: number;
      conflicts: Array<{ path: string; reason: "changed_both" }>;
    }
  | {
      type: "distrusted";
      reason: "whole_folder_missing" | "delete_limit_exceeded";
    }
  | { type: "fence_lost" };

/**
 * Provider-neutral three-way reconciliation for a writable Memory workspace.
 * It mirrors the official Environment Worker's important merge invariant:
 * local writes only win when the canonical SHA still equals the download
 * baseline. Retried creates/updates/deletes are idempotent, while a two-sided
 * edit keeps the canonical winner.
 */
export class ManagedMemoryWorkspaceReconciler {
  constructor(private readonly memories: MemoriesApplicationPort) {}

  async reconcile(
    input: ReconcileManagedMemoryWorkspace,
  ): Promise<ManagedMemoryWorkspaceReconcileResult> {
    if (input.local.length === 0 && input.baseline.length > 1) {
      return { type: "distrusted", reason: "whole_folder_missing" };
    }
    const baseline = uniqueByPath(input.baseline, "baseline");
    const local = uniqueByPath(input.local, "local workspace");
    const remote = await this.listAll(input.memoryStoreId);
    const paths = [...new Set([
      ...baseline.keys(),
      ...local.keys(),
      ...remote.keys(),
    ])].sort();
    const safeDeleteCount = paths.filter((path) => {
      const base = baseline.get(path);
      const remoteEntry = remote.get(path);
      return !local.has(path)
        && base !== undefined
        && remoteEntry !== undefined
        && remoteEntry.contentSha256 === base.sha256;
    }).length;
    if (safeDeleteCount > 50) {
      return { type: "distrusted", reason: "delete_limit_exceeded" };
    }
    let created = 0;
    let updated = 0;
    let deleted = 0;
    const conflicts: Array<{ path: string; reason: "changed_both" }> = [];

    // Upserts always precede deletes so rename (create new path + delete old
    // path) cannot destroy the only canonical copy if creation fails.
    for (const path of paths) {
      const base = baseline.get(path);
      const localEntry = local.get(path);
      const remoteEntry = remote.get(path);
      if (localEntry === undefined) continue;

      if (remoteEntry === undefined) {
        if (base !== undefined && localEntry.sha256 === base.sha256) {
          // Deleted only remotely: canonical deletion wins.
          continue;
        }
        if (!await input.authorize()) return { type: "fence_lost" };
        const result = await this.memories.createMemory({
          memoryStoreId: input.memoryStoreId,
          path,
          content: localEntry.content,
        });
        if (result.type === "created") {
          created += 1;
          continue;
        }
        if (result.type === "path_conflict" || result.type === "conflict") {
          const latest = await this.findPath(input.memoryStoreId, path);
          if (latest?.contentSha256 === localEntry.sha256) continue;
          conflicts.push({ path, reason: "changed_both" });
          continue;
        }
        throw new Error(`Managed Memory create ${path} failed: ${result.type}`);
      }

      if (remoteEntry.contentSha256 === localEntry.sha256) continue;
      if (
        base === undefined
        || remoteEntry.contentSha256 !== base.sha256
        || localEntry.sha256 === base.sha256
      ) {
        conflicts.push({ path, reason: "changed_both" });
        continue;
      }
      if (!await input.authorize()) return { type: "fence_lost" };
      const result = await this.memories.updateMemory({
        memoryStoreId: input.memoryStoreId,
        memoryId: remoteEntry.id,
        content: localEntry.content,
        path,
        contentPrecondition: { expectedSha256: base.sha256 },
      });
      if (result.type === "updated") {
        updated += 1;
        continue;
      }
      if (
        result.type === "precondition_failed"
        || result.type === "path_conflict"
        || result.type === "conflict"
        || result.type === "not_found"
      ) {
        const latest = await this.findPath(input.memoryStoreId, path);
        if (latest?.contentSha256 === localEntry.sha256) continue;
        conflicts.push({ path, reason: "changed_both" });
        continue;
      }
      throw new Error(`Managed Memory update ${path} failed: ${result.type}`);
    }

    for (const path of paths) {
      const base = baseline.get(path);
      const localEntry = local.get(path);
      const remoteEntry = remote.get(path);
      if (localEntry !== undefined || base === undefined || remoteEntry === undefined) continue;
      if (remoteEntry.contentSha256 !== base.sha256) {
        conflicts.push({ path, reason: "changed_both" });
        continue;
      }
      if (!await input.authorize()) return { type: "fence_lost" };
      const result = await this.memories.deleteMemory({
        memoryStoreId: input.memoryStoreId,
        memoryId: remoteEntry.id,
        expectedContentSha256: base.sha256,
      });
      if (result.type === "deleted" || result.type === "not_found") {
        deleted += result.type === "deleted" ? 1 : 0;
        continue;
      }
      if (result.type === "precondition_failed" || result.type === "conflict") {
        conflicts.push({ path, reason: "changed_both" });
      }
    }
    return { type: "reconciled", created, updated, deleted, conflicts };
  }

  private async listAll(memoryStoreId: string) {
    const result = new Map<string, Extract<Awaited<ReturnType<MemoriesApplicationPort["listMemories"]>>, { type: "page" }>["page"]["items"][number] & { kind: "memory" }>();
    let cursor: string | undefined;
    do {
      const page = await this.memories.listMemories({
        memoryStoreId,
        pageSize: 100,
        projection: "basic",
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (page.type !== "page") {
        throw new Error(`Managed Memory Store ${memoryStoreId} could not be listed: ${page.type}`);
      }
      for (const item of page.page.items) {
        if (item.kind === "memory") result.set(item.path, item);
      }
      cursor = page.page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return result;
  }

  private async findPath(memoryStoreId: string, path: string) {
    return (await this.listAll(memoryStoreId)).get(path);
  }
}

function uniqueByPath<T extends { path: string }>(
  entries: readonly T[],
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const entry of entries) {
    if (!entry.path.startsWith("/") || entry.path.includes("\0")) {
      throw new Error(`Managed Memory ${label} contains an unsafe path`);
    }
    if (result.has(entry.path)) {
      throw new Error(`Managed Memory ${label} contains duplicate path ${entry.path}`);
    }
    result.set(entry.path, entry);
  }
  return result;
}

export interface ManagedMemoryWorkspaceBlobPort {
  getText(key: string): Promise<string | null>;
  list(
    prefix: string,
    cursor?: string,
  ): Promise<{ keys: string[]; nextCursor: string | null }>;
  put(key: string, content: string): Promise<unknown | null>;
  delete(key: string): Promise<void>;
}

interface ManagedMemoryWorkspaceReconcilePort {
  reconcile(
    input: ReconcileManagedMemoryWorkspace,
  ): Promise<ManagedMemoryWorkspaceReconcileResult>;
}

interface ManagedMemoryCanonicalSnapshotSource {
  listMemories: MemoriesApplicationPort["listMemories"];
}

interface ManagedMemoryWorkspaceManifest {
  version: 1;
  memories: ManagedMemoryBaselineEntry[];
}

/** Owns the blob-side half of writable Memory synchronization. The mounted
 * `data/` prefix is private to a concrete runtime generation; the baseline is
 * outside that mount so an agent cannot forge its CAS ancestor. */
export class ManagedMemoryBlobWorkspaceSynchronizer {
  constructor(
    private readonly blobs: ManagedMemoryWorkspaceBlobPort,
    private readonly reconciler: ManagedMemoryWorkspaceReconcilePort,
    private readonly canonical: ManagedMemoryCanonicalSnapshotSource,
  ) {}

  async synchronize(input: {
    workspaceId: string;
    sessionId: string;
    runtimeGeneration: string;
    memoryStoreId: string;
    authorize(): Promise<boolean>;
  }): Promise<ManagedMemoryWorkspaceReconcileResult> {
    const root = [
      ".openma-managed-memory-workspaces",
      safeSegment(input.workspaceId, "workspaceId"),
      safeSegment(input.sessionId, "sessionId"),
      safeSegment(input.runtimeGeneration, "runtimeGeneration"),
      safeSegment(input.memoryStoreId, "memoryStoreId"),
    ].join("/");
    const manifestKey = `${root}/manifest.json`;
    const rawManifest = await this.blobs.getText(manifestKey);
    if (rawManifest === null) {
      throw new Error(`Writable Managed Memory baseline is missing for ${input.memoryStoreId}`);
    }
    const manifest = parseManifest(rawManifest);
    const dataPrefix = `${root}/data/`;
    const markerKey = `${dataPrefix}${managedMemoryMarkerName}`;
    const marker = await this.blobs.getText(markerKey);
    const local: ManagedMemoryLocalEntry[] = [];
    for (const key of await this.listKeys(dataPrefix)) {
      const relative = key.slice(dataPrefix.length);
      if (relative.length === 0 || relative.split("/").includes("..")) {
        throw new Error(`Writable Managed Memory snapshot contains unsafe key ${key}`);
      }
      if (relative === managedMemoryMarkerName) continue;
      const content = await this.blobs.getText(key);
      if (content === null) continue;
      local.push({
        path: `/${relative}`,
        content,
        sha256: await sha256Text(content),
      });
    }
    local.sort((left, right) => left.path.localeCompare(right.path));
    const result = marker === managedMemoryMarker(input.memoryStoreId)
      ? await this.reconciler.reconcile({
          memoryStoreId: input.memoryStoreId,
          baseline: manifest.memories,
          local,
          authorize: input.authorize,
        })
      : { type: "distrusted" as const, reason: "whole_folder_missing" as const };
    if (result.type === "fence_lost") return result;
    if (!await input.authorize()) return { type: "fence_lost" };

    // Rebase the mounted tree to the canonical winner. The manifest advances
    // last: if a process dies halfway through this pass, retrying against the
    // old baseline remains safe and eventually completes the same rebase.
    const canonical = await this.listCanonical(input.memoryStoreId);
    const canonicalKeys = new Set(
      canonical.map((memory) => `${dataPrefix}${memory.path.replace(/^\/+/, "")}`),
    );
    canonicalKeys.add(markerKey);
    for (const key of await this.listKeys(dataPrefix)) {
      if (!canonicalKeys.has(key)) await this.blobs.delete(key);
    }
    for (const memory of canonical) {
      const written = await this.blobs.put(
        `${dataPrefix}${memory.path.replace(/^\/+/, "")}`,
        memory.content,
      );
      if (written === null) {
        throw new Error(`Could not rebase Managed Memory ${memory.path}`);
      }
    }
    if (
      await this.blobs.put(markerKey, managedMemoryMarker(input.memoryStoreId)) === null
    ) {
      throw new Error(`Could not rebase Managed Memory marker ${input.memoryStoreId}`);
    }
    const nextManifest: ManagedMemoryWorkspaceManifest = {
      version: 1,
      memories: canonical.map(({ id, path, sha256 }) => ({ id, path, sha256 })),
    };
    if (await this.blobs.put(manifestKey, JSON.stringify(nextManifest)) === null) {
      throw new Error(`Could not advance Managed Memory baseline ${input.memoryStoreId}`);
    }
    return result;
  }

  private async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.blobs.list(prefix, cursor);
      keys.push(...page.keys);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return [...new Set(keys)].sort();
  }

  private async listCanonical(memoryStoreId: string): Promise<Array<{
    id: string;
    path: string;
    sha256: string;
    content: string;
  }>> {
    const memories: Array<{
      id: string;
      path: string;
      sha256: string;
      content: string;
    }> = [];
    let cursor: string | undefined;
    do {
      const result = await this.canonical.listMemories({
        memoryStoreId,
        pageSize: 20,
        projection: "full",
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (result.type !== "page") {
        throw new Error(`Managed Memory Store ${memoryStoreId} could not be rebased: ${result.type}`);
      }
      for (const item of result.page.items) {
        if (item.kind !== "memory") continue;
        if (item.content === undefined) {
          throw new Error(`Managed Memory ${item.id} omitted content during rebase`);
        }
        memories.push({
          id: item.id,
          path: item.path,
          sha256: item.contentSha256,
          content: item.content ?? "",
        });
      }
      cursor = result.page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return memories.sort((left, right) => left.path.localeCompare(right.path));
  }
}

function parseManifest(value: string): ManagedMemoryWorkspaceManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Writable Managed Memory baseline is invalid JSON");
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || (parsed as { version?: unknown }).version !== 1
    || !Array.isArray((parsed as { memories?: unknown }).memories)
  ) {
    throw new Error("Writable Managed Memory baseline has an unsupported shape");
  }
  const memories = (parsed as { memories: unknown[] }).memories.map((entry) => {
    if (
      typeof entry !== "object"
      || entry === null
      || typeof (entry as { id?: unknown }).id !== "string"
      || typeof (entry as { path?: unknown }).path !== "string"
      || typeof (entry as { sha256?: unknown }).sha256 !== "string"
    ) {
      throw new Error("Writable Managed Memory baseline contains an invalid entry");
    }
    return entry as ManagedMemoryBaselineEntry;
  });
  uniqueByPath(memories, "baseline");
  return { version: 1, memories };
}

async function sha256Text(value: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  )));
}
