// Cloudflare R2 implementation of BlobStore.
//
// Shape mapping:
//   put precondition:
//     ifNoneMatch "*"   → onlyIf: { etagDoesNotMatch: "*" }     (or raw If-None-Match: * Headers)
//     ifMatch <etag>    → onlyIf: { etagMatches: etag }
//
//   put options:
//     httpMetadata.contentType + others → R2 binding's `httpMetadata`
//     customMetadata                     → R2 binding's `customMetadata`
//
//   On precondition failure, R2 returns null from put() — surfaced as null here.

import type {
  BlobBody,
  BlobHttpMetadata,
  BlobMetadata,
  BlobObject,
  BlobPutOptions,
  BlobStore,
} from "../ports";

export class CfR2BlobStore implements BlobStore {
  constructor(private readonly bucket: R2Bucket) {}

  async head(key: string): Promise<BlobMetadata | null> {
    const obj = await this.bucket.head(key);
    return obj ? toMetadata(obj) : null;
  }

  async get(key: string): Promise<BlobObject | null> {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return toBlobObject(obj);
  }

  async put(
    key: string,
    body: BlobBody,
    opts?: BlobPutOptions,
  ): Promise<BlobMetadata | null> {
    const r2Opts: R2PutOptions = {};
    if (opts?.httpMetadata) {
      r2Opts.httpMetadata = toR2HttpMetadata(opts.httpMetadata);
    }
    if (opts?.customMetadata) {
      r2Opts.customMetadata = opts.customMetadata;
    }
    if (opts?.precondition?.type === "ifNoneMatch") {
      // `If-None-Match: *` — only PUT when no object exists. R2 binding accepts
      // this both via typed onlyIf and via raw Headers; raw Headers are safest
      // across binding versions.
      r2Opts.onlyIf = new Headers([["If-None-Match", "*"]]);
    } else if (opts?.precondition?.type === "ifMatch") {
      r2Opts.onlyIf = { etagMatches: opts.precondition.etag };
    }

    const result = await this.bucket.put(key, toR2Body(body), r2Opts);
    return result ? toMetadata(result) : null;
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}

/** Convenience: wrap R2Bucket binding as a BlobStore. Returns null when the
 *  binding is undefined so call sites can keep their existing "binding optional"
 *  semantics without wrapping the helper. */
export function blobStoreFromR2(bucket: R2Bucket | undefined): BlobStore | null {
  return bucket ? new CfR2BlobStore(bucket) : null;
}

// ─────────────────────────────────────────────────────────────────────────────

function toR2Body(body: BlobBody): ReadableStream | ArrayBuffer | ArrayBufferView | string {
  // R2.put accepts string | ReadableStream | ArrayBuffer | ArrayBufferView | Blob | null.
  // BlobBody is a strict subset, no conversion needed.
  return body;
}

function toR2HttpMetadata(m: BlobHttpMetadata): R2HTTPMetadata {
  return {
    ...(m.contentType && { contentType: m.contentType }),
    ...(m.contentEncoding && { contentEncoding: m.contentEncoding }),
    ...(m.contentDisposition && { contentDisposition: m.contentDisposition }),
    ...(m.contentLanguage && { contentLanguage: m.contentLanguage }),
    ...(m.cacheControl && { cacheControl: m.cacheControl }),
  };
}

function fromR2HttpMetadata(m: R2HTTPMetadata | undefined): BlobHttpMetadata | undefined {
  if (!m) return undefined;
  const out: BlobHttpMetadata = {};
  if (m.contentType) out.contentType = m.contentType;
  if (m.contentEncoding) out.contentEncoding = m.contentEncoding;
  if (m.contentDisposition) out.contentDisposition = m.contentDisposition;
  if (m.contentLanguage) out.contentLanguage = m.contentLanguage;
  if (m.cacheControl) out.cacheControl = m.cacheControl;
  return Object.keys(out).length > 0 ? out : undefined;
}

function toMetadata(obj: R2Object): BlobMetadata {
  return {
    etag: obj.etag,
    size: obj.size,
    httpMetadata: fromR2HttpMetadata(obj.httpMetadata),
    customMetadata: obj.customMetadata,
  };
}

function toBlobObject(obj: R2ObjectBody): BlobObject {
  return {
    etag: obj.etag,
    size: obj.size,
    httpMetadata: fromR2HttpMetadata(obj.httpMetadata),
    customMetadata: obj.customMetadata,
    body: obj.body,
    text: () => obj.text(),
    arrayBuffer: () => obj.arrayBuffer(),
    bytes: async () => new Uint8Array(await obj.arrayBuffer()),
  };
}
