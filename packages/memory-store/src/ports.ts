// Abstract ports the MemoryStoreService depends on.
//
// Following the same dependency-inversion pattern as packages/integrations-core
// (see ports.ts there): the service knows nothing about D1, Workers AI, or
// Vectorize. Concrete adapters in src/adapters/ implement these against
// Cloudflare bindings; src/test-fakes.ts provides in-memory implementations.
//
// Keep these tiny and runtime-agnostic: no Cloudflare types, no Web Crypto
// types, no D1 query language. Pass plain data + return plain data.

import type {
  Actor,
  MemoryRow,
  MemoryStoreRow,
  MemoryVersionRow,
} from "./types";

// ============================================================
// Persistence — split per aggregate to keep each port small
// ============================================================

export interface NewMemoryStoreInput {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  createdAt: number;
}

export interface MemoryStoreRepo {
  insert(input: NewMemoryStoreInput): Promise<MemoryStoreRow>;
  get(tenantId: string, storeId: string): Promise<MemoryStoreRow | null>;
  list(tenantId: string, opts: { includeArchived: boolean }): Promise<MemoryStoreRow[]>;
  archive(tenantId: string, storeId: string, archivedAt: number): Promise<MemoryStoreRow>;
  /** Cascades to memories + memory_versions in the adapter (no FK; explicit cleanup). */
  delete(tenantId: string, storeId: string): Promise<void>;
  /** All memory IDs in a store — used to pre-compute Vectorize ids before deleteStore. */
  listMemoryIds(storeId: string): Promise<string[]>;
}

export interface NewMemoryRow {
  id: string;
  storeId: string;
  path: string;
  content: string;
  contentSha256: string;
  sizeBytes: number;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryUpdateFields {
  path?: string;
  content?: string;
  contentSha256?: string;
  sizeBytes?: number;
  updatedAt: number;
  /** Set to null when content changes (so reconciler picks it up). */
  vectorSyncedAt: number | null | "unchanged";
}

export interface NewMemoryVersionInput {
  id: string;
  memoryId: string;
  storeId: string;
  operation: "created" | "modified" | "deleted";
  path: string;
  content: string;
  contentSha256: string;
  sizeBytes: number;
  actor: Actor;
  createdAt: number;
}

/**
 * Memory + version go together — every mutation must be atomic with its
 * corresponding version row. The repo enforces this at adapter level
 * (D1.batch in the CF adapter, single object update in the in-memory fake).
 */
export interface MemoryRepo {
  /** Insert a new memory and its version atomically. */
  createWithVersion(memory: NewMemoryRow, version: NewMemoryVersionInput): Promise<MemoryRow>;

  /** Update an existing memory (content or path) and write a version atomically. */
  updateWithVersion(
    memoryId: string,
    update: MemoryUpdateFields,
    version: NewMemoryVersionInput,
  ): Promise<MemoryRow>;

  /** Delete the memory and write a version atomically. */
  deleteWithVersion(memoryId: string, version: NewMemoryVersionInput): Promise<void>;

  findByPath(storeId: string, path: string): Promise<MemoryRow | null>;
  findById(storeId: string, memoryId: string): Promise<MemoryRow | null>;
  list(storeId: string, opts: { pathPrefix?: string }): Promise<MemoryRow[]>;

  /** Mark a memory as fully synced with the vector index. */
  markSynced(memoryId: string, syncedAt: number): Promise<void>;
  /** Force-mark unsynced — used when vector metadata refresh fails. */
  markUnsynced(memoryId: string): Promise<void>;

  /** Drains rows where vector_synced_at IS NULL, optionally tenant/store-scoped. */
  listUnsynced(opts: {
    tenantId?: string;
    storeId?: string;
    limit: number;
  }): Promise<Array<{ id: string; storeId: string; path: string; content: string }>>;

  countUnsynced(opts: { tenantId?: string }): Promise<number>;
}

export interface MemoryVersionRepo {
  list(storeId: string, opts: { memoryId?: string; limit: number }): Promise<MemoryVersionRow[]>;
  get(storeId: string, versionId: string): Promise<MemoryVersionRow | null>;
  redact(storeId: string, versionId: string): Promise<MemoryVersionRow>;
}

// ============================================================
// External infra ports — embedding model + vector index
// ============================================================

/**
 * Computes a dense vector representation of text. Implementations may be:
 *   - Workers AI (Cloudflare-hosted model)
 *   - OpenAI / Anthropic embedding endpoints
 *   - Local sentence-transformers in dev
 *   - A no-op that returns null (when no embedding service is configured —
 *     callers treat null as "skip vector sync, leave row unsynced").
 */
export interface EmbeddingProvider {
  /**
   * Returns the embedding vector, or null if the provider is intentionally
   * disabled (no binding configured). Throws on transient errors so the
   * caller can retry or surface a 5xx.
   */
  embed(text: string): Promise<number[] | null>;
}

export interface VectorUpsertItem {
  id: string;
  values: number[];
  metadata: Record<string, unknown>;
}

export interface VectorMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
  values?: number[];
}

/**
 * Semantic-search index. Implementations may be Cloudflare Vectorize, Pinecone,
 * Qdrant, or an in-memory cosine-similarity fake for tests. A no-op fallback
 * implementation is used when no index is configured — `query` returns [],
 * `upsert`/`deleteByIds` no-op.
 */
export interface VectorIndex {
  upsert(items: VectorUpsertItem[]): Promise<void>;
  query(
    values: number[],
    opts: { topK: number; filter?: Record<string, unknown> },
  ): Promise<VectorMatch[]>;
  deleteByIds(ids: string[]): Promise<void>;
  /** Returns null if id not found. Used for metadata-refresh-only updates. */
  getById(id: string): Promise<{ id: string; values: number[] | null; metadata?: Record<string, unknown> } | null>;
  /** True if this is a no-op implementation; lets callers skip Vectorize-dependent features (search) cleanly. */
  isAvailable(): boolean;
}

// ============================================================
// Misc
// ============================================================

export interface Logger {
  warn(msg: string, ctx?: unknown): void;
}

export interface Clock {
  nowMs(): number;
}

export interface IdGenerator {
  storeId(): string;
  memoryId(): string;
  versionId(): string;
}
