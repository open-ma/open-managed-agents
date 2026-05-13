// S3 path round-trip smoke. Verifies the S3BlobStore + S3 memory poller
// pipeline against a real S3-compatible endpoint.
//
// Skipped unless MEMORY_S3_TEST_* env vars are set. Run locally with:
//   docker run --rm -p 19000:9000 -e MINIO_ROOT_USER=minioadmin \
//     -e MINIO_ROOT_PASSWORD=minioadmin minio/minio:latest server /data
//   docker run --rm --network host minio/mc \
//     mb minio-local/oma-memory-test
//   MEMORY_S3_TEST_ENDPOINT=http://127.0.0.1:19000 \
//     MEMORY_S3_TEST_BUCKET=oma-memory-test \
//     MEMORY_S3_TEST_ACCESS_KEY=minioadmin \
//     MEMORY_S3_TEST_SECRET_KEY=minioadmin \
//     PG_TEST_URL=postgres://oma:oma@127.0.0.1:54329/oma \
//     pnpm --filter @open-managed-agents/main-node test s3
//
// Asserts:
//   1. S3BlobStore.put → head → getText → delete round-trip.
//   2. Direct bucket PUT (simulating sandbox FUSE write) lands in the
//      SQL `memories` index after one S3 poller cycle.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createPostgresSqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import { SqlMemoryRepo } from "@open-managed-agents/memory-store";
import { S3BlobStore } from "@open-managed-agents/memory-store/adapters/s3-blob";
import { startS3MemoryPoller } from "../src/lib/s3-memory-poller.js";

const PG_URL = process.env.PG_TEST_URL ?? "";
const endpoint = process.env.MEMORY_S3_TEST_ENDPOINT ?? "";
const bucket = process.env.MEMORY_S3_TEST_BUCKET ?? "";
const accessKey = process.env.MEMORY_S3_TEST_ACCESS_KEY ?? "";
const secretKey = process.env.MEMORY_S3_TEST_SECRET_KEY ?? "";
const region = process.env.MEMORY_S3_TEST_REGION ?? "us-east-1";

const enabled =
  (PG_URL.startsWith("postgres://") || PG_URL.startsWith("postgresql://")) &&
  endpoint && bucket && accessKey && secretKey;

const d = enabled ? describe : describe.skip;

let sql: SqlClient;
let blobs: S3BlobStore;
let storeId = "";

beforeAll(async () => {
  if (!enabled) return;
  sql = await createPostgresSqlClient(PG_URL);
  // Schema bits the poller needs.
  await sql.exec(`
    CREATE TABLE IF NOT EXISTS "memory_stores" (
      "id"          TEXT PRIMARY KEY NOT NULL,
      "tenant_id"   TEXT NOT NULL,
      "name"        TEXT NOT NULL,
      "description" TEXT,
      "created_at"  BIGINT NOT NULL,
      "updated_at"  BIGINT,
      "archived_at" BIGINT
    );
    CREATE TABLE IF NOT EXISTS "memories" (
      "id"             TEXT PRIMARY KEY NOT NULL,
      "store_id"       TEXT NOT NULL,
      "path"           TEXT NOT NULL,
      "content_sha256" TEXT NOT NULL,
      "etag"           TEXT NOT NULL,
      "size_bytes"     BIGINT NOT NULL,
      "created_at"     BIGINT NOT NULL,
      "updated_at"     BIGINT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "idx_memories_store_path"
      ON "memories" ("store_id", "path");
    CREATE TABLE IF NOT EXISTS "memory_versions" (
      "id"             TEXT PRIMARY KEY NOT NULL,
      "memory_id"      TEXT NOT NULL,
      "store_id"       TEXT NOT NULL,
      "operation"      TEXT NOT NULL,
      "path"           TEXT NOT NULL,
      "content"        TEXT NOT NULL,
      "content_sha256" TEXT NOT NULL,
      "size_bytes"     BIGINT NOT NULL,
      "actor_type"     TEXT NOT NULL,
      "actor_id"       TEXT NOT NULL,
      "created_at"     BIGINT NOT NULL,
      "redacted"       INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS "memory_blob_poller_lease" (
      "store_id"     TEXT PRIMARY KEY NOT NULL,
      "owner"        TEXT NOT NULL,
      "expires_at"   BIGINT NOT NULL,
      "last_seen_ms" BIGINT NOT NULL DEFAULT 0
    );
  `);
  storeId = `ms_test_${Date.now().toString(36)}`;
  await sql
    .prepare(
      `INSERT INTO memory_stores (id, tenant_id, name, created_at) VALUES (?, ?, ?, ?)`,
    )
    .bind(storeId, "tn_test", "test", Date.now())
    .run();
  blobs = new S3BlobStore({
    endpoint,
    bucket,
    accessKeyId: accessKey,
    secretAccessKey: secretKey,
    region,
  });
});

afterAll(async () => {
  if (!enabled) return;
  await sql.prepare(`DELETE FROM memories WHERE store_id = ?`).bind(storeId).run();
  await sql.prepare(`DELETE FROM memory_versions WHERE store_id = ?`).bind(storeId).run();
  await sql.prepare(`DELETE FROM memory_stores WHERE id = ?`).bind(storeId).run();
  await sql.prepare(`DELETE FROM memory_blob_poller_lease WHERE store_id = ?`).bind(storeId).run();
});

d("S3BlobStore + S3 memory poller", () => {
  it("PUT → HEAD → GET → DELETE round-trip", async () => {
    const key = `${storeId}/notes/hello.md`;
    const meta = await blobs.put(key, "hello s3");
    expect(meta?.size).toBe("hello s3".length);
    const head = await blobs.head(key);
    expect(head?.size).toBe("hello s3".length);
    const got = await blobs.getText(key);
    expect(got?.text).toBe("hello s3");
    await blobs.delete(key);
    expect(await blobs.head(key)).toBeNull();
  }, 30_000);

  it("direct bucket PUT lands in SQL index after one poller cycle", async () => {
    // Write directly via the BlobStore — analogous to a sandbox FUSE write
    // that bypasses the REST handler.
    const path = "thoughts/2026-05-12.md";
    const key = `${storeId}/${path}`;
    await blobs.put(key, "via direct bucket put");

    const memoryRepo = new SqlMemoryRepo(sql);
    const poller = await startS3MemoryPoller({
      sql,
      sqlDialect: "postgres",
      memoryRepo,
      replicaId: `test_${process.pid}`,
      // Short interval so the test isn't slow; the lease still works.
      intervalMs: 1_000,
      s3: {
        endpoint,
        bucket,
        accessKey,
        secretKey,
        region,
      },
    });
    try {
      // Poller fires immediately; allow ~2s for it to claim the lease,
      // LIST, GET, and upsert.
      let row: { path: string; size_bytes: number } | null = null;
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        row = await sql
          .prepare(
            `SELECT path, size_bytes FROM memories WHERE store_id = ? AND path = ?`,
          )
          .bind(storeId, "/" + path)
          .first<{ path: string; size_bytes: number }>();
        if (row) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(row, "S3 poller should have indexed the direct bucket write").not.toBeNull();
      expect(row?.size_bytes).toBe("via direct bucket put".length);
    } finally {
      await poller.stop();
      await blobs.delete(key);
    }
  }, 30_000);
});
