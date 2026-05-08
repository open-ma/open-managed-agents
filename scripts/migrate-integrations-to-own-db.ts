#!/usr/bin/env tsx
/**
 * One-time migration: copy integration tables from AUTH_DB into INTEGRATIONS_DB.
 *
 * Why: integrations were historically in the same D1 as auth/sessions/agents.
 * The integration-subsystem split (worktree-integrations-db-split) moves
 * them to their own D1 to isolate webhook write traffic and let schema
 * evolve independently.
 *
 * What it does:
 *   1. SELECT every row from each integration table in AUTH_DB.
 *   2. INSERT into the matching table in INTEGRATIONS_DB.
 *   3. For linear_webhook_events + linear_pending_events specifically:
 *      they merge into the new `linear_events` table (delivery_id PK).
 *      Webhook rows are copied as audit-only (no payload). Pending rows
 *      that haven't been processed are dropped (we expect operators to
 *      drain the queue before cutover; un-drained rows would need a
 *      synthesized delivery_id which would race with real ones).
 *
 * Usage:
 *   pnpm tsx scripts/migrate-integrations-to-own-db.ts \
 *     --account=$CF_ACCOUNT_ID --token=$CF_API_TOKEN \
 *     --auth-db=<auth-db-id> --integrations-db=<integrations-db-id>
 *
 * Idempotent via INSERT OR IGNORE on the target. Safe to re-run.
 *
 * Pre-flight checklist before running in prod:
 *   ☐ INTEGRATIONS_DB created (`wrangler d1 create openma-integrations`)
 *   ☐ INTEGRATIONS_DB schema applied
 *      (`wrangler d1 migrations apply --database openma-integrations
 *        --remote --migrations-dir apps/main/migrations-integrations`)
 *   ☐ wrangler.jsonc updated with the new database_id (replacing the
 *      00000000-... placeholder for both prod + staging)
 *   ☐ Cron drained (no rows in linear_pending_events with processed_at IS NULL)
 *      — `wrangler d1 execute openma-auth --remote --command
 *        "SELECT COUNT(*) FROM linear_pending_events WHERE processed_at IS NULL"`
 *
 * Post-flight (after running this script + deploying new code):
 *   ☐ Verify webhook flow end-to-end on a low-traffic install
 *   ☐ Watch for ≥1 week
 *   ☐ Apply apps/main/migrations/0014_drop_integration_tables.sql to AUTH_DB
 */

interface CfApiResponse<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code?: number; message: string }>;
}

const TABLES_DIRECT_COPY = [
  "linear_apps",
  "linear_installations",
  "linear_publications",
  "linear_setup_links",
  "linear_issue_sessions",
  "linear_authored_comments",
  "linear_dispatch_rules",
  "github_apps",
  "github_installations",
  "github_publications",
  "slack_apps",
  "slack_installations",
  "slack_publications",
  "slack_webhook_events",
  "slack_setup_links",
  "slack_thread_sessions",
] as const;

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

async function copyTable(
  accountId: string,
  token: string,
  srcDb: string,
  dstDb: string,
  table: string,
): Promise<{ copied: number }> {
  // Page through in chunks of 500 — D1 caps query result size around 1MB,
  // and the integration tables are wide (multiple ciphered token columns).
  let offset = 0;
  const PAGE = 500;
  let total = 0;
  // Discover columns once.
  const sample = await d1Query<Record<string, unknown>>(
    accountId,
    token,
    srcDb,
    `SELECT * FROM ${table} LIMIT 1`,
  );
  if (sample.length === 0) {
    console.log(`[${table}] empty — skipping`);
    return { copied: 0 };
  }
  const columns = Object.keys(sample[0]);
  const colList = columns.map((c) => `"${c}"`).join(", ");
  const placeholders = columns.map(() => "?").join(", ");

  while (true) {
    const rows = await d1Query<Record<string, unknown>>(
      accountId,
      token,
      srcDb,
      `SELECT ${colList} FROM ${table} ORDER BY rowid LIMIT ? OFFSET ?`,
      [PAGE, offset],
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      const values = columns.map((c) => row[c]);
      await d1Query(
        accountId,
        token,
        dstDb,
        `INSERT OR IGNORE INTO ${table} (${colList}) VALUES (${placeholders})`,
        values,
      );
    }
    total += rows.length;
    console.log(`[${table}] copied ${total} rows…`);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
  return { copied: total };
}

/**
 * Special path for linear_webhook_events:
 *   AUTH_DB.linear_webhook_events → INTEGRATIONS_DB.linear_events as
 *   audit-only rows (no payload_json / no processed_at). They were the
 *   dedup + audit log; the new schema's `error` and `session_id` columns
 *   carry the same information.
 *
 * GitHub rows in the legacy linear_webhook_events go to github_webhook_events
 * instead. Discriminator: installation_id is in github_installations vs
 * linear_installations.
 */
async function migrateLegacyWebhookEvents(
  accountId: string,
  token: string,
  srcDb: string,
  dstDb: string,
): Promise<void> {
  // Linear rows: those whose installation_id is in linear_installations.
  const linearRows = await d1Query<{
    delivery_id: string;
    tenant_id: string;
    installation_id: string;
    publication_id: string | null;
    event_type: string;
    received_at: number;
    session_id: string | null;
    error: string | null;
  }>(
    accountId,
    token,
    srcDb,
    `SELECT lwe.* FROM linear_webhook_events lwe
       WHERE EXISTS (
         SELECT 1 FROM linear_installations li WHERE li.id = lwe.installation_id
       )`,
  );
  console.log(`[linear_webhook_events → linear_events] copying ${linearRows.length} Linear rows…`);
  for (const r of linearRows) {
    await d1Query(
      accountId,
      token,
      dstDb,
      `INSERT OR IGNORE INTO linear_events
         (delivery_id, tenant_id, installation_id, publication_id,
          event_type, received_at, session_id, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        r.delivery_id,
        r.tenant_id,
        r.installation_id,
        r.publication_id,
        r.event_type,
        r.received_at,
        r.session_id,
        r.error,
      ],
    );
  }

  // GitHub rows: those whose installation_id is in github_installations.
  const githubRows = await d1Query<{
    delivery_id: string;
    tenant_id: string;
    installation_id: string;
    publication_id: string | null;
    event_type: string;
    received_at: number;
    session_id: string | null;
    error: string | null;
  }>(
    accountId,
    token,
    srcDb,
    `SELECT lwe.* FROM linear_webhook_events lwe
       WHERE EXISTS (
         SELECT 1 FROM github_installations gi WHERE gi.id = lwe.installation_id
       )`,
  );
  console.log(`[linear_webhook_events → github_webhook_events] copying ${githubRows.length} GitHub rows…`);
  for (const r of githubRows) {
    await d1Query(
      accountId,
      token,
      dstDb,
      `INSERT OR IGNORE INTO github_webhook_events
         (delivery_id, tenant_id, installation_id, publication_id,
          event_type, received_at, session_id, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        r.delivery_id,
        r.tenant_id,
        r.installation_id,
        r.publication_id,
        r.event_type,
        r.received_at,
        r.session_id,
        r.error,
      ],
    );
  }
}

async function main(): Promise<void> {
  const args = Object.fromEntries(
    process.argv
      .slice(2)
      .filter((a) => a.startsWith("--"))
      .map((a) => {
        const [k, v] = a.slice(2).split("=");
        return [k, v ?? "true"];
      }),
  ) as Record<string, string>;

  const accountId = args.account ?? process.env.CF_ACCOUNT_ID;
  const token = args.token ?? process.env.CF_API_TOKEN;
  const authDb = args["auth-db"];
  const integrationsDb = args["integrations-db"];

  if (!accountId || !token || !authDb || !integrationsDb) {
    console.error(
      "Usage: pnpm tsx scripts/migrate-integrations-to-own-db.ts \\\n" +
        "  --account=<cf-account-id> --token=<cf-api-token> \\\n" +
        "  --auth-db=<auth-db-id> --integrations-db=<integrations-db-id>",
    );
    process.exit(1);
  }

  console.log(`Migrating integration tables: AUTH_DB(${authDb}) → INTEGRATIONS_DB(${integrationsDb})`);

  for (const table of TABLES_DIRECT_COPY) {
    try {
      await copyTable(accountId, token, authDb, integrationsDb, table);
    } catch (err) {
      console.error(`[${table}] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  await migrateLegacyWebhookEvents(accountId, token, authDb, integrationsDb);

  console.log("\n✓ Done. Verify with:");
  console.log(`  wrangler d1 execute openma-integrations --remote --command "SELECT COUNT(*) FROM linear_publications"`);
  console.log(`Then deploy main + integrations workers, run smoke test, wait ≥1 week,`);
  console.log(`then apply apps/main/migrations/0014_drop_integration_tables.sql to AUTH_DB.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
