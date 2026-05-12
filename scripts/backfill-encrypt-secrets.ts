#!/usr/bin/env tsx
/**
 * One-shot backfill: encrypt the `model_cards.api_key_cipher` and
 * `credentials.auth` columns in a single tenant D1 shard.
 *
 * Why: these columns were named for encryption from day one but the runtime
 * was using an identity (passthrough) Crypto, so existing rows are stored as
 * plaintext. The new code (this PR) wires real AES-256-GCM via WebCryptoAesGcm
 * and refuses to start without `PLATFORM_ROOT_SECRET`. This script walks every
 * plaintext row and rewrites it as ciphertext so the runtime can read it.
 *
 * Idempotent via try-decrypt: rows that already decrypt cleanly under the
 * current key are skipped. Re-run is safe (and is the recovery path if a
 * previous run was interrupted).
 *
 * Cutover (single-step, accepted operator-managed downtime):
 *   1. Dry-run on every shard (`--dry-run`) to surface row counts.
 *   2. Deploy the new code (the runtime starts rejecting plaintext rows
 *      immediately — model card / credential reads return 500 until step 3
 *      finishes).
 *   3. Run this script on every shard, ideally in parallel, to cap the
 *      window during which reads fail.
 *   4. Verify by re-running with --dry-run; needsEncryption must be 0.
 *
 * The PLATFORM_ROOT_SECRET MUST be the same value the worker has — derive
 * mismatch will produce ciphertext the runtime can't decrypt. Read it from
 * `wrangler secret list <worker>` if unsure (the value isn't exposed; use the
 * value you originally set).
 *
 * Usage:
 *   CF_ACCOUNT_ID=… CF_API_TOKEN=… PLATFORM_ROOT_SECRET=… \
 *     pnpm tsx scripts/backfill-encrypt-secrets.ts \
 *       --db=<d1-database-id> [--shard=<label>] [--dry-run]
 *
 *   --db          D1 database UUID for the tenant shard to migrate (required).
 *   --shard       Optional human-readable label used in log lines.
 *   --dry-run     Count rows that WOULD be touched; don't write.
 *   --account     CF account UUID (or via CF_ACCOUNT_ID env).
 *   --token       CF API token with D1:Edit on this account (or CF_API_TOKEN).
 *   --signing-key Platform root secret (or PLATFORM_ROOT_SECRET env).
 *   --page        Rows per page (default 200). Lower if you hit D1 size limits.
 */

import { WebCryptoAesGcm } from "../packages/integrations-adapters-cf/src/crypto";

interface CfApiResponse<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code?: number; message: string }>;
}

async function cf<T>(
  accountId: string,
  token: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`,
    {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init?.headers as Record<string, string> | undefined),
      },
    },
  );
  const body = (await res.json()) as CfApiResponse<T>;
  if (!body.success) {
    throw new Error(
      `CF API ${res.status}: ${body.errors?.map((e) => e.message).join("; ") ?? "unknown"}`,
    );
  }
  return body.result;
}

async function d1Query<T = Record<string, unknown>>(
  accountId: string,
  token: string,
  databaseId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const out = await cf<Array<{ results: T[] }>>(
    accountId,
    token,
    `/d1/database/${databaseId}/query`,
    { method: "POST", body: JSON.stringify({ sql, params }) },
  );
  return out[0]?.results ?? [];
}

interface BackfillResult {
  table: string;
  scanned: number;
  alreadyEncrypted: number;
  needsEncryption: number;
  encrypted: number;
  errors: Array<{ id: string; reason: string }>;
}

async function backfillColumn(opts: {
  accountId: string;
  token: string;
  dbId: string;
  table: string;
  idColumn: string;
  cipherColumn: string;
  crypto: WebCryptoAesGcm;
  pageSize: number;
  dryRun: boolean;
  validatePlaintext?: (plaintext: string) => void;
}): Promise<BackfillResult> {
  const result: BackfillResult = {
    table: `${opts.table}.${opts.cipherColumn}`,
    scanned: 0,
    alreadyEncrypted: 0,
    needsEncryption: 0,
    encrypted: 0,
    errors: [],
  };

  let lastId: string | null = null;
  while (true) {
    // Keyset-paginate by primary key. We fetch every row (no SQL-level
    // already-encrypted filter) because there's no marker — we use try-decrypt
    // per row to decide.
    const sql = lastId === null
      ? `SELECT ${opts.idColumn} AS id, ${opts.cipherColumn} AS value
         FROM ${opts.table}
         ORDER BY ${opts.idColumn}
         LIMIT ?`
      : `SELECT ${opts.idColumn} AS id, ${opts.cipherColumn} AS value
         FROM ${opts.table}
         WHERE ${opts.idColumn} > ?
         ORDER BY ${opts.idColumn}
         LIMIT ?`;
    const params = lastId === null ? [opts.pageSize] : [lastId, opts.pageSize];

    const rows = await d1Query<{ id: string; value: string }>(
      opts.accountId,
      opts.token,
      opts.dbId,
      sql,
      params,
    );
    if (rows.length === 0) break;

    result.scanned += rows.length;

    for (const row of rows) {
      // Try-decrypt under the configured key. Success ⇒ already encrypted.
      // Failure ⇒ plaintext (or corrupt — surface those in errors below).
      try {
        await opts.crypto.decrypt(row.value);
        result.alreadyEncrypted += 1;
        continue;
      } catch {
        // Fall through: treat as plaintext.
      }

      result.needsEncryption += 1;

      try {
        if (opts.validatePlaintext) opts.validatePlaintext(row.value);

        if (!opts.dryRun) {
          const encrypted = await opts.crypto.encrypt(row.value);
          await d1Query(
            opts.accountId,
            opts.token,
            opts.dbId,
            `UPDATE ${opts.table} SET ${opts.cipherColumn} = ? WHERE ${opts.idColumn} = ?`,
            [encrypted, row.id],
          );
          result.encrypted += 1;
        }
      } catch (err) {
        result.errors.push({
          id: row.id,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    console.log(
      `  [${opts.table}.${opts.cipherColumn}] scanned ${result.scanned}, ` +
        `alreadyEncrypted ${result.alreadyEncrypted}, encrypted ${result.encrypted}, ` +
        `errors ${result.errors.length}`,
    );

    lastId = rows[rows.length - 1]!.id;
    if (rows.length < opts.pageSize) break;
  }

  return result;
}

function parseArgs(): Record<string, string> {
  return Object.fromEntries(
    process.argv
      .slice(2)
      .filter((a) => a.startsWith("--"))
      .map((a) => {
        const [k, v] = a.slice(2).split("=");
        return [k!, v ?? "true"];
      }),
  );
}

async function main(): Promise<void> {
  const args = parseArgs();
  const accountId = args.account ?? process.env.CF_ACCOUNT_ID;
  const token = args.token ?? process.env.CF_API_TOKEN;
  const dbId = args.db;
  const shard = args.shard ?? dbId;
  const signingKey = args["signing-key"] ?? process.env.PLATFORM_ROOT_SECRET;
  const pageSize = parseInt(args.page ?? "200", 10);
  const dryRun = args["dry-run"] === "true";

  if (!accountId || !token || !dbId || !signingKey) {
    console.error(
      "Usage: pnpm tsx scripts/backfill-encrypt-secrets.ts \\\n" +
        "  --db=<d1-database-id> [--shard=<label>] [--dry-run]\n" +
        "Required env (or flags): CF_ACCOUNT_ID, CF_API_TOKEN, PLATFORM_ROOT_SECRET",
    );
    process.exit(1);
  }

  console.log(`[shard=${shard}] dbId=${dbId} dryRun=${dryRun} pageSize=${pageSize}`);

  const modelCardsCrypto = new WebCryptoAesGcm(signingKey, "model.cards.keys");
  const credentialsCrypto = new WebCryptoAesGcm(signingKey, "credentials.auth");

  console.log(`\n=== model_cards.api_key_cipher ===`);
  const modelCardsResult = await backfillColumn({
    accountId,
    token,
    dbId,
    table: "model_cards",
    idColumn: "id",
    cipherColumn: "api_key_cipher",
    crypto: modelCardsCrypto,
    pageSize,
    dryRun,
  });

  console.log(`\n=== credentials.auth ===`);
  const credentialsResult = await backfillColumn({
    accountId,
    token,
    dbId,
    table: "credentials",
    idColumn: "id",
    cipherColumn: "auth",
    crypto: credentialsCrypto,
    pageSize,
    dryRun,
    // credentials.auth MUST parse as JSON post-decrypt or the runtime will
    // 500 on read. Surface bad rows now rather than after they're encrypted.
    validatePlaintext: (plaintext) => {
      JSON.parse(plaintext);
    },
  });

  console.log(`\n=== Summary [shard=${shard}] ===`);
  for (const r of [modelCardsResult, credentialsResult]) {
    console.log(
      `  ${r.table}: scanned=${r.scanned}, alreadyEncrypted=${r.alreadyEncrypted}, ` +
        `encrypted=${r.encrypted}, errors=${r.errors.length}`,
    );
    if (r.errors.length > 0) {
      console.log(`    First 5 errors:`);
      for (const e of r.errors.slice(0, 5)) {
        console.log(`      ${e.id}: ${e.reason}`);
      }
    }
  }

  const totalErrors = modelCardsResult.errors.length + credentialsResult.errors.length;
  if (totalErrors > 0) {
    console.error(`\n✗ ${totalErrors} rows failed to encrypt. Investigate before re-running.`);
    process.exit(2);
  }

  if (dryRun) {
    console.log(
      `\n✓ Dry run complete. No writes performed. Re-run without --dry-run to apply.`,
    );
  } else {
    const remaining = modelCardsResult.needsEncryption + credentialsResult.needsEncryption -
      modelCardsResult.encrypted - credentialsResult.encrypted;
    if (remaining === 0) {
      console.log(
        `\n✓ Backfill complete. Verify by re-running with --dry-run; needsEncryption must be 0.`,
      );
    } else {
      console.error(`\n✗ ${remaining} rows still need encryption. Re-run.`);
      process.exit(2);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
