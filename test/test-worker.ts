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

// @ts-expect-error vitest resolves SQL via ?raw
import schema0001 from "../apps/main/migrations/0001_schema.sql?raw";
// @ts-expect-error vitest resolves SQL via ?raw
import schema0002 from "../apps/main/migrations/0002_integrations_tenant_id.sql?raw";
// @ts-expect-error vitest resolves SQL via ?raw
import schema0003 from "../apps/main/migrations/0003_tenant_shard.sql?raw";
// @ts-expect-error vitest resolves SQL via ?raw
import schema0010 from "../apps/main/migrations/0010_memory_anthropic_alignment.sql?raw";
// @ts-expect-error vitest resolves SQL via ?raw
import schema0011 from "../apps/main/migrations/0011_workspace_backups.sql?raw";
// INTEGRATIONS_DB schema — separate D1 holding linear_*/github_*/slack_*.
// @ts-expect-error vitest resolves SQL via ?raw
import integrationsSchema from "../apps/main/migrations-integrations/0001_schema.sql?raw";

const MIGRATIONS_RAW: string[] = [
  schema0001 as string,
  schema0002 as string,
  schema0003 as string,
  schema0010 as string,
  schema0011 as string,
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
    const stripped = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    for (const stmt of stripped.split(";").map((s) => s.trim()).filter(Boolean)) {
      try {
        await db.prepare(stmt).run();
      } catch (e) {
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
