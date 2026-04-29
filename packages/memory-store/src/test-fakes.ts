// In-memory implementations of every port for unit tests. No Cloudflare
// bindings needed — tests just `createInMemoryMemoryStoreService()` and
// drive the service like normal code.
//
// Notes:
//   - InMemoryMemoryRepo enforces UNIQUE(store_id, path) the same way the D1
//     adapter does, so duplicate-path semantics match.
//   - InMemoryBlobStore mimics R2's conditional PUT semantics: If-None-Match: *
//     fails if any object exists at the key; If-Match: <etag> fails if the
//     stored etag doesn't match. Etag is sha256-hex of bytes (vs. R2's MD5)
//     — only the conditional comparison cares; tests should not rely on the
//     specific algorithm.

import {
  generateMemoryId,
} from "@open-managed-agents/shared";
import type {
  BlobMetadata,
  BlobReadResult,
  BlobStore,
  IdGenerator,
  Logger,
  MemoryRepo,
  MemoryStoreRepo,
  MemoryUpdateFields,
  MemoryVersionRepo,
  NewMemoryRow,
  NewMemoryStoreInput,
  NewMemoryVersionInput,
} from "./ports";
import { MemoryStoreService } from "./service";
import type { Actor, MemoryRow, MemoryStoreRow, MemoryVersionRow } from "./types";

export class InMemoryStoreRepo implements MemoryStoreRepo {
  private readonly stores = new Map<string, MemoryStoreRow>();

  /** Test-only escape hatch — exposes the underlying memories map for the
   * companion InMemoryMemoryRepo to consult during deletion cascades. */
  attachMemories(memoryRepo: InMemoryMemoryRepo): void {
    this.memoryRepo = memoryRepo;
  }
  private memoryRepo: InMemoryMemoryRepo | null = null;

  async insert(input: NewMemoryStoreInput): Promise<MemoryStoreRow> {
    const row: MemoryStoreRow = {
      id: input.id,
      tenant_id: input.tenantId,
      name: input.name,
      description: input.description,
      created_at: msToIso(input.createdAt),
      updated_at: null,
      archived_at: null,
    };
    this.stores.set(input.id, row);
    return row;
  }

  async get(tenantId: string, storeId: string): Promise<MemoryStoreRow | null> {
    const row = this.stores.get(storeId);
    return row && row.tenant_id === tenantId ? row : null;
  }

  async list(
    tenantId: string,
    opts: { includeArchived: boolean },
  ): Promise<MemoryStoreRow[]> {
    return Array.from(this.stores.values())
      .filter((r) => r.tenant_id === tenantId)
      .filter((r) => opts.includeArchived || !r.archived_at)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async archive(tenantId: string, storeId: string, archivedAt: number): Promise<MemoryStoreRow> {
    const row = await this.get(tenantId, storeId);
    if (!row) throw new Error("store not found");
    const updated: MemoryStoreRow = {
      ...row,
      archived_at: msToIso(archivedAt),
      updated_at: msToIso(archivedAt),
    };
    this.stores.set(storeId, updated);
    return updated;
  }

  async delete(tenantId: string, storeId: string): Promise<void> {
    if (this.stores.get(storeId)?.tenant_id === tenantId) {
      this.stores.delete(storeId);
      // App-layer cascade — matches D1 adapter's batch DELETE on memory_versions
      // + memories. The schema is no-FK by project convention.
      this.memoryRepo?.deleteByStore(storeId);
    }
  }
}

interface InMemMemory {
  id: string;
  store_id: string;
  path: string;
  content_sha256: string;
  etag: string;
  size_bytes: number;
  created_at: number;
  updated_at: number;
}

export class InMemoryMemoryRepo implements MemoryRepo {
  /** memoryId → row */
  private readonly byId = new Map<string, InMemMemory>();
  /** Versions, kept here for simplicity rather than a separate repo's data. */
  readonly versions: MemoryVersionRow[] = [];

  async createWithVersion(memory: NewMemoryRow, version: NewMemoryVersionInput): Promise<MemoryRow> {
    for (const m of this.byId.values()) {
      if (m.store_id === memory.storeId && m.path === memory.path) {
        throw new Error(`UNIQUE constraint failed: memories.store_id, memories.path`);
      }
    }
    const row: InMemMemory = {
      id: memory.id,
      store_id: memory.storeId,
      path: memory.path,
      content_sha256: memory.contentSha256,
      etag: memory.etag,
      size_bytes: memory.sizeBytes,
      created_at: memory.createdAt,
      updated_at: memory.updatedAt,
    };
    this.byId.set(memory.id, row);
    this.versions.push(toVersionRow(version));
    return toRow(row);
  }

  async updateWithVersion(
    memoryId: string,
    update: MemoryUpdateFields,
    version: NewMemoryVersionInput,
  ): Promise<MemoryRow> {
    const row = this.byId.get(memoryId);
    if (!row) throw new Error("memory not found");
    if (update.path !== undefined) row.path = update.path;
    if (update.contentSha256 !== undefined) row.content_sha256 = update.contentSha256;
    if (update.etag !== undefined) row.etag = update.etag;
    if (update.sizeBytes !== undefined) row.size_bytes = update.sizeBytes;
    row.updated_at = update.updatedAt;
    this.versions.push(toVersionRow(version));
    return toRow(row);
  }

  async deleteWithVersion(memoryId: string, version: NewMemoryVersionInput): Promise<void> {
    this.byId.delete(memoryId);
    this.versions.push(toVersionRow(version));
  }

  async findByPath(storeId: string, path: string): Promise<MemoryRow | null> {
    for (const m of this.byId.values()) {
      if (m.store_id === storeId && m.path === path) return toRow(m);
    }
    return null;
  }

  async findById(storeId: string, memoryId: string): Promise<MemoryRow | null> {
    const row = this.byId.get(memoryId);
    return row && row.store_id === storeId ? toRow(row) : null;
  }

  async list(storeId: string, opts: { pathPrefix?: string }): Promise<MemoryRow[]> {
    return Array.from(this.byId.values())
      .filter((m) => m.store_id === storeId)
      .filter((m) => !opts.pathPrefix || m.path.startsWith(opts.pathPrefix))
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(toRow);
  }

  async upsertFromEvent(input: {
    storeId: string;
    path: string;
    contentSha256: string;
    etag: string;
    sizeBytes: number;
    actor: Actor;
    nowMs: number;
    versionId: string;
    content: string;
    memoryId?: string;
  }): Promise<{ wrote: boolean; row: MemoryRow | null }> {
    const existing = await this.findByPath(input.storeId, input.path);
    if (existing && existing.etag === input.etag) return { wrote: false, row: existing };
    if (existing) {
      const row = await this.updateWithVersion(
        existing.id,
        {
          contentSha256: input.contentSha256,
          etag: input.etag,
          sizeBytes: input.sizeBytes,
          updatedAt: input.nowMs,
        },
        {
          id: input.versionId,
          memoryId: existing.id,
          storeId: input.storeId,
          operation: "modified",
          path: input.path,
          content: input.content,
          contentSha256: input.contentSha256,
          sizeBytes: input.sizeBytes,
          actor: input.actor,
          createdAt: input.nowMs,
        },
      );
      return { wrote: true, row };
    }
    const memoryId = input.memoryId ?? generateMemoryId();
    const row = await this.createWithVersion(
      {
        id: memoryId,
        storeId: input.storeId,
        path: input.path,
        contentSha256: input.contentSha256,
        etag: input.etag,
        sizeBytes: input.sizeBytes,
        createdAt: input.nowMs,
        updatedAt: input.nowMs,
      },
      {
        id: input.versionId,
        memoryId,
        storeId: input.storeId,
        operation: "created",
        path: input.path,
        content: input.content,
        contentSha256: input.contentSha256,
        sizeBytes: input.sizeBytes,
        actor: input.actor,
        createdAt: input.nowMs,
      },
    );
    return { wrote: true, row };
  }

  async deleteFromEvent(input: {
    storeId: string;
    path: string;
    actor: Actor;
    nowMs: number;
    versionId: string;
  }): Promise<{ wrote: boolean }> {
    const existing = await this.findByPath(input.storeId, input.path);
    if (!existing) return { wrote: false };
    await this.deleteWithVersion(existing.id, {
      id: input.versionId,
      memoryId: existing.id,
      storeId: input.storeId,
      operation: "deleted",
      path: input.path,
      content: "",
      contentSha256: existing.content_sha256,
      sizeBytes: existing.size_bytes,
      actor: input.actor,
      createdAt: input.nowMs,
    });
    return { wrote: true };
  }

  // ── helpers used by InMemoryStoreRepo for cascade delete ──
  deleteByStore(storeId: string): void {
    for (const [id, m] of this.byId.entries()) if (m.store_id === storeId) this.byId.delete(id);
    for (let i = this.versions.length - 1; i >= 0; i--) {
      if (this.versions[i].store_id === storeId) this.versions.splice(i, 1);
    }
  }
}

export class InMemoryVersionRepo implements MemoryVersionRepo {
  constructor(private readonly memoryRepo: InMemoryMemoryRepo) {}

  async list(
    storeId: string,
    opts: { memoryId?: string; limit: number },
  ): Promise<MemoryVersionRow[]> {
    return this.memoryRepo.versions
      .filter((v) => v.store_id === storeId)
      .filter((v) => !opts.memoryId || v.memory_id === opts.memoryId)
      // Newest first; id desc as tiebreaker so versions written within the
      // same millisecond come out in the order they were inserted (sequential
      // ids = sequential writes). Without this the redact / rollback /
      // outlive-parent tests are non-deterministic.
      .sort((a, b) => {
        const cmp = b.created_at.localeCompare(a.created_at);
        if (cmp !== 0) return cmp;
        return b.id.localeCompare(a.id);
      })
      .slice(0, opts.limit);
  }

  async get(storeId: string, versionId: string): Promise<MemoryVersionRow | null> {
    return this.memoryRepo.versions.find((v) => v.id === versionId && v.store_id === storeId) ?? null;
  }

  async redact(storeId: string, versionId: string): Promise<MemoryVersionRow> {
    const idx = this.memoryRepo.versions.findIndex(
      (v) => v.id === versionId && v.store_id === storeId,
    );
    if (idx === -1) throw new Error("version not found");
    const v = this.memoryRepo.versions[idx];
    const redacted: MemoryVersionRow = {
      ...v,
      path: null,
      content: null,
      content_sha256: null,
      size_bytes: null,
      redacted: true,
    };
    this.memoryRepo.versions[idx] = redacted;
    return redacted;
  }

  async pruneOlderThan(cutoffMs: number): Promise<number> {
    const cutoffIso = new Date(cutoffMs).toISOString();
    // Index of the latest version per memory_id. Tie-break on id so two
    // versions with the same created_at (same millisecond) pick a deterministic
    // "latest" — matches the same id-desc tiebreaker used by list().
    const latestPerMemory = new Map<string, { id: string; createdAt: string }>();
    for (const v of this.memoryRepo.versions) {
      const cur = latestPerMemory.get(v.memory_id);
      if (
        !cur ||
        v.created_at > cur.createdAt ||
        (v.created_at === cur.createdAt && v.id > cur.id)
      ) {
        latestPerMemory.set(v.memory_id, { id: v.id, createdAt: v.created_at });
      }
    }
    let removed = 0;
    for (let i = this.memoryRepo.versions.length - 1; i >= 0; i--) {
      const v = this.memoryRepo.versions[i];
      if (v.created_at >= cutoffIso) continue;
      if (latestPerMemory.get(v.memory_id)?.id === v.id) continue;
      this.memoryRepo.versions.splice(i, 1);
      removed++;
    }
    return removed;
  }
}

/**
 * In-memory blob store with R2-shaped conditional semantics. Etag is
 * sha256-hex of the bytes, deterministic so tests can compare.
 */
export class InMemoryBlobStore implements BlobStore {
  /** key → { text, etag, size, customMetadata } */
  private readonly objects = new Map<
    string,
    { text: string; etag: string; size: number; customMetadata?: Record<string, string> }
  >();

  async head(key: string): Promise<BlobMetadata | null> {
    const obj = this.objects.get(key);
    return obj ? { etag: obj.etag, size: obj.size } : null;
  }

  async getText(key: string): Promise<BlobReadResult | null> {
    const obj = this.objects.get(key);
    return obj ? { text: obj.text, etag: obj.etag, size: obj.size } : null;
  }

  async put(
    key: string,
    body: string,
    opts?: {
      precondition?: import("./ports").BlobPrecondition;
      actorMetadata?: { actor_type: string; actor_id: string };
    },
  ): Promise<BlobMetadata | null> {
    const existing = this.objects.get(key);
    if (opts?.precondition?.type === "ifNoneMatch") {
      if (existing) return null;
    } else if (opts?.precondition?.type === "ifMatch") {
      if (!existing || existing.etag !== opts.precondition.etag) return null;
    }
    const etag = await sha256HexShort(body);
    const size = new TextEncoder().encode(body).length;
    this.objects.set(key, {
      text: body,
      etag,
      size,
      customMetadata: opts?.actorMetadata
        ? { actor_type: opts.actorMetadata.actor_type, actor_id: opts.actorMetadata.actor_id }
        : undefined,
    });
    return { etag, size };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  // Test-only introspection helpers — not part of BlobStore.
  size(): number { return this.objects.size; }
  has(key: string): boolean { return this.objects.has(key); }
  keys(): string[] { return Array.from(this.objects.keys()); }
}

export class SilentLogger implements Logger {
  warn(): void {}
}

/** Sequential ids — predictable across test runs for stable assertions. */
export class SequentialIdGenerator implements IdGenerator {
  private storeN = 0;
  private memoryN = 0;
  private versionN = 0;
  storeId(): string { return `memstore-${++this.storeN}`; }
  memoryId(): string { return `mem-${++this.memoryN}`; }
  versionId(): string { return `memver-${++this.versionN}`; }
}

/**
 * Convenience factory: full in-memory wiring with sane defaults.
 */
export function createInMemoryMemoryStoreService(opts?: {
  ids?: IdGenerator;
  logger?: Logger;
}): {
  service: MemoryStoreService;
  storeRepo: InMemoryStoreRepo;
  memoryRepo: InMemoryMemoryRepo;
  versionRepo: InMemoryVersionRepo;
  blobs: InMemoryBlobStore;
} {
  const storeRepo = new InMemoryStoreRepo();
  const memoryRepo = new InMemoryMemoryRepo();
  const versionRepo = new InMemoryVersionRepo(memoryRepo);
  storeRepo.attachMemories(memoryRepo);

  const blobs = new InMemoryBlobStore();
  const ids = opts?.ids ?? new SequentialIdGenerator();
  const logger = opts?.logger ?? new SilentLogger();

  const service = new MemoryStoreService({
    storeRepo,
    memoryRepo,
    versionRepo,
    blobs,
    ids,
    logger,
  });
  return { service, storeRepo, memoryRepo, versionRepo, blobs };
}

// ── helpers ──

function toRow(m: InMemMemory): MemoryRow {
  return {
    id: m.id,
    store_id: m.store_id,
    path: m.path,
    content_sha256: m.content_sha256,
    etag: m.etag,
    size_bytes: m.size_bytes,
    created_at: msToIso(m.created_at),
    updated_at: msToIso(m.updated_at),
  };
}

function toVersionRow(v: NewMemoryVersionInput): MemoryVersionRow {
  return {
    id: v.id,
    memory_id: v.memoryId,
    store_id: v.storeId,
    operation: v.operation,
    path: v.path,
    content: v.content,
    content_sha256: v.contentSha256,
    size_bytes: v.sizeBytes,
    actor_type: v.actor.type,
    actor_id: v.actor.id,
    created_at: msToIso(v.createdAt),
    redacted: false,
  };
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}

async function sha256HexShort(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
