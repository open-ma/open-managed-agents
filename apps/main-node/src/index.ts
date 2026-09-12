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
import { OpenAIAgentsProtocolError } from "@open-managed-agents/openai-agents-api";
import {
  createArtifactsHandler,
  createManagedSessionMapping,
  createResourcesHandler,
  createSessionsHandler,
  isManagedNoEnvironmentSession,
  readManagedSessionMappingMetadata,
} from "@open-managed-agents/openai-agents-compat";
import { SqlSessionThreadStore } from "@open-managed-agents/session-thread-store-sql";
import { buildOpenAISubagentTools, nodeOpenAISubagentPolicy, openAISubagentSession } from "./openai-subagents.js";
import { buildNodeOpenAIAgentsRoutes } from "./openai-agents.js";
import { createNodeOpenAIAgentsRuntime } from "./openai-managed-runtime.js";
import { createNodeOpenAIArtifactPublisher, withReportedArtifactPublication } from "./openai-artifact-publication.js";
import { createNoEnvironmentSandbox, isNoEnvironmentSandbox } from "./openai-no-environment.js";
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
  createMysql2SqlClient,
  createPostgresSqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import { createSqliteAgentService } from "@open-managed-agents/agents-store";
import {
  createSqliteMemoryStoreService,
  SqlMemoryRepo,
} from "@open-managed-agents/memory-store";
import { createSqliteDreamService } from "@open-managed-agents/dreams-store";
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
import { createSqliteModelCardService } from "@open-managed-agents/model-cards-store";
import { toFileRecord } from "@open-managed-agents/files-store";
import { SqlEventLog } from "@open-managed-agents/event-log/sql";
import type { SessionEvent } from "@open-managed-agents/shared";
import {
  generateEventId,
  listAuthProviders,
} from "@open-managed-agents/shared";
import { registerCoreHarnesses } from "@open-managed-agents/agent/harness/builtins";
import { resolveHarness } from "@open-managed-agents/agent/harness/registry";
import {
  buildTools,
  disposeTools,
} from "@open-managed-agents/agent/harness/tools";
import {
  createPiModelRuntime,
  toAiSdkLanguageModel,
} from "@open-managed-agents/agent/harness/pi-provider";
import type { PiModelConfig } from "@open-managed-agents/agent/harness/pi-provider";
import { generateText } from "ai";
import { composeSystemPrompt } from "@open-managed-agents/agent/harness/platform-guidance";
import type { HarnessContext } from "@open-managed-agents/agent/harness/interface";
import { nodeToMarkdown } from "@open-managed-agents/markdown/adapters/node";
import { applyBetterAuthSchema } from "@open-managed-agents/schema";
import type { OmaDb } from "@open-managed-agents/db-schema";
import { migrateNodeMysqlSchema } from "@open-managed-agents/db-schema/node-mysql";
import { reconcilePiModelConfigMigration } from "./lib/reconcile-pi-model-config-migration.js";
import { ensureSchema as ensureEventLogSchema } from "@open-managed-agents/event-log/sql";
import {
  buildAgentRoutes as buildLegacyAgentRoutes,
  buildVaultRoutes as buildLegacyVaultRoutes,
  buildModelCardRoutes,
  buildEnvironmentRoutes as buildLegacyEnvironmentRoutes,
  buildSessionRoutes,
  buildMemoryRoutes as buildLegacyMemoryRoutes,
  buildDreamRoutes,
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
  buildAgentRoutes as buildManagedAgentRoutes,
  buildCredentialRoutes as buildManagedCredentialRoutes,
  buildDeploymentRoutes as buildManagedDeploymentRoutes,
  buildDeploymentRunRoutes as buildManagedDeploymentRunRoutes,
  buildDreamRoutes as buildManagedDreamRoutes,
  buildEnvironmentRoutes as buildManagedEnvironmentRoutes,
  buildEnvironmentWorkRoutes as buildManagedEnvironmentWorkRoutes,
  buildFileRoutes as buildManagedFileRoutes,
  buildMemoryStoreRoutes as buildManagedMemoryStoreRoutes,
  buildMemoryRoutes as buildManagedMemoryRoutes,
  buildMemoryVersionRoutes as buildManagedMemoryVersionRoutes,
  buildModelRoutes as buildManagedModelRoutes,
  buildSkillRoutes as buildManagedSkillRoutes,
  buildSkillVersionRoutes as buildManagedSkillVersionRoutes,
  buildTunnelCertificateRoutes as buildManagedTunnelCertificateRoutes,
  buildTunnelRoutes as buildManagedTunnelRoutes,
  buildVaultRoutes as buildManagedVaultRoutes,
  buildUserProfileRoutes as buildManagedUserProfileRoutes,
  buildManagedSessionsApi,
} from "@open-managed-agents/managed-agents-api";
import {
  SessionRuntimeHistoryApplicationService,
  SessionRuntimeProjectionApplicationService,
  type SessionEnvironmentSourcePort,
} from "@open-managed-agents/managed-agents-application";
import { bindPort, defineAppModule, providePort } from "@open-managed-agents/app";
import { managedAgentsPortTokens } from "@open-managed-agents/app/managed-agents";
import {
  deploymentAgentSourcePort,
  deploymentEnvironmentSourcePort,
  deploymentFileSourcePort,
  deploymentMemoryStoreSourcePort,
  deploymentSchedulePlannerPort,
  deploymentSessionLauncherPort,
  deploymentVaultSourcePort,
} from "@open-managed-agents/app/modules/deployments";
import {
  dreamCuratorPort,
  dreamExecutionModule,
  dreamMemoryStoreSourcePort,
  dreamMemoryWorkspacePort,
  dreamSessionSourcePort,
} from "@open-managed-agents/app/modules/dreams";
import {
  environmentSessionWorkEnqueuerPort,
  environmentWorkAvailabilityWaiterPort,
  environmentWorkEnqueuerModule,
  environmentWorkEnvironmentSourcePort,
  environmentWorkSessionCredentialIssuerPort,
  environmentWorkWakeupPort,
} from "@open-managed-agents/app/modules/environment-work";
import {
  memoryContentDescriptorPort,
  memoryStoreForMemorySourcePort,
  memoryVersionActorPort,
} from "@open-managed-agents/app/modules/memories";
import { modelCatalogSourcePort } from "@open-managed-agents/app/modules/models";
import {
  skillPackageCompilerPort,
} from "@open-managed-agents/app/modules/skills";
import {
  tunnelCertificateAuthorityPort,
  tunnelProvisionerPort,
  tunnelTokenManagerPort,
} from "@open-managed-agents/app/modules/tunnels";
import {
  userProfileEnrollmentIssuerPort,
} from "@open-managed-agents/app/modules/user-profiles";
import {
  createNodeManagedAgentsApp,
  createNodePlatform,
} from "@open-managed-agents/platform-node";
import { SqlFileStore } from "@open-managed-agents/file-store-sql";
import {
  SqlCredentialStore,
  type CredentialDocumentCipher,
} from "@open-managed-agents/credential-store-sql";
import { SqlVaultStore } from "@open-managed-agents/vault-store-sql";
import {
  SqlDeploymentStore,
  type DeploymentResourceSecretCipher,
} from "@open-managed-agents/deployment-store-sql";
import { SqlDeploymentRunStore } from "@open-managed-agents/deployment-run-store-sql";
import { SqlDreamStore } from "@open-managed-agents/dream-store-sql";
import { SqlMemoryStoreStore } from "@open-managed-agents/memory-store-store-sql";
import { SqlMemoryDocumentStore } from "@open-managed-agents/memory-document-store-sql";
import { SqlSkillStore } from "@open-managed-agents/skill-store-sql";
import { SqlTunnelStore } from "@open-managed-agents/tunnel-store-sql";
import { SqlUserProfileStore } from "@open-managed-agents/user-profile-store-sql";
import {
  SqlEnvironmentWorkStore,
  type EnvironmentWorkSecretCipher,
} from "@open-managed-agents/environment-work-store-sql";
import {
  SqlAgentPersistence,
  SqlDeploymentAgentSource,
  SqlDeploymentVaultSource,
  SqlEnvironmentPersistence,
  SqlFileMetadataPersistence,
  SqlMemoryStoreSource,
  SqlManagedSessionsComposition,
  SqlPersistedSessionEventStream,
  SqlSessionEnvironmentSource,
  SqlSessionSource,
  SqlSessionRuntimeProjectionPersistence,
} from "@open-managed-agents/managed-agents-adapters-sql";
import {
  createSqlSessionRuntimeReaders,
  SqlSessionExecutionCoordinator,
} from "@open-managed-agents/session-runtime-sql";
import { MemorySessionRealtimeHub } from "@open-managed-agents/session-realtime-memory";
import {
  AnthropicMessagesDreamCurator,
  ApplicationDreamMemoryWorkspace,
  ModelCardCatalogSource,
  CronDeploymentSchedulePlanner,
  EnvironmentAwareSessionEventDispatchRouter,
  EnvironmentAwareSessionEventStreamRouter,
  EnvironmentAwareSessionLifecycleRouter,
  ingestEnvironmentWorkRuntimeEvents,
  TimerEnvironmentWorkAvailabilityWaiter,
  IndeterminateCredentialValidationProbe,
  inProcessDreamExecutionSchedulerModule,
  LocalTunnelProvisioner,
  authenticateEnvironmentWorkSessionBearer,
  SealedEnvironmentWorkSessionCredentialIssuer,
  StandardWebhookEnvironmentWorkWakeup,
  DeduplicatingDreamCurator,
  WebCryptoTunnelCertificateAuthority,
  WebCryptoTunnelTokenManager,
  WebCryptoMemoryContentDescriptor,
  ZipSkillPackageCompiler,
  synchronizeManagedSessionMemoryWorkspaces,
} from "@open-managed-agents/managed-agents-adapters-runtime";
import { isCurrentEnvironmentWorkClaim } from "@open-managed-agents/environment-work-store";
import { BlobFileContentStore } from "@open-managed-agents/managed-agents-adapters-blob";
import { buildOmaModelsHttpRoutes } from "@open-managed-agents/managed-agents-adapters-http";
import {
  buildNodeRepos,
  SqlFeishuInstallationRepo,
  SqlFeishuPublicationRepo,
  SqlSlackInstallationRepo,
  SqlSlackPublicationRepo,
  SqlSlackAppRepo,
  WebCryptoAesGcm,
  CryptoIdGenerator,
  WorkerHttpClient,
  type NodeReposEnv,
} from "@open-managed-agents/integrations-adapters-node";
import {
  NodeInstallBridge,
  buildNodeProvidersForRequest,
} from "./lib/node-install-bridge.js";
import { OmaVaultResolver } from "@open-managed-agents/oma-cap-adapter";
import { NodeSessionRouter } from "./lib/node-session-router.js";
import {
  configureFeishuAgentTools,
  resolveFeishuAgentTools,
  sqlSessionMetadataReader,
} from "./lib/feishu-agent-tools.js";
import { nodeOutputsAdapter } from "./lib/node-outputs-adapter.js";
import { NodeManagedSessionOutputCollector } from "./lib/node-managed-session-outputs.js";
import { nodeSessionLifecycle } from "./lib/node-session-lifecycle.js";
import { SqlSessionResourceSecretSource } from "@open-managed-agents/session-resource-store-sql";
import { NodeWorkspaceBackupService } from "./lib/node-workspace-backup.js";
import { DefaultSandboxOrchestrator } from "@open-managed-agents/sandbox/orchestrator";
import {
  createAuthMiddleware as buildAuthMw,
  type ApiKeyResolution,
} from "@open-managed-agents/auth";
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
import { rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { nanoid } from "nanoid";
import {
  InProcessEventStreamHub,
  type EventStreamHub,
} from "./lib/event-stream-hub";
import { PgEventStreamHub } from "./lib/pg-event-stream-hub";
import { NodeHarnessRuntime } from "./lib/node-harness-runtime";
import { SessionRegistry } from "./registry.js";
import { buildNodeSkillsRoutes } from "./lib/node-skills-routes.js";
import { ManagedNodeDefaultHarness } from "./lib/node-managed-default-harness.js";
import {
  allowAllLegacyHarnessTools,
  toLegacyHarnessAgentConfig,
  toLegacyHarnessEnvironmentConfig,
} from "./lib/node-managed-agent-codec.js";
import { NodeManagedConfirmedToolExecutor } from "./lib/node-managed-confirmed-tool-executor.js";
import { NodeManagedOutcomeEvaluator } from "./lib/node-managed-outcome-evaluator.js";
import {
  ApplicationBackedNodeManagedSessionRuntimeEngine,
  DefaultNodeManagedSessionRuntimeDriver,
  NodeManagedSessionRuntimeAdapter,
} from "./lib/node-managed-session-runtime.js";
import { DefaultNodeManagedSessionRunner } from "./lib/node-managed-session-runner.js";
import {
  buildNodeManagedSkillReminders,
  NodeManagedSessionInputPreparer,
} from "./lib/node-managed-session-inputs.js";
import { NodeManagedMemorySnapshotMaterializer } from "./lib/node-managed-memory-snapshots.js";
import { NodeSessionExecutionWorker } from "./lib/node-session-execution-worker.js";
import {
  buildNodeHttpMcpProxyRoutes,
  createNodeMcpProxyBinding,
  type NodeMcpProxyTarget,
} from "./lib/http-mcp-proxy.js";
import {
  resolveNodeProcessMode,
  validateNodeProcessEnvironment,
} from "./process-mode.js";
import { resolveSandboxProviderForEnvironment } from "./sandbox-provider.js";

registerCoreHarnesses();

const processMode = resolveNodeProcessMode(process.env);
validateNodeProcessEnvironment(process.env);
const ownsLongLivedProcesses = processMode === "standalone";
const standaloneSandboxProvider = ownsLongLivedProcesses
  ? resolveSandboxProviderForEnvironment(process.env)
  : null;

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
const useMysql = dbUrl.startsWith("mysql://") || dbUrl.startsWith("mysql2://");
const dialect = usePostgres ? "postgres" : useMysql ? "mysql" : "sqlite";

let sql: SqlClient;
let backendDescription: string;
let mysqlPool: import("mysql2/promise").Pool | null = null;
let databaseShutdown: (() => Promise<void>) | null = null;
// drizzleDb is the dependency-inversion seam new-style adapters take.
// Constructed once at the composition root from the right concrete driver.
// Existing SqlClient is still built alongside for the legacy applySchema /
// integrations adapters until those finish migrating.
let drizzleDb: OmaDb<Record<string, unknown>>;
if (usePostgres) {
  sql = await createPostgresSqlClient(dbUrl);
  const { drizzle: drizzlePostgresJs } = await import("drizzle-orm/postgres-js");
  const postgresMod = (await import("postgres" as string)) as { default: (dsn: string) => unknown };
  const pgClient = postgresMod.default(dbUrl);
  drizzleDb = drizzlePostgresJs(pgClient as never) as unknown as OmaDb<Record<string, unknown>>;
  const u = new URL(dbUrl);
  backendDescription = `postgres ${u.hostname}:${u.port || 5432}${u.pathname}`;
} else if (useMysql) {
  sql = await createMysql2SqlClient(dbUrl);
  const mysql = await import("mysql2/promise");
  mysqlPool = mysql.createPool({
    uri: dbUrl,
    supportBigNumbers: true,
    bigNumberStrings: false,
    timezone: "Z",
  });
  const { drizzle: drizzleMysql2 } = await import("drizzle-orm/mysql2");
  drizzleDb = drizzleMysql2(mysqlPool) as unknown as OmaDb<Record<string, unknown>>;
  const u = new URL(dbUrl);
  backendDescription = `mysql ${u.hostname}:${u.port || 3306}${u.pathname}`;
  databaseShutdown = async () => {
    await mysqlPool?.end();
    await (sql as import("@open-managed-agents/sql-client").Mysql2SqlClient).close();
  };
} else {
  const dbPath = process.env.DATABASE_PATH ?? "./data/oma.db";
  mkdirSync(dirname(dbPath), { recursive: true });
  sql = await createBetterSqlite3SqlClient(dbPath);
  const { drizzle: drizzleBetterSqlite3 } = await import("drizzle-orm/better-sqlite3");
  const BetterSqlite3 = (await import("better-sqlite3")).default;
  const sqliteRaw = new BetterSqlite3(dbPath);
  // Match D1's runtime default — FK enforcement off. See packages/sql-client
  // for the rationale (publication-first install + a few other paths).
  sqliteRaw.exec("PRAGMA foreign_keys = OFF");
  drizzleDb = drizzleBetterSqlite3(sqliteRaw) as unknown as OmaDb<Record<string, unknown>>;
  backendDescription = `sqlite ${dbPath}`;
}

// Apply the consolidated baseline (Drizzle migrate runner — one folder per
// dialect, generated by `pnpm db:generate:node-{pg,sqlite}`). Replaces the
// pre-Drizzle applySchema / applyTenantSchema / applyIntegrationsSchema /
// applyMemoryPollerSchema chain — those creator functions hand-wrote
// CREATE TABLE IF NOT EXISTS and ad-hoc ALTER backfills, which had been
// drifting from the canonical CF migration files.
//
// session_events (event-log) is still its own concern: its idempotent
// ensureSchema lives in @open-managed-agents/event-log/sql and runs after
// the baseline migration applies the rest.
const migrationsFolder = usePostgres
  ? new URL("../migrations", import.meta.url).pathname
  : new URL("../migrations-sqlite", import.meta.url).pathname;
await reconcilePiModelConfigMigration(sql, dialect);
if (usePostgres) {
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  await migrate(drizzleDb as never, { migrationsFolder });
} else if (useMysql) {
  await migrateNodeMysqlSchema(sql, migrationsFolder);
} else {
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(drizzleDb as never, { migrationsFolder });
}
if (!useMysql) await ensureEventLogSchema(sql, dialect);
const managedAgentsPersistence = new SqlAgentPersistence(sql);
const managedAgentsPlatform = createNodePlatform({
  features: {
    preset: "none",
    agents: true,
    environments: true,
    files: true,
    memoryStores: true,
    userProfiles: true,
  },
  stores: {
    agents: managedAgentsPersistence,
    environments: new SqlEnvironmentPersistence(sql),
    files: new SqlFileStore(sql),
    memoryStores: new SqlMemoryStoreStore(sql),
    userProfiles: new SqlUserProfileStore(sql),
  },
  fileContent: () => new BlobFileContentStore(filesBlob),
  clock: { now: () => new Date() },
  ids: {
    next: (namespace) =>
      `${namespace === "environment" ? "env" : namespace === "memory_store" ? "memstore" : namespace === "user-profile" ? "uprof" : namespace}_${nanoid()}`,
  },
  modules: () => [
    providePort(userProfileEnrollmentIssuerPort, {
      issue: async () => ({
        type: "conflict" as const,
        message: "User Profile enrollment is unavailable in self-hosted mode",
      }),
    }),
  ],
});

// Integrations subsystem boot is gated on PLATFORM_ROOT_SECRET (used to
// encrypt OAuth tokens etc.). Tables are part of the consolidated baseline
// above so they're always created — the gate now only controls subsystem
// wiring, not schema bootstrap.
const platformRootSecret = process.env.PLATFORM_ROOT_SECRET;
const openAIAgentsConfigurationCipher = platformRootSecret === undefined
  ? null
  : new WebCryptoAesGcm(platformRootSecret, "openai.agents.configuration");
const openAIAgentsSecrets = {
  seal: async (plaintext: string) => {
    if (!openAIAgentsConfigurationCipher) throw new OpenAIAgentsProtocolError(503, "PLATFORM_ROOT_SECRET is required for confidential Agents API configuration", undefined, "configuration_unavailable");
    return openAIAgentsConfigurationCipher.encrypt(plaintext);
  },
  open: async (ciphertext: string) => {
    if (!openAIAgentsConfigurationCipher) throw new OpenAIAgentsProtocolError(503, "PLATFORM_ROOT_SECRET is required for confidential Agents API configuration", undefined, "configuration_unavailable");
    return openAIAgentsConfigurationCipher.decrypt(ciphertext);
  },
};

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
      githubClientId: process.env.GITHUB_CLIENT_ID,
      githubClientSecret: process.env.GITHUB_CLIENT_SECRET,
      requireEmailVerify: process.env.AUTH_REQUIRE_EMAIL_VERIFY === "1",
      cookieDomain: process.env.AUTH_COOKIE_DOMAIN,
      ensureTenant: (u) => ensureTenantSqlite(sql, u.id, u.name, u.email),
    });
    authShutdown = async () => {
      await pgPool.end();
    };
  } else if (useMysql) {
    if (mysqlPool === null) throw new Error("MySQL pool was not initialized");
    await applyBetterAuthSchema({ sql, dialect: "mysql" });
    auth = buildBetterAuth({
      database: mysqlPool,
      sender,
      secret: process.env.BETTER_AUTH_SECRET ?? randomFallback(),
      baseURL: process.env.PUBLIC_BASE_URL,
      googleClientId: process.env.GOOGLE_CLIENT_ID,
      googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
      githubClientId: process.env.GITHUB_CLIENT_ID,
      githubClientSecret: process.env.GITHUB_CLIENT_SECRET,
      requireEmailVerify: process.env.AUTH_REQUIRE_EMAIL_VERIFY === "1",
      cookieDomain: process.env.AUTH_COOKIE_DOMAIN,
      ensureTenant: (u) => ensureTenantSqlite(sql, u.id, u.name, u.email),
    });
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
      githubClientId: process.env.GITHUB_CLIENT_ID,
      githubClientSecret: process.env.GITHUB_CLIENT_SECRET,
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

const agentsService = createSqliteAgentService({ db: drizzleDb });
const vaultService = createSqliteVaultService({ db: drizzleDb });
const credentialService = createSqliteCredentialService({ db: drizzleDb });
const sessionsService = createSqliteSessionService({ db: drizzleDb });
const filesService = createSqliteFileService({ db: drizzleDb });
const evalsService = createSqliteEvalRunService({ db: drizzleDb });
const environmentsService = createSqliteEnvironmentService({ db: drizzleDb });
const modelCardsService = createSqliteModelCardService(
  { db: drizzleDb },
  {
    crypto: platformRootSecret
      ? new WebCryptoAesGcm(platformRootSecret, "model.cards.keys")
      : undefined,
  },
);

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
  db: drizzleDb,
  blobs: memoryBlobs,
});
const dreamsService = createSqliteDreamService({
  client: sql,
  verifyMemoryStoreExists: async (tenantId, storeId) => {
    const row = await sql
      .prepare("SELECT 1 FROM memory_stores WHERE id = ? AND tenant_id = ?")
      .bind(storeId, tenantId)
      .first();
    return !!row;
  },
  verifySessionExists: async (tenantId, sessionId) => {
    const row = await sql
      .prepare("SELECT 1 FROM sessions WHERE id = ? AND tenant_id = ?")
      .bind(sessionId, tenantId)
      .first();
    return !!row;
  },
});
const memoryRepo = new SqlMemoryRepo(drizzleDb);
// Memory blob watcher — wires chokidar fs events through
// packages/queue's processMemoryEvent so CF + Node share one upsert
// code path. Every SQL backend uses the same durable lease/fence contract.
// Set MEMORY_QUEUE=disabled to skip wiring and fall back to the legacy
// direct-call watcher.
const useQueue = (process.env.MEMORY_QUEUE ?? "auto") !== "disabled";
const memoryWatcher = !ownsLongLivedProcesses
  ? { stop: async () => {} }
  : memoryBlobLocalDir && useQueue
  ? await startNodeMemoryQueue({
      mode: "sql",
      sql,
      sqlDialect: dialect,
      memoryRepo,
      memoryBlobs,
      memoryRoot: memoryBlobLocalDir,
    })
  : memoryBlobLocalDir
    ? startMemoryBlobWatcher({ memoryRoot: memoryBlobLocalDir, memoryRepo })
    : { stop: async () => {} };

let s3Poller: { stop: () => Promise<void> } | null = null;
let feishuRunner: { stop: () => Promise<void> } | null = null;
if (ownsLongLivedProcesses && s3MemoryConfig) {
  // memory_blob_poller_lease lives in the consolidated baseline already; no
  // separate schema bootstrap needed here.
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

async function buildSandbox(
  sessionId: string,
  workdir: string,
): Promise<import("@open-managed-agents/sandbox").SandboxExecutor> {
  const selection = standaloneSandboxProvider
    ?? resolveSandboxProviderForEnvironment(process.env);
  const mod = (await import(selection.modulePath)) as {
    sandboxFactory: import("@open-managed-agents/sandbox").SandboxFactory;
  };
  return mod.sandboxFactory(
    {
      sessionId,
      workdir,
      memoryRoot: memoryBlobLocalDir ?? "",
      memoryWorkspace: {
        getText: (key) => memoryBlobs.getText(key),
        list: (prefix, cursor) => memoryBlobs.list(prefix, cursor),
        put: (key, content) => memoryBlobs.put(key, content),
        delete: (key) => memoryBlobs.delete(key),
      },
      outputsRoot,
    },
    process.env,
  );
}

// ─── Session registry ───────────────────────────────────────────────────

/** Resolve agent.model (a model_id handle) → wire model + credentials.
 *  Prefer a matching model card; fall back to ANTHROPIC_* env vars. */
async function resolveNodeModelCreds(
  tenantId: string,
  agentModel: string | {
    id: string;
    effort?: "low" | "medium" | "high" | "xhigh" | "max";
    speed?: string;
  },
): Promise<{
  wireModel: string;
  apiKey: string;
  baseURL?: string;
  provider?: string;
  customHeaders?: Record<string, string>;
  piConfig?: PiModelConfig;
}> {
  const handle = typeof agentModel === "string" ? agentModel : agentModel.id;
  try {
    const card = await modelCardsService.findByModelId({ tenantId, modelId: handle });
    if (card && !card.archived_at) {
      const key = await modelCardsService.getApiKey({ tenantId, cardId: card.id });
      if (key) {
        return {
          wireModel: card.model,
          apiKey: key,
          baseURL: card.base_url ?? undefined,
          provider: card.provider,
          customHeaders: card.custom_headers ?? undefined,
          piConfig: card.pi_config
            ? card.pi_config as PiModelConfig
            : undefined,
        };
      }
    }
  } catch (err) {
    console.warn(
      `[model-card] lookup failed, falling back to env: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "No model card matched and ANTHROPIC_API_KEY is unset — configure a model card or set the env var",
    );
  }
  return {
    wireModel: handle,
    apiKey,
    baseURL: process.env.ANTHROPIC_BASE_URL,
    customHeaders: parseCustomHeaders(process.env.ANTHROPIC_CUSTOM_HEADERS),
  };
}

async function buildNodeLanguageModel(
  tenantId: string,
  agentModel: string | {
    id: string;
    effort?: "low" | "medium" | "high" | "xhigh" | "max";
    speed?: string;
  },
) {
  const creds = await resolveNodeModelCreds(tenantId, agentModel);
  return toAiSdkLanguageModel(createPiModelRuntime({
    model: creds.wireModel,
    apiKey: creds.apiKey,
    provider: creds.provider,
    baseURL: creds.baseURL,
    customHeaders: creds.customHeaders,
    piConfig: creds.piConfig,
    thinkingLevel: typeof agentModel === "string" ? undefined : agentModel.effort,
    speed: typeof agentModel === "string"
      ? undefined
      : agentModel.speed === "fast" ? "fast" : "standard",
  }));
}

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
  buildModel: (agent, tenantId) => buildNodeLanguageModel(tenantId, agent.model),
  buildTools: async (agent, sandbox, tenantId) => {
    const creds = await resolveNodeModelCreds(tenantId, agent.model);
    return buildTools(agent, sandbox, {
      ANTHROPIC_API_KEY: creds.apiKey,
      ANTHROPIC_BASE_URL: creds.baseURL,
      toMarkdown: toMarkdownProvider,
    });
  },
  buildHarness: (agent) => {
    const h = resolveHarness(agent.harness);
    return {
      run: (ctx: unknown) => h.run(ctx as HarnessContext),
      ...(h.dispose ? {
        dispose: (reason: "replace" | "shutdown" | "destroy") => h.dispose!(reason),
      } : {}),
    };
  },
  buildHarnessContext: async (input) => {
    const creds = await resolveNodeModelCreds(input.tenantId, input.agent.model);
    const pi = createPiModelRuntime({
      model: creds.wireModel,
      apiKey: creds.apiKey,
      provider: creds.provider,
      baseURL: creds.baseURL,
      customHeaders: creds.customHeaders,
      piConfig: creds.piConfig,
      thinkingLevel:
        typeof input.agent.model === "string" ? undefined : input.agent.model.effort,
      speed:
        typeof input.agent.model === "string"
          ? undefined
          : input.agent.model.speed === "fast" ? "fast" : "standard",
    });
    const runtime = new NodeHarnessRuntime({
      sessionId: input.sessionId,
      log: input.eventLog,
      hub,
      sandbox: input.sandbox,
    });
    await runtime.refreshHistory();
    const rawSystemPrompt = input.agent.system ?? "";
    // Feishu-backed sessions get two live tools (mcp__feishu__im_message_send,
    // mcp__feishu__im_chat_read) wired straight to FeishuApiClient. Non-Feishu
    // sessions resolve to {} (a safe no-op spread). Token handling lives inside
    // FeishuApiClient — see lib/feishu-agent-tools.ts.
    const feishuTools = await resolveFeishuAgentTools(input.sessionId);
    return {
      agent: input.agent,
      userMessage: input.userMessage,
      session_id: input.sessionId,
      tools: {
        ...(input.tools as Record<string, unknown>),
        ...feishuTools,
      } as HarnessContext["tools"],
      model: input.model,
      pi,
      systemPrompt: composeSystemPrompt(rawSystemPrompt),
      rawSystemPrompt,
      env: {
        ANTHROPIC_API_KEY: creds.apiKey,
        ANTHROPIC_BASE_URL: creds.baseURL,
      },
      runtime,
    } satisfies HarnessContext;
  },
});

await sessionRegistry.bootstrap();

// ─── Official Managed Sessions composition ─────────────────────────────

async function resolveNodeMcpProxyTarget(input: {
  tenantId: string;
  sessionId: string;
  serverName: string;
}): Promise<NodeMcpProxyTarget | null> {
  const managedContext = await managedRuntimeReaders.executionContext.find({
    workspaceId: input.tenantId,
    sessionId: input.sessionId,
  });
  if (managedContext !== null) {
    const server = managedContext.session.agent.mcpServers.find(
      (candidate) => candidate.name === input.serverName,
    );
    if (server === undefined || !server.url) return null;
    for (const vaultId of managedContext.session.vaultIds) {
      const records = await managedCredentialStore.list({
        workspaceId: input.tenantId,
        vaultId,
        includeArchived: false,
        limit: 100,
      });
      for (const record of records) {
        const credential = record.credential;
        const auth = credential.auth;
        if (
          (auth.type !== "static_bearer" && auth.type !== "mcp_oauth")
          || auth.mcpServerUrl !== server.url
        ) continue;
        const accessToken = auth.type === "static_bearer"
          ? auth.token
          : auth.accessToken;
        if (!accessToken) continue;
        const target: NodeMcpProxyTarget = {
          upstreamUrl: server.url,
          accessToken,
        };
        if (auth.type === "mcp_oauth" && auth.refresh?.refreshToken) {
          const tokenEndpointAuth = auth.refresh.tokenEndpointAuth;
          target.refresh = {
            refreshToken: auth.refresh.refreshToken,
            tokenEndpoint: auth.refresh.tokenEndpoint,
            clientId: auth.refresh.clientId,
            clientSecret: tokenEndpointAuth.type === "none"
              ? undefined
              : tokenEndpointAuth.clientSecret ?? undefined,
          };
          target.onRefreshed = async (tokens) => {
            await managedCredentialStore.replace({
              workspaceId: input.tenantId,
              vaultId,
              credentialId: credential.id,
              expectedRevision: record.revision,
              next: {
                ...credential,
                auth: {
                  ...auth,
                  accessToken: tokens.access_token,
                  refresh: {
                    ...auth.refresh!,
                    refreshToken: tokens.refresh_token,
                  },
                },
                updatedAt: new Date().toISOString(),
              },
            });
          };
        }
        return target;
      }
    }
    return null;
  }

  const session = await sessionsService.get({
    tenantId: input.tenantId,
    sessionId: input.sessionId,
  }).catch(() => null);
  if (session === null || session.archived_at) return null;
  const snapshot = session.agent_snapshot as {
    mcp_servers?: Array<{
      name: string;
      url: string;
      authorization_token?: string;
    }>;
  } | undefined;
  const server = snapshot?.mcp_servers?.find((candidate) =>
    candidate.name === input.serverName
  );
  if (server === undefined || !server.url) return null;
  if (server.authorization_token) {
    return {
      upstreamUrl: server.url,
      accessToken: server.authorization_token,
    };
  }
  const vaultIds = session.vault_ids ?? [];
  if (vaultIds.length === 0) return null;
  const groups = await credentialService.listByVaults({
    tenantId: input.tenantId,
    vaultIds,
  });
  for (const group of groups) {
    for (const credential of group.credentials) {
      if (credential.archived_at !== null) continue;
      const auth = credential.auth as {
        type?: string;
        mcp_server_url?: string;
        bearer_token?: string;
        token?: string;
        access_token?: string;
        refresh_token?: string;
        token_endpoint?: string;
        client_id?: string;
        client_secret?: string;
      };
      if (auth.mcp_server_url !== server.url) continue;
      const accessToken = auth.bearer_token ?? auth.token ?? auth.access_token;
      if (!accessToken) continue;
      const target: NodeMcpProxyTarget = {
        upstreamUrl: server.url,
        accessToken,
      };
      if (auth.type === "mcp_oauth" && auth.refresh_token && auth.token_endpoint) {
        target.refresh = {
          refreshToken: auth.refresh_token,
          tokenEndpoint: auth.token_endpoint,
          clientId: auth.client_id,
          clientSecret: auth.client_secret,
        };
        target.onRefreshed = async (tokens) => {
          await credentialService.refreshAuth({
            tenantId: input.tenantId,
            vaultId: group.vault_id,
            credentialId: credential.id,
            auth: {
              access_token: tokens.access_token,
              refresh_token: tokens.refresh_token,
            },
          });
        };
      }
      return target;
    }
  }
  return null;
}

const nodeMcpProxyBinding = createNodeMcpProxyBinding({
  resolveTarget: resolveNodeMcpProxyTarget,
});

const managedSessionResourceSecrets = new SqlSessionResourceSecretSource(sql, {
  open: async (value) => {
    if (managedResourceCipher === null) {
      throw new Error(
        "PLATFORM_ROOT_SECRET is required for managed Session repository credentials",
      );
    }
    return managedResourceCipher.decrypt(value);
  },
});

const managedSessionExecutionCoordinator = new SqlSessionExecutionCoordinator(sql);

async function isManagedSessionExecutionFenceActive(fence: {
  workspaceId: string;
  sessionId: string;
  executionId: string;
  attemptId: string;
  ownerId: string;
  generation: number;
  expiresAt: string;
}): Promise<boolean> {
  if (Date.parse(fence.expiresAt) <= Date.now()) return false;
  const execution = await managedSessionExecutionCoordinator.find({
    workspaceId: fence.workspaceId,
    executionId: fence.executionId,
  });
  return execution?.state === "running"
    && execution.sessionId === fence.sessionId
    && execution.attempt?.id === fence.attemptId
    && execution.attempt.ownerId === fence.ownerId
    && execution.attempt.generation === fence.generation
    && Date.parse(execution.attempt.leaseExpiresAt) > Date.now();
}

const managedSessionOutputCollector = new NodeManagedSessionOutputCollector({
  outputsRoot,
  isFenceActive: isManagedSessionExecutionFenceActive,
});

const managedRuntimeRunner = new DefaultNodeManagedSessionRunner({
  subagentThreads: new SqlSessionThreadStore(sql),
  subagentPolicy: ({ session }) => nodeOpenAISubagentPolicy(session, openAIAgentsSecrets),
  resolveSubagentSession: async ({ workspaceId, session, request }) => {
    const saved = await readManagedSessionMappingMetadata(session, openAIAgentsSecrets);
    if (saved) return openAISubagentSession(session, request);
    const member = session.agent.multiagent?.agents.find(item => item.type === "agent" && item.id === request.agentId);
    if (!member || member.type !== "agent") throw new Error("Subagent is not in the configured callable agent roster");
    const selected = await managedAgentsPlatform.app({ workspaceId }).port(managedAgentsPortTokens.agents).retrieveAgent({ agentId: member.id, version: member.version });
    if (selected.type !== "found" || selected.agent.archivedAt !== null) throw new Error("Configured subagent is unavailable");
    return { ...session, agent: { ...selected.agent, multiagent: null } };
  },
  confirmedTools: new NodeManagedConfirmedToolExecutor({
    buildExecutableTools: async ({ workspaceId, session, environment, sandbox }) => {
      const agent = allowAllLegacyHarnessTools(
        toLegacyHarnessAgentConfig(session),
      );
      const creds = await resolveNodeModelCreds(workspaceId, agent.model);
      return buildTools(agent, sandbox, {
        ANTHROPIC_API_KEY: creds.apiKey,
        ANTHROPIC_BASE_URL: creds.baseURL,
        toMarkdown: toMarkdownProvider,
        tenantId: workspaceId,
        sessionId: session.id,
        mcpBinding: nodeMcpProxyBinding,
        environmentConfig: toLegacyHarnessEnvironmentConfig(environment),
      });
    },
  }),
  outcomes: new NodeManagedOutcomeEvaluator({
    buildModel: ({ workspaceId, session }) =>
      buildNodeLanguageModel(workspaceId, session.agent.model),
    judge: async ({ model, system, prompt, abortSignal }) => {
      const result = await generateText({
        model,
        system,
        prompt,
        abortSignal,
      });
      return {
        text: result.text,
        usage: {
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
        },
      };
    },
  }),
  buildSandbox: async ({ session }) =>
    await isManagedNoEnvironmentSession(session, openAIAgentsSecrets)
      ? createNoEnvironmentSandbox()
      : buildSandbox(
      session.id,
      join(process.env.SANDBOX_WORKDIR ?? "./data/sandboxes", session.id),
    ),
  prepareSandbox: async ({
    workspaceId,
    session,
    sandbox,
    runtimeGeneration,
  }) => {
    if (isNoEnvironmentSandbox(sandbox)) return;
    const preparer = new NodeManagedSessionInputPreparer({
      files: managedAgentsPlatform
        .app({ workspaceId })
        .port(managedAgentsPortTokens.files),
      skillVersions: managedSkillsPlatform
        .app({ workspaceId })
        .port(managedAgentsPortTokens.skillVersions),
      repositoryCredentials: managedSessionResourceSecrets,
      memorySnapshots: new NodeManagedMemorySnapshotMaterializer(
        managedMemoriesApplicationForWorkspace(workspaceId)
          .port(managedAgentsPortTokens.memories),
        {
          getText: async (key) => (await memoryBlobs.getText(key))?.text ?? null,
          put: (key, content) => memoryBlobs.put(key, content),
        },
      ),
    });
    await preparer.prepare({
      workspaceId,
      session,
      sandbox,
      runtimeGeneration,
    });
  },
  synchronizeSandbox: async ({
    workspaceId,
    session,
    sandbox,
    runtimeGeneration,
    executionFence,
  }) => {
    if (isNoEnvironmentSandbox(sandbox)) return;
    await sandbox.synchronizeMemoryStores?.();
    const memories = managedMemoriesApplicationForWorkspace(workspaceId)
      .port(managedAgentsPortTokens.memories);
    const result = await synchronizeManagedSessionMemoryWorkspaces(
      { find: async () => session },
      memories,
      {
        getText: async (key) => (await memoryBlobs.getText(key))?.text ?? null,
        list: (prefix, cursor) => memoryBlobs.list(prefix, cursor),
        put: (key, content) => memoryBlobs.put(key, content),
        delete: (key) => memoryBlobs.delete(key),
      },
      {
        workspaceId,
        sessionId: session.id,
        runtimeGeneration,
        executionFence,
        isFenceActive: isManagedSessionExecutionFenceActive,
      },
    );
    if (result.type === "fence_lost") {
      throw new Error(
        `Managed Memory synchronization lost the execution fence for ${session.id}`,
      );
    }
    if (result.type === "not_found") {
      throw new Error(`Managed Session ${session.id} disappeared before Memory synchronization`);
    }
    if (result.recoveredWipes.length > 0) {
      throw new Error(
        `Writable Managed Memory workspace became distrusted: ${result.recoveredWipes.join(", ")}`,
      );
    }
    if (result.conflicts.length > 0) {
      logger.warn({
        conflicts: result.conflicts,
        op: "main-node.managed_memory.conflicts",
        sessionId: session.id,
        workspaceId,
      }, "Managed Memory synchronization kept canonical winners for conflicts");
    }
    await managedSessionOutputCollector.synchronize({
      workspaceId,
      sessionId: session.id,
      sandbox,
      executionFence,
    });
  },
  afterExecution: withReportedArtifactPublication(createNodeOpenAIArtifactPublisher({
    historyForWorkspace: workspaceId => new SessionRuntimeHistoryApplicationService({ workspaceId, source: managedRuntimeReaders.history }),
    filesForWorkspace: workspaceId => managedAgentsPlatform.app({ workspaceId }).port(managedAgentsPortTokens.files),
    secrets: openAIAgentsSecrets,
    isFenceActive: isManagedSessionExecutionFenceActive,
    environmentId: session => `oai_env_${session.id}`,
  }), (error, input) => {
    logger.error({
      err: error,
      op: "main-node.openai_agents.artifact_publication_failed",
      workspaceId: input.workspaceId,
      sessionId: input.session.id,
      executionId: input.executionFence.executionId,
    }, "Completed Session output could not be published as an Agents API artifact");
  }),
  buildModel: ({ workspaceId, session }) =>
    buildNodeLanguageModel(workspaceId, session.agent.model),
  buildTools: async ({ workspaceId, session, environment, sandbox, subagents, delegateToAgent }) => {
    const agent = toLegacyHarnessAgentConfig(session);
    const creds = await resolveNodeModelCreds(workspaceId, agent.model);
    const tools = await buildTools(agent, sandbox, {
      ANTHROPIC_API_KEY: creds.apiKey,
      ANTHROPIC_BASE_URL: creds.baseURL,
      toMarkdown: toMarkdownProvider,
      tenantId: workspaceId,
      sessionId: session.id,
      mcpBinding: nodeMcpProxyBinding,
      environmentConfig: toLegacyHarnessEnvironmentConfig(environment),
      delegateToAgent,
    });
    if (subagents && (await readManagedSessionMappingMetadata(session, openAIAgentsSecrets))?.agent.multi_agent?.enabled) {
      for (const [name, definition] of Object.entries(buildOpenAISubagentTools(subagents))) {
        let available = name;
        while (Object.hasOwn(tools, available)) available = `openma_${available}`;
        tools[available] = definition;
      }
    }
    return tools;
  },
  disposeTools,
  buildHarness: () => new ManagedNodeDefaultHarness(),
  buildHarnessContext: async (input) => {
    const agent = toLegacyHarnessAgentConfig(input.session);
    const creds = await resolveNodeModelCreds(input.workspaceId, agent.model);
    const rawSystemPrompt = input.session.agent.system ?? "";
    const platformReminders = buildNodeManagedSkillReminders(input.session);
    const feishuTools = await resolveFeishuAgentTools(input.session.id);
    return {
      agent,
      userMessage: { type: "user.message", content: [] },
      session_id: input.session.id,
      tenant_id: input.workspaceId,
      tools: { ...input.tools, ...feishuTools },
      model: input.model,
      systemPrompt: composeSystemPrompt(rawSystemPrompt, platformReminders),
      rawSystemPrompt,
      platformReminders,
      env: {
        ANTHROPIC_API_KEY: creds.apiKey,
        ANTHROPIC_BASE_URL: creds.baseURL,
      },
      runtime: input.runtime,
    } satisfies HarnessContext;
  },
  clock: { now: () => new Date() },
  ids: { nextEventId: () => `sevt_${nanoid()}` },
  runtimeGenerations: { next: () => `runtime_${nanoid()}` },
});

const managedRuntimeReaders = createSqlSessionRuntimeReaders(sql);
const managedRuntimeEngine = new ApplicationBackedNodeManagedSessionRuntimeEngine({
  historyFor: (workspaceId) =>
    new SessionRuntimeHistoryApplicationService({
      workspaceId,
      source: managedRuntimeReaders.history,
    }),
  runner: managedRuntimeRunner,
});
const managedRuntimeDriver = new DefaultNodeManagedSessionRuntimeDriver({
  engine: managedRuntimeEngine,
  realtime: new MemorySessionRealtimeHub(),
  projectionFor: (workspaceId) =>
    new SessionRuntimeProjectionApplicationService({
      workspaceId,
      persistence: new SqlSessionRuntimeProjectionPersistence(sql),
    }),
});
const managedSessionExecutionWorker = new NodeSessionExecutionWorker({
  coordinator: managedSessionExecutionCoordinator,
  context: managedRuntimeReaders.executionContext,
  runtime: {
    run: async ({ executionId: _executionId, fence, ...input }) => {
      await managedRuntimeDriver.accept({ ...input, executionFence: fence });
    },
    cancel: async (input) => {
      managedRuntimeRunner.cancel(input);
    },
  },
  ownerId: process.env.OMA_SESSION_EXECUTION_OWNER_ID ??
    `node:${process.pid}:${nanoid()}`,
  clock: { now: () => new Date() },
  ids: { nextAttemptId: () => `attempt_${nanoid()}` },
  leaseTtlMs: 30_000,
  heartbeatIntervalMs: 10_000,
  maxConcurrent: Number(process.env.OMA_SESSION_EXECUTION_CONCURRENCY ?? 8),
  onError: (err) => logger.error(
    { err, op: "main-node.session_execution.background_failed" },
    "managed Session execution background operation failed",
  ),
});
const managedSessionRuntime = new NodeManagedSessionRuntimeAdapter(
  managedRuntimeDriver,
  managedSessionExecutionWorker,
);

const persistedManagedEnvironments = new SqlSessionEnvironmentSource(sql);
const nodeManagedEnvironments: SessionEnvironmentSourcePort = {
  find: async (input) => {
    if (input.environmentId !== "env-local-runtime") {
      return persistedManagedEnvironments.find(input);
    }
    return {
      id: input.environmentId,
      archivedAt: null,
      config: {
        type: "cloud",
        networking: { type: "unrestricted" },
        packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] },
      },
      createdAt: "1970-01-01T00:00:00.000Z",
      description: "Node self-hosted runtime",
      metadata: {},
      name: "Local runtime",
      updatedAt: "1970-01-01T00:00:00.000Z",
    };
  },
};
const nodeSessionLifecycleHooks = nodeSessionLifecycle({
  files: filesService,
  filesBlob,
  outputs: nodeOutputsAdapter(outputsRoot),
});
const managedSessionLifecycle = new EnvironmentAwareSessionLifecycleRouter({
  environments: nodeManagedEnvironments,
  runtime: managedSessionRuntime,
  selfHostedWork: {
    enqueue: (input) =>
      managedEnvironmentWorkEnqueuerFor(input.workspaceId).enqueue(input),
    stop: (input) =>
      managedEnvironmentWorkEnqueuerFor(input.workspaceId).stop(input),
  },
  cleanupSession: async ({ workspaceId, sessionId }) => {
    await nodeSessionLifecycleHooks.cascadeDeleteFiles?.({
      tenantId: workspaceId,
      sessionId,
    });
    await rm(
      join(process.env.SANDBOX_WORKDIR ?? "./data/sandboxes", sessionId),
      { recursive: true, force: true },
    );
  },
});
const managedResourceCipher = platformRootSecret === undefined
  ? null
  : new WebCryptoAesGcm(platformRootSecret, "managed.sessions.resources");
const managedSessionsComposition = new SqlManagedSessionsComposition({
  client: sql,
  executionOutbox: true,
  environments: nodeManagedEnvironments,
  lifecycle: managedSessionLifecycle,
  runtime: managedSessionRuntime,
  eventDispatch: new EnvironmentAwareSessionEventDispatchRouter({
    runtime: managedSessionRuntime,
  }),
  eventStream: new EnvironmentAwareSessionEventStreamRouter({
    environments: nodeManagedEnvironments,
    runtime: managedSessionRuntime,
    selfHosted: new SqlPersistedSessionEventStream(sql),
  }),
  sealer: {
    seal: async (value) => {
      if (managedResourceCipher === null) {
        throw new Error(
          "PLATFORM_ROOT_SECRET is required for managed Session resource credentials",
        );
      }
      return managedResourceCipher.encrypt(value);
    },
  },
  clock: { now: () => new Date() },
  ids: {
    nextSessionId: () => `session_${nanoid()}`,
    nextEventId: () => `sevt_${nanoid()}`,
    nextOutcomeId: () => `outc_${nanoid()}`,
    nextResourceId: () => `sesrsc_${nanoid()}`,
  },
});

const managedDeploymentCrypto = platformRootSecret === undefined
  ? null
  : new WebCryptoAesGcm(platformRootSecret, "managed.deployments.resources");
const managedDeploymentCipher: DeploymentResourceSecretCipher = {
  seal: async ({ plaintext }) => {
    if (managedDeploymentCrypto === null) {
      throw new Error(
        "PLATFORM_ROOT_SECRET is required for managed Deployment resource credentials",
      );
    }
    return { ciphertext: await managedDeploymentCrypto.encrypt(plaintext) };
  },
  open: async ({ ciphertext }) => {
    if (managedDeploymentCrypto === null) {
      throw new Error(
        "PLATFORM_ROOT_SECRET is required for managed Deployment resource credentials",
      );
    }
    return { plaintext: await managedDeploymentCrypto.decrypt(ciphertext) };
  },
};
const managedDeploymentSchedulePlanner = new CronDeploymentSchedulePlanner();
const managedEnvironmentWorkAvailability =
  new TimerEnvironmentWorkAvailabilityWaiter();
const managedEnvironmentWorkCrypto = platformRootSecret === undefined
  ? null
  : new WebCryptoAesGcm(platformRootSecret, "managed.environment-work.secret");
const managedEnvironmentWorkCipher: EnvironmentWorkSecretCipher = {
  seal: async ({ plaintext }) => {
    if (managedEnvironmentWorkCrypto === null) {
      throw new Error(
        "PLATFORM_ROOT_SECRET is required for managed Environment Work credentials",
      );
    }
    return {
      ciphertext: await managedEnvironmentWorkCrypto.encrypt(plaintext),
    };
  },
  open: async ({ ciphertext }) => {
    if (managedEnvironmentWorkCrypto === null) {
      throw new Error(
        "PLATFORM_ROOT_SECRET is required for managed Environment Work credentials",
      );
    }
    return {
      plaintext: await managedEnvironmentWorkCrypto.decrypt(ciphertext),
    };
  },
};
const managedEnvironmentWorkSessionTokenCrypto = platformRootSecret === undefined
  ? null
  : new WebCryptoAesGcm(
      platformRootSecret,
      "managed.environment-work.session-token",
    );
const managedEnvironmentWorkCredentials =
  managedEnvironmentWorkSessionTokenCrypto === null
    ? {
        issue: async () => ({
          type: "rejected" as const,
          message: "PLATFORM_ROOT_SECRET is required for managed Environment Work credentials",
        }),
        bindToClaim: async () => {
          throw new Error(
            "PLATFORM_ROOT_SECRET is required for managed Environment Work credentials",
          );
        },
      }
    : new SealedEnvironmentWorkSessionCredentialIssuer({
        crypto: managedEnvironmentWorkSessionTokenCrypto,
        now: () => new Date(),
        ...(process.env.PUBLIC_BASE_URL !== undefined && {
          apiBaseUrl: process.env.PUBLIC_BASE_URL,
        }),
      });
const managedEnvironmentWebhookUrl = process.env.OMA_MANAGED_AGENTS_WEBHOOK_URL;
const managedEnvironmentWebhookKey =
  process.env.OMA_MANAGED_AGENTS_WEBHOOK_SIGNING_KEY;
const managedEnvironmentWebhook =
  managedEnvironmentWebhookUrl !== undefined
  && managedEnvironmentWebhookKey !== undefined
    ? new StandardWebhookEnvironmentWorkWakeup({
        endpoint: managedEnvironmentWebhookUrl,
        signingKey: managedEnvironmentWebhookKey,
        organizationId: ({ workspaceId }) =>
          process.env.OMA_MANAGED_AGENTS_ORGANIZATION_ID ?? workspaceId,
        nextEventId: () => `whe_${nanoid()}`,
      })
    : null;
const managedEnvironmentWorkStore = new SqlEnvironmentWorkStore(
  sql,
  managedEnvironmentWorkCipher,
);
const managedEnvironmentWorkPlatform = createNodePlatform({
  features: { preset: "none", environmentWork: true },
  stores: {
    environmentWork: managedEnvironmentWorkStore,
  },
  clock: { now: () => new Date() },
  ids: {
    next: (namespace) =>
      `${namespace === "environment-work" ? "work" : namespace}_${nanoid()}`,
  },
  modules: () => [
    providePort(environmentWorkEnvironmentSourcePort, nodeManagedEnvironments),
    providePort(
      environmentWorkAvailabilityWaiterPort,
      managedEnvironmentWorkAvailability,
    ),
    providePort(
      environmentWorkSessionCredentialIssuerPort,
      managedEnvironmentWorkCredentials,
    ),
    providePort(environmentWorkWakeupPort, {
      notifyRunStarted: async (input) => {
        if (managedEnvironmentWebhook === null) return;
        void managedEnvironmentWebhook.notifyRunStarted(input).catch((err) => {
          logger.error(
            { err, op: "main-node.environment_work.webhook_failed" },
            "Managed Agents webhook wake-up failed; poll fallback remains active",
          );
        });
      },
    }),
    environmentWorkEnqueuerModule(),
  ],
});
function managedEnvironmentWorkEnqueuerFor(
  workspaceId: string,
) {
  return managedEnvironmentWorkPlatform
    .app({ workspaceId })
    .port(environmentSessionWorkEnqueuerPort);
}
const managedDeploymentsPlatform = createNodePlatform({
  features: {
    preset: "none",
    deploymentRuns: true,
    deployments: true,
  },
  stores: {
    deployments: new SqlDeploymentStore(sql, managedDeploymentCipher),
    deploymentRuns: new SqlDeploymentRunStore(sql),
  },
  clock: { now: () => new Date() },
  ids: {
    next: (namespace) =>
      `${namespace === "deployment" ? "depl" : namespace === "deployment-run" ? "drun" : namespace}_${nanoid()}`,
  },
  modules: (scope) => [
    providePort(deploymentAgentSourcePort, new SqlDeploymentAgentSource(sql)),
    providePort(deploymentEnvironmentSourcePort, nodeManagedEnvironments),
    providePort(deploymentFileSourcePort, new SqlFileMetadataPersistence(sql)),
    providePort(deploymentMemoryStoreSourcePort, new SqlMemoryStoreSource(sql)),
    providePort(deploymentSchedulePlannerPort, managedDeploymentSchedulePlanner),
    providePort(
      deploymentSessionLauncherPort,
      managedSessionsComposition.portsFor(scope.workspaceId)
        .deploymentSessionLauncher,
    ),
    providePort(deploymentVaultSourcePort, new SqlDeploymentVaultSource(sql)),
  ],
});
const managedDeploymentsRoutes = buildManagedDeploymentRoutes((context) => {
  const workspaceId = (context.var as { tenant_id: string }).tenant_id;
  return managedDeploymentsPlatform
    .app({ workspaceId })
    .port(managedAgentsPortTokens.deployments);
});
const managedDeploymentRunsRoutes = buildManagedDeploymentRunRoutes((context) => {
  const workspaceId = (context.var as { tenant_id: string }).tenant_id;
  return managedDeploymentsPlatform
    .app({ workspaceId })
    .port(managedAgentsPortTokens.deploymentRuns);
});

const managedEnvironmentsRoutes = buildManagedEnvironmentRoutes((context) =>
  managedAgentsPlatform
    .app({
      workspaceId: (context.var as { tenant_id: string }).tenant_id,
    })
    .port(managedAgentsPortTokens.environments),
);

const managedEnvironmentWorkRoutes = buildManagedEnvironmentWorkRoutes(
  (context) =>
    managedEnvironmentWorkPlatform
      .app({ workspaceId: (context.var as { tenant_id: string }).tenant_id })
      .port(managedAgentsPortTokens.environmentWork),
);

const managedDreamCurator =
  process.env.DREAM_CURATOR_MODE === "dedup" ||
    process.env.ANTHROPIC_API_KEY === undefined
  ? new DeduplicatingDreamCurator()
  : new AnthropicMessagesDreamCurator({
      apiKey: process.env.ANTHROPIC_API_KEY,
      ...(process.env.ANTHROPIC_BASE_URL !== undefined && {
        baseUrl: process.env.ANTHROPIC_BASE_URL,
      }),
    });
const managedDreamsPlatform = createNodePlatform({
  features: {
    preset: "none",
    dreams: true,
    memories: true,
    memoryStores: true,
  },
  stores: {
    dreams: new SqlDreamStore(sql),
    memoryStores: new SqlMemoryStoreStore(sql),
    memories: new SqlMemoryDocumentStore(sql),
  },
  clock: { now: () => new Date() },
  ids: {
    next: (namespace) => `${
      namespace === "memory_store"
        ? "memstore"
        : namespace === "memory"
          ? "mem"
          : namespace === "memory-version"
            ? "memver"
            : "dream"
    }_${nanoid()}`,
  },
  modules: (scope) => {
    const memoryStoreSource = new SqlMemoryStoreSource(sql);
    return [
      providePort(dreamMemoryStoreSourcePort, memoryStoreSource),
      providePort(memoryStoreForMemorySourcePort, memoryStoreSource),
      providePort(memoryContentDescriptorPort, managedMemoryContent),
      providePort(memoryVersionActorPort, {
        kind: "service_account",
        serviceAccountId: "dream_executor",
      }),
      providePort(dreamSessionSourcePort, new SqlSessionSource(sql)),
      providePort(dreamCuratorPort, managedDreamCurator),
      defineAppModule({
        name: "managed-agents:dream-memory-workspace",
        provides: [dreamMemoryWorkspacePort],
        requires: [
          managedAgentsPortTokens.memoryStores,
          managedAgentsPortTokens.memories,
        ],
        setup: ({ port }) => ({
          ports: [bindPort(
            dreamMemoryWorkspacePort,
            new ApplicationDreamMemoryWorkspace({
              workspaceId: scope.workspaceId,
              memoryStores: port(managedAgentsPortTokens.memoryStores),
              memories: port(managedAgentsPortTokens.memories),
            }),
          )],
        }),
      }),
      dreamExecutionModule(),
      inProcessDreamExecutionSchedulerModule({
        defer: (task) => {
          void task;
        },
      }),
    ];
  },
});
const managedDreamsRoutes = buildManagedDreamRoutes((context) =>
  managedDreamsPlatform
    .app({
      workspaceId: (context.var as { tenant_id: string }).tenant_id,
    })
    .port(managedAgentsPortTokens.dreams),
);

const managedModelsRoutes = buildManagedModelRoutes((context) =>
  createNodeManagedAgentsApp({
    workspaceId: (context.var as { tenant_id: string }).tenant_id,
    features: { preset: "none", models: true },
    modules: () => [providePort(
      modelCatalogSourcePort,
      new ModelCardCatalogSource(modelCardsService),
    )],
  }).port(managedAgentsPortTokens.models)
);

const managedTunnelProvisioner = new LocalTunnelProvisioner({
  domainSuffix: process.env.TUNNEL_DOMAIN_SUFFIX ?? "tunnels.localhost",
  nextTokenId: () => `ttok_${nanoid()}`,
});
const managedTunnelTokens = new WebCryptoTunnelTokenManager({
  rootSecret: platformRootSecret,
  nextTokenId: () => `ttok_${nanoid()}`,
});
const managedTunnelCertificates = new WebCryptoTunnelCertificateAuthority();
const managedTunnelsPlatform = createNodePlatform({
  features: {
    preset: "none",
    tunnelCertificates: true,
    tunnels: true,
  },
  stores: { tunnels: new SqlTunnelStore(sql) },
  clock: { now: () => new Date() },
  ids: {
    next: (namespace) =>
      `${namespace === "tunnel" ? "tnl" : "tcrt"}_${nanoid()}`,
  },
  modules: () => [
    providePort(tunnelProvisionerPort, managedTunnelProvisioner),
    providePort(tunnelTokenManagerPort, managedTunnelTokens),
    providePort(tunnelCertificateAuthorityPort, managedTunnelCertificates),
  ],
});
const managedTunnelsRoutes = buildManagedTunnelRoutes((context) =>
  managedTunnelsPlatform.app({
    workspaceId: (context.var as { tenant_id: string }).tenant_id,
  }).port(managedAgentsPortTokens.tunnels),
);
const managedTunnelCertificateRoutes = buildManagedTunnelCertificateRoutes(
  (context) => managedTunnelsPlatform.app({
    workspaceId: (context.var as { tenant_id: string }).tenant_id,
  }).port(managedAgentsPortTokens.tunnelCertificates),
);

const managedFilesRoutes = buildManagedFileRoutes((context) =>
  managedAgentsPlatform
    .app({
      workspaceId: (context.var as { tenant_id: string }).tenant_id,
    })
    .port(managedAgentsPortTokens.files)
);

const managedMemoryStoresRoutes = buildManagedMemoryStoreRoutes((context) =>
  managedAgentsPlatform
    .app({
      workspaceId: (context.var as { tenant_id: string }).tenant_id,
    })
    .port(managedAgentsPortTokens.memoryStores),
);

const managedMemoryContent = new WebCryptoMemoryContentDescriptor();
const managedMemoryDocuments = new SqlMemoryDocumentStore(sql);
function managedMemoryActor(userId: string | undefined) {
  return userId === undefined
    ? { kind: "api" as const, apiKeyId: "self_hosted" }
    : { kind: "user" as const, userId };
}
function managedMemoriesApplicationFor(context: unknown) {
  const request = (context as {
    var: { tenant_id: string; user_id?: string };
  }).var;
  return managedMemoriesApplicationForWorkspace(
    request.tenant_id,
    request.user_id,
  );
}
function managedMemoriesApplicationForWorkspace(
  workspaceId: string,
  userId?: string,
) {
  return createNodeManagedAgentsApp({
    workspaceId,
    features: {
      preset: "none",
      memories: true,
      memoryVersions: true,
    },
    stores: {
      memoryStores: new SqlMemoryStoreStore(sql),
      memories: managedMemoryDocuments,
    },
    clock: { now: () => new Date() },
    ids: {
      next: (namespace) => `${
        namespace === "memory"
          ? "mem"
          : namespace === "memory-version"
            ? "memver"
            : namespace
      }_${nanoid()}`,
    },
    modules: () => [
      providePort(
        memoryStoreForMemorySourcePort,
        new SqlMemoryStoreSource(sql),
      ),
      providePort(memoryContentDescriptorPort, managedMemoryContent),
      providePort(
        memoryVersionActorPort,
        managedMemoryActor(userId),
      ),
    ],
  });
}
const managedMemoriesRoutes = buildManagedMemoryRoutes((context) =>
  managedMemoriesApplicationFor(context)
    .port(managedAgentsPortTokens.memories),
);
const managedMemoryVersionsRoutes = buildManagedMemoryVersionRoutes((context) =>
  managedMemoriesApplicationFor(context)
    .port(managedAgentsPortTokens.memoryVersions),
);

const managedSkillCompiler = new ZipSkillPackageCompiler();
let lastManagedSkillVersion = 0n;
function nextManagedSkillVersion(): string {
  const now = BigInt(Date.now()) * 1_000n;
  lastManagedSkillVersion = now > lastManagedSkillVersion
    ? now
    : lastManagedSkillVersion + 1n;
  return lastManagedSkillVersion.toString();
}
const managedSkillsPlatform = createNodePlatform({
  features: {
    preset: "none",
    skills: true,
    skillVersions: true,
  },
  stores: { skills: new SqlSkillStore(sql) },
  clock: { now: () => new Date() },
  ids: {
    next: (namespace) =>
      namespace === "skill-version-value"
        ? nextManagedSkillVersion()
        : `${namespace === "skill-version" ? "skv" : namespace}_${nanoid()}`,
  },
  modules: () => [
    providePort(skillPackageCompilerPort, managedSkillCompiler),
  ],
});
const managedSkillsRoutes = buildManagedSkillRoutes((context) =>
  managedSkillsPlatform.app({
    workspaceId: (context.var as { tenant_id: string }).tenant_id,
  }).port(managedAgentsPortTokens.skills),
);
const managedSkillVersionsRoutes = buildManagedSkillVersionRoutes((context) =>
  managedSkillsPlatform.app({
    workspaceId: (context.var as { tenant_id: string }).tenant_id,
  }).port(managedAgentsPortTokens.skillVersions),
);

const managedCredentialCrypto = platformRootSecret === undefined
  ? null
  : new WebCryptoAesGcm(platformRootSecret, "managed.vault.credentials");
const managedCredentialCipher: CredentialDocumentCipher = {
  seal: async ({ plaintext }) => {
    if (managedCredentialCrypto === null) {
      throw new Error(
        "PLATFORM_ROOT_SECRET is required for managed Vault credentials",
      );
    }
    return { ciphertext: await managedCredentialCrypto.encrypt(plaintext) };
  },
  open: async ({ ciphertext }) => {
    if (managedCredentialCrypto === null) {
      throw new Error(
        "PLATFORM_ROOT_SECRET is required for managed Vault credentials",
      );
    }
    return { plaintext: await managedCredentialCrypto.decrypt(ciphertext) };
  },
};
const managedCredentialValidation = new IndeterminateCredentialValidationProbe();
const managedCredentialStore = new SqlCredentialStore(sql, managedCredentialCipher);
const managedCredentialsPlatform = createNodePlatform({
  features: {
    preset: "none",
    credentials: true,
    vaults: true,
  },
  stores: {
    credentials: managedCredentialStore,
    vaults: new SqlVaultStore(sql),
  },
  credentialValidation: managedCredentialValidation,
  clock: { now: () => new Date() },
  ids: {
    next: (namespace) =>
      `${namespace === "credential" ? "vcrd" : namespace === "vault" ? "vlt" : namespace}_${nanoid()}`,
  },
});
const managedVaultsRoutes = buildManagedVaultRoutes((context) =>
  managedCredentialsPlatform
    .app({ workspaceId: (context.var as { tenant_id: string }).tenant_id })
    .port(managedAgentsPortTokens.vaults),
);
const managedCredentialsRoutes = buildManagedCredentialRoutes((context) =>
  managedCredentialsPlatform
    .app({ workspaceId: (context.var as { tenant_id: string }).tenant_id })
    .port(managedAgentsPortTokens.credentials),
);

const managedUserProfilesRoutes = buildManagedUserProfileRoutes((context) =>
  managedAgentsPlatform
    .app({ workspaceId: (context.var as { tenant_id: string }).tenant_id })
    .port(managedAgentsPortTokens.userProfiles),
);

// ─── Services bundle ────────────────────────────────────────────────────

const kv = new SqlKvStore({ db: drizzleDb, tenantId: "default" });

const services: RouteServices = {
  sql,
  agents: agentsService,
  vaults: vaultService,
  credentials: credentialService,
  memory: memoryService,
  sessions: sessionsService,
  dreams: dreamsService,
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
        `INSERT INTO api_keys (
           id, tenant_id, user_id, name, prefix, hash,
           credential_type, environment_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        record.tenant_id,
        record.user_id ?? null,
        record.name,
        prefix,
        hash,
        record.credential?.type ?? "workspace",
        record.credential?.type === "environment"
          ? record.credential.environmentId
          : null,
        Date.parse(record.created_at),
      )
      .run();
  },
  async listByTenant(tenantId) {
    const r = await sql
      .prepare(
        `SELECT id, name, prefix, credential_type, environment_id, created_at FROM api_keys
          WHERE tenant_id = ? AND revoked_at IS NULL
          ORDER BY created_at DESC`,
      )
      .bind(tenantId)
      .all<{
        id: string;
        name: string;
        prefix: string;
        credential_type: string;
        environment_id: string | null;
        created_at: number;
      }>();
    return (r.results ?? []).map<ApiKeyMeta>((row) => ({
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      created_at: new Date(row.created_at).toISOString(),
      credential: row.credential_type === "environment" && row.environment_id !== null
        ? { type: "environment", environmentId: row.environment_id }
        : { type: "workspace" },
    }));
  },
  async findByHash(hash) {
    const row = await sql
      .prepare(
        `SELECT id, tenant_id, user_id, name, credential_type, environment_id, created_at FROM api_keys
          WHERE hash = ? AND revoked_at IS NULL`,
      )
      .bind(hash)
      .first<{
        id: string;
        tenant_id: string;
        user_id: string | null;
        name: string;
        credential_type: string;
        environment_id: string | null;
        created_at: number;
      }>();
    if (!row) return null;
    const rec: ApiKeyRecord = {
      id: row.id,
      tenant_id: row.tenant_id,
      ...(row.user_id ? { user_id: row.user_id } : {}),
      name: row.name,
      created_at: new Date(row.created_at).toISOString(),
      credential: row.credential_type === "environment" && row.environment_id !== null
        ? { type: "environment", environmentId: row.environment_id }
        : { type: "workspace" },
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
  Variables: {
    tenant_id: string;
    user_id?: string;
    auth_credential?: ApiKeyResolution["credential"];
  };
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
        : useMysql
          ? "better-auth-mysql"
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
      : listAuthProviders({
          emailOtp: process.env.AUTH_REQUIRE_EMAIL_VERIFY === "1",
          googleClientId: process.env.GOOGLE_CLIENT_ID,
          googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
          githubClientId: process.env.GITHUB_CLIENT_ID,
          githubClientSecret: process.env.GITHUB_CLIENT_SECRET,
        }),
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
    if (process.env.API_KEY && apiKey === process.env.API_KEY) {
      return { tenantId: "default" };
    }
    const hash = await sha256Hex(apiKey);
    const rec = await apiKeyStorage.findByHash(hash);
    if (!rec) return null;
    return {
      tenantId: rec.tenant_id,
      userId: rec.user_id,
      credential: rec.credential,
    };
  },
  resolveBearerToken: async ({ token, method, path }) => {
    if (managedEnvironmentWorkSessionTokenCrypto === null) return null;
    const scoped = await authenticateEnvironmentWorkSessionBearer({
      token,
      method,
      path,
      crypto: managedEnvironmentWorkSessionTokenCrypto,
      now: () => new Date(),
      isCurrent: (claim) => isCurrentEnvironmentWorkClaim({
        store: managedEnvironmentWorkStore,
        now: () => new Date(),
      }, claim),
    });
    return scoped === null
      ? null
      : {
          tenantId: scoped.workspaceId,
          credential: {
            type: "environment_work_session",
            environmentId: scoped.environmentId,
            sessionId: scoped.sessionId,
            workId: scoped.workId,
            claimedAt: scoped.claimedAt,
            generation: scoped.generation,
          },
        };
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
  Variables: {
    tenant_id: string;
    user_id?: string;
    auth_credential?: ApiKeyResolution["credential"];
  };
}>();
v1.use("*", authMw);

v1.post("/oma/sessions/:sessionId/runtime-events", async (c) => {
  const credential = c.get("auth_credential");
  if (credential?.type !== "environment_work_session") {
    return c.json({ error: "Environment Work session credential required" }, 403);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }
  const result = await ingestEnvironmentWorkRuntimeEvents({
    claim: {
      workspaceId: c.get("tenant_id"),
      environmentId: credential.environmentId,
      sessionId: credential.sessionId,
      workId: credential.workId,
      generation: credential.generation,
    },
    sessionId: c.req.param("sessionId"),
    body,
    projection: new SessionRuntimeProjectionApplicationService({
      workspaceId: c.get("tenant_id"),
      persistence: managedSessionsComposition.runtimeProjection,
    }),
    publish: async () => {},
  });
  if (result.type === "recorded") {
    return c.json({ data: result.eventIds.map((id) => ({ id })) }, 200);
  }
  if (result.type === "invalid_request") {
    return c.json({ error: result.message }, 400);
  }
  if (result.type === "not_found") return c.json({ error: "Session not found" }, 404);
  if (result.type === "forbidden") return c.json({ error: "Forbidden" }, 403);
  return c.json({ error: result.type }, 409);
});

// Mount route bundles. Same paths CF uses; behavior preserved. Once a tenant
// has configured model cards, agent model handles must resolve to an active
// card; an empty card set keeps the legacy ANTHROPIC_API_KEY fallback usable.
v1.route("/agents", buildManagedAgentRoutes((context) =>
  managedAgentsPlatform
    .app({
      workspaceId: (context.var as { tenant_id: string }).tenant_id,
    })
    .port(managedAgentsPortTokens.agents),
));
v1.route("/oma/agents", buildLegacyAgentRoutes({
  services,
  validateModel: async (tenantId, model) => {
    const cards = await modelCardsService.list({ tenantId });
    const active = cards.filter((card) => card.archived_at === null);
    if (active.length === 0) return { valid: true };
    const modelId = typeof model === "string" ? model : model.id;
    if (!active.some((card) => card.model_id === modelId)) {
      return {
        valid: false,
        error: `No model card with model_id "${modelId}". Create a card with that handle, or set agent.model to an existing card's model_id.`,
      };
    }
    return { valid: true };
  },
}));
const sessionRouter = new NodeSessionRouter({
  sql,
  hub,
  registry: sessionRegistry,
  newEventLog,
});
v1.route("/sessions", buildManagedSessionsApi({
  sessions: (context) =>
    managedSessionsComposition.portsFor(
      (context.var as { tenant_id: string }).tenant_id,
    ).sessions,
  sessionEvents: (context) =>
    managedSessionsComposition.portsFor(
      (context.var as { tenant_id: string }).tenant_id,
    ).sessionEvents,
  sessionResources: (context) =>
    managedSessionsComposition.portsFor(
      (context.var as { tenant_id: string }).tenant_id,
    ).sessionResources,
  sessionThreads: (context) =>
    managedSessionsComposition.portsFor(
      (context.var as { tenant_id: string }).tenant_id,
    ).sessionThreads,
  sessionThreadEvents: (context) =>
    managedSessionsComposition.portsFor(
      (context.var as { tenant_id: string }).tenant_id,
    ).sessionThreadEvents,
}, {
  outputs: {
    workspaceId: (context) =>
      (context.var as { tenant_id: string }).tenant_id,
    store: nodeOutputsAdapter(outputsRoot),
  },
}));
v1.route("/oma/sessions", buildSessionRoutes({
  services,
  router: sessionRouter,
  outputs: nodeOutputsAdapter(outputsRoot),
  lifecycle: nodeSessionLifecycleHooks,
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
v1.route("/oma/mcp-proxy", buildNodeHttpMcpProxyRoutes({
  resolveTarget: resolveNodeMcpProxyTarget,
}));
v1.route("/vaults", managedVaultsRoutes);
v1.route("/vaults", managedCredentialsRoutes);
v1.route("/user_profiles", managedUserProfilesRoutes);
v1.route("/oma/vaults", buildLegacyVaultRoutes({ services }));
v1.route("/memory_stores", managedMemoryStoresRoutes);
v1.route("/memory_stores", managedMemoriesRoutes);
v1.route("/memory_stores", managedMemoryVersionsRoutes);
v1.route("/models", managedModelsRoutes);
v1.route("/oma/memory_stores", buildLegacyMemoryRoutes({ services }));
v1.route("/skills", managedSkillsRoutes);
v1.route("/skills", managedSkillVersionsRoutes);
v1.route("/deployments", managedDeploymentsRoutes);
v1.route("/deployment_runs", managedDeploymentRunsRoutes);
v1.route("/environments", managedEnvironmentWorkRoutes);
v1.route("/dreams", managedDreamsRoutes);
v1.route("/oma/dreams", buildDreamRoutes({
  services,
  curatorEnv: {
    DREAM_CURATOR_MODE: process.env.DREAM_CURATOR_MODE,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  },
}));
v1.route("/tunnels", managedTunnelsRoutes);
v1.route("/tunnels", managedTunnelCertificateRoutes);
v1.route("/oma/me", buildMeRoutes({
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
v1.route("/oma/tenants", buildTenantRoutes({ services }));
v1.route("/oma/api_keys", buildApiKeyRoutes({ storage: apiKeyStorage }));
v1.route("/oma/evals", buildEvalRoutes({
  evals: evalsService,
  agents: agentsService,
  environments: environmentsService,
}));

async function countManagedPages(
  load: (cursor?: string) => Promise<{
    items: readonly unknown[];
    nextCursor: string | null;
  }>,
): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  const visited = new Set<string>();

  for (;;) {
    const page = await load(cursor);
    total += page.items.length;
    if (page.nextCursor === null) return total;
    if (visited.has(page.nextCursor)) {
      throw new Error(`Managed stats pagination repeated cursor ${page.nextCursor}`);
    }
    visited.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

// OMA-only stubs used by the self-hosted console.
v1.route("/oma/skills", buildNodeSkillsRoutes({ db: drizzleDb, blobs: filesBlob }));
v1.get("/oma/runtimes", (c) => c.json({ data: [] }));
v1.get("/oma/stats", async (c) => {
  const tenantId = c.get("tenant_id");
  const managedApp = managedAgentsPlatform.app({ workspaceId: tenantId });
  const managedAgents = managedApp.port(managedAgentsPortTokens.agents);
  const managedEnvironments = managedApp.port(managedAgentsPortTokens.environments);
  const managedSessions = managedSessionsComposition.portsFor(tenantId).sessions;
  const managedSkills = managedSkillsPlatform
    .app({ workspaceId: tenantId })
    .port(managedAgentsPortTokens.skills);
  const managedVaults = managedCredentialsPlatform
    .app({ workspaceId: tenantId })
    .port(managedAgentsPortTokens.vaults);
  const [
    agents,
    sessions,
    environments,
    vaults,
    skills,
    modelCards,
    apiKeys,
  ] = await Promise.all([
    countManagedPages(async (cursor) => {
      const result = await managedAgents.listAgents({
        pageSize: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (result.type !== "page") throw new Error(result.message);
      return { items: result.page.agents, nextCursor: result.page.nextCursor };
    }),
    countManagedPages(async (cursor) => {
      const result = await managedSessions.listSessions({
        pageSize: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (result.type !== "page") throw new Error(result.message);
      return { items: result.page.sessions, nextCursor: result.page.nextCursor };
    }),
    countManagedPages(async (cursor) => {
      const result = await managedEnvironments.listEnvironments({
        pageSize: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (result.type !== "page") throw new Error(result.message);
      return { items: result.page.environments, nextCursor: result.page.nextCursor };
    }),
    countManagedPages(async (cursor) => {
      const result = await managedVaults.listVaults({
        pageSize: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (result.type !== "page") throw new Error(result.message);
      return { items: result.page.vaults, nextCursor: result.page.nextCursor };
    }),
    countManagedPages(async (cursor) => {
      const result = await managedSkills.listSkills({
        pageSize: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (result.type !== "page") throw new Error(result.message);
      return { items: result.page.skills, nextCursor: result.page.nextCursor };
    }),
    modelCardsService.list({ tenantId }),
    apiKeyStorage.listByTenant(tenantId),
  ]);

  return c.json({
    agents,
    sessions,
    environments,
    vaults,
    skills,
    model_cards: modelCards.filter((card) => card.archived_at === null).length,
    api_keys: apiKeys.length,
  });
});
v1.route("/environments", managedEnvironmentsRoutes);
v1.route("/oma/environments", buildLegacyEnvironmentRoutes({
  environments: environmentsService,
  sessions: sessionsService,
}));
v1.route("/files", managedFilesRoutes);
v1.route("/oma/model_cards", buildModelCardRoutes({ modelCards: modelCardsService }));
v1.route("/oma/models", buildOmaModelsHttpRoutes({
  fetch: (input, init) => fetch(input, init),
}));
v1.get("/oma/integrations/github/credentials", (c) => c.json({ data: [] }));
v1.get("/oma/integrations/linear/credentials", (c) => c.json({ data: [] }));
v1.get("/oma/integrations/slack/credentials", (c) => c.json({ data: [] }));

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
    db: drizzleDb,
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

// Feishu WebSocket long-connection runner — the production ingest path for
// Feishu and the driver of the `credentials_filled / awaiting_install → live`
// status flip. The bot dials OUT, so (unlike the legacy HTTP webhook) no
// public URL is needed. Opt-in (`FEISHU_WS_RUNNER=1`) until it has been
// exercised against real Feishu app credentials — otherwise a stale
// publication with fake creds would dial out and backoff-loop on every boot.
if (
  ownsLongLivedProcesses
  && platformRootSecret
  && installBridge
  && process.env.FEISHU_WS_RUNNER === "1"
) {
  try {
    const { startFeishuWsRunner } = await import("./lib/ws-feishu-runner.js");
    const feishuContainer = installBridge.buildContainers().feishu;
    const feishuProvider = buildNodeProvidersForRequest(installBridge, gatewayOrigin).feishu;
    // HTTP adapter for the automatic-egress send path (FeishuApiClient). One
    // instance serves all Feishu Apps; the client mints/caches its own token.
    const feishuHttp = new WorkerHttpClient();
    // Wire the live Feishu agent tools (send/read) into the harness tool map
    // for Feishu-backed sessions. Same publication repo + HTTP adapter as the
    // runner — the WS runner is the only ingest path that produces Feishu
    // sessions, so this is the only place that needs configuring.
    configureFeishuAgentTools({
      reader: sqlSessionMetadataReader(sql),
      pubs: feishuContainer.feishuPublications,
      http: feishuHttp,
    });
    feishuRunner = await startFeishuWsRunner({
      sql,
      pubs: feishuContainer.feishuPublications,
      installations: feishuContainer.feishuInstallations,
      webhookEvents: feishuContainer.webhookEvents,
      provider: feishuProvider,
      hub,
      http: feishuHttp,
    });
  } catch (err) {
    logger.warn(
      { err, op: "main-node.feishu_ws_runner_start_failed" },
      "feishu ws runner failed to start",
    );
  }
}

if (platformRootSecret) {
  const integrationsRepoEnv: NodeReposEnv = {
    sql,
    db: drizzleDb,
    PLATFORM_ROOT_SECRET: platformRootSecret,
  };
  v1.route(
    "/oma/integrations",
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
            installations: new SqlSlackInstallationRepo(drizzleDb, slackCrypto, slackIds),
            publications: new SqlSlackPublicationRepo(drizzleDb, slackIds, slackCrypto),
            apps: new SqlSlackAppRepo(drizzleDb, slackCrypto, slackIds),
          },
          feishu: {
            installations: new SqlFeishuInstallationRepo(drizzleDb, slackCrypto, slackIds),
            publications: new SqlFeishuPublicationRepo(drizzleDb, slackIds, slackCrypto),
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
v1.get("/oma/files", async (c) => {
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
v1.get("/oma/files/:id/content", async (c) => {
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
v1.get("/oma/files/:id", async (c) => {
  const id = c.req.param("id");
  const t = c.var.tenant_id;
  const row = await filesService.get({ tenantId: t, fileId: id });
  if (!row) return c.json({ error: "File not found" }, 404);
  return c.json(toFileRecord(row));
});
v1.delete("/oma/files/:id", async (c) => {
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

// ── Session ↔ memory_store binding (Node-specific; not in package yet) ──
v1.post("/oma/sessions/:id/memory_stores", async (c) => {
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
v1.get("/oma/sessions/:id/memory_stores", async (c) => {
  const r = await sql
    .prepare(
      `SELECT store_id, access, created_at FROM session_memory_stores WHERE session_id = ?`,
    )
    .bind(c.req.param("id"))
    .all<{ store_id: string; access: string; created_at: number }>();
  return c.json({ data: r.results ?? [] });
});

app.route("/v1", v1);
app.route("/openai", buildNodeOpenAIAgentsRoutes({
  authMiddleware: authMw,
  portFor: (workspaceId) => {
    const application = managedAgentsPlatform.app({ workspaceId });
    const credentialApplication = managedCredentialsPlatform.app({ workspaceId });
    const native = managedSessionsComposition.portsFor(workspaceId);
    const agents = application.port(managedAgentsPortTokens.agents);
    const environments = application.port(managedAgentsPortTokens.environments);
    const files = application.port(managedAgentsPortTokens.files);
    const runtime = createNodeOpenAIAgentsRuntime({
      environments, sessions: native.sessions, secrets: openAIAgentsSecrets,
      connectedSandbox: sessionId => managedRuntimeRunner.connectedSandbox({ workspaceId, sessionId }),
    });
    const resources = createResourcesHandler({
      agents, environments, files, secrets: openAIAgentsSecrets, runtime: runtime.files,
      vaults: credentialApplication.port(managedAgentsPortTokens.vaults),
      credentials: credentialApplication.port(managedAgentsPortTokens.credentials),
    });
    const artifacts = createArtifactsHandler({
      files,
      requireSession: async sessionId => {
        const found = await native.sessions.retrieveSession({ sessionId });
        if (found.type !== "found") throw new OpenAIAgentsProtocolError(404, "Session not found");
      },
    });
    const sessions = createSessionsHandler({
      workspaceId, sessions: native.sessions, sessionEvents: native.sessionEvents,
      history: new SessionRuntimeHistoryApplicationService({ workspaceId, source: managedRuntimeReaders.history }),
      mapping: createManagedSessionMapping({ agents, environments, resources, secrets: openAIAgentsSecrets, runtime: runtime.mapping }),
      resources: { execute: artifacts },
    });
    return { execute: request => request.operation.startsWith("sessions.") ? sessions.execute(request) : resources(request) };
  },
}));

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

// ── Console UI (optional) ──
const consoleDir = process.env.CONSOLE_DIR;
if (consoleDir) {
  const cwd = process.cwd();
  const rootRel = consoleDir.startsWith("/")
    ? relative(cwd, consoleDir)
    : consoleDir;
  app.use("/*", serveStatic({ root: rootRel }));
  // SPA fallback for client-side routes ONLY. Never serve index.html for
  // API/auth/health paths — a missing /v1/* handler used to fall through
  // here and the console would fail with
  // `Unexpected token '<' ... is not valid JSON` (HTML parsed as JSON).
  app.get("/*", async (c, next) => {
    const p = c.req.path;
    if (
      p === "/health" ||
      p.startsWith("/v1/") ||
      p.startsWith("/auth") ||
      p.startsWith("/linear") ||
      p.startsWith("/github")
    ) {
      return next();
    }
    return serveStatic({ root: rootRel, path: "index.html" })(c, next);
  });
  logger.info({ op: "main-node.console_ui", dir: consoleDir, cwd_rel: rootRel }, "console UI served");
}

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => {
  logger.error({ err, op: "main-node.unhandled" }, "unhandled error");
  return c.json({ error: "internal_error", message: err.message }, 500);
});

// ─── Listen ──────────────────────────────────────────────────────────────

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

export const shutdownNodeApp = async (signal = "dispose") => {
  logger.info({ op: "main-node.shutdown", signal }, `received ${signal}, shutting down`);
  managedSessionExecutionWorker.stop();
  try { await managedSessionsComposition.stopAll(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.managed_sessions_stop_failed" }, "managed Sessions app graphs stop failed"); }
  try { await managedAgentsPlatform.stopAll(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.managed_platform_stop_failed" }, "managed platform stop failed"); }
  try { await managedCredentialsPlatform.stopAll(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.managed_credentials_platform_stop_failed" }, "managed Credentials platform stop failed"); }
  try { await managedDeploymentsPlatform.stopAll(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.managed_deployments_platform_stop_failed" }, "managed Deployments platform stop failed"); }
  try { await managedDreamsPlatform.stopAll(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.managed_dreams_platform_stop_failed" }, "managed Dreams platform stop failed"); }
  try { await scheduler.stop(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.scheduler_stop_failed" }, "scheduler stop failed"); }
  try { await memoryWatcher.stop(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.watcher_stop_failed" }, "memory watcher stop failed"); }
  if (s3Poller) {
    try { await s3Poller.stop(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.s3_poller_stop_failed" }, "s3-poller stop failed"); }
  }
  if (feishuRunner) {
    try { await feishuRunner.stop(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.feishu_runner_stop_failed" }, "feishu ws runner stop failed"); }
  }
  if (hub instanceof PgEventStreamHub) {
    try { await hub.stop(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.pg_hub_stop_failed" }, "pg-hub stop failed"); }
  }
  if (authShutdown) {
    try { await authShutdown(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.auth_failed" }, "auth shutdown failed"); }
  }
  if (databaseShutdown) {
    try { await databaseShutdown(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.database_failed" }, "database shutdown failed"); }
  }
  try { await sessionRegistry.shutdown(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.session_registry_failed" }, "session registry shutdown failed"); }
  try { await tracer.shutdown(); } catch { /* tracer shutdown is best-effort */ }
};

export { app };

if (ownsLongLivedProcesses) {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "0.0.0.0";
  // Start the execution poller only after every runtime dependency below its
  // declaration (Managed Memory/Skill applications included) has initialized.
  managedSessionExecutionWorker.start();
  serve({ fetch: app.fetch, port, hostname: host }, (info) => {
    logger.info(
      { op: "main-node.listening", address: info.address, port: info.port, db: backendDescription },
      `listening on http://${info.address}:${info.port}`,
    );
  });
  await scheduler.start();
  logger.info({ op: "main-node.scheduler.started" }, "scheduler started");

  const shutdownProcess = async (signal: string) => {
    await shutdownNodeApp(signal);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdownProcess("SIGTERM"));
  process.on("SIGINT", () => void shutdownProcess("SIGINT"));
}

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
 *
 * Linear's publication-first endpoints use distinct subpath shapes:
 *   - POST  linear/publications                       → mode='create-publication'
 *   - PATCH linear/publications/<id>/credentials      → mode='submit-credentials-pub'
 * Slack/GitHub continue using the legacy /start-a1, /credentials,
 * /handoff-link variants until they ship their own publication-first
 * refactors.
 */
function bridgeAsInstallProxy(bridge: NodeInstallBridge): InstallProxyForwarder {
  return {
    async forward({ subpath, body, method }) {
      // Linear publication-first endpoints first — they share a subpath
      // prefix with the legacy ones so order matters.
      const newPub = /^linear\/publications$/.exec(subpath);
      if (newPub && method === "POST") {
        const result = await bridge.startInstallation!({
          provider: "linear",
          mode: "create-publication",
          body: (body ?? {}) as Record<string, unknown>,
        });
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { "content-type": "application/json" },
        });
      }
      const newCreds = /^linear\/publications\/([^/]+)\/credentials$/.exec(subpath);
      if (newCreds && (method === "PATCH" || method === "POST")) {
        const result = await bridge.startInstallation!({
          provider: "linear",
          mode: "submit-credentials-pub",
          body: { ...(body ?? {}), publicationId: newCreds[1] } as Record<string, unknown>,
        });
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { "content-type": "application/json" },
        });
      }

      // Form-token reissue (wizard resume path): `<provider>/publications/<id>/form-token`.
      // Has a dynamic :id segment so it can't fold into the static-mode regex below —
      // handle it first and inject the id as body.publicationId (the bridge's
      // `form-token` mode reads it). Mounted for slack/github/feishu; linear returns
      // 410 inside the bridge.
      const formTokenRe = /^([^/]+)\/publications\/([^/]+)\/form-token$/.exec(subpath);
      // The http-routes forwarder omits `method` on this path; the CF
      // counterpart defaults to POST (apps/main/src/routes/integrations.ts)
      // — mirror that here so wizard refresh-resume works on Node.
      if (formTokenRe && (method ?? "POST") === "POST") {
        const result = await bridge.startInstallation!({
          provider: formTokenRe[1] as "linear" | "github" | "slack" | "feishu",
          mode: "form-token",
          body: {
            ...(body ?? {}),
            publicationId: formTokenRe[2],
          } as Record<string, unknown>,
        });
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { "content-type": "application/json" },
        });
      }

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
        provider: provider as "linear" | "github" | "slack" | "feishu",
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
