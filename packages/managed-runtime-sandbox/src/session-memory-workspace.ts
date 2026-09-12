import type {
  SessionInputLifecycleContext,
  SessionMemoryAccessPort,
  SessionMemoryDocument,
} from "@open-managed-agents/runtime-resource-contract";

const markerName = ".openma-memory-store";
const manifestVersion = 1;
const deleteSafetyLimit = 50;

export interface SessionMemoryWorkspaceFilePort {
  /** Returns relative text files, or null when the directory is absent/empty. */
  scan(root: string, signal: AbortSignal): Promise<ReadonlyMap<string, string> | null>;
  read(path: string, signal: AbortSignal): Promise<string | null>;
  write(path: string, content: string, signal: AbortSignal): Promise<void>;
  /** Replaces only this directory; callers validate it is a dedicated mount. */
  replace(
    root: string,
    entries: ReadonlyMap<string, string>,
    signal: AbortSignal,
  ): Promise<void>;
}

interface MemoryAttachment {
  memoryStoreId: string;
  mountPath: string;
  access: "read_only" | "read_write";
}

interface BaselineEntry {
  id: string;
  path: string;
  sha256: string;
}

interface MemoryManifest {
  version: 1;
  memoryStoreId: string;
  mountPath: string;
  baseline: BaselineEntry[];
}

/**
 * Provider-neutral Memory Store lifecycle for OpenMA-supervised harnesses.
 * The official AMA worker keeps using the SDK's own SessionMemoryStores and
 * therefore never enters this writer. A durable manifest beside /workspace
 * lets a reclaimed execution reconcile edits left by the previous process.
 */
export class SessionMemoryWorkspaceLifecycle {
  constructor(private readonly files: SessionMemoryWorkspaceFilePort) {}

  async materialize(input: SessionInputLifecycleContext): Promise<void> {
    if (input.resourceOwnership.memoryStore === "worker") return;
    const attachments = memoryAttachments(input);
    if (attachments.length === 0) return;
    const access = requireMemoryAccess(input);
    for (const attachment of attachments) {
      input.signal.throwIfAborted();
      const manifest = await this.readManifest(input, attachment);
      const local = await this.files.scan(attachment.mountPath, input.signal);
      if (
        attachment.access === "read_write"
        && manifest !== null
        && local?.get(markerName) === markerValue(attachment.memoryStoreId)
      ) {
        // Crash/reclaim recovery: reconcile the previous durable workspace
        // before downloading a new baseline, otherwise unsent edits vanish.
        await this.reconcileOne(input, access, attachment, manifest, local);
        continue;
      }
      await this.hydrate(input, access, attachment);
    }
  }

  async synchronize(input: SessionInputLifecycleContext): Promise<void> {
    if (input.resourceOwnership.memoryStore === "worker") return;
    const attachments = memoryAttachments(input);
    if (attachments.length === 0) return;
    const access = requireMemoryAccess(input);
    for (const attachment of attachments) {
      input.signal.throwIfAborted();
      if (attachment.access === "read_only") {
        await this.hydrate(input, access, attachment);
        continue;
      }
      const manifest = await this.readManifest(input, attachment);
      const local = await this.files.scan(attachment.mountPath, input.signal);
      if (
        manifest === null
        || local === null
        || local.get(markerName) !== markerValue(attachment.memoryStoreId)
      ) {
        // Missing/wrong marker means the folder is not trustworthy. Re-pull;
        // never interpret an accidental whole-folder wipe as mass deletion.
        await this.hydrate(input, access, attachment);
        continue;
      }
      await this.reconcileOne(input, access, attachment, manifest, local);
    }
  }

  private async reconcileOne(
    input: SessionInputLifecycleContext,
    access: SessionMemoryAccessPort,
    attachment: MemoryAttachment,
    manifest: MemoryManifest,
    scanned: ReadonlyMap<string, string>,
  ): Promise<void> {
    const baseline = new Map(manifest.baseline.map((item) => [item.path, item]));
    const local = new Map<string, { content: string; sha256: string }>();
    for (const [relative, content] of scanned) {
      if (relative === markerName) continue;
      const path = wirePath(relative);
      local.set(path, { content, sha256: await sha256(content) });
    }
    const remote = byPath(await access.list({
      memoryStoreId: attachment.memoryStoreId,
      projection: "full",
      signal: input.signal,
    }), true);
    const deleteCandidates = [...baseline.values()].filter((base) => {
      const current = remote.get(base.path);
      return !local.has(base.path)
        && current !== undefined
        && current.contentSha256 === base.sha256;
    });
    if (deleteCandidates.length > deleteSafetyLimit) {
      throw new Error(
        `Session Memory deletion safety limit exceeded (${deleteCandidates.length})`,
      );
    }

    // Upserts precede deletes so a rename never destroys the only canonical
    // copy before the new path exists.
    for (const [path, localEntry] of [...local].sort(([a], [b]) => a.localeCompare(b))) {
      input.signal.throwIfAborted();
      const base = baseline.get(path);
      const current = remote.get(path);
      if (current === undefined) {
        if (base !== undefined && localEntry.sha256 === base.sha256) {
          // Deleted only remotely: the canonical deletion wins.
          continue;
        }
        await authorizeMutation(input);
        await access.create({
          memoryStoreId: attachment.memoryStoreId,
          path,
          content: localEntry.content,
          signal: input.signal,
        });
        continue;
      }
      if (current.contentSha256 === localEntry.sha256) continue;
      if (
        base === undefined
        || current.contentSha256 !== base.sha256
        || localEntry.sha256 === base.sha256
      ) {
        // New-path collision, two-sided change, or remote-only change: the
        // canonical state wins and is pulled during the rebase below.
        continue;
      }
      await authorizeMutation(input);
      await access.update({
        memoryStoreId: attachment.memoryStoreId,
        memoryId: current.id,
        path,
        content: localEntry.content,
        expectedContentSha256: base.sha256,
        signal: input.signal,
      });
    }

    for (const base of deleteCandidates.sort((a, b) => a.path.localeCompare(b.path))) {
      input.signal.throwIfAborted();
      const current = remote.get(base.path)!;
      // One scan-level marker check plus one immediate pre-delete re-check
      // bounds the accidental-wipe window without trusting harness content.
      if (
        await this.files.read(`${attachment.mountPath}/${markerName}`, input.signal)
        !== markerValue(attachment.memoryStoreId)
      ) {
        throw new Error("Session Memory marker changed during synchronization");
      }
      await authorizeMutation(input);
      await access.delete({
        memoryStoreId: attachment.memoryStoreId,
        memoryId: current.id,
        expectedContentSha256: base.sha256,
        signal: input.signal,
      });
    }

    // Re-list makes conflict/not-found responses idempotent: regardless of a
    // concurrent winner or a retry after partial success, disk and baseline
    // advance to exactly the current canonical state.
    await this.hydrate(input, access, attachment);
  }

  private async hydrate(
    input: SessionInputLifecycleContext,
    access: SessionMemoryAccessPort,
    attachment: MemoryAttachment,
  ): Promise<void> {
    const canonical = byPath(await access.list({
      memoryStoreId: attachment.memoryStoreId,
      projection: "full",
      signal: input.signal,
    }), true);
    const entries = new Map<string, string>([
      [markerName, markerValue(attachment.memoryStoreId)],
    ]);
    const baseline: BaselineEntry[] = [];
    for (const memory of [...canonical.values()].sort((a, b) => a.path.localeCompare(b.path))) {
      const relative = relativeMemoryPath(memory.path);
      if (relative === markerName) {
        throw new Error(`Session Memory path ${memory.path} is reserved`);
      }
      entries.set(relative, memory.content!);
      baseline.push({ id: memory.id, path: memory.path, sha256: memory.contentSha256 });
    }
    await this.files.replace(attachment.mountPath, entries, input.signal);
    const manifest: MemoryManifest = {
      version: manifestVersion,
      memoryStoreId: attachment.memoryStoreId,
      mountPath: attachment.mountPath,
      baseline,
    };
    // The baseline advances last. A crash before this write safely retries
    // against the old ancestor; a crash after it has a complete rebase.
    await this.files.write(
      manifestPath(input, attachment),
      JSON.stringify(manifest),
      input.signal,
    );
  }

  private async readManifest(
    input: SessionInputLifecycleContext,
    attachment: MemoryAttachment,
  ): Promise<MemoryManifest | null> {
    const raw = await this.files.read(manifestPath(input, attachment), input.signal);
    if (raw === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
    if (
      typeof value !== "object"
      || value === null
      || (value as { version?: unknown }).version !== manifestVersion
      || (value as { memoryStoreId?: unknown }).memoryStoreId !== attachment.memoryStoreId
      || (value as { mountPath?: unknown }).mountPath !== attachment.mountPath
      || !Array.isArray((value as { baseline?: unknown }).baseline)
    ) return null;
    const baseline: BaselineEntry[] = [];
    for (const item of (value as { baseline: unknown[] }).baseline) {
      if (
        typeof item !== "object"
        || item === null
        || typeof (item as { id?: unknown }).id !== "string"
        || typeof (item as { path?: unknown }).path !== "string"
        || typeof (item as { sha256?: unknown }).sha256 !== "string"
      ) return null;
      const entry = item as BaselineEntry;
      try {
        relativeMemoryPath(entry.path);
      } catch {
        return null;
      }
      baseline.push(entry);
    }
    if (new Set(baseline.map(({ path }) => path)).size !== baseline.length) return null;
    return { version: 1, memoryStoreId: attachment.memoryStoreId, mountPath: attachment.mountPath, baseline };
  }
}

function requireMemoryAccess(input: SessionInputLifecycleContext): SessionMemoryAccessPort {
  const access = input.access?.memories;
  if (access === undefined) {
    throw new Error("Session Memory materialization requires per-claim Memory access");
  }
  return access;
}

function memoryAttachments(input: SessionInputLifecycleContext): MemoryAttachment[] {
  return input.session.resources
    .filter((resource) => resource.type === "memory_store")
    .map((resource) => {
      const memoryStoreId = requiredString(resource, "memory_store_id");
      const mountPath = dedicatedMountPath(resource);
      const access = resource.access === "read_only" ? "read_only" : "read_write";
      return { memoryStoreId, mountPath, access };
    });
}

function dedicatedMountPath(resource: Readonly<Record<string, unknown>>): string {
  const path = requiredString(resource, "mount_path").replace(/\/+$/u, "");
  if (
    path === ""
    || path === "/"
    || path === "/workspace"
    || !path.startsWith("/")
    || path.split("/").includes("..")
    || path.includes("\0")
    || pathsOverlap(path, "/workspace/.openma/session-inputs")
  ) {
    throw new Error("Session Memory mount_path must be a dedicated safe absolute directory");
  }
  return path;
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function requiredString(resource: Readonly<Record<string, unknown>>, field: string): string {
  const value = resource[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Session ${resource.type} resource requires ${field}`);
  }
  return value;
}

function manifestPath(
  input: SessionInputLifecycleContext,
  attachment: MemoryAttachment,
): string {
  return `/workspace/.openma/session-inputs/${safeSegment(input.session.id)}/memory/${safeSegment(attachment.memoryStoreId)}.json`;
}

function safeSegment(value: string): string {
  if (value.length === 0 || value === "." || value === ".." || value.includes("\0")) {
    throw new Error("Session Memory identity is unsafe");
  }
  return encodeURIComponent(value);
}

function markerValue(memoryStoreId: string): string {
  return `openma-memory-store-v1\n${memoryStoreId}`;
}

function wirePath(relative: string): string {
  return `/${relativeMemoryPath(`/${relative}`)}`;
}

function relativeMemoryPath(path: string): string {
  if (!path.startsWith("/") || path.includes("\0")) {
    throw new Error(`Session Memory path ${path} is unsafe`);
  }
  const relative = path.replace(/^\/+/, "");
  if (
    relative.length === 0
    || relative.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Session Memory path ${path} is unsafe`);
  }
  return relative;
}

function byPath(
  memories: readonly SessionMemoryDocument[],
  requireContent: boolean,
): Map<string, SessionMemoryDocument> {
  const result = new Map<string, SessionMemoryDocument>();
  for (const memory of memories) {
    relativeMemoryPath(memory.path);
    if (requireContent && memory.content === undefined) {
      throw new Error(`Session Memory ${memory.id} omitted full content`);
    }
    if (result.has(memory.path)) {
      throw new Error(`Session Memory API returned duplicate path ${memory.path}`);
    }
    result.set(memory.path, memory);
  }
  return result;
}

async function authorizeMutation(input: SessionInputLifecycleContext): Promise<void> {
  input.signal.throwIfAborted();
  if (!await input.authorize()) throw new Error("Session Memory resource fence lost");
  input.signal.throwIfAborted();
}

async function sha256(content: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  )), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
