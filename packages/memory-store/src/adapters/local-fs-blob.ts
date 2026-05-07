// Local filesystem implementation of memory-store's BlobStore — backs
// memory-store content with a directory tree on the host instead of R2/S3.
//
// File layout: <baseDir>/<key> with parents auto-created. Each file holds
// the memory's text content; sidecar `.meta.json` holds custom metadata
// (actor_type / actor_id) the queue consumer reads after R2 events. Etag is
// the sha256 hex of content — same byte-for-byte across runtimes so the CAS
// preconditions are interchangeable with R2 etags.
//
// SECURITY: this adapter has no isolation between memory stores beyond
// directory paths. Multi-tenant deployments must scope baseDir per tenant
// or use a real S3-backed adapter. Local dev / single-tenant only.

import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type {
  BlobMetadata,
  BlobPrecondition,
  BlobReadResult,
  BlobStore,
} from "../ports";

export interface LocalFsBlobStoreOptions {
  /** Root directory under which memory store content lives. */
  baseDir: string;
}

interface SidecarMeta {
  actor_type?: string;
  actor_id?: string;
}

export class LocalFsBlobStore implements BlobStore {
  /** Absolute path to the directory holding blob content. Public so callers
   *  that need filesystem access alongside the BlobStore API (e.g. the local
   *  sandbox bind-mounting memory stores) can read it without re-resolving. */
  readonly baseDir: string;

  constructor(opts: LocalFsBlobStoreOptions) {
    this.baseDir = resolve(opts.baseDir);
  }

  async head(key: string): Promise<BlobMetadata | null> {
    try {
      const path = this.pathFor(key);
      const stat = await fs.stat(path);
      const buf = await fs.readFile(path);
      const etag = sha256Hex(buf);
      return { etag, size: stat.size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async getText(key: string): Promise<BlobReadResult | null> {
    try {
      const path = this.pathFor(key);
      const buf = await fs.readFile(path);
      const text = buf.toString("utf8");
      return {
        text,
        etag: sha256Hex(buf),
        size: buf.byteLength,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async put(
    key: string,
    body: string,
    opts?: {
      precondition?: BlobPrecondition;
      actorMetadata?: { actor_type: string; actor_id: string };
    },
  ): Promise<BlobMetadata | null> {
    const path = this.pathFor(key);
    const existing = await this.head(key);

    if (opts?.precondition?.type === "ifNoneMatch") {
      if (existing) return null; // create-only and key already present
    } else if (opts?.precondition?.type === "ifMatch") {
      if (!existing || existing.etag !== opts.precondition.etag) return null;
    }

    await fs.mkdir(dirname(path), { recursive: true });
    const buf = Buffer.from(body, "utf8");
    await fs.writeFile(path, buf);

    if (opts?.actorMetadata) {
      const meta: SidecarMeta = {
        actor_type: opts.actorMetadata.actor_type,
        actor_id: opts.actorMetadata.actor_id,
      };
      await fs.writeFile(`${path}.meta.json`, JSON.stringify(meta));
    }

    return { etag: sha256Hex(buf), size: buf.byteLength };
  }

  async delete(key: string): Promise<void> {
    const path = this.pathFor(key);
    await fs.rm(path, { force: true });
    await fs.rm(`${path}.meta.json`, { force: true });
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private pathFor(key: string): string {
    // Strip any leading slash to keep keys workdir-relative; reject path
    // traversal via the resolve() check below.
    const rel = key.replace(/^\/+/, "");
    const full = join(this.baseDir, rel);
    if (!full.startsWith(this.baseDir)) {
      throw new Error(`LocalFsBlobStore: path traversal rejected for key ${key}`);
    }
    return full;
  }
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
