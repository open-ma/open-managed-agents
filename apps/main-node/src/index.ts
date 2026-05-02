/**
 * apps/main-node — CFless Node entry for the Open Managed Agents API.
 *
 * Phase B2 milestone: bootstraps a SQLite database via better-sqlite3,
 * mounts a minimal /v1/agents CRUD against it, and proves the
 * SqlAgentRepo runs unchanged on Node + SQLite (the same class apps/main
 * uses on Cloudflare D1, just with a different SqlClient adapter).
 *
 *   pnpm --filter @open-managed-agents/main-node start
 *   curl localhost:8787/health
 *   curl -X POST localhost:8787/v1/agents \
 *     -H "x-api-key: dev" -H "content-type: application/json" \
 *     -d '{"name":"hello","model":"claude-sonnet-4-6","system":"hi","tools":[]}'
 *
 * What's intentionally NOT here yet (Phase B3+):
 *   - Auth: every request is treated as tenant_id="default"
 *   - SessionDO equivalent / sandbox / harness loop
 *   - Other store packages (memory, sessions, vaults, ...) — only agents
 *     is wired so this PoC fits in one file
 *   - Migrations runner — we apply the agents schema inline at boot
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  createBetterSqlite3SqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import {
  AgentNotFoundError,
  AgentVersionMismatchError,
  createSqliteAgentService,
  type AgentService,
} from "@open-managed-agents/agents-store";
import type { AgentConfig } from "@open-managed-agents/shared";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ─── Bootstrap ───────────────────────────────────────────────────────────

const dbPath = process.env.DATABASE_PATH ?? "./data/oma.db";
mkdirSync(dirname(dbPath), { recursive: true });

const sql: SqlClient = await createBetterSqlite3SqlClient(dbPath);

// Apply the agents schema. Idempotent (CREATE TABLE IF NOT EXISTS); pulled
// verbatim from apps/main/migrations/0001_schema.sql so D1 and SQLite stay
// byte-for-byte identical at the table level. A real CFless deploy would
// run a migrations binary instead of inlining DDL on boot.
await sql.exec(`
  CREATE TABLE IF NOT EXISTS "agents" (
    "id"           TEXT PRIMARY KEY NOT NULL,
    "tenant_id"    TEXT NOT NULL,
    "config"       TEXT NOT NULL,
    "version"      INTEGER NOT NULL,
    "created_at"   INTEGER NOT NULL,
    "updated_at"   INTEGER,
    "archived_at"  INTEGER
  );
  CREATE INDEX IF NOT EXISTS "idx_agents_tenant"
    ON "agents" ("tenant_id", "archived_at");

  CREATE TABLE IF NOT EXISTS "agent_versions" (
    "agent_id"    TEXT NOT NULL,
    "tenant_id"   TEXT NOT NULL,
    "version"     INTEGER NOT NULL,
    "snapshot"    TEXT NOT NULL,
    "created_at"  INTEGER NOT NULL,
    PRIMARY KEY ("agent_id", "version")
  );
  CREATE INDEX IF NOT EXISTS "idx_agent_versions_tenant_agent"
    ON "agent_versions" ("tenant_id", "agent_id", "version");
`);

const agentsService: AgentService = createSqliteAgentService({ client: sql });

// ─── HTTP ────────────────────────────────────────────────────────────────

const app = new Hono();

app.get("/health", (c) =>
  c.json({
    status: "ok",
    runtime: "node",
    pid: process.pid,
    uptime_s: Math.round(process.uptime()),
    backends: { agents: "sqlite", db_path: dbPath },
  }),
);

// Stub auth: every request becomes tenant=default. Phase B3 swaps this for
// real better-auth + tenant resolution, mirroring apps/main/src/auth.ts.
const TENANT = "default";

// Inline /v1/agents CRUD — minimal subset of apps/main/src/routes/agents.ts.
// Skips model-card validation, archive, delete, version-history endpoints.
// The point is to prove the SqlAgentRepo wiring works end-to-end.

const v1 = new Hono();

v1.post("/agents", async (c) => {
  const body = await c.req.json<{
    name: string;
    model: string | { id: string; speed?: "standard" | "fast" };
    system?: string;
    tools?: AgentConfig["tools"];
    description?: string;
  }>();
  if (!body.name) return c.json({ error: "name is required" }, 400);
  if (!body.model) return c.json({ error: "model is required" }, 400);
  const row = await agentsService.create({
    tenantId: TENANT,
    input: {
      name: body.name,
      model: body.model,
      system: body.system,
      tools: body.tools,
      description: body.description,
    },
  });
  return c.json(toApiAgent(row), 201);
});

v1.get("/agents", async (c) => {
  const rows = await agentsService.list({ tenantId: TENANT });
  return c.json({ data: rows.map(toApiAgent) });
});

v1.get("/agents/:id", async (c) => {
  const row = await agentsService.get({ tenantId: TENANT, agentId: c.req.param("id") });
  if (!row) return c.json({ error: "Agent not found" }, 404);
  return c.json(toApiAgent(row));
});

v1.put("/agents/:id", async (c) => {
  const body = await c.req.json<{
    name?: string;
    system?: string | null;
    description?: string | null;
    version?: number;
  }>();
  try {
    const row = await agentsService.update({
      tenantId: TENANT,
      agentId: c.req.param("id"),
      expectedVersion: body.version,
      input: {
        name: body.name,
        system: body.system,
        description: body.description,
      },
    });
    return c.json(toApiAgent(row));
  } catch (err) {
    if (err instanceof AgentVersionMismatchError) {
      return c.json({ error: "Version mismatch" }, 409);
    }
    if (err instanceof AgentNotFoundError) {
      return c.json({ error: "Agent not found" }, 404);
    }
    throw err;
  }
});

app.route("/v1", v1);

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => {
  console.error("[main-node] unhandled", err);
  return c.json({ error: "internal_error", message: err.message }, 500);
});

// ─── Anthropic-shape response helper ─────────────────────────────────────

function toApiAgent(row: AgentConfig & { tenant_id?: string }) {
  const { tenant_id: _t, ...agent } = row;
  const model =
    !agent.model || typeof agent.model === "string"
      ? { id: agent.model || "", speed: "standard" as const }
      : { id: agent.model.id, speed: agent.model.speed || ("standard" as const) };
  return {
    type: "agent" as const,
    ...agent,
    model,
    system: agent.system || null,
    description: agent.description || null,
  };
}

// ─── Listen ──────────────────────────────────────────────────────────────

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";

serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`[main-node] listening on http://${info.address}:${info.port}`);
  console.log(`[main-node] sqlite db: ${dbPath}`);
});

const shutdown = (signal: string) => {
  console.log(`[main-node] received ${signal}, shutting down`);
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
