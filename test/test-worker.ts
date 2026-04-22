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
import auth0001 from "../apps/main/migrations/0001_auth_tables.sql?raw";
// @ts-expect-error
import int0002 from "../apps/main/migrations/0002_integrations_tables.sql?raw";
// @ts-expect-error
import pub0003 from "../apps/main/migrations/0003_publications_environment.sql?raw";
// @ts-expect-error
import inst0004 from "../apps/main/migrations/0004_installations_vault.sql?raw";
// @ts-expect-error
import drop0005 from "../apps/main/migrations/0005_drop_b_plus_columns.sql?raw";
// @ts-expect-error
import gh0006 from "../apps/main/migrations/0006_github_tables.sql?raw";
// @ts-expect-error
import mem0007 from "../apps/main/migrations/0007_memory_tables.sql?raw";

const MIGRATIONS_RAW: string[] = [
  auth0001 as string,
  int0002 as string,
  pub0003 as string,
  inst0004 as string,
  drop0005 as string,
  gh0006 as string,
  mem0007 as string,
];

let migrationsApplied = false;
async function ensureMigrations(env: { AUTH_DB?: D1Database }): Promise<void> {
  if (migrationsApplied || !env.AUTH_DB) return;
  for (const sql of MIGRATIONS_RAW) {
    // Strip line-comments so they don't break statement boundaries, then split
    // on `;`. Run each statement individually via prepare().run() — D1.exec()
    // splits on newlines and breaks multi-line CREATE TABLE.
    const stripped = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    for (const stmt of stripped.split(";").map((s) => s.trim()).filter(Boolean)) {
      try {
        await env.AUTH_DB.prepare(stmt).run();
      } catch (e) {
        // Some migration files contain ALTER TABLE DROP COLUMN that may fail
        // on re-run after IF NOT EXISTS makes them no-ops elsewhere — tolerate
        // benign errors but log to surface real schema issues during dev.
        const msg = e instanceof Error ? e.message : String(e);
        if (!/no such column|duplicate column|already exists/i.test(msg)) {
          console.error(`[test-migrations] failed: ${msg}\n  SQL: ${stmt.slice(0, 80)}...`);
        }
      }
    }
  }
  migrationsApplied = true;
}

export default {
  async fetch(req: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    await ensureMigrations(env);
    return mainApp.fetch(req, env, ctx);
  },
};
