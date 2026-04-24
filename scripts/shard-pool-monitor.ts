#!/usr/bin/env -S npx tsx
/**
 * Capacity monitor for the shard pool.
 *
 * Reads the live D1 size for every binding registered in `shard_pool` (via
 * the Cloudflare REST API, since this runs outside a Worker and has no
 * binding access), writes `size_bytes` + `observed_at` back, and
 * automatically flips `status` based on thresholds:
 *
 *   < 7 GB   → leave at 'open'      (fresh, accepting new tenants)
 *   7 - 9 GB → mark 'draining'      (no new tenants, existing keep writing)
 *   ≥ 9 GB   → mark 'full'          (write floor close — alert + migrate)
 *
 * Designed to be run periodically (cron / GitHub Action) once you have N>1
 * shards. At N=1 it's a no-op pass that keeps AUTH_DB at status='open'
 * regardless of size — the default shard never gets demoted because there's
 * nowhere to drain to.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=...    \
 *   CLOUDFLARE_ACCOUNT_ID=...   \
 *   CONTROL_DB_ID=...           \
 *     pnpm tsx scripts/shard-pool-monitor.ts [--dry-run]
 *
 * --dry-run: print what would be updated, do nothing.
 */

import { argv, env, exit } from "node:process";

const DRAINING_THRESHOLD = 7 * 1024 ** 3; // 7 GB
const FULL_THRESHOLD = 9 * 1024 ** 3; // 9 GB
const D1_HARD_CAP = 10 * 1024 ** 3; // 10 GB (D1 product limit)

interface ShardRow {
  binding_name: string;
  status: string;
  tenant_count: number;
  size_bytes: number | null;
  observed_at: number | null;
}

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

async function d1Query<T>(
  accountId: string,
  token: string,
  databaseId: string,
  sql: string,
): Promise<T[]> {
  const out = await cf<Array<{ results: T[] }>>(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
    token,
    { method: "POST", body: JSON.stringify({ sql }) },
  );
  return out[0]?.results ?? [];
}

interface D1Info {
  uuid: string;
  name: string;
  file_size: number;
}

async function getD1Info(
  accountId: string,
  token: string,
  databaseName: string,
): Promise<D1Info | null> {
  const list = await cf<D1Info[]>(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database?name=${encodeURIComponent(databaseName)}`,
    token,
  );
  return list.find((d) => d.name === databaseName) ?? null;
}

/**
 * Map a `shard_pool.binding_name` to the actual D1 database NAME the CF
 * REST API reports sizes for. The convention this project uses:
 *
 *   AUTH_DB                  → openma-auth (or openma-auth-staging on staging)
 *   TENANT_DB_<sanitized_id> → oma-tenant-<sanitized_id> (per provisioning convention)
 *
 * If your binding name doesn't follow these conventions, edit
 * `bindingToDbName` to match your wrangler.jsonc database_name.
 */
function bindingToDbName(bindingName: string, env: "prod" | "staging"): string {
  if (bindingName === "AUTH_DB") {
    return env === "staging" ? "openma-auth-staging" : "openma-auth";
  }
  if (bindingName.startsWith("TENANT_DB_")) {
    const id = bindingName.slice("TENANT_DB_".length);
    return env === "staging" ? `oma-tenant-${id}-staging` : `oma-tenant-${id}`;
  }
  // Unknown convention — return as-is and hope the operator named the DB
  // exactly the same as the binding.
  return bindingName.toLowerCase();
}

function shouldFlipStatus(currentStatus: string, sizeBytes: number): "open" | "draining" | "full" | null {
  // We never auto-flip away from manual operator states like 'archived';
  // those decisions are explicit. Only auto-transition between the
  // capacity-driven states.
  if (currentStatus !== "open" && currentStatus !== "draining" && currentStatus !== "full") {
    return null;
  }
  let target: "open" | "draining" | "full";
  if (sizeBytes >= FULL_THRESHOLD) target = "full";
  else if (sizeBytes >= DRAINING_THRESHOLD) target = "draining";
  else target = "open";
  return target === currentStatus ? null : target;
}

function formatGB(bytes: number | null): string {
  if (bytes == null) return "?";
  return `${(bytes / 1024 ** 3).toFixed(2)}GB`;
}

async function main(): Promise<void> {
  const token = env.CLOUDFLARE_API_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const controlDbId = env.CONTROL_DB_ID;
  const envName = (env.ENV ?? "prod") as "prod" | "staging";
  const dryRun = argv.includes("--dry-run");

  if (!token || !accountId || !controlDbId) {
    console.error(
      "CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, and CONTROL_DB_ID required",
    );
    exit(1);
  }

  const shards = await d1Query<ShardRow>(
    accountId,
    token,
    controlDbId,
    `SELECT binding_name, status, tenant_count, size_bytes, observed_at FROM shard_pool ORDER BY binding_name`,
  );
  console.log(`[shard-pool-monitor] ${shards.length} shard(s) registered`);

  const now = Date.now();
  for (const shard of shards) {
    const dbName = bindingToDbName(shard.binding_name, envName);
    let info: D1Info | null;
    try {
      info = await getD1Info(accountId, token, dbName);
    } catch (err) {
      console.warn(
        `  ${shard.binding_name} → db "${dbName}": failed to fetch info: ${String(err)}`,
      );
      continue;
    }
    if (!info) {
      console.warn(
        `  ${shard.binding_name} → db "${dbName}": not found in CF (check naming convention)`,
      );
      continue;
    }

    const newStatus = shouldFlipStatus(shard.status, info.file_size);
    const pctOfCap = ((info.file_size / D1_HARD_CAP) * 100).toFixed(1);
    const flip = newStatus
      ? ` → status ${shard.status} → ${newStatus}`
      : ` (status ${shard.status} unchanged)`;
    console.log(
      `  ${shard.binding_name}: ${formatGB(info.file_size)} (${pctOfCap}% of 10GB), tenants=${shard.tenant_count}${flip}`,
    );

    if (dryRun) continue;

    // Update size + observation timestamp.
    await d1Query(
      accountId,
      token,
      controlDbId,
      `UPDATE shard_pool SET size_bytes = ${info.file_size}, observed_at = ${now} WHERE binding_name = '${shard.binding_name.replace(/'/g, "''")}'`,
    );
    if (newStatus) {
      await d1Query(
        accountId,
        token,
        controlDbId,
        `UPDATE shard_pool SET status = '${newStatus}' WHERE binding_name = '${shard.binding_name.replace(/'/g, "''")}'`,
      );
    }
  }

  console.log("[shard-pool-monitor] done");
}

main().catch((err) => {
  console.error(err);
  exit(1);
});
