import {
  generateMemoryId,
  generateMemoryStoreId,
  generateMemoryVersionId,
} from "@open-managed-agents/shared";
import {
  MemoryBlobStoreError,
  MemoryContentTooLargeError,
  MemoryNotFoundError,
  MemoryPreconditionFailedError,
  MemoryStoreNotFoundError,
} from "./errors";
import type {
  BlobStore,
  Clock,
  IdGenerator,
  Logger,
  MemoryRepo,
  MemoryStoreRepo,
  MemoryVersionRepo,
} from "./ports";
import {
  Actor,
  MEMORY_CONTENT_MAX_BYTES,
  MemoryRow,
  MemoryStoreRow,
  MemoryVersionRow,
  WritePrecondition,
} from "./types";

export interface MemoryStoreServiceDeps {
  storeRepo: MemoryStoreRepo;
  memoryRepo: MemoryRepo;
  versionRepo: MemoryVersionRepo;
  blobs: BlobStore;
  clock?: Clock;
  ids?: IdGenerator;
  logger?: Logger;
}

/**
 * MemoryStoreService — Anthropic Managed Agents Memory contract over Cloudflare.
 *
 * Architecture (https://platform.claude.com/docs/en/managed-agents/memory):
 *   - R2 is the bytes-of-truth. Object key = `<store_id>/<memory_path>`.
 *   - D1 holds: store metadata (`memory_stores`), index (`memories`, no content
 *     column), and audit (`memory_versions`, content inline up to 100KB).
 *   - Agent reads/writes /mnt/memory/<store>/ via standard file tools (no memory_*
 *     tools). Sandbox mounts the bucket per-session with a `prefix` scope.
 *   - REST API writes (this service) take both paths atomically: R2 PUT first,
 *     then D1 batch [memory index UPSERT, memory_versions INSERT]. Writes from
 *     agent FUSE (which bypass the service) are reconciled into D1 via R2 Event
 *     Notifications → Queue → Consumer (apps/main/src/queue/memory-events.ts).
 *
 * Atomicity:
 *   - R2 single-key PUT is atomic. Conditional PUT (etag match / etag absent)
 *     gives us CAS for both create-only and update-with-precondition semantics.
 *   - The (R2 PUT, D1 batch) pair is NOT a distributed transaction. If we crash
 *     between them, R2 has the bytes and D1 missed the version row. The R2-event
 *     queue consumer fills the gap, deduped by (store_id, path, etag). Worst
 *     case: brief window where REST-API readers see stale list metadata.
 *
 * Rollback:
 *   - Emergent. Caller does `getVersion(v) → updateById/writeByPath(v.content)`.
 *     Per Anthropic doc: "There is no dedicated restore endpoint."
 *
 * Redact:
 *   - Refuses live head: a version whose `content_sha256` matches the live
 *     memory's current `content_sha256` cannot be redacted. Caller must write
 *     a new version first (or delete the memory) before redacting prior history.
 *
 * Out of scope (vs. the previous implementation):
 *   - No semantic search / embeddings / Vectorize. Anthropic's spec does not
 *     ship one and the prior gold-plated layer is removed in this rewrite.
 *   - No reconciler. Vector sync is no longer a concept.
 */
export class MemoryStoreService {
  private readonly storeRepo: MemoryStoreRepo;
  private readonly memoryRepo: MemoryRepo;
  private readonly versionRepo: MemoryVersionRepo;
  private readonly blobs: BlobStore;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly logger: Logger;

  constructor(deps: MemoryStoreServiceDeps) {
    this.storeRepo = deps.storeRepo;
    this.memoryRepo = deps.memoryRepo;
    this.versionRepo = deps.versionRepo;
    this.blobs = deps.blobs;
    this.clock = deps.clock ?? defaultClock;
    this.ids = deps.ids ?? defaultIds();
    this.logger = deps.logger ?? consoleLogger;
  }

  // ============================================================
  // Stores
  // ============================================================

  async createStore(opts: {
    tenantId: string;
    name: string;
    description?: string;
  }): Promise<MemoryStoreRow> {
    assertValidStoreName(opts.name);
    return this.storeRepo.insert({
      id: this.ids.storeId(),
      tenantId: opts.tenantId,
      name: opts.name,
      description: opts.description ?? null,
      createdAt: this.clock.nowMs(),
    });
  }

  async getStore(opts: { tenantId: string; storeId: string }): Promise<MemoryStoreRow | null> {
    return this.storeRepo.get(opts.tenantId, opts.storeId);
  }

  async listStores(opts: {
    tenantId: string;
    includeArchived?: boolean;
  }): Promise<MemoryStoreRow[]> {
    return this.storeRepo.list(opts.tenantId, { includeArchived: !!opts.includeArchived });
  }

  /**
   * Update mutable fields on a store. Only `name` and `description` are
   * editable today; `id`, `tenant_id`, `created_at`, `archived_at` stay
   * immutable. `description: null` clears the field. `name` validation
   * mirrors createStore.
   */
  async updateStore(opts: {
    tenantId: string;
    storeId: string;
    name?: string;
    description?: string | null;
  }): Promise<MemoryStoreRow> {
    await this.requireStore(opts);
    if (opts.name !== undefined) assertValidStoreName(opts.name);
    return this.storeRepo.update(opts.tenantId, opts.storeId, {
      name: opts.name,
      description: opts.description,
      updatedAt: this.clock.nowMs(),
    });
  }

  async archiveStore(opts: { tenantId: string; storeId: string }): Promise<MemoryStoreRow> {
    await this.requireStore(opts);
    return this.storeRepo.archive(opts.tenantId, opts.storeId, this.clock.nowMs());
  }

  /**
   * Delete the store and all its memories + versions. Best-effort R2 cleanup —
   * list R2 objects under the prefix and delete them; failure leaves orphans
   * (eventual lifecycle GC will catch them). D1 cascade is via adapter batch.
   */
  async deleteStore(opts: { tenantId: string; storeId: string }): Promise<void> {
    await this.requireStore(opts);
    // Best-effort R2 cleanup: scan and delete. 100KB cap × few thousand keys
    // is bounded; LIST iterates with cursors. We don't fail the store delete
    // if R2 cleanup hiccups — orphans are recoverable, missing the audit isn't.
    try {
      const memos = await this.memoryRepo.list(opts.storeId, {});
      for (const m of memos) {
        try {
          await this.blobs.delete(r2Key(opts.storeId, m.path));
        } catch (err) {
          this.logger.warn("R2 delete failed during store delete (orphan left)", {
            store_id: opts.storeId,
            path: m.path,
            err: errToString(err),
          });
        }
      }
    } catch (err) {
      this.logger.warn("R2 cleanup pre-scan failed during store delete", {
        store_id: opts.storeId,
        err: errToString(err),
      });
    }
    await this.storeRepo.delete(opts.tenantId, opts.storeId);
  }

  // ============================================================
  // Memories — write paths (REST API actor; agent FUSE writes go through queue)
  // ============================================================

  /**
   * Upsert by path. Creates or overwrites the memory at `path`.
   *
   * Steps:
   *   1. Validate (size, store exists, precondition).
   *   2. R2 conditional PUT:
   *      - precondition: not_exists       → If-None-Match: *
   *      - precondition: content_sha256   → If-Match: <existing etag from D1>
   *      - no precondition + new path     → If-None-Match: *  (defensive)
   *      - no precondition + existing     → unconditional PUT
   *   3. D1 batch [INSERT/UPDATE memories index, INSERT memory_versions] atomically.
   */
  async writeByPath(opts: {
    tenantId: string;
    storeId: string;
    path: string;
    content: string;
    precondition?: WritePrecondition;
    actor: Actor;
  }): Promise<MemoryRow> {
    await this.requireStore(opts);
    assertValidMemoryPath(opts.path);
    this.assertContentSize(opts.content);

    const existing = await this.memoryRepo.findByPath(opts.storeId, opts.path);

    // App-layer precondition checks before R2 to give clean error semantics.
    // R2's conditional PUT is the actual atomicity barrier.
    if (opts.precondition?.type === "not_exists" && existing) {
      throw new MemoryPreconditionFailedError("memory exists at path");
    }
    if (
      opts.precondition?.type === "content_sha256" &&
      existing &&
      existing.content_sha256 !== opts.precondition.content_sha256
    ) {
      throw new MemoryPreconditionFailedError("content_sha256 mismatch");
    }

    const sha = await sha256Hex(opts.content);
    const sizeBytes = byteLength(opts.content);
    const key = r2Key(opts.storeId, opts.path);

    let blob;
    try {
      blob = await this.blobs.put(key, opts.content, {
        precondition: existing
          ? { type: "ifMatch", etag: existing.etag }
          : { type: "ifNoneMatch", value: "*" },
        actorMetadata: { actor_type: opts.actor.type, actor_id: opts.actor.id },
      });
    } catch (err) {
      throw new MemoryBlobStoreError(err);
    }
    if (!blob) {
      // R2 precondition failed — someone wrote between our D1 read and the PUT.
      throw new MemoryPreconditionFailedError(
        existing ? "concurrent write detected (etag mismatch)" : "memory exists at path",
      );
    }

    const now = this.clock.nowMs();
    let mem: MemoryRow;
    if (existing) {
      mem = await this.memoryRepo.updateWithVersion(
        existing.id,
        {
          contentSha256: sha,
          etag: blob.etag,
          sizeBytes,
          updatedAt: now,
        },
        {
          id: this.ids.versionId(),
          memoryId: existing.id,
          storeId: opts.storeId,
          operation: "modified",
          path: opts.path,
          content: opts.content,
          contentSha256: sha,
          sizeBytes,
          actor: opts.actor,
          createdAt: now,
        },
      );
    } else {
      const memoryId = this.ids.memoryId();
      mem = await this.memoryRepo.createWithVersion(
        {
          id: memoryId,
          storeId: opts.storeId,
          path: opts.path,
          contentSha256: sha,
          etag: blob.etag,
          sizeBytes,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: this.ids.versionId(),
          memoryId,
          storeId: opts.storeId,
          operation: "created",
          path: opts.path,
          content: opts.content,
          contentSha256: sha,
          sizeBytes,
          actor: opts.actor,
          createdAt: now,
        },
      );
    }

    // Hand back the row with content filled (caller just provided it).
    return { ...mem, content: opts.content };
  }

  /** Mutate by ID — supports rename (path change) and content edit. */
  async updateById(opts: {
    tenantId: string;
    storeId: string;
    memoryId: string;
    path?: string;
    content?: string;
    precondition?: WritePrecondition;
    actor: Actor;
  }): Promise<MemoryRow> {
    await this.requireStore(opts);
    const existing = await this.requireMemory(opts.storeId, opts.memoryId);

    if (opts.content !== undefined) this.assertContentSize(opts.content);
    if (opts.path !== undefined) assertValidMemoryPath(opts.path);

    if (opts.precondition?.type === "content_sha256") {
      if (existing.content_sha256 !== opts.precondition.content_sha256) {
        throw new MemoryPreconditionFailedError("content_sha256 mismatch");
      }
    }
    if (opts.precondition?.type === "not_exists" && opts.path) {
      const conflict = await this.memoryRepo.findByPath(opts.storeId, opts.path);
      if (conflict && conflict.id !== opts.memoryId) {
        throw new MemoryPreconditionFailedError("path occupied");
      }
    }

    const newPath = opts.path ?? existing.path;
    const pathChanged = opts.path !== undefined && opts.path !== existing.path;
    const contentChanged = opts.content !== undefined;
    if (!pathChanged && !contentChanged) return { ...existing };

    let newContent: string;
    let newSha: string;
    let newSize: number;
    let newEtag: string;

    if (contentChanged) {
      newContent = opts.content!;
      newSha = await sha256Hex(newContent);
      newSize = byteLength(newContent);

      // Write content to (possibly new) R2 key with CAS protection on the
      // existing key's etag. If path is also changing, we PUT the new key
      // create-only then DELETE the old key.
      const targetKey = r2Key(opts.storeId, newPath);
      const oldKey = r2Key(opts.storeId, existing.path);

      let blob;
      try {
        if (pathChanged) {
          blob = await this.blobs.put(targetKey, newContent, {
            precondition: { type: "ifNoneMatch", value: "*" },
            actorMetadata: { actor_type: opts.actor.type, actor_id: opts.actor.id },
          });
        } else {
          blob = await this.blobs.put(targetKey, newContent, {
            precondition: { type: "ifMatch", etag: existing.etag },
            actorMetadata: { actor_type: opts.actor.type, actor_id: opts.actor.id },
          });
        }
      } catch (err) {
        throw new MemoryBlobStoreError(err);
      }
      if (!blob) {
        throw new MemoryPreconditionFailedError(
          pathChanged ? "target path occupied" : "concurrent write detected (etag mismatch)",
        );
      }
      newEtag = blob.etag;

      if (pathChanged) {
        // Best-effort: drop the old object after the new one is committed.
        // If this fails the audit row still records the rename; an orphan R2
        // object remains until the next store-delete or a manual cleanup.
        try {
          await this.blobs.delete(oldKey);
        } catch (err) {
          this.logger.warn("R2 delete of old key after rename failed", {
            store_id: opts.storeId,
            old_path: existing.path,
            err: errToString(err),
          });
        }
      }
    } else {
      // Pure rename: copy content to the new R2 key, delete the old.
      const blob0 = await this.blobs.getText(r2Key(opts.storeId, existing.path));
      if (!blob0) {
        // R2 doesn't have it — nothing to copy. Index is lying or recently
        // deleted. Treat as not-found.
        throw new MemoryNotFoundError("memory content missing in blob store");
      }
      newContent = blob0.text;
      newSha = existing.content_sha256;
      newSize = existing.size_bytes;

      let blob;
      try {
        blob = await this.blobs.put(r2Key(opts.storeId, newPath), newContent, {
          precondition: { type: "ifNoneMatch", value: "*" },
          actorMetadata: { actor_type: opts.actor.type, actor_id: opts.actor.id },
        });
      } catch (err) {
        throw new MemoryBlobStoreError(err);
      }
      if (!blob) throw new MemoryPreconditionFailedError("target path occupied");
      newEtag = blob.etag;
      try {
        await this.blobs.delete(r2Key(opts.storeId, existing.path));
      } catch (err) {
        this.logger.warn("R2 delete of old key after rename failed", {
          store_id: opts.storeId,
          old_path: existing.path,
          err: errToString(err),
        });
      }
    }

    const now = this.clock.nowMs();
    const mem = await this.memoryRepo.updateWithVersion(
      opts.memoryId,
      {
        path: newPath,
        contentSha256: newSha,
        etag: newEtag,
        sizeBytes: newSize,
        updatedAt: now,
      },
      {
        id: this.ids.versionId(),
        memoryId: opts.memoryId,
        storeId: opts.storeId,
        operation: "modified",
        path: newPath,
        content: newContent,
        contentSha256: newSha,
        sizeBytes: newSize,
        actor: opts.actor,
        createdAt: now,
      },
    );

    return { ...mem, content: newContent };
  }

  /** Delete by ID. R2 DELETE first; then D1 batch (index drop + version row). */
  async deleteById(opts: {
    tenantId: string;
    storeId: string;
    memoryId: string;
    expectedSha?: string;
    actor: Actor;
  }): Promise<void> {
    await this.requireStore(opts);
    const existing = await this.requireMemory(opts.storeId, opts.memoryId);
    if (opts.expectedSha && existing.content_sha256 !== opts.expectedSha) {
      throw new MemoryPreconditionFailedError("content_sha256 mismatch");
    }

    // Snapshot content for the version row before R2 delete.
    const snapshot = await this.blobs.getText(r2Key(opts.storeId, existing.path));
    const snapshotContent = snapshot?.text ?? "";

    try {
      await this.blobs.delete(r2Key(opts.storeId, existing.path));
    } catch (err) {
      throw new MemoryBlobStoreError(err);
    }

    const now = this.clock.nowMs();
    await this.memoryRepo.deleteWithVersion(opts.memoryId, {
      id: this.ids.versionId(),
      memoryId: opts.memoryId,
      storeId: opts.storeId,
      operation: "deleted",
      path: existing.path,
      content: snapshotContent,
      contentSha256: existing.content_sha256,
      sizeBytes: existing.size_bytes,
      actor: opts.actor,
      createdAt: now,
    });
  }

  // ============================================================
  // Memories — read paths
  // ============================================================

  async listMemories(opts: {
    tenantId: string;
    storeId: string;
    pathPrefix?: string;
  }): Promise<MemoryRow[]> {
    await this.requireStore(opts);
    return this.memoryRepo.list(opts.storeId, { pathPrefix: opts.pathPrefix });
  }

  /** Single read by path — fills `content` from R2. */
  async readByPath(opts: {
    tenantId: string;
    storeId: string;
    path: string;
  }): Promise<MemoryRow | null> {
    await this.requireStore(opts);
    const row = await this.memoryRepo.findByPath(opts.storeId, opts.path);
    if (!row) return null;
    const blob = await this.blobs.getText(r2Key(opts.storeId, row.path));
    return { ...row, content: blob?.text ?? "" };
  }

  /** Single read by id — fills `content` from R2. */
  async readById(opts: {
    tenantId: string;
    storeId: string;
    memoryId: string;
  }): Promise<MemoryRow | null> {
    await this.requireStore(opts);
    const row = await this.memoryRepo.findById(opts.storeId, opts.memoryId);
    if (!row) return null;
    const blob = await this.blobs.getText(r2Key(opts.storeId, row.path));
    return { ...row, content: blob?.text ?? "" };
  }

  // ============================================================
  // Versions
  // ============================================================

  async listVersions(opts: {
    tenantId: string;
    storeId: string;
    memoryId?: string;
    limit?: number;
  }): Promise<MemoryVersionRow[]> {
    await this.requireStore(opts);
    return this.versionRepo.list(opts.storeId, {
      memoryId: opts.memoryId,
      limit: Math.min(opts.limit ?? 100, 500),
    });
  }

  async getVersion(opts: {
    tenantId: string;
    storeId: string;
    versionId: string;
  }): Promise<MemoryVersionRow | null> {
    await this.requireStore(opts);
    return this.versionRepo.get(opts.storeId, opts.versionId);
  }

  /**
   * Redact a prior version's content. Per Anthropic spec:
   *   "A version that is the current head of a live memory cannot be redacted.
   *    Write a new version first (or delete the memory), then redact the old one."
   *
   * "Live head" = a version whose content_sha256 equals the live memory's current
   * content_sha256. We check by looking up the memory at the version's
   * memory_id and comparing sha256s.
   */
  async redactVersion(opts: {
    tenantId: string;
    storeId: string;
    versionId: string;
  }): Promise<MemoryVersionRow> {
    await this.requireStore(opts);
    const version = await this.versionRepo.get(opts.storeId, opts.versionId);
    if (!version) throw new MemoryNotFoundError("Memory version not found");

    // If the parent memory still exists and its current sha256 matches this
    // version, the version IS the live head — refuse.
    const liveMemory = await this.memoryRepo.findById(opts.storeId, version.memory_id);
    if (
      liveMemory &&
      version.content_sha256 !== null &&
      liveMemory.content_sha256 === version.content_sha256
    ) {
      throw new MemoryPreconditionFailedError(
        "cannot redact the current head of a live memory; write a new version first",
      );
    }
    return this.versionRepo.redact(opts.storeId, opts.versionId);
  }

  // ============================================================
  // Internals
  // ============================================================

  private async requireStore(opts: { tenantId: string; storeId: string }): Promise<MemoryStoreRow> {
    const row = await this.storeRepo.get(opts.tenantId, opts.storeId);
    if (!row) throw new MemoryStoreNotFoundError();
    return row;
  }

  private async requireMemory(storeId: string, memoryId: string): Promise<MemoryRow> {
    const row = await this.memoryRepo.findById(storeId, memoryId);
    if (!row) throw new MemoryNotFoundError();
    return row;
  }

  private assertContentSize(content: string): void {
    if (byteLength(content) > MEMORY_CONTENT_MAX_BYTES) {
      throw new MemoryContentTooLargeError(MEMORY_CONTENT_MAX_BYTES);
    }
  }

  // ============================================================
  // Maintenance
  // ============================================================

  /**
   * Prune memory_versions rows older than `cutoffMs`, except always keep
   * the most recent version per memory_id (Anthropic spec). Returns the
   * count of rows deleted, or -1 if the underlying repo can't report it.
   *
   * Cross-tenant: does NOT take a tenantId — runs over the entire shard.
   * Callers needing cross-shard fan-out use forEachShardServices in the
   * services package.
   */
  async pruneVersionsOlderThan(cutoffMs: number): Promise<number> {
    return this.versionRepo.pruneOlderThan(cutoffMs);
  }
}

// ============================================================
// Default infra (used when callers don't override)
// ============================================================

const defaultClock: Clock = { nowMs: () => Date.now() };

const defaultIdGenerator: IdGenerator = {
  storeId: generateMemoryStoreId,
  memoryId: generateMemoryId,
  versionId: generateMemoryVersionId,
};

function defaultIds(): IdGenerator {
  return defaultIdGenerator;
}

const consoleLogger: Logger = {
  warn: (msg, ctx) => console.warn(msg, ctx),
};

// ============================================================
// utilities (exported for adapters/queue consumer reuse)
// ============================================================

/**
 * Compute the R2 object key for a memory. Anthropic paths typically lead with
 * "/" (e.g. "/preferences/formatting.md"). We strip a leading "/" before
 * concatenating to avoid R2 keys with double slashes that confuse `list`.
 */
export function r2Key(storeId: string, memoryPath: string): string {
  const p = memoryPath.startsWith("/") ? memoryPath.slice(1) : memoryPath;
  return `${storeId}/${p}`;
}

/** Reverse of `r2Key`. Returns null if the key isn't <store_id>/<path>. */
export function parseR2Key(key: string): { storeId: string; memoryPath: string } | null {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) return null;
  return {
    storeId: key.slice(0, slash),
    memoryPath: "/" + key.slice(slash + 1),
  };
}

export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function errToString(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Validate a store name. Anthropic mounts as `/mnt/memory/<name>/` literally
 * (spaces allowed) so we accept anything except chars that would break a
 * filesystem path: forward slash, NUL, and control chars.
 */
function assertValidStoreName(name: string): void {
  if (!name || name.length === 0) {
    throw new Error("memory store name cannot be empty");
  }
  if (name.length > 255) {
    throw new Error("memory store name too long (>255 chars)");
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f/\\]/.test(name)) {
    throw new Error("memory store name contains forbidden characters");
  }
}

/**
 * Validate a memory path. Anthropic paths are forward-slash separated and
 * typically start with "/". Reject backslash, NUL, control chars, and
 * relative-traversal segments.
 */
function assertValidMemoryPath(path: string): void {
  if (!path || path.length === 0) {
    throw new Error("memory path cannot be empty");
  }
  if (path.length > 1024) {
    throw new Error("memory path too long (>1024 chars)");
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\\]/.test(path)) {
    throw new Error("memory path contains forbidden characters");
  }
  for (const segment of path.split("/")) {
    if (segment === ".." || segment === ".") {
      throw new Error("memory path cannot contain '.' or '..' segments");
    }
  }
}
