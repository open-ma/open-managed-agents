import {
  generateMemoryId,
  generateMemoryStoreId,
  generateMemoryVersionId,
} from "@open-managed-agents/shared";
import {
  MemoryContentTooLargeError,
  MemoryEmbeddingFailedError,
  MemoryNotFoundError,
  MemoryPreconditionFailedError,
  MemoryStoreNotFoundError,
} from "./errors";
import type {
  Clock,
  EmbeddingProvider,
  IdGenerator,
  Logger,
  MemoryRepo,
  MemoryStoreRepo,
  MemoryVersionRepo,
  VectorIndex,
} from "./ports";
import {
  Actor,
  MEMORY_CONTENT_MAX_BYTES,
  MemoryRow,
  MemoryStoreRow,
  MemoryVersionRow,
  ReconcileResult,
  SearchHit,
  WritePrecondition,
} from "./types";

export interface MemoryStoreServiceDeps {
  storeRepo: MemoryStoreRepo;
  memoryRepo: MemoryRepo;
  versionRepo: MemoryVersionRepo;
  embedding: EmbeddingProvider;
  vectorIndex: VectorIndex;
  clock?: Clock;
  ids?: IdGenerator;
  logger?: Logger;
}

/**
 * MemoryStoreService — pure business logic over abstract ports.
 *
 * The service contains the consistency rules (D1 is truth, Vectorize is a
 * best-effort side index, write order, atomic memory+version writes,
 * preconditions, content cap, reconciliation strategy) but knows nothing
 * about D1, Workers AI, Vectorize, or any other concrete runtime. All
 * persistence and infrastructure flows through the injected ports.
 *
 * Deployment wiring (tenant ↔ adapter binding) is the caller's job:
 *   - Production: createCfMemoryStoreService(env) — see src/adapters/index.ts
 *   - Tests: createInMemoryMemoryStoreService() — see src/test-fakes.ts
 *
 * Consistency model:
 *   - The persistence repo is the single source of truth. All read paths hit
 *     it directly and are strongly consistent.
 *   - The vector index is a search-time side replica. Each successful write
 *     attempts to maintain it inline; failures only degrade `searchMemories`,
 *     they never fail the canonical write. Memories with NULL vector_synced_at
 *     are picked up by `reconcile()` on demand.
 *   - When the embedding provider returns null (intentionally unconfigured),
 *     the vector index is left untouched and `searchMemories` returns []. This
 *     is the supported "no semantic search" mode for tests/dev.
 */
export class MemoryStoreService {
  private readonly storeRepo: MemoryStoreRepo;
  private readonly memoryRepo: MemoryRepo;
  private readonly versionRepo: MemoryVersionRepo;
  private readonly embedding: EmbeddingProvider;
  private readonly vectorIndex: VectorIndex;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly logger: Logger;

  constructor(deps: MemoryStoreServiceDeps) {
    this.storeRepo = deps.storeRepo;
    this.memoryRepo = deps.memoryRepo;
    this.versionRepo = deps.versionRepo;
    this.embedding = deps.embedding;
    this.vectorIndex = deps.vectorIndex;
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

  async archiveStore(opts: { tenantId: string; storeId: string }): Promise<MemoryStoreRow> {
    await this.requireStore(opts);
    return this.storeRepo.archive(opts.tenantId, opts.storeId, this.clock.nowMs());
  }

  /**
   * Delete the store and all its memories + versions. Best-effort vector
   * cleanup — list all memory IDs, delete them from the index, then drop the
   * D1 rows via adapter-level cascade. Failure to clean the index leaves
   * orphan vectors that search-time D1 join will filter out.
   */
  async deleteStore(opts: { tenantId: string; storeId: string }): Promise<void> {
    await this.requireStore(opts);
    const memIds = await this.storeRepo.listMemoryIds(opts.storeId);
    if (memIds.length > 0 && this.vectorIndex.isAvailable()) {
      try {
        await this.vectorIndex.deleteByIds(memIds.map((id) => vectorKey(opts.storeId, id)));
      } catch (err) {
        this.logger.warn("vector index cleanup failed during store delete", {
          store_id: opts.storeId,
          err: errToString(err),
        });
      }
    }
    await this.storeRepo.delete(opts.tenantId, opts.storeId);
  }

  // ============================================================
  // Memories — write paths
  // ============================================================

  /**
   * Upsert by path. Creates a memory at the path or, if `precondition` allows,
   * overwrites the existing memory at that path.
   *
   * Steps:
   *   1. Validate (size, store exists, precondition)
   *   2. Compute embedding (throws MemoryEmbeddingFailedError on failure — write
   *      is aborted before any state mutation; null = embedding intentionally
   *      disabled, in which case we skip step 4 and leave vector_synced_at NULL)
   *   3. memoryRepo.{create,update}WithVersion — atomic memory + version
   *   4. vectorIndex.upsert (best-effort — failure logs warn, leaves
   *      vector_synced_at NULL for reconciler)
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
    this.assertContentSize(opts.content);

    const existing = await this.memoryRepo.findByPath(opts.storeId, opts.path);

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

    const embedding = await this.embed(opts.content);
    const now = this.clock.nowMs();
    const sha = await sha256Hex(opts.content);
    const sizeBytes = byteLength(opts.content);

    let mem: MemoryRow;
    if (existing) {
      mem = await this.memoryRepo.updateWithVersion(
        existing.id,
        {
          content: opts.content,
          contentSha256: sha,
          sizeBytes,
          updatedAt: now,
          vectorSyncedAt: null,
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
          content: opts.content,
          contentSha256: sha,
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

    if (embedding) {
      await this.syncVectorIndex(opts.tenantId, opts.storeId, mem.id, opts.path, embedding);
    }

    // Re-read to capture vector_synced_at the syncVectorIndex update may have set.
    const refreshed = await this.memoryRepo.findById(opts.storeId, mem.id);
    return refreshed ?? mem;
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
    const newContent = opts.content ?? existing.content;
    const contentChanged = opts.content !== undefined && opts.content !== existing.content;
    const newSha = contentChanged ? await sha256Hex(newContent) : existing.content_sha256;
    const newSize = contentChanged ? byteLength(newContent) : existing.size_bytes;
    const now = this.clock.nowMs();

    // Embed only if content changed — saves a network round-trip on pure renames.
    let embedding: number[] | null = null;
    if (contentChanged) embedding = await this.embed(newContent);

    const mem = await this.memoryRepo.updateWithVersion(
      opts.memoryId,
      {
        path: newPath,
        content: contentChanged ? newContent : undefined,
        contentSha256: contentChanged ? newSha : undefined,
        sizeBytes: contentChanged ? newSize : undefined,
        updatedAt: now,
        vectorSyncedAt: contentChanged ? null : "unchanged",
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

    if (embedding) {
      await this.syncVectorIndex(opts.tenantId, opts.storeId, opts.memoryId, newPath, embedding);
    } else if (opts.path && opts.path !== existing.path && this.vectorIndex.isAvailable()) {
      // Path changed without content change — refresh metadata in vector index
      // so search results carry the new path. Cheap: same vector values.
      await this.refreshVectorMetadata(opts.tenantId, opts.storeId, opts.memoryId, newPath);
    }

    const refreshed = await this.memoryRepo.findById(opts.storeId, opts.memoryId);
    return refreshed ?? mem;
  }

  /**
   * Delete by ID. Persistence is the truth — once it commits, the memory is
   * gone for read/list/get; orphan vector cleanup is best-effort.
   */
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
    const now = this.clock.nowMs();
    await this.memoryRepo.deleteWithVersion(opts.memoryId, {
      id: this.ids.versionId(),
      memoryId: opts.memoryId,
      storeId: opts.storeId,
      operation: "deleted",
      path: existing.path,
      content: existing.content,
      contentSha256: existing.content_sha256,
      sizeBytes: existing.size_bytes,
      actor: opts.actor,
      createdAt: now,
    });
    if (this.vectorIndex.isAvailable()) {
      try {
        await this.vectorIndex.deleteByIds([vectorKey(opts.storeId, opts.memoryId)]);
      } catch (err) {
        this.logger.warn("vector index delete failed (orphan vector left)", {
          store_id: opts.storeId,
          memory_id: opts.memoryId,
          err: errToString(err),
        });
      }
    }
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

  async readByPath(opts: {
    tenantId: string;
    storeId: string;
    path: string;
  }): Promise<MemoryRow | null> {
    await this.requireStore(opts);
    return this.memoryRepo.findByPath(opts.storeId, opts.path);
  }

  async readById(opts: {
    tenantId: string;
    storeId: string;
    memoryId: string;
  }): Promise<MemoryRow | null> {
    await this.requireStore(opts);
    return this.memoryRepo.findById(opts.storeId, opts.memoryId);
  }

  // ============================================================
  // Search
  // ============================================================

  async searchMemories(opts: {
    tenantId: string;
    storeId: string;
    query: string;
    topK?: number;
  }): Promise<SearchHit[]> {
    await this.requireStore(opts);
    if (!this.vectorIndex.isAvailable()) return [];

    let queryEmbedding: number[] | null;
    try {
      queryEmbedding = await this.embedding.embed(opts.query);
    } catch (err) {
      this.logger.warn("query embedding failed", { err: errToString(err) });
      return [];
    }
    if (!queryEmbedding) return [];

    const matches = await this.vectorIndex.query(queryEmbedding, {
      topK: opts.topK ?? 10,
      filter: { store_id: opts.storeId },
    });
    if (!matches.length) return [];

    // D1 join filters orphan vectors (vector exists but D1 row gone).
    const hits: SearchHit[] = [];
    for (const m of matches) {
      const memId = extractMemoryId(m.id);
      const row = await this.memoryRepo.findById(opts.storeId, memId);
      if (!row) continue;
      hits.push({ id: row.id, path: row.path, content: row.content, score: m.score });
    }
    return hits;
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

  async redactVersion(opts: {
    tenantId: string;
    storeId: string;
    versionId: string;
  }): Promise<MemoryVersionRow> {
    const existing = await this.versionRepo.get(opts.storeId, opts.versionId);
    if (!existing) throw new MemoryNotFoundError("Memory version not found");
    return this.versionRepo.redact(opts.storeId, opts.versionId);
  }

  // ============================================================
  // Reconciliation
  // ============================================================

  /**
   * Re-embed and re-upsert any memories with NULL vector_synced_at, then mark
   * them synced. Bounded by `limit` to keep a single invocation cheap; call
   * repeatedly until `still_failing === 0` to drain entirely.
   */
  async reconcile(opts: {
    tenantId?: string;
    storeId?: string;
    limit?: number;
  }): Promise<ReconcileResult> {
    const limit = Math.min(opts.limit ?? 100, 500);
    const rows = await this.memoryRepo.listUnsynced({
      tenantId: opts.tenantId,
      storeId: opts.storeId,
      limit,
    });

    if (!this.vectorIndex.isAvailable()) {
      return {
        scanned: rows.length,
        fixed: 0,
        still_failing: rows.length,
        sample_errors: rows.length
          ? [{ memory_id: rows[0].id, error: "vector index unavailable" }]
          : [],
      };
    }

    let fixed = 0;
    const errors: Array<{ memory_id: string; error: string }> = [];

    for (const row of rows) {
      try {
        const embedding = await this.embedding.embed(row.content);
        if (!embedding) throw new Error("embedding returned null (provider disabled)");
        await this.vectorIndex.upsert([
          {
            id: vectorKey(row.storeId, row.id),
            values: embedding,
            metadata: { store_id: row.storeId, memory_id: row.id, path: row.path },
          },
        ]);
        await this.memoryRepo.markSynced(row.id, this.clock.nowMs());
        fixed++;
      } catch (err) {
        if (errors.length < 5) errors.push({ memory_id: row.id, error: errToString(err) });
      }
    }

    return {
      scanned: rows.length,
      fixed,
      still_failing: rows.length - fixed,
      sample_errors: errors,
    };
  }

  /** For health endpoints / monitoring — reconcile backlog gauge. */
  async countUnsynced(opts: { tenantId?: string }): Promise<number> {
    return this.memoryRepo.countUnsynced({ tenantId: opts.tenantId });
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

  private async embed(text: string): Promise<number[] | null> {
    try {
      return await this.embedding.embed(text);
    } catch (err) {
      throw new MemoryEmbeddingFailedError(err);
    }
  }

  private async syncVectorIndex(
    tenantId: string,
    storeId: string,
    memoryId: string,
    path: string,
    embedding: number[],
  ): Promise<void> {
    if (!this.vectorIndex.isAvailable()) return;
    try {
      await this.vectorIndex.upsert([
        {
          id: vectorKey(storeId, memoryId),
          values: embedding,
          metadata: { tenant_id: tenantId, store_id: storeId, memory_id: memoryId, path },
        },
      ]);
      await this.memoryRepo.markSynced(memoryId, this.clock.nowMs());
    } catch (err) {
      this.logger.warn("vector index upsert failed; row left for reconcile", {
        store_id: storeId,
        memory_id: memoryId,
        err: errToString(err),
      });
    }
  }

  private async refreshVectorMetadata(
    tenantId: string,
    storeId: string,
    memoryId: string,
    path: string,
  ): Promise<void> {
    try {
      const existing = await this.vectorIndex.getById(vectorKey(storeId, memoryId));
      if (!existing || !existing.values) throw new Error("vector missing");
      await this.vectorIndex.upsert([
        {
          id: vectorKey(storeId, memoryId),
          values: existing.values,
          metadata: { tenant_id: tenantId, store_id: storeId, memory_id: memoryId, path },
        },
      ]);
      await this.memoryRepo.markSynced(memoryId, this.clock.nowMs());
    } catch (err) {
      await this.memoryRepo.markUnsynced(memoryId);
      this.logger.warn("vector metadata refresh failed; row left for reconcile", {
        store_id: storeId,
        memory_id: memoryId,
        err: errToString(err),
      });
    }
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
// utilities
// ============================================================

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function vectorKey(storeId: string, memoryId: string): string {
  return `${storeId}:${memoryId}`;
}

function extractMemoryId(vectorId: string): string {
  const idx = vectorId.indexOf(":");
  return idx === -1 ? vectorId : vectorId.slice(idx + 1);
}

function errToString(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
