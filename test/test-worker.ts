/**
 * Combined test worker: merges main worker routes + agent worker DO classes.
 * Only used in vitest — production has separate workers.
 */

// --- Main worker routes ---
import mainApp from "../apps/main/src/index";

// --- Agent worker DO + harness registration ---
import { registerHarness } from "../apps/agent/src/harness/registry";
import { DefaultHarness } from "../apps/agent/src/harness/default-loop";
registerHarness("default", () => new DefaultHarness());

export { SessionDO } from "../apps/agent/src/runtime/session-do";
export { Sandbox } from "@cloudflare/sandbox";
export { outbound, outboundByHost } from "../apps/agent/src/outbound";

// --- Migration bootstrap ---
// Apply D1 schema migrations on first request. Necessary because miniflare's
// D1 starts empty and our routes (e.g. /v1/memory_stores) hit memory tables.
// Idempotent: every CREATE uses IF NOT EXISTS, drop is a no-op rerun.
//
// MUST mirror the on-disk migration list at apps/main/migrations/. Add new
// rows here whenever a migration is added; missing rows surface as
// "no such column" / "no such table" errors at runtime. Order is
// lexicographic-by-filename — what wrangler does in prod.

// @ts-expect-error vitest resolves SQL via ?raw
import schema0001 from "../apps/main/migrations/0001_schema.sql?raw";
// @ts-expect-error vitest resolves SQL via ?raw
import schema0002 from "../apps/main/migrations/0002_integrations_tenant_id.sql?raw";
// @ts-expect-error vitest resolves SQL via ?raw
import schema0003 from "../apps/main/migrations/0003_tenant_shard.sql?raw";
// @ts-expect-error vitest resolves SQL via ?raw
import schema0004 from "../apps/main/migrations/0004_slack_tables.sql?raw";
// @ts-expect-error vitest resolves SQL via ?raw
import schema0005 from "../apps/main/migrations/0005_membership.sql?raw";
// @ts-expect-error vitest resolves SQL via ?raw
import schema0006 from "../apps/main/migrations/0006_env_image_strategy.sql?raw";
// @ts-expect-error vitest resolves SQL via ?raw
import schema0007 from "../apps/main/migrations/0007_linear_dispatch_rules.sql?raw";
// @ts-expect-error vitest resolves SQL via ?raw
import schema0008 from "../apps/main/migrations/0008_linear_pending_events.sql?raw";
// @ts-expect-error vitest resolves SQL via ?raw
import schema0009 from "../apps/main/migrations/0009_split_github_tables.sql?raw";
// Two 0010_* and two 0011_* migrations exist (merged from sibling PRs the
// same day). Wrangler applies in lexicographic order by filename, so the
// chronological merge order doesn't matter for correctness — just mirror
// whatever wrangler would do.
// @ts-expect-error vitest resolves SQL via ?raw
import schema0010a from "../apps/main/migrations/0010_memory_anthropic_alignment.sql?raw";
// @ts-expect-error vitest resolves SQL via ?raw
import schema0010b from "../apps/main/migrations/0010_runtimes.sql?raw";
// @ts-expect-error vitest resolves SQL via ?raw
import schema0011a from "../apps/main/migrations/0011_runtime_local_skills.sql?raw";
// @ts-expect-error vitest resolves SQL via ?raw
import schema0011b from "../apps/main/migrations/0011_workspace_backups.sql?raw";
// @ts-expect-error vitest resolves SQL via ?raw
import schema0012 from "../apps/main/migrations/0012_slack_per_channel.sql?raw";
// @ts-expect-error vitest resolves SQL via ?raw
import schema0013 from "../apps/main/migrations/0013_cursor_pagination_indexes.sql?raw";
// @ts-expect-error vitest resolves SQL via ?raw
import schema0014 from "../apps/main/migrations/0014_session_turn_id.sql?raw";
// @ts-expect-error vitest resolves SQL via ?raw
import schema0015 from "../apps/main/migrations/0015_model_card_handle_rename.sql?raw";
// @ts-expect-error vitest resolves SQL via ?raw
import schema0016 from "../apps/main/migrations/0016_session_terminated_at.sql?raw";
// INTEGRATIONS_DB schema — separate D1 holding linear_*/github_*/slack_*.
// @ts-expect-error vitest resolves SQL via ?raw
import integrationsSchema from "../apps/main/migrations-integrations/0001_schema.sql?raw";

const MIGRATIONS_RAW: string[] = [
  schema0001 as string,
  schema0002 as string,
  schema0003 as string,
  schema0004 as string,
  schema0005 as string,
  schema0006 as string,
  schema0007 as string,
  schema0008 as string,
  schema0009 as string,
  schema0010a as string,
  schema0010b as string,
  schema0011a as string,
  schema0011b as string,
  schema0012 as string,
  schema0013 as string,
  schema0014 as string,
  schema0015 as string,
  schema0016 as string,
];

const INTEGRATIONS_MIGRATIONS_RAW: string[] = [
  integrationsSchema as string,
];

let migrationsApplied = false;
async function ensureMigrations(env: {
  AUTH_DB?: D1Database;
  INTEGRATIONS_DB?: D1Database;
}): Promise<void> {
  if (migrationsApplied || !env.AUTH_DB) return;
  await applyMigrations(env.AUTH_DB, MIGRATIONS_RAW, "auth");
  if (env.INTEGRATIONS_DB) {
    await applyMigrations(env.INTEGRATIONS_DB, INTEGRATIONS_MIGRATIONS_RAW, "integrations");
  }
  migrationsApplied = true;
}

async function applyMigrations(
  db: D1Database,
  files: string[],
  label: string,
): Promise<void> {
  for (const sql of files) {
    // Strip line-comments so they don't break statement boundaries, then split
    // on `;`. Run each statement individually via prepare().run() — D1.exec()
    // splits on newlines and breaks multi-line CREATE TABLE.
    const stripped = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    for (const stmt of stripped.split(";").map((s) => s.trim()).filter(Boolean)) {
      try {
        await db.prepare(stmt).run();
      } catch (e) {
        // Some migration files contain ALTER TABLE DROP COLUMN that may fail
        // on re-run after IF NOT EXISTS makes them no-ops elsewhere — tolerate
        // benign errors but log to surface real schema issues during dev.
        const msg = e instanceof Error ? e.message : String(e);
        if (!/no such column|duplicate column|already exists/i.test(msg)) {
          console.error(`[test-migrations:${label}] failed: ${msg}\n  SQL: ${stmt.slice(0, 80)}...`);
        }
      }
    }
  }
}

export default {
  async fetch(req: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    await ensureMigrations(env);
    return mainApp.fetch(req, env, ctx);
  },
};
