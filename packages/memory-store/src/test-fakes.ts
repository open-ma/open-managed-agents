// In-memory implementations of every port for unit tests. No Cloudflare
// bindings needed — tests just `createInMemoryMemoryStoreService()` and
// drive the service like normal code.
//
// Notes:
//   - InMemoryMemoryRepo enforces UNIQUE(store_id, path) the same way the D1
//     adapter does (via UNIQUE constraint), so duplicate-path semantics match.
//   - DeterministicEmbeddingProvider hashes text → fixed-length vector so
//     "search" can deterministically rank exact substrings without depending
//     on an actual embedding model.
//   - InMemoryVectorIndex stores vectors keyed by id and queries via cosine
//     similarity. Supports the metadata filter shape the service uses.

import type {
  EmbeddingProvider,
  IdGenerator,
  Logger,
  MemoryRepo,
  MemoryStoreRepo,
  MemoryUpdateFields,
  MemoryVersionRepo,
  NewMemoryRow,
  NewMemoryStoreInput,
  NewMemoryVersionInput,
  VectorIndex,
  VectorMatch,
  VectorUpsertItem,
} from "./ports";
import { MemoryStoreService } from "./service";
import type { MemoryRow, MemoryStoreRow, MemoryVersionRow } from "./types";

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

  async listMemoryIds(storeId: string): Promise<string[]> {
    return this.memoryRepo?.listIdsByStore(storeId) ?? [];
  }
}

interface InMemMemory {
  id: string;
  store_id: string;
  path: string;
  content: string;
  content_sha256: string;
  size_bytes: number;
  created_at: number;
  updated_at: number;
  vector_synced_at: number | null;
}

export class InMemoryMemoryRepo implements MemoryRepo {
  /** memoryId → row */
  private readonly byId = new Map<string, InMemMemory>();
  /** Versions, kept here for simplicity rather than a separate repo's data. */
  readonly versions: MemoryVersionRow[] = [];

  async createWithVersion(memory: NewMemoryRow, version: NewMemoryVersionInput): Promise<MemoryRow> {
    // UNIQUE(store_id, path) check — match D1's constraint behavior.
    for (const m of this.byId.values()) {
      if (m.store_id === memory.storeId && m.path === memory.path) {
        throw new Error(`UNIQUE constraint failed: memories.store_id, memories.path`);
      }
    }
    const row: InMemMemory = {
      id: memory.id,
      store_id: memory.storeId,
      path: memory.path,
      content: memory.content,
      content_sha256: memory.contentSha256,
      size_bytes: memory.sizeBytes,
      created_at: memory.createdAt,
      updated_at: memory.updatedAt,
      vector_synced_at: null,
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
    if (update.content !== undefined) row.content = update.content;
    if (update.contentSha256 !== undefined) row.content_sha256 = update.contentSha256;
    if (update.sizeBytes !== undefined) row.size_bytes = update.sizeBytes;
    row.updated_at = update.updatedAt;
    if (update.vectorSyncedAt !== "unchanged") row.vector_synced_at = update.vectorSyncedAt;
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

  async markSynced(memoryId: string, syncedAt: number): Promise<void> {
    const row = this.byId.get(memoryId);
    if (row) row.vector_synced_at = syncedAt;
  }

  async markUnsynced(memoryId: string): Promise<void> {
    const row = this.byId.get(memoryId);
    if (row) row.vector_synced_at = null;
  }

  async listUnsynced(opts: {
    tenantId?: string;
    storeId?: string;
    limit: number;
  }): Promise<Array<{ id: string; storeId: string; path: string; content: string }>> {
    // tenantId filter is intentionally not enforced — fakes test the service's
    // logic, not cross-table joins. If a test really cares, configure storeId.
    return Array.from(this.byId.values())
      .filter((m) => m.vector_synced_at === null)
      .filter((m) => !opts.storeId || m.store_id === opts.storeId)
      .slice(0, opts.limit)
      .map((m) => ({ id: m.id, storeId: m.store_id, path: m.path, content: m.content }));
  }

  async countUnsynced(): Promise<number> {
    let n = 0;
    for (const m of this.byId.values()) if (m.vector_synced_at === null) n++;
    return n;
  }

  // ── helpers used by InMemoryStoreRepo for cascade delete ──
  deleteByStore(storeId: string): void {
    for (const [id, m] of this.byId.entries()) if (m.store_id === storeId) this.byId.delete(id);
    // Also drop versions — D1 adapter cascades both in the same batch.
    for (let i = this.versions.length - 1; i >= 0; i--) {
      if (this.versions[i].store_id === storeId) this.versions.splice(i, 1);
    }
  }
  listIdsByStore(storeId: string): string[] {
    const out: string[] = [];
    for (const m of this.byId.values()) if (m.store_id === storeId) out.push(m.id);
    return out;
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
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
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
}

/**
 * Deterministic embedding: hash the text into a fixed-length numeric vector.
 * Two texts with significant token overlap produce vectors with high cosine
 * similarity, so basic semantic-search assertions work.
 */
export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  constructor(private readonly dim: number = 32) {}

  async embed(text: string): Promise<number[] | null> {
    const v = new Array(this.dim).fill(0);
    // Token-frequency style projection. Each word increments dim slots based
    // on its character codes. Simple, deterministic, no external libs.
    for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
      const slot = hashStr(word) % this.dim;
      v[slot] += 1;
    }
    // L2 normalize so cosine sim ranges in [-1, 1].
    const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
    return norm === 0 ? v : v.map((x) => x / norm);
  }
}

export class InMemoryVectorIndex implements VectorIndex {
  /** id → { values, metadata } */
  private readonly vectors = new Map<string, { values: number[]; metadata: Record<string, unknown> }>();

  isAvailable(): boolean {
    return true;
  }

  async upsert(items: VectorUpsertItem[]): Promise<void> {
    for (const it of items) {
      this.vectors.set(it.id, { values: it.values, metadata: it.metadata });
    }
  }

  async query(
    values: number[],
    opts: { topK: number; filter?: Record<string, unknown> },
  ): Promise<VectorMatch[]> {
    const ranked: VectorMatch[] = [];
    for (const [id, v] of this.vectors.entries()) {
      if (opts.filter) {
        let match = true;
        for (const [k, expected] of Object.entries(opts.filter)) {
          if (v.metadata[k] !== expected) {
            match = false;
            break;
          }
        }
        if (!match) continue;
      }
      ranked.push({ id, score: cosineSim(values, v.values), metadata: v.metadata, values: v.values });
    }
    ranked.sort((a, b) => b.score - a.score);
    return ranked.slice(0, opts.topK);
  }

  async deleteByIds(ids: string[]): Promise<void> {
    for (const id of ids) this.vectors.delete(id);
  }

  async getById(id: string): Promise<{ id: string; values: number[]; metadata?: Record<string, unknown> } | null> {
    const v = this.vectors.get(id);
    return v ? { id, values: v.values, metadata: v.metadata } : null;
  }

  // Test introspection helpers — not part of VectorIndex.
  size(): number { return this.vectors.size; }
  has(id: string): boolean { return this.vectors.has(id); }
}

/** A vector index that fails every operation — for testing the service's
 * "Vectorize down → write still succeeds, vector_synced_at stays NULL" path. */
export class FailingVectorIndex implements VectorIndex {
  isAvailable(): boolean { return true; }
  async upsert(): Promise<void> { throw new Error("vector index unavailable"); }
  async query(): Promise<VectorMatch[]> { throw new Error("vector index unavailable"); }
  async deleteByIds(): Promise<void> { throw new Error("vector index unavailable"); }
  async getById(): Promise<null> { throw new Error("vector index unavailable"); }
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
 * Convenience factory: full in-memory wiring with sane defaults. Tests can
 * still pass overrides for any port to inject failure modes (FailingVectorIndex,
 * a stubbed embedding provider, a ManualClock, etc.).
 */
export function createInMemoryMemoryStoreService(opts?: {
  embedding?: EmbeddingProvider;
  vectorIndex?: VectorIndex;
  ids?: IdGenerator;
  logger?: Logger;
}): {
  service: MemoryStoreService;
  storeRepo: InMemoryStoreRepo;
  memoryRepo: InMemoryMemoryRepo;
  versionRepo: InMemoryVersionRepo;
  vectorIndex: VectorIndex;
  embedding: EmbeddingProvider;
} {
  const storeRepo = new InMemoryStoreRepo();
  const memoryRepo = new InMemoryMemoryRepo();
  const versionRepo = new InMemoryVersionRepo(memoryRepo);
  storeRepo.attachMemories(memoryRepo);

  const embedding = opts?.embedding ?? new DeterministicEmbeddingProvider();
  const vectorIndex = opts?.vectorIndex ?? new InMemoryVectorIndex();
  const ids = opts?.ids ?? new SequentialIdGenerator();
  const logger = opts?.logger ?? new SilentLogger();

  const service = new MemoryStoreService({
    storeRepo,
    memoryRepo,
    versionRepo,
    embedding,
    vectorIndex,
    ids,
    logger,
  });
  return { service, storeRepo, memoryRepo, versionRepo, vectorIndex, embedding };
}

// ── helpers ──

function hashStr(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return Math.abs(h | 0);
}

function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function toRow(m: InMemMemory): MemoryRow {
  return {
    id: m.id,
    store_id: m.store_id,
    path: m.path,
    content: m.content,
    content_sha256: m.content_sha256,
    size_bytes: m.size_bytes,
    created_at: msToIso(m.created_at),
    updated_at: msToIso(m.updated_at),
    vector_synced_at: m.vector_synced_at ? msToIso(m.vector_synced_at) : null,
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
