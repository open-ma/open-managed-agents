/**
 * apps/main-node — CFless Node entry for the Open Managed Agents API.
 *
 * Phase B-resume milestone: persistent sessions + event log + SSE with
 * Last-Event-ID resume + crash recovery on restart. Proves the storage
 * abstraction supports `kill -9 <node-pid>` and the client picks up
 * exactly where it left off — the key property the original SessionDO
 * implementation gave us via DO durability.
 *
 *   pnpm --filter @open-managed-agents/main-node start
 *
 *   # 1. Create a session
 *   SID=$(curl -s -X POST localhost:8787/v1/sessions \
 *     -H 'content-type: application/json' -d '{}' | jq -r .id)
 *
 *   # 2. Open an SSE stream
 *   curl -N localhost:8787/v1/sessions/$SID/events/stream &
 *
 *   # 3. Inject an event from another shell
 *   curl -X POST localhost:8787/v1/sessions/$SID/_test_emit \
 *     -H 'content-type: application/json' -d '{"text":"hello"}'
 *
 *   # 4. kill -9 the node process. SSE drops.
 *   # 5. Restart node.
 *   # 6. Reconnect SSE — pass the last seen seq to resume:
 *   curl -N -H 'Last-Event-ID: 0' localhost:8787/v1/sessions/$SID/events/stream
 *   # → replays everything from seq 1 onward + listens for new events
 *
 * What's NOT here yet:
 *   - Real harness loop (no LLM call, no tool execution) — `_test_emit`
 *     is the placeholder for what a Phase D NodeSessionRuntime would do
 *     when a turn produces an agent.message
 *   - Auth: every request still treated as tenant_id="default"
 *   - Sandbox / E2B / sub-agents / vault / memory / files
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
import {
  createSqliteMemoryStoreService,
  type MemoryStoreService,
} from "@open-managed-agents/memory-store";
import { LocalFsBlobStore } from "@open-managed-agents/memory-store/adapters/local-fs-blob";
import {
  createSqliteVaultService,
  type VaultService,
} from "@open-managed-agents/vaults-store";
import {
  createSqliteCredentialService,
  stripSecrets,
  type CredentialService,
} from "@open-managed-agents/credentials-store";
import { SqlEventLog, ensureSchema as ensureEventLogSchema } from "@open-managed-agents/event-log/sql";
import type { AgentConfig, SessionEvent, UserMessageEvent } from "@open-managed-agents/shared";
import { generateEventId } from "@open-managed-agents/shared";
import { DefaultHarness } from "@open-managed-agents/agent/harness/default-loop";
import { buildTools } from "@open-managed-agents/agent/harness/tools";
import { resolveModel } from "@open-managed-agents/agent/harness/provider";
import type { HarnessContext } from "@open-managed-agents/agent/harness/interface";
import { cfWorkersAiToMarkdown as _cfWorkersAiToMarkdown } from "@open-managed-agents/markdown";
import { LocalSubprocessSandbox } from "@open-managed-agents/sandbox/adapters/local-subprocess";
import { nodeToMarkdown } from "@open-managed-agents/markdown/adapters/node";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { nanoid } from "nanoid";
import { InProcessEventStreamHub, type EventWriter } from "./lib/event-stream-hub";
import { NodeHarnessRuntime } from "./lib/node-harness-runtime";

// Single ToMarkdownProvider instance — turndown is heavy enough that
// instantiating per turn would be wasteful. Lazy-loads on first use.
const toMarkdownProvider = nodeToMarkdown();

// ─── Bootstrap ───────────────────────────────────────────────────────────

const dbPath = process.env.DATABASE_PATH ?? "./data/oma.db";
mkdirSync(dirname(dbPath), { recursive: true });

const sql: SqlClient = await createBetterSqlite3SqlClient(dbPath);

// Apply schemas. Idempotent. CFless deploys eventually replace this with a
// proper migrations runner.
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

  CREATE TABLE IF NOT EXISTS "sessions" (
    "id"           TEXT PRIMARY KEY NOT NULL,
    "tenant_id"    TEXT NOT NULL,
    "agent_id"     TEXT,
    "status"       TEXT NOT NULL,
    "title"        TEXT,
    "created_at"   INTEGER NOT NULL,
    "updated_at"   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS "idx_sessions_status"
    ON "sessions" ("status", "tenant_id");

  CREATE TABLE IF NOT EXISTS "memory_stores" (
    "id"           TEXT PRIMARY KEY NOT NULL,
    "tenant_id"    TEXT NOT NULL,
    "name"         TEXT NOT NULL,
    "description"  TEXT,
    "created_at"   INTEGER NOT NULL,
    "updated_at"   INTEGER,
    "archived_at"  INTEGER
  );
  CREATE INDEX IF NOT EXISTS "idx_memory_stores_tenant"
    ON "memory_stores" ("tenant_id", "archived_at");

  CREATE TABLE IF NOT EXISTS "memories" (
    "id"               TEXT PRIMARY KEY NOT NULL,
    "store_id"         TEXT NOT NULL,
    "path"             TEXT NOT NULL,
    "content_sha256"   TEXT NOT NULL,
    "etag"             TEXT NOT NULL,
    "size_bytes"       INTEGER NOT NULL,
    "created_at"       INTEGER NOT NULL,
    "updated_at"       INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "idx_memories_store_path"
    ON "memories" ("store_id", "path");

  CREATE TABLE IF NOT EXISTS "memory_versions" (
    "id"               TEXT PRIMARY KEY NOT NULL,
    "memory_id"        TEXT NOT NULL,
    "store_id"         TEXT NOT NULL,
    "operation"        TEXT NOT NULL,
    "path"             TEXT NOT NULL,
    "content"          TEXT NOT NULL,
    "content_sha256"   TEXT NOT NULL,
    "size_bytes"       INTEGER NOT NULL,
    "actor_type"       TEXT NOT NULL,
    "actor_id"         TEXT NOT NULL,
    "created_at"       INTEGER NOT NULL,
    "redacted"         INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS "idx_memory_versions_store"
    ON "memory_versions" ("store_id", "created_at" DESC);
  CREATE INDEX IF NOT EXISTS "idx_memory_versions_memory"
    ON "memory_versions" ("memory_id", "created_at" DESC);

  CREATE TABLE IF NOT EXISTS "vaults" (
    "id"          TEXT PRIMARY KEY NOT NULL,
    "tenant_id"   TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "created_at"  INTEGER NOT NULL,
    "updated_at"  INTEGER,
    "archived_at" INTEGER
  );
  CREATE INDEX IF NOT EXISTS "idx_vaults_tenant"
    ON "vaults" ("tenant_id", "archived_at");

  CREATE TABLE IF NOT EXISTS "credentials" (
    "id"             TEXT PRIMARY KEY NOT NULL,
    "tenant_id"      TEXT NOT NULL,
    "vault_id"       TEXT NOT NULL,
    "display_name"   TEXT NOT NULL,
    "auth_type"      TEXT NOT NULL,
    "mcp_server_url" TEXT,
    "provider"       TEXT,
    "auth"           TEXT NOT NULL,
    "created_at"     INTEGER NOT NULL,
    "updated_at"     INTEGER,
    "archived_at"    INTEGER
  );
  CREATE INDEX IF NOT EXISTS "idx_credentials_vault"
    ON "credentials" ("tenant_id", "vault_id", "archived_at");
  CREATE UNIQUE INDEX IF NOT EXISTS "idx_credentials_mcp_url_active"
    ON "credentials" ("tenant_id", "vault_id", "mcp_server_url")
    WHERE "mcp_server_url" IS NOT NULL AND "archived_at" IS NULL;
`);
await ensureEventLogSchema(sql);

const agentsService: AgentService = createSqliteAgentService({ client: sql });

// Memory store: SQLite for index/audit + local filesystem for content blobs.
// Production CFless can swap LocalFsBlobStore for an S3-compatible adapter
// (Tigris / MinIO / etc.) — same BlobStore port.
const memoryBlobs = new LocalFsBlobStore({
  baseDir: process.env.MEMORY_BLOB_DIR ?? "./data/memory-blobs",
});
const memoryService: MemoryStoreService = createSqliteMemoryStoreService({
  client: sql,
  blobs: memoryBlobs,
});

// Vaults: per-tenant credential containers. Created via REST, consumed by
// the oma-vault sidecar (apps/oma-vault) which reads the same sqlite file.
const vaultService: VaultService = createSqliteVaultService({ client: sql });
const credentialService: CredentialService = createSqliteCredentialService({ client: sql });

const hub = new InProcessEventStreamHub();

// ─── Crash-recovery scan ─────────────────────────────────────────────────
//
// Mirrors what SessionDO does inside ensureSchema(): on cold start, find
// orphan in-flight state from before the last process death and reconcile.
// Two categories:
//   - sessions with status='running': the process that owned them is gone;
//     append a session.error event so SSE clients learn what happened, then
//     flip status to 'idle'.
//   - streams with status='streaming': finalize as 'interrupted' so the
//     events log stays consistent (mirrors recovery.ts on the CF side).

async function restoreInterruptedSessions(): Promise<void> {
  const orphans = await sql
    .prepare(`SELECT id FROM sessions WHERE status = 'running'`)
    .all<{ id: string }>();
  for (const row of orphans.results ?? []) {
    const sid = row.id;
    const log = newEventLog(sid);
    await log.appendAsync({
      type: "session.error",
      error: "process_restart_recovery",
      message:
        "The session host process restarted while this session was running. Resend your last user.message to retry.",
    } as unknown as SessionEvent);
    await sql
      .prepare(`UPDATE sessions SET status = 'idle', updated_at = ? WHERE id = ?`)
      .bind(Date.now(), sid)
      .run();
    // Finalise any half-streamed messages so the events log is consistent.
    await sql
      .prepare(
        `UPDATE session_streams
           SET status = 'interrupted', completed_at = ?, error_text = ?
         WHERE session_id = ? AND status = 'streaming'`,
      )
      .bind(Date.now(), "process_restart", sid)
      .run();
    console.log(`[main-node] crash-recovered session ${sid}`);
  }
}
await restoreInterruptedSessions();

// ─── Helpers ─────────────────────────────────────────────────────────────

function newEventLog(sessionId: string): SqlEventLog {
  // stamp closure mirrors SessionDO's inline stamp: fill id + processed_at
  // on every appended event so SSE consumers can dedupe and order safely.
  return new SqlEventLog(sql, sessionId, (e) => {
    const ev = e as SessionEvent & { id?: string; processed_at?: string };
    if (!ev.id) ev.id = `sevt_${generateEventId()}`;
    if (!ev.processed_at) ev.processed_at = new Date().toISOString();
  });
}

// ─── HTTP ────────────────────────────────────────────────────────────────

const app = new Hono();

app.get("/health", (c) =>
  c.json({
    status: "ok",
    runtime: "node",
    pid: process.pid,
    uptime_s: Math.round(process.uptime()),
    backends: { agents: "sqlite", events: "sqlite", hub: "in-process", db_path: dbPath },
  }),
);

const TENANT = "default";
const v1 = new Hono();

// ── Agents (Phase B2 — unchanged) ────────────────────────────────────────

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
      input: { name: body.name, system: body.system, description: body.description },
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

// ── Sessions (Phase B-resume) ────────────────────────────────────────────

v1.post("/sessions", async (c) => {
  const body = await c.req
    .json<{ agent_id?: string; title?: string }>()
    .catch(() => ({}) as { agent_id?: string; title?: string });
  // Validate agent if provided. Sessions without an agent only support
  // _test_emit injection — they can't run a harness loop.
  if (body.agent_id) {
    const agent = await agentsService.get({ tenantId: TENANT, agentId: body.agent_id });
    if (!agent) return c.json({ error: "Agent not found" }, 404);
  }
  const id = `sess_${nanoid(20)}`;
  const now = Date.now();
  await sql
    .prepare(
      `INSERT INTO sessions (id, tenant_id, agent_id, status, title, created_at, updated_at)
       VALUES (?, ?, ?, 'idle', ?, ?, ?)`,
    )
    .bind(id, TENANT, body.agent_id ?? null, body.title ?? null, now, now)
    .run();
  return c.json({ id, agent_id: body.agent_id ?? null, status: "idle", title: body.title ?? null }, 201);
});

v1.get("/sessions/:id", async (c) => {
  const row = await sql
    .prepare(
      `SELECT id, agent_id, status, title, created_at, updated_at FROM sessions
       WHERE tenant_id = ? AND id = ?`,
    )
    .bind(TENANT, c.req.param("id"))
    .first<{
      id: string;
      agent_id: string | null;
      status: string;
      title: string | null;
      created_at: number;
      updated_at: number;
    }>();
  if (!row) return c.json({ error: "Session not found" }, 404);
  return c.json(row);
});

// POST /v1/sessions/:id/events — append events to the log and (if a
// user.message is among them and the session is bound to an agent) drive
// one harness turn. Mirrors apps/main's /v1/sessions/:id/events route +
// SessionDO's onUserMessage path, condensed onto the Node side.
v1.post("/sessions/:id/events", async (c) => {
  const sid = c.req.param("id");
  const session = await sql
    .prepare(`SELECT id, agent_id FROM sessions WHERE tenant_id = ? AND id = ?`)
    .bind(TENANT, sid)
    .first<{ id: string; agent_id: string | null }>();
  if (!session) return c.json({ error: "Session not found" }, 404);
  const body = await c.req.json<{ events: SessionEvent[] }>();
  if (!Array.isArray(body.events)) return c.json({ error: "events array required" }, 400);

  const log = newEventLog(sid);
  for (const ev of body.events) await log.appendAsync(ev);
  // Re-read so we can deliver hub publishes with their assigned seq.
  const stored = await log.getEventsAsync();
  const newOnes = stored.slice(-body.events.length);
  for (const ev of newOnes) hub.publish(sid, ev);

  // If any of the new events is a user.message and the session has an
  // agent bound, kick a harness turn. Fire-and-forget — the SSE client
  // gets streamed agent.message_chunk events as the LLM runs.
  const hasUserMessage = body.events.some((e) => e.type === "user.message");
  if (hasUserMessage && session.agent_id) {
    void runHarnessTurn(sid, session.agent_id, body.events.find(
      (e) => e.type === "user.message",
    ) as UserMessageEvent).catch((err) => {
      console.error("[main-node] harness turn failed", err);
      // Surface as session.error so SSE clients learn the turn died.
      void log.appendAsync({
        type: "session.error",
        error: "harness_turn_failed",
        message: err instanceof Error ? err.message : String(err),
      } as unknown as SessionEvent);
    });
  }

  return c.json({ accepted: body.events.length, harness_triggered: hasUserMessage && !!session.agent_id }, 202);
});

/**
 * Run one DefaultHarness turn for `sessionId` against `agentId` with the
 * given user message. Builds a HarnessContext on the fly: agent config from
 * agentsService, model from resolveModel + ANTHROPIC_API_KEY, tools from
 * buildTools (with the no-sandbox stub). Marks the session 'running' for the
 * duration so crash-recovery on restart finds it.
 */
async function runHarnessTurn(
  sessionId: string,
  agentId: string,
  userMessage: UserMessageEvent,
): Promise<void> {
  const agent = await agentsService.get({ tenantId: TENANT, agentId });
  if (!agent) throw new Error(`agent ${agentId} not found`);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY env var required for harness turns");

  await sql
    .prepare(`UPDATE sessions SET status = 'running', updated_at = ? WHERE id = ?`)
    .bind(Date.now(), sessionId)
    .run();

  try {
    const log = newEventLog(sessionId);
    const sandboxWorkdir = join(
      process.env.SANDBOX_WORKDIR ?? "./data/sandboxes",
      sessionId,
    );
    const sandbox = new LocalSubprocessSandbox({ workdir: sandboxWorkdir });
    const runtime = new NodeHarnessRuntime({ sessionId, log, hub, sandbox });
    await runtime.refreshHistory();

    const model = resolveModel(
      agent.model,
      apiKey,
      process.env.ANTHROPIC_BASE_URL,
      undefined, // compat: default to Anthropic
      parseCustomHeaders(process.env.ANTHROPIC_CUSTOM_HEADERS),
    );
    const tools = await buildTools(agent, runtime.sandbox, {
      ANTHROPIC_API_KEY: apiKey,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      // toMarkdown wired via @open-managed-agents/markdown's Node adapter
      // (turndown for HTML; other formats fall through to raw curl with
      // a warning). On CF this slot gets cfWorkersAiToMarkdown(env.AI).
      toMarkdown: toMarkdownProvider,
    });

    const ctx: HarnessContext = {
      agent,
      userMessage,
      session_id: sessionId,
      tools,
      model,
      systemPrompt: agent.system ?? "",
      env: {
        ANTHROPIC_API_KEY: apiKey,
        ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      },
      runtime,
    };

    const harness = new DefaultHarness();
    await harness.run(ctx);
  } finally {
    await sql
      .prepare(`UPDATE sessions SET status = 'idle', updated_at = ? WHERE id = ?`)
      .bind(Date.now(), sessionId)
      .run();
  }
}

// POST /v1/sessions/:id/_test_emit — manual event injector. Stand-in for
// what a real harness loop does when an LLM produces an agent.message.
// Lets the PoC demo crash-recovery without wiring a full agent loop.
v1.post("/sessions/:id/_test_emit", async (c) => {
  const sid = c.req.param("id");
  const session = await sql
    .prepare(`SELECT id FROM sessions WHERE tenant_id = ? AND id = ?`)
    .bind(TENANT, sid)
    .first();
  if (!session) return c.json({ error: "Session not found" }, 404);
  const body = await c.req
    .json<{ text?: string }>()
    .catch(() => ({}) as { text?: string });
  const ev: SessionEvent = {
    type: "agent.message",
    content: [{ type: "text", text: body.text ?? `tick at ${new Date().toISOString()}` }],
  } as unknown as SessionEvent;
  const log = newEventLog(sid);
  await log.appendAsync(ev);
  const stored = await log.getEventsAsync();
  const last = stored[stored.length - 1];
  hub.publish(sid, last);
  return c.json({ emitted: last }, 202);
});

// GET /v1/sessions/:id/events/stream — SSE with crash-recovery via
// Last-Event-ID. The browser's EventSource API auto-reconnects with the
// last received id; curl can pass `-H 'Last-Event-ID: <seq>'` to resume.
v1.get("/sessions/:id/events/stream", async (c) => {
  const sid = c.req.param("id");
  const session = await sql
    .prepare(`SELECT id FROM sessions WHERE tenant_id = ? AND id = ?`)
    .bind(TENANT, sid)
    .first();
  if (!session) return c.json({ error: "Session not found" }, 404);

  const lastSeen = parseLastEventId(c.req.header("Last-Event-ID"));
  const log = newEventLog(sid);

  // Replay history from after the client's last seen event. EventSource
  // will pick this up as a normal stream.
  const history = await log.getEventsAsync(lastSeen);

  let writer: EventWriter | null = null;
  let off: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      writer = {
        closed: false,
        write(ev) {
          const seq = (ev as { seq?: number }).seq;
          const id = seq !== undefined ? `id: ${seq}\n` : "";
          try {
            controller.enqueue(enc.encode(`${id}data: ${JSON.stringify(ev)}\n\n`));
          } catch {
            this.closed = true;
          }
        },
        close() {
          if (this.closed) return;
          this.closed = true;
          try {
            controller.close();
          } catch {
            // already closed
          }
        },
      };

      // Send the SSE retry hint so EventSource reconnects fast (default
      // browser is 3s; we lower to 1s for snappier recovery in the demo).
      controller.enqueue(enc.encode("retry: 1000\n\n"));

      // Replay first, then subscribe so live events that landed during
      // replay also reach the client.
      for (const ev of history) writer.write(ev);

      off = hub.attach(sid, writer);
    },
    cancel() {
      // Client disconnected.
      off?.();
      writer?.close();
    },
  });

  // Some Hono+Node combos drop the cancel signal silently if the request
  // is aborted mid-flight; piggyback on the abort signal too.
  c.req.raw.signal.addEventListener("abort", () => {
    off?.();
    writer?.close();
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
});

// ── Memory stores (Phase B-memory) ───────────────────────────────────────
//
// REST API for the Anthropic-aligned managed memory contract. Inside the
// sandbox, agents access memory stores as filesystem mounts at
// `/mnt/memory/<store_name>/` using the standard file tools — no bespoke
// memory_* tools. The Node-side LocalSubprocessSandbox doesn't support
// real FUSE mounts so the agent path is currently REST-only; mount support
// lands when the sandbox grows it (E2B already supports it via s3fs).

v1.post("/memory_stores", async (c) => {
  const body = await c.req.json<{ name: string; description?: string }>();
  if (!body.name) return c.json({ error: "name is required" }, 400);
  const row = await memoryService.createStore({
    tenantId: TENANT,
    name: body.name,
    description: body.description,
  });
  return c.json(row, 201);
});

v1.get("/memory_stores", async (c) => {
  const rows = await memoryService.listStores({
    tenantId: TENANT,
    includeArchived: c.req.query("include_archived") === "true",
  });
  return c.json({ data: rows });
});

v1.get("/memory_stores/:id", async (c) => {
  const row = await memoryService.getStore({
    tenantId: TENANT,
    storeId: c.req.param("id"),
  });
  if (!row) return c.json({ error: "Memory store not found" }, 404);
  return c.json(row);
});

v1.post("/memory_stores/:id/memories", async (c) => {
  const body = await c.req.json<{
    path: string;
    content: string;
    precondition?: { type: "content_sha256"; content_sha256: string } | { type: "not_exists" };
  }>();
  if (!body.path || body.content === undefined) {
    return c.json({ error: "path and content are required" }, 400);
  }
  try {
    const row = await memoryService.writeByPath({
      tenantId: TENANT,
      storeId: c.req.param("id"),
      path: body.path,
      content: body.content,
      precondition: body.precondition,
      actor: { type: "user", id: TENANT },
    });
    return c.json(row, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

v1.get("/memory_stores/:id/memories", async (c) => {
  const rows = await memoryService.listMemories({
    tenantId: TENANT,
    storeId: c.req.param("id"),
    pathPrefix: c.req.query("path_prefix") ?? undefined,
  });
  return c.json({ data: rows });
});

v1.get("/memory_stores/:id/memories/:mid", async (c) => {
  const row = await memoryService.readById({
    tenantId: TENANT,
    storeId: c.req.param("id"),
    memoryId: c.req.param("mid"),
  });
  if (!row) return c.json({ error: "Memory not found" }, 404);
  return c.json(row);
});

// ── Vaults + credentials (Phase B-vault) ──────────────────────────────────
//
// REST CRUD for vaults and credentials. The actual credential injection
// happens in apps/oma-vault (separate process) which reads the same sqlite
// db. apps/oma-vault sits in front of the agent's outbound HTTPS traffic
// as a MITM proxy, matches the destination URL against active credentials,
// and rewrites the Authorization header. Sandboxes run with HTTPS_PROXY +
// NODE_EXTRA_CA_CERTS pointing at it — the agent never sees secrets.

v1.post("/vaults", async (c) => {
  const body = await c.req.json<{ name: string }>();
  if (!body.name) return c.json({ error: "name is required" }, 400);
  const row = await vaultService.create({
    tenantId: TENANT,
    name: body.name,
  });
  return c.json(row, 201);
});

v1.get("/vaults", async (c) => {
  const rows = await vaultService.list({
    tenantId: TENANT,
    includeArchived: c.req.query("include_archived") === "true",
  });
  return c.json({ data: rows });
});

v1.get("/vaults/:id", async (c) => {
  const row = await vaultService.get({
    tenantId: TENANT,
    vaultId: c.req.param("id"),
  });
  if (!row) return c.json({ error: "Vault not found" }, 404);
  return c.json(row);
});

v1.post("/vaults/:id/credentials", async (c) => {
  const body = await c.req.json<{
    display_name: string;
    auth: import("@open-managed-agents/shared").CredentialAuth;
  }>();
  if (!body.display_name || !body.auth) {
    return c.json({ error: "display_name and auth are required" }, 400);
  }
  const row = await credentialService.create({
    tenantId: TENANT,
    vaultId: c.req.param("id"),
    displayName: body.display_name,
    auth: body.auth,
  });
  // Always strip secret fields before returning over the wire.
  return c.json(stripSecrets(row), 201);
});

v1.get("/vaults/:id/credentials", async (c) => {
  const rows = await credentialService.list({
    tenantId: TENANT,
    vaultId: c.req.param("id"),
    includeArchived: c.req.query("include_archived") === "true",
  });
  return c.json({ data: rows.map(stripSecrets) });
});

app.route("/v1", v1);

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => {
  console.error("[main-node] unhandled", err);
  return c.json({ error: "internal_error", message: err.message }, 500);
});

// ─── Helpers ─────────────────────────────────────────────────────────────

function parseLastEventId(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Parse `Header-Name: value, Header-2: value2` into a Record. Best-effort —
 *  malformed entries silently dropped. Used to thread custom headers
 *  (X-Sub-Module etc.) into the model API call when ANTHROPIC_BASE_URL
 *  points at a proxy that requires them. */
function parseCustomHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const [name, ...rest] = part.split(":");
    if (!name || rest.length === 0) continue;
    out[name.trim()] = rest.join(":").trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

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
