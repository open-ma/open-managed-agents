#!/usr/bin/env -S npx tsx
/**
 * One-shot data migration: copy `memories.content` from D1 → R2 keyed by
 * `<store_id>/<memory_path>`, ahead of migration 0010_memory_anthropic_alignment.sql
 * which drops the content column.
 *
 * Why this script exists:
 *   The Anthropic-aligned rewrite makes R2 the bytes-of-truth for memory
 *   content (D1 keeps only the index + audit). Migration 0010 rebuilds the
 *   `memories` table without the content column. Without this back-fill the
 *   bytes are gone after 0010 runs.
 *
 * Deploy sequence:
 *   1. Deploy new code (apps/main + apps/agent + apps/console) — but DO NOT
 *      apply migration 0010 yet.
 *   2. Run THIS script: `pnpm tsx scripts/migrate-memories-to-r2.ts --commit`.
 *   3. Apply migration 0010 (drops content column).
 *
 * Idempotency:
 *   - If R2 already has an object at <store_id>/<path> with matching size,
 *     we skip the PUT. Re-running is safe.
 *
 * Caveat — etag back-fill:
 *   The post-0010 `memories` table has an `etag TEXT` column populated from
 *   the R2 PUT result on subsequent writes. Existing rows will have NULL
 *   etag until their first re-write through the new service. CAS updates
 *   against a NULL etag will fail with 409, prompting clients to re-read
 *   and retry — which restores the etag in the same write.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=...           # account-scoped token w/ D1 read + R2 write
 *   CLOUDFLARE_ACCOUNT_ID=...
 *   D1_DATABASE_ID=...                 # the openma-auth (or staging) database id
 *   R2_BUCKET=managed-agents-memory    # target memory bucket
 *   pnpm tsx scripts/migrate-memories-to-r2.ts [--tenant <id>] [--commit]
 *
 * Without --commit: dry run. Prints how many rows would be migrated, their
 * total bytes, and a sample of paths. No writes.
 *
 * With --commit: actually writes to R2. Reads paged from D1; PUTs in batches
 * of 50; reports progress every batch.
 */

import { argv, env, exit } from "node:process";

interface MemoryRow {
  id: string;
  store_id: string;
  path: string;
  content: string;
  content_sha256: string;
  size_bytes: number;
}

const CF_API = "https://api.cloudflare.com/client/v4";

async function main(): Promise<void> {
  const args = argv.slice(2);
  const commit = args.includes("--commit");
  const tenantIdx = args.indexOf("--tenant");
  const tenantFilter = tenantIdx !== -1 ? args[tenantIdx + 1] : undefined;

  const apiToken = env.CLOUDFLARE_API_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const databaseId = env.D1_DATABASE_ID;
  const bucket = env.R2_BUCKET;

  if (!apiToken || !accountId || !databaseId || !bucket) {
    console.error(
      "Missing required env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID, R2_BUCKET",
    );
    exit(1);
  }

  console.log(`Mode:     ${commit ? "COMMIT (will write to R2)" : "DRY RUN (no writes)"}`);
  console.log(`Account:  ${accountId}`);
  console.log(`Database: ${databaseId}`);
  console.log(`Bucket:   ${bucket}`);
  if (tenantFilter) console.log(`Tenant:   ${tenantFilter}`);
  console.log();

  // 1. Pull every memory row that needs migrating. We page on (id) so re-runs
  // resume reliably even if the underlying table is being touched.
  console.log("Scanning memories table...");
  const rows = await fetchAllMemories({
    apiToken, accountId, databaseId, tenantFilter,
  });
  const totalBytes = rows.reduce((acc, r) => acc + r.size_bytes, 0);
  console.log(`Found ${rows.length} memories, ${humanBytes(totalBytes)} total.`);
  if (rows.length > 0) {
    console.log(`Sample paths:`);
    for (const r of rows.slice(0, 5)) console.log(`  ${r.store_id}/${r.path}`);
    if (rows.length > 5) console.log(`  … and ${rows.length - 5} more`);
  }

  if (!commit) {
    console.log("\nDry run complete. Re-run with --commit to perform the migration.");
    return;
  }

  console.log("\nMigrating to R2...");
  let migrated = 0, skipped = 0, failed = 0;
  const sampleErrors: Array<{ key: string; err: string }> = [];
  const batchSize = 50;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (row) => {
        const key = r2Key(row.store_id, row.path);
        try {
          // Idempotency: HEAD the object; if present with the right size,
          // assume it matches (size + sha256 from app layer is enough).
          const head = await r2Head({ apiToken, accountId, bucket, key });
          if (head && head.size === row.size_bytes) {
            skipped++;
            return;
          }
          await r2Put({
            apiToken, accountId, bucket, key,
            body: row.content,
            customMetadata: {
              content_sha256: row.content_sha256,
              migrated_from_d1_id: row.id,
            },
          });
          migrated++;
        } catch (err) {
          failed++;
          if (sampleErrors.length < 10) {
            sampleErrors.push({ key, err: errMsg(err) });
          }
        }
      }),
    );
    console.log(`  batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(rows.length / batchSize)} — migrated=${migrated} skipped=${skipped} failed=${failed}`);
  }

  console.log(`\nDone. migrated=${migrated} skipped=${skipped} failed=${failed}`);
  if (sampleErrors.length) {
    console.log("\nSample errors:");
    for (const e of sampleErrors) console.log(`  ${e.key}: ${e.err}`);
  }
  console.log(
    "\nNext step: apply migration 0010_memory_anthropic_alignment.sql " +
    "(`pnpm wrangler d1 migrations apply ...`).",
  );
}

// =================================================================
// D1 access
// =================================================================

async function fetchAllMemories(opts: {
  apiToken: string;
  accountId: string;
  databaseId: string;
  tenantFilter?: string;
}): Promise<MemoryRow[]> {
  const all: MemoryRow[] = [];
  let lastId = "";
  // Page-by-id loop so we don't hit D1's per-query result cap. 500 rows/page.
  // Single-pass; if the table is being mutated mid-migration we may miss
  // newly-inserted rows but won't double-process anything.
  for (;;) {
    const sql = opts.tenantFilter
      ? `SELECT m.id, m.store_id, m.path, m.content, m.content_sha256, m.size_bytes
         FROM memories m JOIN memory_stores s ON s.id = m.store_id
         WHERE m.id > ? AND s.tenant_id = ? AND m.content IS NOT NULL
         ORDER BY m.id LIMIT 500`
      : `SELECT id, store_id, path, content, content_sha256, size_bytes
         FROM memories WHERE id > ? AND content IS NOT NULL
         ORDER BY id LIMIT 500`;
    const params = opts.tenantFilter ? [lastId, opts.tenantFilter] : [lastId];
    const result = await d1Query<MemoryRow>(opts, sql, params);
    if (result.length === 0) break;
    all.push(...result);
    lastId = result[result.length - 1].id;
    if (all.length % 5000 === 0) {
      console.log(`  scanned ${all.length} rows so far...`);
    }
  }
  return all;
}

async function d1Query<T>(
  opts: { apiToken: string; accountId: string; databaseId: string },
  sql: string,
  params: unknown[],
): Promise<T[]> {
  const resp = await fetch(
    `${CF_API}/accounts/${opts.accountId}/d1/database/${opts.databaseId}/query`,
    {
      method: "POST",
      headers: {
        "authorization": `Bearer ${opts.apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
    },
  );
  if (!resp.ok) {
    throw new Error(`D1 query ${resp.status}: ${await resp.text()}`);
  }
  const json = await resp.json() as {
    success: boolean;
    errors?: Array<{ message: string }>;
    result: Array<{ results: T[] }>;
  };
  if (!json.success) {
    throw new Error(`D1 query failed: ${JSON.stringify(json.errors ?? [])}`);
  }
  return json.result?.[0]?.results ?? [];
}

// =================================================================
// R2 access (REST API; binding API isn't available outside a Worker)
// =================================================================

async function r2Head(opts: {
  apiToken: string;
  accountId: string;
  bucket: string;
  key: string;
}): Promise<{ size: number } | null> {
  const url = `${CF_API}/accounts/${opts.accountId}/r2/buckets/${opts.bucket}/objects/${encodeR2Key(opts.key)}`;
  const resp = await fetch(url, {
    method: "HEAD",
    headers: { "authorization": `Bearer ${opts.apiToken}` },
  });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`R2 HEAD ${resp.status}: ${await resp.text()}`);
  const sizeHdr = resp.headers.get("content-length");
  return { size: sizeHdr ? parseInt(sizeHdr, 10) : 0 };
}

async function r2Put(opts: {
  apiToken: string;
  accountId: string;
  bucket: string;
  key: string;
  body: string;
  customMetadata?: Record<string, string>;
}): Promise<void> {
  const url = `${CF_API}/accounts/${opts.accountId}/r2/buckets/${opts.bucket}/objects/${encodeR2Key(opts.key)}`;
  const headers: Record<string, string> = {
    "authorization": `Bearer ${opts.apiToken}`,
    "content-type": "application/octet-stream",
  };
  if (opts.customMetadata) {
    for (const [k, v] of Object.entries(opts.customMetadata)) {
      headers[`x-amz-meta-${k}`] = v;
    }
  }
  const resp = await fetch(url, {
    method: "PUT",
    headers,
    body: opts.body,
  });
  if (!resp.ok) {
    throw new Error(`R2 PUT ${resp.status}: ${await resp.text()}`);
  }
}

// =================================================================
// helpers
// =================================================================

/**
 * R2 key for a memory: <store_id>/<memory_path>. We strip a leading slash on
 * the memory path to avoid R2 keys with double slashes — must mirror the
 * convention in packages/memory-store/src/service.ts:r2Key.
 */
function r2Key(storeId: string, memoryPath: string): string {
  const p = memoryPath.startsWith("/") ? memoryPath.slice(1) : memoryPath;
  return `${storeId}/${p}`;
}

/** R2 REST URL path-encodes the key — use encodeURIComponent on each segment. */
function encodeR2Key(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

main().catch((err) => {
  console.error("FATAL:", err);
  exit(1);
});
