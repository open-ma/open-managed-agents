/**
 * apps/main-node — self-host Node entry for the Open Managed Agents API.
 *
 * Wiring file. ~280 lines: build services → mount route bundles from
 * @open-managed-agents/http-routes → start server. All route bodies live
 * in packages/http-routes; storage adapters in their respective packages
 * (agents-store, vaults-store, memory-store, etc.).
 */

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import {
  createNodeLogger,
} from "@open-managed-agents/observability/logger/node";
import {
  createNodeMetricsRecorder,
  type NodeMetricsHandle,
} from "@open-managed-agents/observability/metrics/node";
import {
  createNodeTracer,
  type NodeTracerHandle,
} from "@open-managed-agents/observability/tracer/node";
import {
  requestMetrics,
  tracerMiddleware,
  setRootLogger,
  type Logger,
} from "@open-managed-agents/observability";
import {
  createBetterSqlite3SqlClient,
  createPostgresSqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import { createSqliteAgentService } from "@open-managed-agents/agents-store";
import {
  createSqliteMemoryStoreService,
  SqlMemoryRepo,
} from "@open-managed-agents/memory-store";
import { LocalFsBlobStore as MemoryLocalFsBlobStore } from "@open-managed-agents/memory-store/adapters/local-fs-blob";
import {
  S3BlobStore as FilesS3BlobStore,
  type BlobStore,
} from "@open-managed-agents/blob-store";
import { LocalFsBlobStore as FilesLocalFsBlobStore } from "@open-managed-agents/blob-store/adapters/local-fs";
import { createSqliteVaultService } from "@open-managed-agents/vaults-store";
import { createSqliteCredentialService } from "@open-managed-agents/credentials-store";
import { createSqliteSessionService } from "@open-managed-agents/sessions-store";
import { createSqliteFileService } from "@open-managed-agents/files-store";
import { createSqliteEvalRunService } from "@open-managed-agents/evals-store";
import { createSqliteEnvironmentService } from "@open-managed-agents/environments-store";
import { toFileRecord } from "@open-managed-agents/files-store";
import { SqlEventLog } from "@open-managed-agents/event-log/sql";
import type { SessionEvent } from "@open-managed-agents/shared";
import { generateEventId } from "@open-managed-agents/shared";
import { DefaultHarness } from "@open-managed-agents/agent/harness/default-loop";
import { buildTools } from "@open-managed-agents/agent/harness/tools";
import { resolveModel } from "@open-managed-agents/agent/harness/provider";
import { composeSystemPrompt } from "@open-managed-agents/agent/harness/platform-guidance";
import type { HarnessContext } from "@open-managed-agents/agent/harness/interface";
import { nodeToMarkdown } from "@open-managed-agents/markdown/adapters/node";
import {
  applySchema,
  applyBetterAuthSchema,
  applyTenantSchema,
  applyMemoryPollerSchema,
  applyIntegrationsSchema,
} from "@open-managed-agents/schema";
import {
  buildAgentRoutes,
  buildVaultRoutes,
  buildSessionRoutes,
  buildMemoryRoutes,
  buildTenantRoutes,
  buildMeRoutes,
  buildApiKeyRoutes,
  buildEvalRoutes,
  buildIntegrationsRoutes,
  buildIntegrationsGatewayRoutes,
  type RouteServices,
  type ApiKeyStorage,
  type ApiKeyMeta,
  type ApiKeyRecord,
  type InstallProxyForwarder,
  mintApiKeyOnStorage,
  sha256Hex,
} from "@open-managed-agents/http-routes";
import {
  buildNodeRepos,
  SqlSlackInstallationRepo,
  SqlSlackPublicationRepo,
  SqlSlackAppRepo,
  WebCryptoAesGcm,
  CryptoIdGenerator,
  type NodeReposEnv,
} from "@open-managed-agents/integrations-adapters-node";
import {
  NodeInstallBridge,
  buildNodeProvidersForRequest,
} from "./lib/node-install-bridge.js";
import { OmaVaultResolver } from "@open-managed-agents/oma-cap-adapter";
import { NodeSessionRouter } from "./lib/node-session-router.js";
import { nodeOutputsAdapter } from "./lib/node-outputs-adapter.js";
import { nodeSessionLifecycle } from "./lib/node-session-lifecycle.js";
import { NodeWorkspaceBackupService } from "./lib/node-workspace-backup.js";
import { DefaultSandboxOrchestrator } from "@open-managed-agents/sandbox/orchestrator";
import { createAuthMiddleware as buildAuthMw } from "@open-managed-agents/auth";
import {
  buildBetterAuth,
  ensureTenantSqlite,
} from "@open-managed-agents/auth-config";
import { senderFromEnv } from "@open-managed-agents/email/adapters/nodemailer";
import { SqlKvStore } from "@open-managed-agents/kv-store/adapters/sql";
import {
  selectBrowserHarness,
  buildSelectedBrowserHarness,
} from "@open-managed-agents/browser-harness/select";
import type { BrowserHarness } from "@open-managed-agents/browser-harness";
import { startMemoryBlobWatcher } from "./lib/memory-blob-watcher.js";
import { buildNodeScheduler } from "./lib/node-scheduler-jobs.js";
import { startNodeMemoryQueue } from "./lib/node-memory-queue.js";
import { mkdirSync } from "node:fs";
import { dirname, relative } from "node:path";
import { nanoid } from "nanoid";
import {
  InProcessEventStreamHub,
  type EventStreamHub,
} from "./lib/event-stream-hub";
import { PgEventStreamHub } from "./lib/pg-event-stream-hub";
import { NodeHarnessRuntime } from "./lib/node-harness-runtime";
import { SessionRegistry } from "./registry.js";

const toMarkdownProvider = nodeToMarkdown();

// ─── Observability bootstrap ─────────────────────────────────────────────
//
// Logger is constructed first so every later step can use it instead of
// raw console.*. Metrics + tracer follow; both are no-ops by default and
// only spin up real backends when the env opts in.
//   - Prometheus metrics: always-on in-process registry; /metrics text
//     endpoint mounted below.
//   - OTel tracing: starts only when OTEL_EXPORTER_OTLP_ENDPOINT is set.
const logger: Logger = await createNodeLogger({
  bindings: { service: "main-node", pid: process.pid },
});
setRootLogger(logger);

const metrics: NodeMetricsHandle = await createNodeMetricsRecorder();
const tracer: NodeTracerHandle = await createNodeTracer({
  serviceName: "oma-main-node",
});

// ─── Bootstrap ───────────────────────────────────────────────────────────

const dbUrl = process.env.DATABASE_URL ?? "";
const usePostgres = dbUrl.startsWith("postgres://") || dbUrl.startsWith("postgresql://");
const dialect = usePostgres ? "postgres" : "sqlite";

let sql: SqlClient;
let backendDescription: string;
if (usePostgres) {
  sql = await createPostgresSqlClient(dbUrl);
  const u = new URL(dbUrl);
  backendDescription = `postgres ${u.hostname}:${u.port || 5432}${u.pathname}`;
} else {
  const dbPath = process.env.DATABASE_PATH ?? "./data/oma.db";
  mkdirSync(dirname(dbPath), { recursive: true });
  sql = await createBetterSqlite3SqlClient(dbPath);
  backendDescription = `sqlite ${dbPath}`;
}

await applySchema({ sql, dialect });
await applyTenantSchema(sql);
// Integration tables — Linear/GitHub/Slack publications, installs, dispatch
// rules, webhook event log. Self-host runs them on the same SqlClient as
// agents/sessions/etc; CF stays on D1 migrations.
const platformRootSecret = process.env.PLATFORM_ROOT_SECRET;
if (platformRootSecret) {
  await applyIntegrationsSchema({ sql, dialect });
}

// ─── Auth ───────────────────────────────────────────────────────────────

const authDisabled = process.env.AUTH_DISABLED === "1";
const authDbPath = process.env.AUTH_DATABASE_PATH ?? "./data/auth.db";
const sender = senderFromEnv(process.env);

let auth: ReturnType<typeof buildBetterAuth> | null = null;
let authShutdown: (() => Promise<void>) | null = null;

if (!authDisabled) {
  if (usePostgres) {
    const { Pool } = (await import("pg")) as typeof import("pg");
    const pgPool = new Pool({ connectionString: dbUrl });
    await applyBetterAuthSchema({ sql, dialect: "postgres" });
    auth = buildBetterAuth({
      database: pgPool,
      sender,
      secret: process.env.BETTER_AUTH_SECRET ?? randomFallback(),
      baseURL: process.env.PUBLIC_BASE_URL,
      googleClientId: process.env.GOOGLE_CLIENT_ID,
      googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
      requireEmailVerify: process.env.AUTH_REQUIRE_EMAIL_VERIFY === "1",
      cookieDomain: process.env.AUTH_COOKIE_DOMAIN,
      ensureTenant: (u) => ensureTenantSqlite(sql, u.id, u.name, u.email),
    });
    authShutdown = async () => {
      await pgPool.end();
    };
  } else {
    mkdirSync(dirname(authDbPath), { recursive: true });
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const authDb = new BetterSqlite3(authDbPath);
    // Run the better-auth schema on the auth db via a thin SqlClient shim —
    // applyBetterAuthSchema only uses sql.exec which maps cleanly.
    await applyBetterAuthSchema({
      sql: betterSqliteAsSqlClient(authDb),
      dialect: "sqlite",
    });
    auth = buildBetterAuth({
      database: authDb,
      sender,
      secret: process.env.BETTER_AUTH_SECRET ?? randomFallback(),
      baseURL: process.env.PUBLIC_BASE_URL,
      googleClientId: process.env.GOOGLE_CLIENT_ID,
      googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
      requireEmailVerify: process.env.AUTH_REQUIRE_EMAIL_VERIFY === "1",
      cookieDomain: process.env.AUTH_COOKIE_DOMAIN,
      ensureTenant: (u) => ensureTenantSqlite(sql, u.id, u.name, u.email),
    });
    authShutdown = async () => {
      authDb.close();
    };
  }
}

// ─── Stores ─────────────────────────────────────────────────────────────

const agentsService = createSqliteAgentService({ client: sql });
const vaultService = createSqliteVaultService({ client: sql });
const credentialService = createSqliteCredentialService({ client: sql });
const sessionsService = createSqliteSessionService({ client: sql });
const filesService = createSqliteFileService({ client: sql });
const evalsService = createSqliteEvalRunService({ client: sql });
const environmentsService = createSqliteEnvironmentService({ client: sql });

let memoryBlobs: import("@open-managed-agents/memory-store").BlobStore;
let memoryBlobDescription: string;
let memoryBlobLocalDir: string | null = null;
let s3MemoryConfig: {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
} | null = null;

if (
  process.env.MEMORY_S3_ENDPOINT &&
  process.env.MEMORY_S3_BUCKET &&
  process.env.MEMORY_S3_ACCESS_KEY &&
  process.env.MEMORY_S3_SECRET_KEY
) {
  const { S3BlobStore } = await import(
    "@open-managed-agents/memory-store/adapters/s3-blob"
  );
  s3MemoryConfig = {
    endpoint: process.env.MEMORY_S3_ENDPOINT,
    bucket: process.env.MEMORY_S3_BUCKET,
    accessKey: process.env.MEMORY_S3_ACCESS_KEY,
    secretKey: process.env.MEMORY_S3_SECRET_KEY,
    region: process.env.MEMORY_S3_REGION ?? "us-east-1",
  };
  memoryBlobs = new S3BlobStore({
    endpoint: s3MemoryConfig.endpoint,
    bucket: s3MemoryConfig.bucket,
    accessKeyId: s3MemoryConfig.accessKey,
    secretAccessKey: s3MemoryConfig.secretKey,
    region: s3MemoryConfig.region,
  });
  memoryBlobDescription = `s3 ${s3MemoryConfig.endpoint}/${s3MemoryConfig.bucket}`;
} else {
  memoryBlobLocalDir = process.env.MEMORY_BLOB_DIR ?? "./data/memory-blobs";
  memoryBlobs = new MemoryLocalFsBlobStore({ baseDir: memoryBlobLocalDir });
  memoryBlobDescription = `localfs ${memoryBlobLocalDir}`;
}

const memoryService = createSqliteMemoryStoreService({
  client: sql,
  blobs: memoryBlobs,
});
const memoryRepo = new SqlMemoryRepo(sql);
// Memory blob watcher — wires chokidar fs events through
// packages/queue's processMemoryEvent so CF + Node share one upsert
// code path. PG mode uses the multi-replica-safe PG queue table; SQLite
// single-instance uses an in-memory queue. Set MEMORY_QUEUE=disabled to
// skip wiring and fall back to the legacy direct-call watcher.
const useQueue = (process.env.MEMORY_QUEUE ?? "auto") !== "disabled";
const memoryWatcher = memoryBlobLocalDir && useQueue
  ? await startNodeMemoryQueue({
      mode: usePostgres ? "pg" : "in-memory",
      sql: usePostgres ? sql : undefined,
      memoryRepo,
      memoryBlobs,
      memoryRoot: memoryBlobLocalDir,
    })
  : memoryBlobLocalDir
    ? startMemoryBlobWatcher({ memoryRoot: memoryBlobLocalDir, memoryRepo })
    : { stop: async () => {} };

let s3Poller: { stop: () => Promise<void> } | null = null;
if (s3MemoryConfig) {
  await applyMemoryPollerSchema({ sql, dialect });
  const replicaId = `replica_${process.pid}_${Math.floor(Math.random() * 1e9).toString(36)}`;
  const intervalSec = Number(process.env.MEMORY_S3_POLL_INTERVAL_SEC ?? 30);
  const { startS3MemoryPoller } = await import("./lib/s3-memory-poller.js");
  s3Poller = await startS3MemoryPoller({
    sql,
    sqlDialect: dialect,
    memoryRepo,
    replicaId,
    intervalMs: Math.max(5_000, intervalSec * 1000),
    s3: s3MemoryConfig,
  });
}

const outputsRoot = process.env.SESSION_OUTPUTS_DIR ?? "./data/session-outputs";
mkdirSync(outputsRoot, { recursive: true });

// ─── Files-store blob backend ────────────────────────────────────────
//
// Keyed off FILES_S3_* env vars; falls back to a local-FS adapter under
// FILES_BLOB_DIR (default ./data/files-blobs). The blob store backs both
// the files-store table content AND workspace_backups tar archives —
// same single store, two key prefixes.

let filesBlob: BlobStore;
let filesBlobDescription: string;
if (
  process.env.FILES_S3_ENDPOINT &&
  process.env.FILES_S3_BUCKET &&
  process.env.FILES_S3_ACCESS_KEY &&
  process.env.FILES_S3_SECRET_KEY
) {
  filesBlob = new FilesS3BlobStore({
    endpoint: process.env.FILES_S3_ENDPOINT,
    bucket: process.env.FILES_S3_BUCKET,
    accessKeyId: process.env.FILES_S3_ACCESS_KEY,
    secretAccessKey: process.env.FILES_S3_SECRET_KEY,
    region: process.env.FILES_S3_REGION ?? "us-east-1",
  });
  filesBlobDescription = `s3 ${process.env.FILES_S3_ENDPOINT}/${process.env.FILES_S3_BUCKET}`;
} else {
  const filesBlobDir = process.env.FILES_BLOB_DIR ?? "./data/files-blobs";
  mkdirSync(filesBlobDir, { recursive: true });
  filesBlob = new FilesLocalFsBlobStore({ baseDir: filesBlobDir });
  filesBlobDescription = `localfs ${filesBlobDir}`;
}

const workspaceBackups = new NodeWorkspaceBackupService({
  sql,
  blobs: filesBlob,
});

const sandboxOrchestrator = new DefaultSandboxOrchestrator({
  backups: workspaceBackups,
});

// ─── Hub + event log ────────────────────────────────────────────────────

function newEventLog(sessionId: string): SqlEventLog {
  return new SqlEventLog(sql, sessionId, (e) => {
    const ev = e as SessionEvent & { id?: string; processed_at?: string };
    if (!ev.id) ev.id = `sevt_${generateEventId()}`;
    if (!ev.processed_at) ev.processed_at = new Date().toISOString();
  });
}

let hub: EventStreamHub;
if (usePostgres) {
  hub = await PgEventStreamHub.create({
    dsn: dbUrl,
    fetchEventsAfter: (sid, afterSeq) => newEventLog(sid).getEventsAsync(afterSeq),
  });
} else {
  hub = new InProcessEventStreamHub();
}

// ─── Sandbox factory ────────────────────────────────────────────────────

const SANDBOX_PROVIDER_PATHS: Record<string, string> = {
  subprocess: "@open-managed-agents/sandbox/adapters/local-subprocess",
  litebox: "@open-managed-agents/sandbox/adapters/litebox",
  boxlite: "@open-managed-agents/sandbox/adapters/litebox",
  boxrun: "@open-managed-agents/sandbox/adapters/boxrun",
  daytona: "@open-managed-agents/sandbox/adapters/daytona",
  e2b: "@open-managed-agents/sandbox/adapters/e2b",
};

async function buildSandbox(
  sessionId: string,
  workdir: string,
): Promise<import("@open-managed-agents/sandbox").SandboxExecutor> {
  const provider = (process.env.SANDBOX_PROVIDER ?? "subprocess").toLowerCase();
  const path = SANDBOX_PROVIDER_PATHS[provider];
  if (!path) {
    throw new Error(
      `SANDBOX_PROVIDER=${provider} not recognized; valid: ${Object.keys(SANDBOX_PROVIDER_PATHS).join(", ")}`,
    );
  }
  const mod = (await import(path)) as {
    sandboxFactory: import("@open-managed-agents/sandbox").SandboxFactory;
  };
  return mod.sandboxFactory(
    {
      sessionId,
      workdir,
      memoryRoot: memoryBlobLocalDir ?? "",
      outputsRoot,
    },
    process.env,
  );
}

// ─── Session registry ───────────────────────────────────────────────────

const sessionRegistry = new SessionRegistry({
  sql,
  hub,
  agentsService,
  memoryService,
  sandboxOrchestrator,
  newEventLog,
  buildSandbox,
  sandboxWorkdirRoot: process.env.SANDBOX_WORKDIR ?? "./data/sandboxes",
  sqlDialect: dialect,
  buildModel: (agent) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY env var required for harness turns");
    return resolveModel(
      agent.model,
      apiKey,
      process.env.ANTHROPIC_BASE_URL,
      undefined,
      parseCustomHeaders(process.env.ANTHROPIC_CUSTOM_HEADERS),
    );
  },
  buildTools: async (agent, sandbox) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY env var required for harness turns");
    return buildTools(agent, sandbox, {
      ANTHROPIC_API_KEY: apiKey,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      toMarkdown: toMarkdownProvider,
    });
  },
  buildHarness: () => {
    const h = new DefaultHarness();
    return { run: (ctx: unknown) => h.run(ctx as HarnessContext) };
  },
  buildHarnessContext: async (input) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY env var required for harness turns");
    const runtime = new NodeHarnessRuntime({
      sessionId: input.sessionId,
      log: input.eventLog,
      hub,
      sandbox: input.sandbox,
    });
    await runtime.refreshHistory();
    const rawSystemPrompt = input.agent.system ?? "";
    return {
      agent: input.agent,
      userMessage: input.userMessage,
      session_id: input.sessionId,
      tools: input.tools as HarnessContext["tools"],
      model: input.model,
      systemPrompt: composeSystemPrompt(rawSystemPrompt),
      rawSystemPrompt,
      env: {
        ANTHROPIC_API_KEY: apiKey,
        ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      },
      runtime,
    } satisfies HarnessContext;
  },
});

await sessionRegistry.bootstrap();

// ─── Services bundle ────────────────────────────────────────────────────

const kv = new SqlKvStore({ sql, tenantId: "default" });

const services: RouteServices = {
  sql,
  agents: agentsService,
  vaults: vaultService,
  credentials: credentialService,
  memory: memoryService,
  sessions: sessionsService,
  kv,
  newEventLog,
  hub: {
    publish: (sid, ev) => hub.publish(sid, ev as SessionEvent),
    attach: (sid, writer) => hub.attach(sid, writer),
  },
  sessionRegistry: {
    enqueueUserMessage: (sid, tenantId, agentId, ev) => {
      void sessionRegistry
        .getOrCreate(sid, tenantId)
        .then((entry) =>
          entry.machine.runHarnessTurn(agentId, ev as import("@open-managed-agents/shared").UserMessageEvent),
        )
        .catch((err) => {
          logger.error(
            { err, op: "session.harness_turn.failed", session_id: sid, agent_id: agentId },
            "harness turn failed",
          );
          void newEventLog(sid).appendAsync({
            type: "session.error",
            error: "harness_turn_failed",
            message: err instanceof Error ? err.message : String(err),
          } as unknown as SessionEvent);
        });
    },
    interrupt: (sid) => {
      sessionRegistry.interrupt?.(sid);
    },
  },
  background: {
    run: (p) => {
      void p.catch((err) =>
        logger.error({ err, op: "main-node.background.failed" }, "background task failed"),
      );
    },
  },
  outputsRoot,
  logger,
  metrics,
  tracer,
};

// ─── API key storage (SQL) ──────────────────────────────────────────────

const apiKeyStorage: ApiKeyStorage = {
  async insert({ id, hash, prefix, record }) {
    await sql
      .prepare(
        `INSERT INTO api_keys (id, tenant_id, user_id, name, prefix, hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        record.tenant_id,
        record.user_id ?? null,
        record.name,
        prefix,
        hash,
        Date.parse(record.created_at),
      )
      .run();
  },
  async listByTenant(tenantId) {
    const r = await sql
      .prepare(
        `SELECT id, name, prefix, created_at FROM api_keys
          WHERE tenant_id = ? AND revoked_at IS NULL
          ORDER BY created_at DESC`,
      )
      .bind(tenantId)
      .all<{ id: string; name: string; prefix: string; created_at: number }>();
    return (r.results ?? []).map<ApiKeyMeta>((row) => ({
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      created_at: new Date(row.created_at).toISOString(),
    }));
  },
  async findByHash(hash) {
    const row = await sql
      .prepare(
        `SELECT id, tenant_id, user_id, name, created_at FROM api_keys
          WHERE hash = ? AND revoked_at IS NULL`,
      )
      .bind(hash)
      .first<{
        id: string;
        tenant_id: string;
        user_id: string | null;
        name: string;
        created_at: number;
      }>();
    if (!row) return null;
    const rec: ApiKeyRecord = {
      id: row.id,
      tenant_id: row.tenant_id,
      ...(row.user_id ? { user_id: row.user_id } : {}),
      name: row.name,
      created_at: new Date(row.created_at).toISOString(),
    };
    return rec;
  },
  async deleteById(tenantId, id) {
    const r = await sql
      .prepare(
        `UPDATE api_keys SET revoked_at = ? WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL`,
      )
      .bind(Date.now(), tenantId, id)
      .run();
    return (r.meta?.changes ?? 0) > 0;
  },
};

// ─── HTTP ───────────────────────────────────────────────────────────────

const app = new Hono<{
  Variables: { tenant_id: string; user_id?: string };
}>();

// Observability middleware first so it captures auth failures, rate-limit
// rejects, and unhandled exceptions. Mirrors apps/main's CF wiring.
app.use("*", requestMetrics({ recorder: metrics }));
app.use("*", tracerMiddleware({ tracer }));

// Prometheus scrape endpoint. When METRICS_BIND_TOKEN is set, callers must
// pass it in `x-metrics-token`; absent, the endpoint is open on the same
// port (acceptable for self-host single-operator deploys, documented in
// .env.example). For prod, ops should either set the token or front the
// app with a reverse proxy that filters /metrics.
const metricsToken = process.env.METRICS_BIND_TOKEN;
app.get("/metrics", async (c) => {
  if (metricsToken && c.req.header("x-metrics-token") !== metricsToken) {
    return c.text("forbidden", 403);
  }
  const text = await metrics.getPromText();
  return new Response(text, {
    headers: { "Content-Type": metrics.promContentType() },
  });
});

app.get("/health", (c) =>
  c.json({
    status: "ok",
    runtime: "node",
    pid: process.pid,
    uptime_s: Math.round(process.uptime()),
    auth: authDisabled
      ? "disabled"
      : usePostgres
        ? "better-auth-pg"
        : "better-auth-sqlite",
    backends: {
      agents: dialect,
      events: dialect,
      hub: usePostgres ? "pg-notify" : "in-process",
      memory_blobs: memoryBlobDescription,
      db: backendDescription,
    },
  }),
);

app.get("/auth-info", (c) =>
  c.json({
    providers: authDisabled
      ? []
      : [
          "email",
          ...(process.env.AUTH_REQUIRE_EMAIL_VERIFY === "1" ? ["email-otp"] : []),
          ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
            ? ["google"]
            : []),
        ],
    turnstile_site_key: null,
  }),
);

if (auth) {
  app.on(["GET", "POST"], "/auth/*", (c) => auth!.handler(c.req.raw));
}

// Auth middleware via packages/auth — same five-priority resolution as
// apps/main on CF.
const authMw = buildAuthMw({
  disabled: authDisabled,
  bypassPath: (path) => path === "/health" || path.startsWith("/auth/"),
  resolveSession: async (headers) => {
    if (!auth) return null;
    const session = (await auth.api.getSession({ headers })) as
      | { user?: { id: string; email?: string | null; name?: string | null } }
      | null;
    if (!session?.user) return null;
    return {
      userId: session.user.id,
      email: session.user.email ?? null,
      name: session.user.name ?? null,
    };
  },
  resolveApiKey: async (apiKey) => {
    const hash = await sha256Hex(apiKey);
    const rec = await apiKeyStorage.findByHash(hash);
    if (!rec) return null;
    return { tenantId: rec.tenant_id, userId: rec.user_id };
  },
  defaultTenantForUser: async (userId) => {
    const row = await sql
      .prepare(
        `SELECT tenant_id FROM membership WHERE user_id = ? ORDER BY created_at ASC, tenant_id ASC LIMIT 1`,
      )
      .bind(userId)
      .first<{ tenant_id: string }>();
    return row?.tenant_id ?? null;
  },
  hasMembership: async (userId, tenantId) => {
    const row = await sql
      .prepare(
        `SELECT 1 AS one FROM membership WHERE user_id = ? AND tenant_id = ? LIMIT 1`,
      )
      .bind(userId, tenantId)
      .first<{ one: number }>();
    return row !== null;
  },
  ensureTenantForUser: (s) => ensureTenantSqlite(sql, s.userId, s.name, s.email),
});

const v1 = new Hono<{
  Variables: { tenant_id: string; user_id?: string };
}>();
v1.use("*", authMw);

// Mount route bundles. Same paths CF uses; behavior preserved.
v1.route("/agents", buildAgentRoutes({ services }));
const sessionRouter = new NodeSessionRouter({
  sql,
  hub,
  registry: sessionRegistry,
  newEventLog,
});
v1.route("/sessions", buildSessionRoutes({
  services,
  router: sessionRouter,
  outputs: nodeOutputsAdapter(outputsRoot),
  lifecycle: nodeSessionLifecycle({ files: filesService, filesBlob }),
  // Node has no per-tenant cloud environments yet — every agent is treated
  // as a local runtime. The package's loadEnvironment hook returns a
  // synthetic snapshot so session create doesn't 404 on missing env_id.
  localRuntimeEnvId: "env-local-runtime",
  loadEnvironment: async ({ environmentId }) => {
    return {
      id: environmentId,
      runtime: "local",
      sandbox_template: null,
    } as unknown as import("@open-managed-agents/shared").EnvironmentConfig;
  },
}));
v1.route("/vaults", buildVaultRoutes({ services }));
v1.route("/memory_stores", buildMemoryRoutes({ services }));
v1.route("/me", buildMeRoutes({
  services,
  authDisabled,
  loadTenant: async (tenantId) => {
    const r = await sql
      .prepare(`SELECT id, name FROM "tenant" WHERE id = ?`)
      .bind(tenantId)
      .first<{ id: string; name: string }>();
    return r ?? null;
  },
  listMemberships: async (userId) => {
    const r = await sql
      .prepare(
        `SELECT t.id AS id, t.name AS name, m.role AS role, m.created_at AS created_at
           FROM "membership" m JOIN "tenant" t ON t.id = m.tenant_id
          WHERE m.user_id = ? ORDER BY m.created_at ASC, t.id ASC`,
      )
      .bind(userId)
      .all<{ id: string; name: string; role: string; created_at: number }>();
    return r.results ?? [];
  },
  hasMembership: async (userId, tenantId) => {
    const row = await sql
      .prepare(
        `SELECT 1 AS one FROM membership WHERE user_id = ? AND tenant_id = ? LIMIT 1`,
      )
      .bind(userId, tenantId)
      .first<{ one: number }>();
    return row !== null;
  },
  mintApiKey: (input) => mintApiKeyOnStorage(apiKeyStorage, input),
}));
v1.route("/tenants", buildTenantRoutes({ services }));
v1.route("/api_keys", buildApiKeyRoutes({ storage: apiKeyStorage }));
v1.route("/evals", buildEvalRoutes({
  evals: evalsService,
  agents: agentsService,
  // Node has no per-tenant cloud environments yet — leave the optional
  // dep undefined so the route accepts any environment_id without 404ing.
}));

// Stubs for routes the console hits but main-node doesn't yet implement.
v1.get("/environments", (c) => c.json({ data: [] }));
v1.get("/runtimes", (c) => c.json({ data: [] }));
v1.get("/skills", (c) => c.json({ data: [] }));
v1.get("/model_cards", (c) => c.json({ data: [] }));
v1.get("/models/list", (c) =>
  c.json({
    data: [
      { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5", speeds: ["standard", "fast"] },
      { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6", speeds: ["standard"] },
      { id: "claude-opus-4-7", display_name: "Claude Opus 4.7", speeds: ["standard"] },
    ],
  }),
);
v1.get("/integrations/github/credentials", (c) => c.json({ data: [] }));
v1.get("/integrations/linear/credentials", (c) => c.json({ data: [] }));
v1.get("/integrations/slack/credentials", (c) => c.json({ data: [] }));

// Real integration CRUD + lookup (linear/github/slack publications,
// installations, dispatch rules). Active only when PLATFORM_ROOT_SECRET is
// set — otherwise the routes 503 with a remediation message. Install-proxy
// endpoints (start-a1 / credentials / handoff-link / personal-token) return
// 503 because the OAuth/install gateway is not yet ported to Node (P4
// follow-up); the read endpoints work standalone.
// Real integration CRUD + lookup (linear/github/slack publications,
// installations, dispatch rules). Active only when PLATFORM_ROOT_SECRET is
// set — otherwise the routes 503 with a remediation message. The
// install-proxy endpoints (start-a1 / credentials / handoff-link /
// personal-token) call into the in-process InstallBridge, mirroring the
// CF /linear/publications/* etc. wire shapes verbatim.
const integrationsInternalToken = process.env.INTEGRATIONS_INTERNAL_TOKEN ?? null;
const gatewayOrigin = process.env.GATEWAY_ORIGIN ?? process.env.PUBLIC_BASE_URL ?? "http://localhost:8787";
let installBridge: NodeInstallBridge | null = null;
if (platformRootSecret) {
  installBridge = new NodeInstallBridge({
    sql,
    platformRootSecret,
    gatewayOrigin: gatewayOrigin.replace(/\/+$/, ""),
    vaults: vaultService,
    credentials: credentialService,
    sessions: sessionsService,
    agents: agentsService,
    resolveTenantId: async (userId) => {
      const row = await sql
        .prepare(
          `SELECT tenant_id FROM membership WHERE user_id = ? ORDER BY created_at ASC, tenant_id ASC LIMIT 1`,
        )
        .bind(userId)
        .first<{ tenant_id: string }>();
      return row?.tenant_id ?? null;
    },
    appendUserEvent: async (sessionId, _tenantId, _agentId, event) => {
      // Webhook → session-resume drives the same NodeSessionRouter the
      // public POST /v1/sessions/:id/events route uses, so the harness
      // wakes up via the existing event-driven runtime.
      await sessionRouter.appendEvent(sessionId, event);
    },
  });
}

if (platformRootSecret) {
  const integrationsRepoEnv: NodeReposEnv = {
    sql,
    PLATFORM_ROOT_SECRET: platformRootSecret,
  };
  v1.route(
    "/integrations",
    buildIntegrationsRoutes({
      bags: () => {
        const repos = buildNodeRepos(integrationsRepoEnv);
        const slackCrypto = new WebCryptoAesGcm(platformRootSecret, "integrations.tokens");
        const slackIds = new CryptoIdGenerator();
        return {
          linear: {
            installations: repos.linearInstallations,
            publications: repos.linearPublications,
            apps: repos.apps,
            dispatchRules: repos.dispatchRules,
          },
          github: {
            installations: repos.githubInstallations,
            publications: repos.githubPublications,
            githubApps: repos.githubApps,
          },
          slack: {
            installations: new SqlSlackInstallationRepo(sql, slackCrypto, slackIds),
            publications: new SqlSlackPublicationRepo(sql, slackIds),
            apps: new SqlSlackAppRepo(sql, slackCrypto, slackIds),
          },
        };
      },
      installProxy: installBridge ? bridgeAsInstallProxy(installBridge) : null,
    }),
  );
}

// ── Files API (subset of apps/main/src/routes/files.ts) ──
//
// CF mounts a richer files surface with synthesized session-output ids
// and multipart upload; Node ships the read-side equivalent so the SDK
// + console can list, download, and delete files. Uploads still go via
// POST /v1/sessions/:id/files (lifecycle.promoteSandboxFile) and the
// CF-only POST /v1/files (multipart upload from the browser) — that
// route can be ported when console upload UX needs it.
v1.get("/files", async (c) => {
  const t = c.var.tenant_id;
  const scopeId = c.req.query("scope_id") ?? undefined;
  const limitParam = c.req.query("limit");
  let requested = limitParam ? parseInt(limitParam, 10) : 100;
  if (isNaN(requested) || requested < 1) requested = 100;
  if (requested > 1000) requested = 1000;
  const rows = await filesService.list({
    tenantId: t,
    sessionId: scopeId,
    limit: requested,
  });
  return c.json({ data: rows.map(toFileRecord), has_more: false });
});
v1.get("/files/:id/content", async (c) => {
  const id = c.req.param("id");
  const t = c.var.tenant_id;
  const row = await filesService.get({ tenantId: t, fileId: id });
  if (!row) return c.json({ error: "File not found" }, 404);
  if (!row.downloadable) return c.json({ error: "This file is not downloadable" }, 403);
  const obj = await filesBlob.get(row.r2_key);
  if (!obj) return c.json({ error: "File content not found" }, 404);
  return new Response(obj.body, {
    headers: { "Content-Type": row.media_type },
  });
});
v1.get("/files/:id", async (c) => {
  const id = c.req.param("id");
  const t = c.var.tenant_id;
  const row = await filesService.get({ tenantId: t, fileId: id });
  if (!row) return c.json({ error: "File not found" }, 404);
  return c.json(toFileRecord(row));
});
v1.delete("/files/:id", async (c) => {
  try {
    const deleted = await filesService.delete({
      tenantId: c.var.tenant_id,
      fileId: c.req.param("id"),
    });
    await filesBlob.delete(deleted.r2_key).catch(() => undefined);
    return c.json({ type: "file_deleted", id: deleted.id });
  } catch (err) {
    if ((err as { code?: string }).code === "file_not_found") {
      return c.json({ error: "File not found" }, 404);
    }
    throw err;
  }
});

app.route("/v1", v1);

// /v1/oma/* mirror — same Hono sub-app mounted twice. New OMA-only
// endpoints should be added here only; the bare /v1/<resource> mounts
// stay live for back-compat with Console + CLI.
app.route("/v1/oma/me", buildMeRoutes({
  services,
  authDisabled,
  loadTenant: async (tenantId) => {
    const r = await sql
      .prepare(`SELECT id, name FROM "tenant" WHERE id = ?`)
      .bind(tenantId)
      .first<{ id: string; name: string }>();
    return r ?? null;
  },
  listMemberships: async (userId) => {
    const r = await sql
      .prepare(
        `SELECT t.id AS id, t.name AS name, m.role AS role, m.created_at AS created_at
           FROM "membership" m JOIN "tenant" t ON t.id = m.tenant_id
          WHERE m.user_id = ? ORDER BY m.created_at ASC, t.id ASC`,
      )
      .bind(userId)
      .all<{ id: string; name: string; role: string; created_at: number }>();
    return r.results ?? [];
  },
  hasMembership: async (userId, tenantId) => {
    const row = await sql
      .prepare(
        `SELECT 1 AS one FROM membership WHERE user_id = ? AND tenant_id = ? LIMIT 1`,
      )
      .bind(userId, tenantId)
      .first<{ one: number }>();
    return row !== null;
  },
  mintApiKey: (input) => mintApiKeyOnStorage(apiKeyStorage, input),
}));
app.route("/v1/oma/tenants", buildTenantRoutes({ services }));
app.route("/v1/oma/api_keys", buildApiKeyRoutes({ storage: apiKeyStorage }));
app.route("/v1/oma/evals", buildEvalRoutes({
  evals: evalsService,
  agents: agentsService,
}));

// /v1/oma/integrations mirror — same factory used twice. New OMA-only
// endpoints (if any) get added in the package, not here.
if (platformRootSecret) {
  const integrationsRepoEnvOma: NodeReposEnv = {
    sql,
    PLATFORM_ROOT_SECRET: platformRootSecret,
  };
  app.route(
    "/v1/oma/integrations",
    buildIntegrationsRoutes({
      bags: () => {
        const repos = buildNodeRepos(integrationsRepoEnvOma);
        const slackCrypto = new WebCryptoAesGcm(platformRootSecret, "integrations.tokens");
        const slackIds = new CryptoIdGenerator();
        return {
          linear: {
            installations: repos.linearInstallations,
            publications: repos.linearPublications,
            apps: repos.apps,
            dispatchRules: repos.dispatchRules,
          },
          github: {
            installations: repos.githubInstallations,
            publications: repos.githubPublications,
            githubApps: repos.githubApps,
          },
          slack: {
            installations: new SqlSlackInstallationRepo(sql, slackCrypto, slackIds),
            publications: new SqlSlackPublicationRepo(sql, slackIds),
            apps: new SqlSlackAppRepo(sql, slackCrypto, slackIds),
          },
        };
      },
      installProxy: installBridge ? bridgeAsInstallProxy(installBridge) : null,
    }),
  );
}

// ─── Integrations gateway (OAuth callbacks, setup pages, Linear MCP,
// GitHub internal refresh, webhooks) — mounted on `app` (NOT under /v1)
// because the upstream OAuth/webhook URLs are at /linear/oauth/...,
// /linear-setup/..., /linear/webhook/..., etc. Active only when
// PLATFORM_ROOT_SECRET is set (encryption requires it). The bridge
// constructs providers per-request off the same Container builder used
// by the read-side routes, so a write hits the same underlying tables.
if (installBridge) {
  const containers = installBridge.buildContainers();
  app.route(
    "/",
    buildIntegrationsGatewayRoutes({
      installBridge,
      jwt: containers.linear.jwt,
      webhooks: {
        linear: (req) => buildNodeProvidersForRequest(installBridge!, gatewayOrigin).linear.handleWebhook(req),
        github: (req) => buildNodeProvidersForRequest(installBridge!, gatewayOrigin).github.handleWebhook(req),
        slack: (req) => buildNodeProvidersForRequest(installBridge!, gatewayOrigin).slack.handleWebhook(req),
      },
      internalSecret: integrationsInternalToken,
      // Node has no per-tenant rate-limit binding by default; soft-pass.
      rateLimit: undefined,
    }),
  );
}

// oma-cap-adapter wire — exposes a Resolver against the in-process vault
// services so a future Node outbound proxy (mirroring CF's mcp-proxy) can
// inject cap_cli credentials into sandbox traffic. Wired here at the
// services construction site so the resolver is available even before
// the outbound surface lands.
const _capResolver = new OmaVaultResolver({
  sessions: {
    get: ({ tenantId, sessionId }) => sessionsService.get({ tenantId, sessionId }) as never,
  },
  credentials: {
    listByVaults: ({ tenantId, vaultIds }) =>
      credentialService.listByVaults({ tenantId, vaultIds }) as never,
    update: ({ tenantId, vaultId, credentialId, auth }) =>
      credentialService.update({ tenantId, vaultId, credentialId, auth }) as never,
    create: ({ tenantId, vaultId, displayName, auth }) =>
      credentialService.create({ tenantId, vaultId, displayName, auth }) as never,
  },
});
void _capResolver;

// ── Session ↔ memory_store binding (Node-specific; not in package yet) ──
v1.post("/sessions/:id/memory_stores", async (c) => {
  const sid = c.req.param("id");
  const session = await sql
    .prepare(`SELECT id FROM sessions WHERE tenant_id = ? AND id = ?`)
    .bind(c.var.tenant_id, sid)
    .first();
  if (!session) return c.json({ error: "Session not found" }, 404);
  const body = await c.req.json<{ store_id: string; access?: string }>();
  if (!body.store_id) return c.json({ error: "store_id is required" }, 400);
  const store = await memoryService.getStore({
    tenantId: c.var.tenant_id,
    storeId: body.store_id,
  });
  if (!store) return c.json({ error: "Memory store not found" }, 404);
  const access = body.access === "read_only" ? "read_only" : "read_write";
  await sql
    .prepare(
      `INSERT INTO session_memory_stores (session_id, store_id, access, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id, store_id) DO UPDATE SET access = excluded.access`,
    )
    .bind(sid, body.store_id, access, Date.now())
    .run();
  return c.json({ session_id: sid, store_id: body.store_id, access }, 201);
});
v1.get("/sessions/:id/memory_stores", async (c) => {
  const r = await sql
    .prepare(
      `SELECT store_id, access, created_at FROM session_memory_stores WHERE session_id = ?`,
    )
    .bind(c.req.param("id"))
    .all<{ store_id: string; access: string; created_at: number }>();
  return c.json({ data: r.results ?? [] });
});

// ── Console UI (optional) ──
const consoleDir = process.env.CONSOLE_DIR;
if (consoleDir) {
  const cwd = process.cwd();
  const rootRel = consoleDir.startsWith("/")
    ? relative(cwd, consoleDir)
    : consoleDir;
  app.use("/*", serveStatic({ root: rootRel }));
  app.get("/*", serveStatic({ root: rootRel, path: "index.html" }));
  logger.info({ op: "main-node.console_ui", dir: consoleDir, cwd_rel: rootRel }, "console UI served");
}

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => {
  logger.error({ err, op: "main-node.unhandled" }, "unhandled error");
  return c.json({ error: "internal_error", message: err.message }, 500);
});

// ─── Listen ──────────────────────────────────────────────────────────────

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";
serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  logger.info(
    { op: "main-node.listening", address: info.address, port: info.port, db: backendDescription },
    `listening on http://${info.address}:${info.port}`,
  );
});

// Cron — eval-tick + memory retention sweep + (when integrations schema is
// applied) webhook-events retention. Linear dispatch is left un-wired here
// because main-node doesn't construct a LinearProvider; pass `linearSweeper`
// when an in-process gateway lands.
const scheduler = buildNodeScheduler({
  evalServices: {
    agents: agentsService,
    environments: environmentsService,
    sessions: sessionsService,
    evals: evalsService,
    kv,
  },
  memory: memoryService,
  integrationsSql: platformRootSecret ? sql : null,
});
await scheduler.start();
logger.info({ op: "main-node.scheduler.started" }, "scheduler started");

const shutdown = async (signal: string) => {
  logger.info({ op: "main-node.shutdown", signal }, `received ${signal}, shutting down`);
  try { await scheduler.stop(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.scheduler_stop_failed" }, "scheduler stop failed"); }
  try { await memoryWatcher.stop(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.watcher_stop_failed" }, "memory watcher stop failed"); }
  if (s3Poller) {
    try { await s3Poller.stop(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.s3_poller_stop_failed" }, "s3-poller stop failed"); }
  }
  if (hub instanceof PgEventStreamHub) {
    try { await hub.stop(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.pg_hub_stop_failed" }, "pg-hub stop failed"); }
  }
  if (authShutdown) {
    try { await authShutdown(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.auth_failed" }, "auth shutdown failed"); }
  }
  try { await tracer.shutdown(); } catch { /* tracer shutdown is best-effort */ }
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// ─── Helpers ─────────────────────────────────────────────────────────────

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

function randomFallback(): string {
  // Pre-bootstrap fallback — logger is built before BetterAuth in the
  // current ordering, so this can use the structured logger.
  logger.warn(
    { op: "main-node.auth_secret_missing" },
    "BETTER_AUTH_SECRET not set — generating per-process random secret. Sessions will not survive restart.",
  );
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * In-process forwarder for the package's `installProxy` deps. Each subpath
 * (e.g. "linear/publications/start-a1") routes to bridge.startInstallation.
 * Mirrors apps/main/src/routes/integrations.ts but skips the
 * INTEGRATIONS.fetch hop.
 */
function bridgeAsInstallProxy(bridge: NodeInstallBridge): InstallProxyForwarder {
  return {
    async forward({ subpath, body }) {
      const m = /^([^/]+)\/publications\/(start-a1|credentials|handoff-link|personal-token)$/.exec(
        subpath,
      );
      if (!m) {
        return new Response(
          JSON.stringify({ error: `unsupported install proxy subpath: ${subpath}` }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      const [, provider, mode] = m;
      const result = await bridge.startInstallation!({
        provider: provider as "linear" | "github" | "slack",
        mode: mode as "start-a1" | "credentials" | "handoff-link" | "personal-token",
        body: (body ?? {}) as Record<string, unknown>,
      });
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

/**
 * Lightweight SqlClient shim around a better-sqlite3 Database. Used only
 * to run the better-auth schema apply against the auth db (separate
 * connection from the main SqlClient). We don't ship a full adapter — only
 * .exec() is needed.
 */
function betterSqliteAsSqlClient(
  db: import("better-sqlite3").Database,
): SqlClient {
  return {
    exec: async (s: string) => {
      db.exec(s);
    },
    prepare: () => {
      throw new Error("not implemented");
    },
    batch: async () => [],
  } as SqlClient;
}
