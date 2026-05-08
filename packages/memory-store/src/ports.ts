// Abstract ports the MemoryStoreService depends on.
//
// Following the same dependency-inversion pattern as packages/integrations-core
// (see ports.ts there): the service knows nothing about D1 or R2. Concrete
// adapters in src/adapters/ implement these against Cloudflare bindings;
// src/test-fakes.ts provides in-memory implementations.
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
  /** Mutable subset — only `name` and `description` are user-editable.
   *  `updated_at` is bumped automatically; pass `null` to clear description. */
  update(
    tenantId: string,
    storeId: string,
    fields: { name?: string; description?: string | null; updatedAt: number },
  ): Promise<MemoryStoreRow>;
  archive(tenantId: string, storeId: string, archivedAt: number): Promise<MemoryStoreRow>;
  /** Cascades to memories + memory_versions in the adapter (no FK; explicit cleanup). */
  delete(tenantId: string, storeId: string): Promise<void>;
}

/**
 * The fields written to the D1 `memories` index row. Note: no `content` —
 * R2 is the bytes-of-truth. The `etag` field carries the R2 object etag so
 * subsequent updates can use R2's `If-Match` precondition for CAS.
 */
export interface NewMemoryRow {
  id: string;
  storeId: string;
  path: string;
  contentSha256: string;
  /** R2 object etag — captured from the PUT result. */
  etag: string;
  sizeBytes: number;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryUpdateFields {
  path?: string;
  contentSha256?: string;
  /** R2 object etag — required when content changes. */
  etag?: string;
  sizeBytes?: number;
  updatedAt: number;
}

export interface NewMemoryVersionInput {
  id: string;
  memoryId: string;
  storeId: string;
  operation: "created" | "modified" | "deleted";
  path: string;
  /** Inline snapshot for audit + rollback. Bounded by MEMORY_CONTENT_MAX_BYTES. */
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
 *
 * Note: R2 PUT happens BEFORE the D1 batch. Order of operations in the service:
 *   1. R2 PUT (with conditional headers for create/CAS) → returns etag.
 *   2. D1 batch [memory index UPSERT, memory_versions INSERT] in one transaction.
 * Crash between (1) and (2): R2 has the new bytes, D1 missing the version row.
 * The R2 → Queue consumer reconciles this by inserting a version row from the
 * R2 event, deduped by (store_id, path, etag) — see apps/main/src/queue/memory-events.ts.
 */
export interface MemoryRepo {
  /** Insert a new memory index row + version atomically. */
  createWithVersion(memory: NewMemoryRow, version: NewMemoryVersionInput): Promise<MemoryRow>;

  /** Update the index row (path/sha/etag/size) + write a version atomically. */
  updateWithVersion(
    memoryId: string,
    update: MemoryUpdateFields,
    version: NewMemoryVersionInput,
  ): Promise<MemoryRow>;

  /** Delete the index row + write a version atomically. */
  deleteWithVersion(memoryId: string, version: NewMemoryVersionInput): Promise<void>;

  /** Index lookup by path. Returns metadata only — content is in R2. */
  findByPath(storeId: string, path: string): Promise<MemoryRow | null>;
  /** Index lookup by id. Returns metadata only — content is in R2. */
  findById(storeId: string, memoryId: string): Promise<MemoryRow | null>;
  /** List memories in a store, optionally filtered by path prefix. Metadata only. */
  list(storeId: string, opts: { pathPrefix?: string }): Promise<MemoryRow[]>;

  /**
   * Idempotent upsert from the R2 events queue consumer.
   *   - If no row exists at (store_id, path), insert one + insert a `created` version.
   *   - If a row exists at the path with a different etag, update etag/sha/size +
   *     insert a `modified` version.
   *   - If etag matches the existing row, no-op (R2 event re-delivery dedupe).
   *
   * Returns true if a write occurred, false on dedupe.
   */
  upsertFromEvent(input: {
    storeId: string;
    path: string;
    contentSha256: string;
    etag: string;
    sizeBytes: number;
    actor: Actor;
    nowMs: number;
    versionId: string;
    /** Required for the version row's `content` field. Pass the bytes we just GET'd from R2. */
    content: string;
    /** Optional — generate if not supplied. */
    memoryId?: string;
  }): Promise<{ wrote: boolean; row: MemoryRow | null }>;

  /**
   * Idempotent delete from the R2 events queue consumer.
   *   - If a row exists at (store_id, path), delete it + insert a `deleted` version.
   *   - If no row exists, no-op (dedupe).
   *
   * Returns true if a delete occurred, false on dedupe.
   */
  deleteFromEvent(input: {
    storeId: string;
    path: string;
    actor: Actor;
    nowMs: number;
    versionId: string;
  }): Promise<{ wrote: boolean }>;
}

export interface MemoryVersionRepo {
  list(storeId: string, opts: { memoryId?: string; limit: number }): Promise<MemoryVersionRow[]>;
  get(storeId: string, versionId: string): Promise<MemoryVersionRow | null>;
  /** Wipes content/path/sha/size, sets redacted=1. Append-only audit row stays. */
  redact(storeId: string, versionId: string): Promise<MemoryVersionRow>;
  /** Cleanup hook — delete versions older than `cutoffMs` EXCEPT the most recent
   *  per memory_id. Returns the number of rows deleted. Used by the daily
   *  retention cron in apps/main/src/cron/memory-retention.ts. */
  pruneOlderThan(cutoffMs: number): Promise<number>;
}

// ============================================================
// R2 blob store — bytes-of-truth for memory content
// ============================================================

export interface BlobMetadata {
  /** R2 object etag (HTTP-spec quoted). Used as the CAS primitive. */
  etag: string;
  /** Object size in bytes. */
  size: number;
}

export interface BlobReadResult extends BlobMetadata {
  text: string;
}

export type BlobPrecondition =
  /** Only PUT if no object exists at the key (R2 `If-None-Match: *`). */
  | { type: "ifNoneMatch"; value: "*" }
  /** Only PUT if the existing object matches `etag` (R2 `If-Match: <etag>`). */
  | { type: "ifMatch"; etag: string };

/**
 * Bytes-of-truth blob store. R2 in production; in-memory fake in tests.
 * Conditional PUT semantics mirror Anthropic's `precondition.content_sha256`
 * model: the wire shape is sha256, but the storage CAS is etag-based — the
 * service maps one to the other via the D1 index.
 */
export interface BlobStore {
  /** HEAD an object — returns metadata (etag, size) or null if not found. */
  head(key: string): Promise<BlobMetadata | null>;

  /** GET text content + metadata. Returns null if not found. */
  getText(key: string): Promise<BlobReadResult | null>;

  /**
   * PUT with optional precondition. Returns the new metadata on success,
   * or null if the precondition failed. Throws on transport / 5xx errors.
   */
  put(
    key: string,
    body: string,
    opts?: {
      precondition?: BlobPrecondition;
      /** Sticks to the R2 object as customMetadata. Useful for the queue
       *  consumer to attribute writes to a session/api_key. */
      actorMetadata?: { actor_type: string; actor_id: string };
    },
  ): Promise<BlobMetadata | null>;

  /** DELETE an object. Idempotent — no-op if missing. */
  delete(key: string): Promise<void>;
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
