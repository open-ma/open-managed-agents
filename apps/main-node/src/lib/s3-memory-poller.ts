// S3 memory poller — keeps the SQL `memories` index in sync with writes
// that hit the bucket directly (sandbox FUSE → s3fs → S3 PUT). Plays the
// same role as chokidar for LocalFsBlobStore but for the S3 path that
// remote sandboxes use.
//
// How it runs:
//   - Every N seconds (default 30), list every memory store registered in
//     the `memory_stores` table; for each store the lease holder LISTs
//     the bucket prefix `<storeId>/`, fetches new/changed objects since
//     `last_seen_ms`, and calls memoryRepo.upsertFromEvent with the same
//     payload shape the chokidar watcher uses.
//   - Multi-replica safe via a `memory_blob_poller_lease` row per store.
//     Acquired with INSERT ... ON CONFLICT DO UPDATE WHERE expires_at <
//     now (atomic claim). Lease TTL 60s; the holder bumps `expires_at`
//     each cycle. If the holder dies, another replica claims the next
//     poll.
//
// Why polling and not S3 event notifications: most S3-compatible
// endpoints (MinIO, R2 in S3 mode, Wasabi) ship with very different
// notification setups. A 30s LIST against a per-store prefix bounds the
// blast radius while keeping the operator setup to "set 4 env vars".
// Operators on AWS S3 with SQS / SNS notifications can wire those up
// later as a separate adapter behind the same MemoryRepo sink.
//
// Sidecar `.meta.json` keys are filtered out by suffix — we treat them
// as opaque storage of actor metadata, same as chokidar.

import { createHash } from "node:crypto";
import { generateMemoryVersionId } from "@open-managed-agents/shared";
import { getLogger } from "@open-managed-agents/observability";
import type { MemoryRepo } from "@open-managed-agents/memory-store";
import type { SqlClient } from "@open-managed-agents/sql-client";

const log = getLogger("s3-memory-poller");

interface PollerS3Object {
  Key?: string;
  LastModified?: Date;
  ETag?: string;
  Size?: number;
}
interface PollerListOutput {
  Contents?: PollerS3Object[];
  IsTruncated?: boolean;
  NextContinuationToken?: string;
}
interface PollerGetOutput {
  Body?: { transformToByteArray(): Promise<Uint8Array> };
}
type PollerCmdCtor<I, O> = new (input: I) => { output?: O };
interface PollerS3Client {
  send<O>(command: { output?: O }): Promise<O>;
  destroy(): void;
}

export interface S3MemoryPollerOptions {
  sql: SqlClient;
  sqlDialect: "postgres" | "sqlite";
  memoryRepo: MemoryRepo;
  /** Per-process token used as the lease owner — survives only this process. */
  replicaId: string;
  intervalMs: number;
  s3: {
    endpoint: string;
    bucket: string;
    accessKey: string;
    secretKey: string;
    region: string;
  };
}

const LEASE_TTL_MS = 60_000;

export async function startS3MemoryPoller(
  opts: S3MemoryPollerOptions,
): Promise<{ stop: () => Promise<void> }> {
  const sdk = (await import(
    /* @vite-ignore */ "@aws-sdk/client-s3" as string
  )) as {
    S3Client: new (cfg: unknown) => PollerS3Client;
    ListObjectsV2Command: PollerCmdCtor<unknown, PollerListOutput>;
    GetObjectCommand: PollerCmdCtor<unknown, PollerGetOutput>;
  };
  const client = new sdk.S3Client({
    endpoint: opts.s3.endpoint,
    region: opts.s3.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: opts.s3.accessKey,
      secretAccessKey: opts.s3.secretKey,
    },
  });

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;

  const tick = async () => {
    if (stopped) return;
    inFlight = runOnce(opts, client, sdk).catch((err) => {
      log.warn({ err, op: "s3_poller.tick_failed" }, "tick failed");
    });
    await inFlight;
    inFlight = null;
    if (!stopped) timer = setTimeout(tick, opts.intervalMs);
  };

  log.info(
    { op: "s3_poller.started", bucket: opts.s3.bucket, interval_ms: opts.intervalMs, replica_id: opts.replicaId },
    "s3 memory poller started",
  );
  // Kick off first cycle on next tick so other init can finish.
  timer = setTimeout(tick, 0);

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (inFlight) await inFlight.catch(() => {});
      try {
        client.destroy();
      } catch {
        /* best-effort */
      }
    },
  };
}

async function runOnce(
  opts: S3MemoryPollerOptions,
  client: PollerS3Client,
  sdk: {
    ListObjectsV2Command: PollerCmdCtor<unknown, PollerListOutput>;
    GetObjectCommand: PollerCmdCtor<unknown, PollerGetOutput>;
  },
): Promise<void> {
  const stores = await opts.sql
    .prepare(`SELECT id FROM memory_stores WHERE archived_at IS NULL`)
    .all<{ id: string }>();
  for (const row of stores.results ?? []) {
    const claimed = await tryClaimLease(opts, row.id);
    if (!claimed) continue;
    try {
      await pollStore(opts, client, sdk, row.id, claimed.lastSeenMs);
    } catch (err) {
      log.warn({ err, op: "s3_poller.store_failed", store_id: row.id }, "store poll failed");
    }
  }
}

interface ClaimedLease {
  lastSeenMs: number;
}

async function tryClaimLease(
  opts: S3MemoryPollerOptions,
  storeId: string,
): Promise<ClaimedLease | null> {
  const now = Date.now();
  const expiresAt = now + LEASE_TTL_MS;
  // Atomic claim: insert a row, or take it from a holder whose lease
  // expired. ON CONFLICT DO UPDATE ... WHERE excluded.expires_at >
  // memory_blob_poller_lease.expires_at lets the conflicting INSERT win
  // when the existing row is stale.
  const upsert = await opts.sql
    .prepare(
      `INSERT INTO memory_blob_poller_lease (store_id, owner, expires_at, last_seen_ms)
       VALUES (?, ?, ?, 0)
       ON CONFLICT(store_id) DO UPDATE
         SET owner = excluded.owner,
             expires_at = excluded.expires_at
         WHERE memory_blob_poller_lease.expires_at < excluded.expires_at
            OR memory_blob_poller_lease.owner = excluded.owner`,
    )
    .bind(storeId, opts.replicaId, expiresAt)
    .run();
  // SQLite returns changes=0 when WHERE filtered the update out; PG also
  // returns rowCount=0. In either case we lost the race.
  if ((upsert.meta?.changes ?? 0) === 0) {
    // Re-check: maybe we already own a fresh lease (renewing).
    const existing = await opts.sql
      .prepare(
        `SELECT owner, expires_at, last_seen_ms FROM memory_blob_poller_lease WHERE store_id = ?`,
      )
      .bind(storeId)
      .first<{ owner: string; expires_at: number; last_seen_ms: number }>();
    if (!existing) return null;
    if (existing.owner !== opts.replicaId) return null;
    return { lastSeenMs: existing.last_seen_ms ?? 0 };
  }
  // Read back last_seen_ms for the cycle.
  const row = await opts.sql
    .prepare(
      `SELECT last_seen_ms FROM memory_blob_poller_lease WHERE store_id = ?`,
    )
    .bind(storeId)
    .first<{ last_seen_ms: number }>();
  return { lastSeenMs: row?.last_seen_ms ?? 0 };
}

async function pollStore(
  opts: S3MemoryPollerOptions,
  client: PollerS3Client,
  sdk: {
    ListObjectsV2Command: PollerCmdCtor<unknown, PollerListOutput>;
    GetObjectCommand: PollerCmdCtor<unknown, PollerGetOutput>;
  },
  storeId: string,
  lastSeenMs: number,
): Promise<void> {
  const prefix = `${storeId}/`;
  let token: string | undefined = undefined;
  let highWater = lastSeenMs;
  do {
    const list: PollerListOutput = await client.send(
      new sdk.ListObjectsV2Command({
        Bucket: opts.s3.bucket,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    for (const obj of list.Contents ?? []) {
      if (!obj.Key) continue;
      // Sidecar metadata files are managed alongside the content; ignore
      // them as a memory write — they get re-emitted by the .json key
      // suffix filter and have no place in the SQL index.
      if (obj.Key.endsWith(".meta.json")) continue;
      const lm = obj.LastModified instanceof Date ? obj.LastModified.getTime() : 0;
      if (lm <= lastSeenMs) continue;
      const memoryPath = "/" + obj.Key.slice(prefix.length);
      const get: PollerGetOutput = await client.send(
        new sdk.GetObjectCommand({ Bucket: opts.s3.bucket, Key: obj.Key }),
      );
      const bytes = (await get.Body?.transformToByteArray()) ?? new Uint8Array();
      const text = Buffer.from(bytes).toString("utf8");
      const sha = createHash("sha256").update(bytes).digest("hex");
      await opts.memoryRepo.upsertFromEvent({
        storeId,
        path: memoryPath,
        contentSha256: sha,
        // Use sha as etag so the memoryRepo dedupe matches the chokidar
        // path exactly. S3's own ETag is fine for CAS but the watcher
        // uses sha and the repo dedupes on the etag column verbatim.
        etag: sha,
        sizeBytes: bytes.byteLength,
        actor: { type: "agent_session", id: "s3-poller" },
        nowMs: Date.now(),
        versionId: generateMemoryVersionId(),
        content: text,
      });
      if (lm > highWater) highWater = lm;
    }
    token = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (token);
  // Renew lease + advance high-water so the next cycle skips already-seen
  // objects. Keep `expires_at` fresh in case we fell behind on the tick.
  const expiresAt = Date.now() + LEASE_TTL_MS;
  await opts.sql
    .prepare(
      `UPDATE memory_blob_poller_lease
          SET expires_at = ?, last_seen_ms = ?
        WHERE store_id = ? AND owner = ?`,
    )
    .bind(expiresAt, highWater, storeId, opts.replicaId)
    .run();
}
