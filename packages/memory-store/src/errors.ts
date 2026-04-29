/** Typed errors so HTTP handlers can map to status codes without leaking internals. */

export class MemoryNotFoundError extends Error {
  readonly code = "memory_not_found";
  constructor(message = "Memory not found") {
    super(message);
  }
}

export class MemoryStoreNotFoundError extends Error {
  readonly code = "memory_store_not_found";
  constructor(message = "Memory store not found") {
    super(message);
  }
}

export class MemoryPreconditionFailedError extends Error {
  readonly code = "memory_precondition_failed";
  constructor(message = "Memory precondition failed") {
    super(message);
  }
}

export class MemoryContentTooLargeError extends Error {
  readonly code = "memory_content_too_large";
  constructor(public limitBytes: number) {
    super(`content exceeds ${limitBytes} byte limit`);
  }
}

/**
 * The blob store (R2) couldn't write the bytes — typically transient. Distinct
 * from precondition failure (separate error). Maps to 503.
 */
export class MemoryBlobStoreError extends Error {
  readonly code = "memory_blob_store_error";
  constructor(public cause: unknown) {
    super(`memory blob store error: ${describeCause(cause)}`);
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}
