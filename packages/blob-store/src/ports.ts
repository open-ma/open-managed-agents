// Runtime-agnostic blob store port.
//
// Goal: separate "where the bytes live" (R2 / S3 / local FS / in-memory)
// from "how the app talks to it". One BlobStore interface, multiple
// adapters, swappable per deployment.
//
// Used by:
//   - apps/main/src/routes/files.ts        (FILES_BUCKET)
//   - apps/main/src/routes/skills.ts       (FILES_BUCKET, skill files)
//   - apps/main/src/routes/clawhub.ts      (FILES_BUCKET, hub imports)
//   - apps/main/src/routes/sessions.ts     (FILES_BUCKET, scoped file copies)
//
// Memory-store has its own narrower text-only BlobStore in
// packages/memory-store/src/ports.ts; the two will likely converge later
// once the full CFless migration is settled.

/**
 * What can be PUT to a blob. Mirrors R2 / S3 SDK accepted shapes.
 *  - string: text content (UTF-8)
 *  - ArrayBuffer / ArrayBufferView: raw binary
 *  - ReadableStream<Uint8Array>: streaming upload (R2 supports this natively;
 *    S3 adapter buffers if needed)
 */
export type BlobBody =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | ReadableStream<Uint8Array>;

/**
 * Per-blob HTTP-level metadata that survives across PUT/GET. R2/S3 store this
 * separately from custom metadata; both are returned on GET.
 */
export interface BlobHttpMetadata {
  contentType?: string;
  contentEncoding?: string;
  contentDisposition?: string;
  contentLanguage?: string;
  cacheControl?: string;
}

export interface BlobMetadata {
  /** Storage etag (HTTP-spec quoted on R2; verbatim on S3). Used as CAS primitive. */
  etag: string;
  /** Object size in bytes. */
  size: number;
  httpMetadata?: BlobHttpMetadata;
  customMetadata?: Record<string, string>;
}

/**
 * GET result. Body is the canonical access — helpers mirror Response/R2Object
 * for ergonomics. Reading body twice throws (single-consumption stream).
 */
export interface BlobObject extends BlobMetadata {
  /** Stream the object body. Single consumption. */
  body: ReadableStream<Uint8Array>;
  /** Convenience: drain body and decode as UTF-8. */
  text(): Promise<string>;
  /** Convenience: drain body into ArrayBuffer. */
  arrayBuffer(): Promise<ArrayBuffer>;
  /** Convenience: drain body into Uint8Array. */
  bytes(): Promise<Uint8Array>;
}

/**
 * Conditional PUT semantics. Mirrors R2's `onlyIf` / S3's If-Match-headers.
 *  - ifNoneMatch "*": create-only (PUT only if no object exists at key)
 *  - ifMatch <etag>: CAS (PUT only if existing object's etag matches)
 *
 * On failure, `put()` returns `null` (not an error).
 */
export type BlobPrecondition =
  | { type: "ifNoneMatch"; value: "*" }
  | { type: "ifMatch"; etag: string };

export interface BlobPutOptions {
  httpMetadata?: BlobHttpMetadata;
  customMetadata?: Record<string, string>;
  precondition?: BlobPrecondition;
}

/**
 * The port. Implementations:
 *   - CfR2BlobStore (adapters/cf-r2.ts) — wraps R2Bucket
 *   - InMemoryBlobStore (adapters/in-memory.ts) — for tests / dev
 *   - S3BlobStore — TODO when needed (MinIO/AWS/Tigris)
 *   - LocalFsBlobStore — TODO when needed (single-node deployments)
 */
export interface BlobStore {
  /** HEAD an object — returns metadata or null if not found. */
  head(key: string): Promise<BlobMetadata | null>;

  /** GET an object — returns body+metadata or null if not found. */
  get(key: string): Promise<BlobObject | null>;

  /**
   * PUT an object. Returns the new metadata on success, null when a
   * precondition fails. Throws on transport / 5xx errors.
   */
  put(
    key: string,
    body: BlobBody,
    opts?: BlobPutOptions,
  ): Promise<BlobMetadata | null>;

  /** DELETE an object. Idempotent — no-op if missing. */
  delete(key: string): Promise<void>;
}
