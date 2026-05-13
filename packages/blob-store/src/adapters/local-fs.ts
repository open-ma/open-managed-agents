// Local filesystem BlobStore — files-store / workspace-backups blob target
// for single-node deployments. Same shape as CfR2BlobStore + S3BlobStore.
//
// Layout: <baseDir>/<key> with parent dirs auto-created. Sidecar
// `.meta.json` carries httpMetadata + customMetadata so GET round-trips.
// Etag is sha256 hex of content; CAS preconditions compared byte-equal.

import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type {
  BlobBody,
  BlobMetadata,
  BlobObject,
  BlobPutOptions,
  BlobStore,
  BlobHttpMetadata,
} from "../ports";

export interface LocalFsBlobStoreOptions {
  baseDir: string;
}

interface SidecarMeta {
  httpMetadata?: BlobHttpMetadata;
  customMetadata?: Record<string, string>;
}

export class LocalFsBlobStore implements BlobStore {
  readonly baseDir: string;

  constructor(opts: LocalFsBlobStoreOptions) {
    this.baseDir = resolve(opts.baseDir);
  }

  async head(key: string): Promise<BlobMetadata | null> {
    try {
      const buf = await fs.readFile(this.pathFor(key));
      const meta = await this.readSidecar(key);
      return {
        etag: sha256Hex(buf),
        size: buf.byteLength,
        httpMetadata: meta?.httpMetadata,
        customMetadata: meta?.customMetadata,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async get(key: string): Promise<BlobObject | null> {
    try {
      const buf = await fs.readFile(this.pathFor(key));
      const meta = await this.readSidecar(key);
      const bytes = new Uint8Array(buf);
      return {
        etag: sha256Hex(buf),
        size: buf.byteLength,
        httpMetadata: meta?.httpMetadata,
        customMetadata: meta?.customMetadata,
        body: streamFromBytes(bytes),
        text: async () => buf.toString("utf8"),
        arrayBuffer: async () =>
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer,
        bytes: async () => new Uint8Array(bytes),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async put(
    key: string,
    body: BlobBody,
    opts?: BlobPutOptions,
  ): Promise<BlobMetadata | null> {
    const path = this.pathFor(key);
    if (opts?.precondition?.type === "ifNoneMatch") {
      try {
        await fs.access(path);
        return null;
      } catch {
        /* not present — proceed */
      }
    }
    if (opts?.precondition?.type === "ifMatch") {
      try {
        const existing = await fs.readFile(path);
        if (sha256Hex(existing) !== opts.precondition.etag) return null;
      } catch {
        return null;
      }
    }
    const bytes = await bodyToBytes(body);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, bytes);
    if (opts?.httpMetadata || opts?.customMetadata) {
      const sidecar: SidecarMeta = {
        httpMetadata: opts.httpMetadata,
        customMetadata: opts.customMetadata,
      };
      await fs.writeFile(`${path}.meta.json`, JSON.stringify(sidecar), "utf8");
    }
    return {
      etag: sha256Hex(bytes),
      size: bytes.byteLength,
      httpMetadata: opts?.httpMetadata,
      customMetadata: opts?.customMetadata,
    };
  }

  async delete(key: string): Promise<void> {
    const path = this.pathFor(key);
    await fs.rm(path, { force: true });
    await fs.rm(`${path}.meta.json`, { force: true });
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private pathFor(key: string): string {
    // Reject any traversal-style keys before they can escape baseDir.
    if (key.includes("..")) throw new Error(`invalid key: ${key}`);
    return join(this.baseDir, key);
  }

  private async readSidecar(key: string): Promise<SidecarMeta | null> {
    try {
      const raw = await fs.readFile(`${this.pathFor(key)}.meta.json`, "utf8");
      return JSON.parse(raw) as SidecarMeta;
    } catch {
      return null;
    }
  }
}

async function bodyToBytes(body: BlobBody): Promise<Uint8Array> {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
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

function sha256Hex(bytes: Uint8Array | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
