import type { BlobMetadata, BlobPrecondition, BlobReadResult, BlobStore } from "../ports";

/**
 * Cloudflare R2 implementation of {@link BlobStore}.
 *
 * Conditional PUT mapping (https://developers.cloudflare.com/r2/api/workers/workers-api-reference/):
 *   - { type: "ifNoneMatch", value: "*" } → R2 binding accepts this through
 *     `onlyIf: { etagDoesNotMatch: "*" }` if the runtime supports it; for
 *     defensive portability we pass it via raw `Headers` with `If-None-Match: *`,
 *     which the binding maps through to the underlying R2 API.
 *   - { type: "ifMatch", etag: e } → `onlyIf: { etagMatches: e }` works in all
 *     versions; etag values are passed verbatim including the surrounding
 *     quotes if R2 returned them with quotes.
 *
 * On precondition failure the R2 binding returns `null` from `put()`. We
 * surface that as a null return; the service wraps in MemoryPreconditionFailedError.
 */
export class CfR2BlobStore implements BlobStore {
  constructor(private readonly bucket: R2Bucket) {}

  async head(key: string): Promise<BlobMetadata | null> {
    const obj = await this.bucket.head(key);
    return obj ? { etag: obj.etag, size: obj.size } : null;
  }

  async getText(key: string): Promise<BlobReadResult | null> {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    const text = await obj.text();
    return { text, etag: obj.etag, size: obj.size };
  }

  async put(
    key: string,
    body: string,
    opts?: {
      precondition?: BlobPrecondition;
      actorMetadata?: { actor_type: string; actor_id: string };
    },
  ): Promise<BlobMetadata | null> {
    const customMetadata = opts?.actorMetadata
      ? { actor_type: opts.actorMetadata.actor_type, actor_id: opts.actorMetadata.actor_id }
      : undefined;

    let result: R2Object | null = null;

    if (opts?.precondition?.type === "ifNoneMatch") {
      // `If-None-Match: *` — only PUT if no object exists. R2 binding supports
      // this both via the typed `onlyIf` field and via raw `Headers`. We use
      // raw Headers for portability across binding versions.
      result = await this.bucket.put(key, body, {
        onlyIf: new Headers([["If-None-Match", "*"]]),
        customMetadata,
      });
    } else if (opts?.precondition?.type === "ifMatch") {
      result = await this.bucket.put(key, body, {
        onlyIf: { etagMatches: opts.precondition.etag },
        customMetadata,
      });
    } else {
      result = await this.bucket.put(key, body, { customMetadata });
    }

    if (!result) return null;
    return { etag: result.etag, size: result.size };
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}
