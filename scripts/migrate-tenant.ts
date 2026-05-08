#!/usr/bin/env -S npx tsx
/**
 * Migrate one tenant's data from one shard binding to another.
 *
 * The hard part: D1 doesn't have cross-database transactions. The approach
 * here is "copy-then-flip-then-cleanup":
 *
 *   1. Mark the source shard as 'draining' so the operator knows nothing
 *      else should be assigned there.
 *   2. For each per-tenant table, dump the tenant's rows from source via
 *      the CF REST API + INSERT them into target.
 *   3. Flip `tenant_shard.binding_name` for this tenant in the control
 *      plane. From this point on, new requests for this tenant resolve
 *      to the target binding.
 *   4. Tell the operator to restart workers (or flush the per-isolate
 *      cache via a future /admin/cache/flush endpoint). MetaTableTenantDbProvider
 *      caches forever; live isolates will keep talking to the OLD binding
 *      until restart.
 *   5. After verifying traffic moved + nothing broke, manually delete the
 *      old rows from the source shard. We don't auto-delete because once
 *      data is gone it's gone — operator should sanity check first.
 *
 * IMPORTANT — there is a write window between step 2 and step 4 where
 * writes to the source shard are NOT mirrored to the target. To do this
 * cleanly you should either:
 *   - take a brief read-only window for the tenant (set a lockout flag in
 *     the app layer, deny writes, run migration, lift), OR
 *   - accept that any writes that land on the source between dump and
 *     restart need to be re-replayed by hand.
 *
 * This script does NOT implement read-only mode. That's app-layer concern
 * and depends on your service shape. For low-traffic / off-hours migrations
 * the simpler approach is "schedule a 60s window, restart workers right
 * after the flip".
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=...                                   \
 *   CLOUDFLARE_ACCOUNT_ID=...                                  \
 *   CONTROL_DB_ID=...                                          \
 *     pnpm tsx scripts/migrate-tenant.ts <tenant_id> <from_binding> <to_binding> [--commit]
 *
 * Without --commit: dry-run, prints how many rows per table would move,
 * does not write anything.
 *
 * With --commit: actually copies + flips. You still have to manually
 * delete from source + restart workers afterwards.
 */

import { argv, env, exit } from "node:process";

// Per-tenant tables — keep in sync with apps/main/migrations/0001 schema +
// 0002 (the integrations tables that gained tenant_id). Tables that are
// linked through other rows (e.g. session_resources via session_id) are
// included here too — anything filterable by tenant_id directly OR via a
// well-defined JOIN belongs in this list.
// Tables in AUTH_DB that carry tenant_id directly. Integration tables
// (linear_*/github_*/slack_*) used to live here but moved to INTEGRATIONS_DB
// in the integration subsystem split. This script only touches AUTH_DB.
const TENANT_TABLES_BY_TENANT_ID = [
  "agents",
  "agent_versions",
  "credentials",
  "environments",
  "eval_runs",
  "files",
  "memory_stores",
  "model_cards",
  "sessions",
  "vaults",
] as const;

// Tables that don't have tenant_id directly but cascade from a tenant table.
// migrate_via tells the script how to filter rows: via the parent table's
// id column. Order matters — parents must be migrated before children
// (here memories live under memory_stores; session_resources under sessions).
const TENANT_TABLES_VIA_PARENT = [
  { table: "memories", parent: "memory_stores", parent_key: "store_id" },
  { table: "memory_versions", parent: "memory_stores", parent_key: "store_id" },
  { table: "session_resources", parent: "sessions", parent_key: "session_id" },
] as const;

interface CfApiSuccess<T> {
  success: true;
  result: T;
}
interface CfApiFail {
  success: false;
  errors: Array<{ code?: number; message: string }>;
}

async function cf<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  const body = (await res.json()) as CfApiSuccess<T> | CfApiFail;
  if (!body.success) {
    throw new Error(`CF API ${res.status}: ${body.errors.map((e) => e.message).join("; ")}`);
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
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
    token,
    { method: "POST", body: JSON.stringify({ sql, params }) },
  );
  return out[0]?.results ?? [];
}

async function lookupBindingDatabaseId(
  accountId: string,
  token: string,
  controlDbId: string,
  bindingName: string,
): Promise<string> {
  // shard_pool doesn't store database_id directly — bindings are resolved
  // via wrangler config in the worker. For an out-of-band script we map
  // binding name to D1 database name via convention, then look up the id
  // via CF REST. (See shard-pool-monitor.ts for the same convention.)
  const dbName =
    bindingName === "AUTH_DB"
      ? env.ENV === "staging"
        ? "openma-auth-staging"
        : "openma-auth"
      : env.ENV === "staging"
        ? `oma-tenant-${bindingName.slice("TENANT_DB_".length)}-staging`
        : `oma-tenant-${bindingName.slice("TENANT_DB_".length)}`;
  const list = await cf<Array<{ uuid: string; name: string }>>(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database?name=${encodeURIComponent(dbName)}`,
    token,
  );
  const hit = list.find((d) => d.name === dbName);
  if (!hit) {
    throw new Error(
      `lookupBindingDatabaseId: no D1 database named "${dbName}" for binding "${bindingName}"`,
    );
  }
  return hit.uuid;
}

function quote(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function buildInsert(table: string, row: Record<string, unknown>): string {
  const cols = Object.keys(row);
  const vals = cols.map((c) => quote(row[c]));
  return `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${vals.join(", ")})`;
}

async function copyRows(
  accountId: string,
  token: string,
  fromDbId: string,
  toDbId: string,
  table: string,
  whereSql: string,
  commit: boolean,
): Promise<number> {
  const rows = await d1Query<Record<string, unknown>>(
    accountId,
    token,
    fromDbId,
    `SELECT * FROM "${table}" WHERE ${whereSql}`,
  );
  if (rows.length === 0) return 0;
  if (!commit) return rows.length;
  // Insert in batches of 50 to keep request size reasonable
  const batchSize = 50;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const sql = batch.map((r) => buildInsert(table, r)).join("; ");
    await d1Query(accountId, token, toDbId, sql);
  }
  return rows.length;
}

async function main(): Promise<void> {
  const token = env.CLOUDFLARE_API_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const controlDbId = env.CONTROL_DB_ID;
  const tenantId = argv[2];
  const fromBinding = argv[3];
  const toBinding = argv[4];
  const commit = argv.includes("--commit");

  if (!token || !accountId || !controlDbId || !tenantId || !fromBinding || !toBinding) {
    console.error(
      "usage: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... CONTROL_DB_ID=... pnpm tsx scripts/migrate-tenant.ts <tenant_id> <from_binding> <to_binding> [--commit]",
    );
    exit(1);
  }
  if (fromBinding === toBinding) {
    console.error("from and to bindings are identical; nothing to do");
    exit(1);
  }

  console.log(`[migrate-tenant] tenantId=${tenantId} ${fromBinding} → ${toBinding}`);
  if (!commit) console.log("[migrate-tenant] DRY RUN (no writes; pass --commit to actually move)");

  const fromDbId = await lookupBindingDatabaseId(accountId, token, controlDbId, fromBinding);
  const toDbId = await lookupBindingDatabaseId(accountId, token, controlDbId, toBinding);
  console.log(`  resolved: ${fromBinding}=${fromDbId}  ${toBinding}=${toDbId}`);

  // Sanity: tenant must currently be assigned to fromBinding (or unassigned,
  // which means it falls back to AUTH_DB).
  const current = await d1Query<{ binding_name: string }>(
    accountId,
    token,
    controlDbId,
    `SELECT binding_name FROM tenant_shard WHERE tenant_id = '${tenantId.replace(/'/g, "''")}'`,
  );
  const currentBinding = current[0]?.binding_name ?? "AUTH_DB"; // unassigned = fallback
  if (currentBinding !== fromBinding) {
    console.error(
      `tenant_shard says tenant ${tenantId} is currently on "${currentBinding}", not "${fromBinding}". Refusing.`,
    );
    exit(1);
  }

  // 1. Mark source draining (idempotent).
  if (commit) {
    await d1Query(
      accountId,
      token,
      controlDbId,
      `UPDATE shard_pool SET status = 'draining' WHERE binding_name = '${fromBinding.replace(/'/g, "''")}' AND status = 'open'`,
    );
    console.log(`  [1/5] marked ${fromBinding} as draining (if it was open)`);
  } else {
    console.log(`  [1/5] would mark ${fromBinding} as draining`);
  }

  // 2. Copy rows for each per-tenant table.
  let total = 0;
  for (const t of TENANT_TABLES_BY_TENANT_ID) {
    const n = await copyRows(
      accountId,
      token,
      fromDbId,
      toDbId,
      t,
      `tenant_id = '${tenantId.replace(/'/g, "''")}'`,
      commit,
    );
    total += n;
    if (n > 0) console.log(`  [2/5] ${t}: ${n} row(s)`);
  }
  // Tables that filter via parent.
  for (const cfg of TENANT_TABLES_VIA_PARENT) {
    const n = await copyRows(
      accountId,
      token,
      fromDbId,
      toDbId,
      cfg.table,
      `${cfg.parent_key} IN (SELECT id FROM "${cfg.parent}" WHERE tenant_id = '${tenantId.replace(/'/g, "''")}')`,
      commit,
    );
    total += n;
    if (n > 0) console.log(`  [2/5] ${cfg.table}: ${n} row(s) via ${cfg.parent}`);
  }
  console.log(`  [2/5] total rows ${commit ? "copied" : "to copy"}: ${total}`);

  // 3. Flip tenant_shard. INSERT OR REPLACE so a previously-unassigned
  // tenant (no row) still gets one written.
  if (commit) {
    const now = Date.now();
    await d1Query(
      accountId,
      token,
      controlDbId,
      `INSERT OR REPLACE INTO tenant_shard (tenant_id, binding_name, created_at) VALUES ('${tenantId.replace(/'/g, "''")}', '${toBinding.replace(/'/g, "''")}', ${now})`,
    );
    console.log(`  [3/5] tenant_shard flipped: ${tenantId} → ${toBinding}`);
  } else {
    console.log(`  [3/5] would flip tenant_shard: ${tenantId} → ${toBinding}`);
  }

  // 4. Tell operator to restart.
  console.log(`  [4/5] RESTART WORKERS now (cache invalidate). MetaTableTenantDbProvider caches per-isolate forever — until restart, live isolates keep routing this tenant to ${fromBinding}.`);

  // 5. Manual cleanup hint.
  console.log(`  [5/5] After verifying traffic moved + no errors, run:`);
  console.log(`        wrangler d1 execute <db_for_${fromBinding}> --remote --command \\`);
  for (const t of TENANT_TABLES_BY_TENANT_ID) {
    console.log(`          \"DELETE FROM ${t} WHERE tenant_id = '${tenantId}';\"`);
  }
  for (const cfg of TENANT_TABLES_VIA_PARENT) {
    console.log(`          \"DELETE FROM ${cfg.table} WHERE ${cfg.parent_key} IN (SELECT id FROM ${cfg.parent} WHERE tenant_id = '${tenantId}');\"`);
  }
  console.log(`        # do these LAST, after restart and traffic verification`);

  console.log("[migrate-tenant] done" + (commit ? "" : " (dry-run)"));
}

main().catch((err) => {
  console.error(err);
  exit(1);
});
