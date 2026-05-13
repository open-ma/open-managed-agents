// S3-compatible BlobStore for memory-store content.
//
// Same shape as LocalFsBlobStore — text content keyed by `<storeId>/<path>`
// with sidecar key `<key>.meta.json` for actor metadata. Works against any
// S3-API endpoint: AWS S3, MinIO, Cloudflare R2 (S3 API), Tigris, Wasabi.
//
// Why a peer-dep on @aws-sdk/client-s3: keeps SQLite-only deploys lean —
// pnpm install with no S3 use ships nothing extra. main-node bundles the
// dep at the app level so the import here resolves at runtime when
// MEMORY_S3_* is configured.
//
// Conditional PUT: S3's atomic IfNoneMatch / IfMatch landed in late 2024
// for AWS and is supported on R2 / MinIO. We use it when present; on
// older S3-compatible endpoints the read-then-write pattern races, which
// matches LocalFsBlobStore behaviour and is fine for memory writes.

import type {
  BlobMetadata,
  BlobPrecondition,
  BlobReadResult,
  BlobStore,
} from "../ports";

export interface S3BlobStoreOptions {
  /** S3 endpoint URL — e.g. https://s3.amazonaws.com,
   *  http://minio:9000, https://<account>.r2.cloudflarestorage.com */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Region — default "us-east-1" since most S3-compat endpoints accept it. */
  region?: string;
  /** Some endpoints (MinIO) require path-style addressing. Default true
   *  for safety; AWS S3 also accepts it. */
  forcePathStyle?: boolean;
  /** Optional path prefix prepended to every key. Useful for sharing a
   *  bucket across stages (`prefix: "prod/"`). */
  prefix?: string;
}

interface S3SidecarMeta {
  actor_type?: string;
  actor_id?: string;
}

// Shapes from @aws-sdk/client-s3 minus the SDK dep — we dynamic-import.
interface S3HeadOutput {
  ETag?: string;
  ContentLength?: number;
}
interface S3GetOutput {
  ETag?: string;
  ContentLength?: number;
  Body?: { transformToString(): Promise<string> };
}
interface S3PutOutput {
  ETag?: string;
}
interface S3CommandConstructor<I, O> {
  new (input: I): { resolveMiddleware?: unknown; output?: O };
}
interface S3Client {
  send<I, O>(command: { resolveMiddleware?: unknown; output?: O }): Promise<O>;
  destroy(): void;
}

export class S3BlobStore implements BlobStore {
  /** Bucket name — public so the S3 poller can reuse it without re-reading config. */
  readonly bucket: string;
  readonly prefix: string;
  /** Lazy-resolved client + command constructors so the AWS SDK isn't
   *  loaded unless this adapter is actually constructed. */
  private clientPromise: Promise<{
    client: S3Client;
    HeadObjectCommand: S3CommandConstructor<unknown, S3HeadOutput>;
    GetObjectCommand: S3CommandConstructor<unknown, S3GetOutput>;
    PutObjectCommand: S3CommandConstructor<unknown, S3PutOutput>;
    DeleteObjectCommand: S3CommandConstructor<unknown, unknown>;
  }> | null = null;

  constructor(private opts: S3BlobStoreOptions) {
    this.bucket = opts.bucket;
    this.prefix = opts.prefix ?? "";
  }

  private async ensureClient() {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const sdk = (await import(
          /* @vite-ignore */ "@aws-sdk/client-s3" as string
        )) as {
          S3Client: new (cfg: unknown) => S3Client;
          HeadObjectCommand: S3CommandConstructor<unknown, S3HeadOutput>;
          GetObjectCommand: S3CommandConstructor<unknown, S3GetOutput>;
          PutObjectCommand: S3CommandConstructor<unknown, S3PutOutput>;
          DeleteObjectCommand: S3CommandConstructor<unknown, unknown>;
        };
        const client = new sdk.S3Client({
          endpoint: this.opts.endpoint,
          region: this.opts.region ?? "us-east-1",
          forcePathStyle: this.opts.forcePathStyle ?? true,
          credentials: {
            accessKeyId: this.opts.accessKeyId,
            secretAccessKey: this.opts.secretAccessKey,
          },
        });
        return {
          client,
          HeadObjectCommand: sdk.HeadObjectCommand,
          GetObjectCommand: sdk.GetObjectCommand,
          PutObjectCommand: sdk.PutObjectCommand,
          DeleteObjectCommand: sdk.DeleteObjectCommand,
        };
      })();
    }
    return this.clientPromise;
  }

  async head(key: string): Promise<BlobMetadata | null> {
    const { client, HeadObjectCommand } = await this.ensureClient();
    try {
      const out = await client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
      );
      return {
        etag: stripQuotes(out.ETag ?? ""),
        size: out.ContentLength ?? 0,
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async getText(key: string): Promise<BlobReadResult | null> {
    const { client, GetObjectCommand } = await this.ensureClient();
    try {
      const out = await client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
      );
      const text = (await out.Body?.transformToString()) ?? "";
      return {
        text,
        etag: stripQuotes(out.ETag ?? ""),
        size: out.ContentLength ?? text.length,
      };
    } catch (err) {
      if (isNotFound(err)) return null;
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
    const { client, PutObjectCommand } = await this.ensureClient();
    const fullKey = this.fullKey(key);

    // Pre-check semantics — same race-prone HEAD-then-PUT pattern as
    // LocalFsBlobStore. Modern AWS S3 supports IfNoneMatch / IfMatch
    // atomically; we layer that on top of the pre-check so newer endpoints
    // catch a write that landed between the check and the PUT.
    const precondition = opts?.precondition;
    const existing = precondition ? await this.head(key) : null;
    if (precondition?.type === "ifNoneMatch") {
      if (existing) return null;
    } else if (precondition?.type === "ifMatch") {
      if (!existing || existing.etag !== precondition.etag) return null;
    }

    const putInput: Record<string, unknown> = {
      Bucket: this.bucket,
      Key: fullKey,
      Body: body,
      ContentType: "text/plain; charset=utf-8",
    };
    if (precondition?.type === "ifNoneMatch") putInput.IfNoneMatch = "*";
    else if (precondition?.type === "ifMatch") putInput.IfMatch = precondition.etag;
    if (opts?.actorMetadata) {
      putInput.Metadata = {
        actor_type: opts.actorMetadata.actor_type,
        actor_id: opts.actorMetadata.actor_id,
      };
    }

    let put: S3PutOutput;
    try {
      put = await client.send(new PutObjectCommand(putInput));
    } catch (err) {
      // 412 Precondition Failed → contract says return null, not throw.
      if (isPreconditionFailed(err)) return null;
      throw err;
    }
    const etag = stripQuotes(put.ETag ?? "");

    // Sidecar meta — separate object so a `head` can stay cheap.
    if (opts?.actorMetadata) {
      const meta: S3SidecarMeta = {
        actor_type: opts.actorMetadata.actor_type,
        actor_id: opts.actorMetadata.actor_id,
      };
      await client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: `${fullKey}.meta.json`,
          Body: JSON.stringify(meta),
          ContentType: "application/json",
        }),
      );
    }

    // S3 returns the size as ContentLength on HEAD, not on PUT. Re-derive
    // from the body bytes — accurate for the typical text payload.
    return { etag, size: Buffer.byteLength(body, "utf8") };
  }

  async delete(key: string): Promise<void> {
    const { client, DeleteObjectCommand } = await this.ensureClient();
    const fullKey = this.fullKey(key);
    await client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: fullKey }),
    );
    // Best-effort sidecar cleanup. Missing-key delete is a no-op on S3.
    await client
      .send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: `${fullKey}.meta.json`,
        }),
      )
      .catch(() => {});
  }

  /** Public for the S3 poller — strips any leading slash + applies prefix. */
  fullKey(key: string): string {
    const stripped = key.replace(/^\/+/, "");
    return this.prefix ? `${this.prefix}${stripped}` : stripped;
  }
}

function stripQuotes(etag: string): string {
  if (etag.startsWith('"') && etag.endsWith('"')) return etag.slice(1, -1);
  return etag;
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === "NoSuchKey" ||
    e?.name === "NotFound" ||
    e?.$metadata?.httpStatusCode === 404
  );
}

function isPreconditionFailed(err: unknown): boolean {
  const e = err as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    e?.name === "PreconditionFailed" ||
    e?.$metadata?.httpStatusCode === 412
  );
}
