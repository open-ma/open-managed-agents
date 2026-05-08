// In-memory BlobStore for tests and local development.
//
// Stores Uint8Array bytes per key with etag (sha256 hex) + size + metadata.
// Etag values are unquoted hex (R2 uses HTTP-spec quoted etags); CAS comparison
// is byte-for-byte so tests can assert against consistent values.

import type {
  BlobBody,
  BlobMetadata,
  BlobObject,
  BlobPutOptions,
  BlobStore,
} from "../ports";

interface InMemoryBlob {
  bytes: Uint8Array;
  metadata: BlobMetadata;
}

export class InMemoryBlobStore implements BlobStore {
  private map = new Map<string, InMemoryBlob>();

  async head(key: string): Promise<BlobMetadata | null> {
    const blob = this.map.get(key);
    return blob ? cloneMetadata(blob.metadata) : null;
  }

  async get(key: string): Promise<BlobObject | null> {
    const blob = this.map.get(key);
    if (!blob) return null;
    const bytes = blob.bytes;
    return {
      ...cloneMetadata(blob.metadata),
      body: streamFromBytes(bytes),
      text: async () => new TextDecoder("utf-8").decode(bytes),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      bytes: async () => new Uint8Array(bytes),
    };
  }

  async put(
    key: string,
    body: BlobBody,
    opts?: BlobPutOptions,
  ): Promise<BlobMetadata | null> {
    if (opts?.precondition?.type === "ifNoneMatch" && this.map.has(key)) {
      return null;
    }
    if (opts?.precondition?.type === "ifMatch") {
      const existing = this.map.get(key);
      if (!existing || existing.metadata.etag !== opts.precondition.etag) {
        return null;
      }
    }
    const bytes = await bodyToBytes(body);
    const etag = await sha256Hex(bytes);
    const metadata: BlobMetadata = {
      etag,
      size: bytes.byteLength,
      httpMetadata: opts?.httpMetadata ? { ...opts.httpMetadata } : undefined,
      customMetadata: opts?.customMetadata ? { ...opts.customMetadata } : undefined,
    };
    this.map.set(key, { bytes, metadata });
    return cloneMetadata(metadata);
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  // ─── test helpers ─────────────────────────────────────────────────────────

  /** Number of objects currently held. */
  size(): number {
    return this.map.size;
  }

  /** Snapshot all keys (no order guarantee). */
  keys(): string[] {
    return Array.from(this.map.keys());
  }

  /** Drop everything. */
  clear(): void {
    this.map.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function bodyToBytes(body: BlobBody): Promise<Uint8Array> {
  if (typeof body === "string") {
    return new TextEncoder().encode(body);
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  // ReadableStream<Uint8Array>
  const chunks: Uint8Array[] = [];
  const reader = body.getReader();
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function cloneMetadata(m: BlobMetadata): BlobMetadata {
  return {
    etag: m.etag,
    size: m.size,
    httpMetadata: m.httpMetadata ? { ...m.httpMetadata } : undefined,
    customMetadata: m.customMetadata ? { ...m.customMetadata } : undefined,
  };
}
