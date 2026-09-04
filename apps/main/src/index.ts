import { Hono } from "hono";
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "@open-managed-agents/shared";
import {
  buildCfTenantDbProvider,
  servicesMiddleware,
  tenantDbMiddleware,
  getCfServicesForTenant,
} from "@open-managed-agents/services";
import {
  buildAgentRoutes as buildLegacyAgentRoutes,
  buildVaultRoutes as buildLegacyVaultRoutes,
  buildSessionRoutes,
  buildApiKeyRoutes,
  buildMeRoutes,
  buildTenantRoutes,
  mintApiKeyOnStorage,
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
  createCloudflareManagedAgentsApp,
} from "@open-managed-agents/platform-cloudflare";
import type { CredentialDocumentCipher } from "@open-managed-agents/credential-store-sql";
import type { DeploymentResourceSecretCipher } from "@open-managed-agents/deployment-store-sql";
import type { EnvironmentWorkSecretCipher } from "@open-managed-agents/environment-work-store-sql";
import {
  SqlDeploymentAgentSource,
  SqlDeploymentVaultSource,
  SqlFileMetadataPersistence,
  SqlMemoryStoreSource,
  SqlManagedSessionsComposition,
  SqlSessionEnvironmentSource,
  SqlSessionSource,
  SqlSessionRuntimeProjectionPersistence,
} from "@open-managed-agents/managed-agents-adapters-sql";
import { BlobFileContentStore } from "@open-managed-agents/managed-agents-adapters-blob";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import {
  createCfShardPoolService,
  createCfTenantShardDirectoryService,
} from "@open-managed-agents/tenant-dbs-store";
import {
  LOCAL_RUNTIME_ENV_ID,
  listAuthProviders,
} from "@open-managed-agents/shared";
import { toEnvironmentConfig } from "@open-managed-agents/environments-store";
import { authMiddleware } from "./auth";
import { rateLimitMiddleware, authRateLimitMiddleware } from "./rate-limit";
import { cfRouteServices } from "./lib/cf-route-services";
import { cfApiKeyStorage } from "./lib/cf-api-key-storage";
import { CfSessionRouter } from "./lib/cf-session-router";
import { CfManagedRuntimeFetcher } from "./lib/cf-managed-runtime-fetcher";
import { CfManagedSessionRuntimeAdapter } from "./lib/cf-managed-session-runtime";
import { CfManagedSessionSecretSealer } from "./lib/cf-managed-session-secret-sealer";
import {
  AnthropicMessagesDreamCurator,
  ApplicationDreamMemoryWorkspace,
  ModelCardCatalogSource,
  decodeRuntimeProducedSessionEvent,
  CronDeploymentSchedulePlanner,
  EnvironmentAwareSessionLifecycleRouter,
  TimerEnvironmentWorkAvailabilityWaiter,
  IndeterminateCredentialValidationProbe,
  inProcessDreamExecutionSchedulerModule,
  LocalTunnelProvisioner,
  SealedEnvironmentWorkSessionCredentialIssuer,
  DeduplicatingDreamCurator,
  WebCryptoTunnelCertificateAuthority,
  WebCryptoTunnelTokenManager,
  WebCryptoMemoryContentDescriptor,
  ZipSkillPackageCompiler,
} from "@open-managed-agents/managed-agents-adapters-runtime";
import { WebCryptoAesGcm } from "@open-managed-agents/integrations-adapters-cf";
import {
  cfSessionLifecycle,
  cfOutputsAdapter,
  fetchVaultCredentials,
} from "./lib/cf-session-lifecycle";
import { validateAgentLimits } from "./lib/limits";
import { listMemberships, hasMembership } from "./auth-config";
import legacyEnvironmentsRoutes from "./routes/environments";
import oauthRoutes from "./routes/oauth";
import capCliOauthRoutes from "./routes/cap-cli-oauth";
import legacyMemoryRoutes from "./routes/memory";
import dreamsRoutes from "./routes/dreams";
import legacyFilesRoutes from "./routes/files";
import legacySkillsRoutes from "./routes/skills";
import modelCardsRoutes from "./routes/model-cards";
import modelsRoutes from "./routes/models";
import clawhubRoutes from "./routes/clawhub";
import evalsRoutes from "./routes/evals";
import costReportRoutes from "./routes/cost-report";
import internalRoutes from "./routes/internal";
import integrationsRoutes from "./routes/integrations";
import { runtimesRoutes, runtimeDaemonRoutes, authenticateRuntimeToken } from "./routes/runtimes";
import statsRoutes from "./routes/stats";
import mcpProxyRoutes, {
  resolveProxyTargetByTenant,
  resolveOutboundCredentialByHost,
  forwardWithRefresh,
} from "./routes/mcp-proxy";
import { resolveGithubCredentials } from "./lib/github-creds";
import { buildCfScheduler } from "./lib/cf-scheduler-jobs";
import { buildCfMemoryQueue, dispatchCfMemoryQueueBatch } from "./lib/cf-queue-handlers";
import { logError, recordEvent, errFields } from "@open-managed-agents/shared";
import { globalErrorHandler, requestMetricsMiddleware } from "./lib/observability";
import { errorEnvelopeMiddleware } from "./lib/error-envelope";
import type { R2EventMessage } from "@open-managed-agents/shared";

// Main worker: CRUD + routing layer.
// SessionDO and Sandbox are in per-environment sandbox workers.
// Environment builds are triggered via GitHub Actions.

// --- HTTP app ---
const app = new Hono<{ Bindings: Env }>();

// Request-level observability — must be the FIRST middleware so it
// captures every request including auth failures, rate-limit rejects,
// and unhandled exceptions. Pairs with globalErrorHandler below.
app.use("*", requestMetricsMiddleware);

// Normalize all 4xx/5xx JSON bodies into the Anthropic-compatible error
// envelope (`{type:"error", error:{type,message}, request_id}`) so callers
// of the official @anthropic-ai/sdk can `catch (e) { if (e.error?.error?.type
// === 'authentication_error') ... }`. Runs second so it sees the response
// body produced by every downstream middleware/handler. See lib/error-envelope.ts.
app.use("*", errorEnvelopeMiddleware);

// Catch-all for anything that escapes per-route try/catch. Logs +
// records to AE before returning a clean 500 (no internal leak in body).
app.onError(globalErrorHandler);

// Hono's default notFound is a plain "404 Not Found" body — wrap it in the
// Anthropic envelope so SDK callers can `if (e.error?.error?.type ===
// 'not_found_error')` instead of relying on raw status codes. Returning a
// JSON body here makes errorEnvelopeMiddleware's already-canonical short
// path kick in.
app.notFound((c) =>
  c.json(
    {
      type: "error" as const,
      error: {
        type: "not_found_error",
        message: `No route matched ${c.req.method} ${c.req.path}`,
      },
    },
    404,
  ),
);

app.get("/health", (c) => c.json({ status: "ok" }));

// Auth routes (public — no authMiddleware, but rate-limited per-IP and
// per-email so a stranger can't spam OTP sends and burn the mail budget).
// Lazy import to avoid crashing workerd in test environments
app.use("/auth/*", authRateLimitMiddleware);
app.on(["GET", "POST"], "/auth/*", async (c) => {
  if (!c.env.MAIN_DB) return c.json({ error: "Auth not configured" }, 503);
  const { createAuth } = await import("./auth-config");
  return createAuth(c.env).handler(c.req.raw);
});

// Auth info endpoint (public — tells the frontend which providers are enabled
// and surfaces the Turnstile site key so the Login page can render the widget).
app.get("/auth-info", (c) => {
  const providers = listAuthProviders({
    emailOtp: true,
    googleClientId: c.env.GOOGLE_CLIENT_ID,
    googleClientSecret: c.env.GOOGLE_CLIENT_SECRET,
    githubClientId: c.env.GITHUB_CLIENT_ID,
    githubClientSecret: c.env.GITHUB_CLIENT_SECRET,
  });
  return c.json({
    providers,
    turnstile_site_key: c.env.TURNSTILE_SITE_KEY ?? null,
  });
});

// API routes (require authentication)
app.use("/v1/*", authMiddleware);
app.use("/v1/*", rateLimitMiddleware);
// Resolve the per-tenant D1 database for this request. Phase 1: returns the
// shared MAIN_DB for every tenant (zero behaviour change). Phase 4: routes
// to per-tenant bindings published by the CICD sync script.
app.use("/v1/*", tenantDbMiddleware);
// Build the platform-agnostic service container once per request and stash it
// on c.var.services. Wiring (CF / Postgres / SQLite) lives in
// packages/services — routes only see the abstract Services interface.
app.use("/v1/*", servicesMiddleware);

// Build agent / vault / api-keys / me / tenants from
// `@open-managed-agents/http-routes`. Per-request `RouteServices` is
// resolved off `c.var.services` so the per-tenant D1 binding flows
// through; CF-only callbacks (model card validation, field-size limits,
// shard assignment, KV-backed api-key storage, MAIN_DB membership reads)
// get plumbed in here. Each mount is a Hono sub-app whose handler builds
// a one-shot package app per request — cheap (~µs of route registration)
// and keeps the per-tenant + per-request callbacks correctly scoped
// without leaking globals.

// Build agent / vault / api-keys / me / tenants / sessions from
// `@open-managed-agents/http-routes`. Per-request `RouteServices` is
// resolved off `c.var.services` so the per-tenant D1 binding flows
// through; CF-only callbacks (model card validation, field-size limits,
// shard assignment, KV-backed api-key storage, MAIN_DB membership reads,
// USAGE_METER + refresh + GitHub fast-path lifecycle hooks) get plumbed
// in via closures over `c` so they always see the per-request services
// container without leaking globals.

type AppCtx = import("hono").Context<{
  Bindings: Env;
  Variables: {
    tenant_id: string;
    user_id?: string;
    services: import("@open-managed-agents/services").Services;
    tenantDb: D1Database;
  };
}>;

const cfRouteServicesFromCtx = (c: AppCtx) =>
  cfRouteServices(c as never);

const legacyAgentsRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const services = ctx.var.services;
  const app = buildLegacyAgentRoutes({
    services: () => cfRouteServicesFromCtx(ctx),
    validateModel: async (tenantId, model) => {
      const cards = await services.modelCards.list({ tenantId });
      const active = cards.filter((card) => card.archived_at === null);
      if (active.length === 0) return { valid: true };
      const modelId = typeof model === "string" ? model : model.id;
      const match = active.find((card) => card.model_id === modelId);
      if (!match) {
        return {
          valid: false,
          error: `No model card with model_id "${modelId}". Create a card with that handle, or set agent.model to an existing card's model_id.`,
        };
      }
      return { valid: true };
    },
    validateAgentLimits: (body) =>
      validateAgentLimits(body as Parameters<typeof validateAgentLimits>[0]),
    hasActiveSessionsByAgent: (tenantId, agentId) =>
      services.sessions.hasActiveByAgent({ tenantId, agentId }),
    hasActiveEvalsByAgent: (tenantId, agentId) =>
      services.evals.hasActiveByAgent({ tenantId, agentId }),
  });
  return invokePackage(c, app);
});

function managedCoreApplicationFor(context: { var: unknown }) {
  const request = context.var as {
    tenant_id: string;
    tenantDb: D1Database;
  };
  return createCloudflareManagedAgentsApp({
    workspaceId: request.tenant_id,
    sql: new CfD1SqlClient(request.tenantDb),
  }, {
    features: {
      preset: "none",
      agents: true,
      environments: true,
      memoryStores: true,
      userProfiles: true,
    },
    clock: { now: () => new Date() },
    ids: {
      next: (namespace) =>
        `${namespace === "environment" ? "env" : namespace === "memory_store" ? "memstore" : namespace === "user-profile" ? "uprof" : namespace}_${crypto.randomUUID().replaceAll("-", "")}`,
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
}

const managedAgentsRoutes = buildManagedAgentRoutes((context) => {
  return managedCoreApplicationFor(context)
    .port(managedAgentsPortTokens.agents);
});

const managedEnvironmentsRoutes = buildManagedEnvironmentRoutes((context) => {
  return managedCoreApplicationFor(context)
    .port(managedAgentsPortTokens.environments);
});

const managedFilesRoutes = buildManagedFileRoutes((context) => {
  const request = context.var as {
    tenant_id: string;
    tenantDb: D1Database;
    services: import("@open-managed-agents/services").Services;
  };
  const blobs = request.services.filesBlob;
  if (blobs === null) {
    throw new Error("FILES_BUCKET binding is required for managed Files");
  }
  return createCloudflareManagedAgentsApp({
    workspaceId: request.tenant_id,
    sql: new CfD1SqlClient(request.tenantDb),
    fileContent: new BlobFileContentStore(blobs),
  }, {
    features: { preset: "none", files: true },
    clock: { now: () => new Date() },
    ids: {
      next: (namespace) =>
        `${namespace}_${crypto.randomUUID().replaceAll("-", "")}`,
    },
  }).port(managedAgentsPortTokens.files);
});

const managedMemoryStoresRoutes = buildManagedMemoryStoreRoutes((context) => {
  return managedCoreApplicationFor(context)
    .port(managedAgentsPortTokens.memoryStores);
});

const managedMemoryContent = new WebCryptoMemoryContentDescriptor();
function managedMemoryActor(userId: string | undefined) {
  return userId === undefined
    ? { kind: "api" as const, apiKeyId: "self_hosted" }
    : { kind: "user" as const, userId };
}
const managedMemoriesRoutes = buildManagedMemoryRoutes((context) => {
  return managedMemoriesApplicationFor(context as unknown as AppCtx)
    .port(managedAgentsPortTokens.memories);
});
const managedMemoryVersionsRoutes = buildManagedMemoryVersionRoutes((context) => {
  return managedMemoriesApplicationFor(context as unknown as AppCtx)
    .port(managedAgentsPortTokens.memoryVersions);
});

function managedMemoriesApplicationFor(ctx: AppCtx) {
  const client = new CfD1SqlClient(ctx.var.tenantDb);
  return createCloudflareManagedAgentsApp({
    workspaceId: ctx.var.tenant_id,
    sql: client,
  }, {
    features: {
      preset: "none",
      memories: true,
      memoryVersions: true,
    },
    clock: { now: () => new Date() },
    ids: {
      next: (namespace) => `${
        namespace === "memory"
          ? "mem"
          : namespace === "memory-version"
            ? "memver"
            : namespace
      }_${crypto.randomUUID().replaceAll("-", "")}`,
    },
    modules: () => [
      providePort(
        memoryStoreForMemorySourcePort,
        new SqlMemoryStoreSource(client),
      ),
      providePort(memoryContentDescriptorPort, managedMemoryContent),
      providePort(
        memoryVersionActorPort,
        managedMemoryActor(ctx.var.user_id),
      ),
    ],
  });
}

const managedSkillCompiler = new ZipSkillPackageCompiler();
let lastManagedSkillVersion = 0n;
function nextManagedSkillVersion(): string {
  const now = BigInt(Date.now()) * 1_000n;
  lastManagedSkillVersion = now > lastManagedSkillVersion
    ? now
    : lastManagedSkillVersion + 1n;
  return lastManagedSkillVersion.toString();
}
function managedSkillsApplicationFor(ctx: AppCtx) {
  const client = new CfD1SqlClient(ctx.var.tenantDb);
  return createCloudflareManagedAgentsApp({
    workspaceId: ctx.var.tenant_id,
    sql: client,
  }, {
    features: {
      preset: "none",
      skills: true,
      skillVersions: true,
    },
    clock: { now: () => new Date() },
    ids: {
      next: (namespace) =>
        namespace === "skill-version-value"
          ? nextManagedSkillVersion()
          : `${namespace === "skill-version" ? "skv" : namespace}_${crypto.randomUUID().replaceAll("-", "")}`,
    },
    modules: () => [
      providePort(skillPackageCompilerPort, managedSkillCompiler),
    ],
  });
}
const managedSkillsRoutes = buildManagedSkillRoutes((context) =>
  managedSkillsApplicationFor(context as unknown as AppCtx)
    .port(managedAgentsPortTokens.skills),
);
const managedSkillVersionsRoutes = buildManagedSkillVersionRoutes((context) =>
  managedSkillsApplicationFor(context as unknown as AppCtx)
    .port(managedAgentsPortTokens.skillVersions),
);

const legacyVaultsRoutes = new Hono<{ Bindings: Env; Variables: { tenant_id: string } }>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const app = buildLegacyVaultRoutes({ services: () => cfRouteServicesFromCtx(ctx) });
  return invokePackage(c, app);
});

const managedVaultsRoutes = buildManagedVaultRoutes((context) => {
  const request = context.var as {
    tenant_id: string;
    tenantDb: D1Database;
  };
  return createCloudflareManagedAgentsApp({
    workspaceId: request.tenant_id,
    sql: new CfD1SqlClient(request.tenantDb),
  }, {
    features: { preset: "none", vaults: true },
    clock: { now: () => new Date() },
    ids: {
      next: (namespace) =>
        `${namespace === "vault" ? "vlt" : namespace}_${crypto.randomUUID().replaceAll("-", "")}`,
    },
  }).port(managedAgentsPortTokens.vaults);
});

const managedCredentialValidation = new IndeterminateCredentialValidationProbe();
const managedCredentialsRoutes = buildManagedCredentialRoutes((context) => {
  const request = context.var as {
    tenant_id: string;
    tenantDb: D1Database;
  };
  const credentialCrypto = context.env.PLATFORM_ROOT_SECRET === undefined
    ? null
    : new WebCryptoAesGcm(
        context.env.PLATFORM_ROOT_SECRET,
        "managed.vault.credentials",
      );
  const cipher: CredentialDocumentCipher = {
    seal: async ({ plaintext }) => {
      if (credentialCrypto === null) {
        throw new Error(
          "PLATFORM_ROOT_SECRET is required for managed Vault credentials",
        );
      }
      return { ciphertext: await credentialCrypto.encrypt(plaintext) };
    },
    open: async ({ ciphertext }) => {
      if (credentialCrypto === null) {
        throw new Error(
          "PLATFORM_ROOT_SECRET is required for managed Vault credentials",
        );
      }
      return { plaintext: await credentialCrypto.decrypt(ciphertext) };
    },
  };
  return createCloudflareManagedAgentsApp({
    workspaceId: request.tenant_id,
    sql: new CfD1SqlClient(request.tenantDb),
    credentialCipher: cipher,
    credentialValidation: managedCredentialValidation,
  }, {
    features: { preset: "none", credentials: true },
    clock: { now: () => new Date() },
    ids: {
      next: (namespace) =>
        `${namespace === "credential" ? "vcrd" : namespace}_${crypto.randomUUID().replaceAll("-", "")}`,
    },
  }).port(managedAgentsPortTokens.credentials);
});

const managedUserProfilesRoutes = buildManagedUserProfileRoutes((context) => {
  return managedCoreApplicationFor(context)
    .port(managedAgentsPortTokens.userProfiles);
});

const apiKeysRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const services = ctx.var.services;
  const app = buildApiKeyRoutes({ storage: cfApiKeyStorage(services.kv) });
  return invokePackage(c, app);
});

const meRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const env = ctx.env;
  const services = ctx.var.services;
  const app = buildMeRoutes({
    services: () => cfRouteServicesFromCtx(ctx),
    authDisabled: false,
    loadUser: async (userId) => {
      if (!env.MAIN_DB) return null;
      const r = await env.MAIN_DB
        .prepare(`SELECT id, email, name FROM "user" WHERE id = ?`)
        .bind(userId)
        .first<{ id: string; email: string; name: string | null }>();
      return r ?? null;
    },
    loadTenant: async (tenantId) => {
      if (!env.MAIN_DB) return null;
      const r = await env.MAIN_DB
        .prepare(`SELECT id, name FROM tenant WHERE id = ?`)
        .bind(tenantId)
        .first<{ id: string; name: string }>();
      return r ?? null;
    },
    listMemberships: (userId) => listMemberships(env.MAIN_DB, userId),
    hasMembership: (userId, tenantId) => hasMembership(env.MAIN_DB, userId, tenantId),
    mintApiKey: (input) =>
      mintApiKeyOnStorage(cfApiKeyStorage(services.kv), input),
  });
  return invokePackage(c, app);
});

const tenantsRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const env = ctx.env;
  const app = buildTenantRoutes({
    services: () => cfRouteServicesFromCtx(ctx),
    createTenantAndMembership: async ({ tenantId, name, userId }) => {
      const now = Math.floor(Date.now() / 1000);
      await env.MAIN_DB.batch([
        env.MAIN_DB
          .prepare("INSERT INTO tenant (id, name, createdAt, updatedAt) VALUES (?, ?, ?, ?)")
          .bind(tenantId, name, now, now),
        env.MAIN_DB
          .prepare(
            "INSERT INTO membership (user_id, tenant_id, role, created_at) VALUES (?, ?, 'owner', ?)",
          )
          .bind(userId, tenantId, now),
      ]);
    },
    assignShard: async (tenantId) => {
      const controlPlaneDb = env.ROUTER_DB ?? env.MAIN_DB;
      const shardPool = createCfShardPoolService({ controlPlaneDb });
      const tenantShardDirectory = createCfTenantShardDirectoryService({ controlPlaneDb });
      const pick = await shardPool.pickShardForNewTenant();
      const bindingName = pick?.bindingName ?? "AUTH_DB_00";
      await tenantShardDirectory.assign({ tenantId, bindingName });
      await shardPool.incrementTenantCount(bindingName);
    },
  });
  return invokePackage(c, app);
});

const legacySessionsRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const env = ctx.env;
  const services = ctx.var.services;
  const tenantId = ctx.var.tenant_id;
  const router = new CfSessionRouter({ env, services, tenantId });
  const app = buildSessionRoutes({
    services: () => cfRouteServicesFromCtx(ctx),
    router,
    localRuntimeEnvId: LOCAL_RUNTIME_ENV_ID,
    loadEnvironment: async ({ tenantId, environmentId }) => {
      if (environmentId === LOCAL_RUNTIME_ENV_ID) return null;
      const row = await services.environments.get({ tenantId, environmentId });
      return row ? toEnvironmentConfig(row) : null;
    },
    fetchVaultCredentials: ({ tenantId, vaultIds }) =>
      fetchVaultCredentials(services, tenantId, vaultIds),
    outputs: cfOutputsAdapter(env),
    debugRecoveryToken: (env as { DEBUG_TOKEN?: string }).DEBUG_TOKEN,
    lifecycle: cfSessionLifecycle(c as never),
  });
  return invokePackage(c, app);
});

function managedSessionEnvironmentSource(
  client: CfD1SqlClient,
): SessionEnvironmentSourcePort {
  const persistedEnvironments = new SqlSessionEnvironmentSource(client);
  return {
    find: (input) => {
      if (input.environmentId !== LOCAL_RUNTIME_ENV_ID) {
        return persistedEnvironments.find(input);
      }
      return Promise.resolve({
        id: input.environmentId,
        archivedAt: null,
        config: {
          type: "cloud" as const,
          networking: { type: "unrestricted" as const },
          packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] },
        },
        createdAt: "1970-01-01T00:00:00.000Z",
        description: "Cloudflare local runtime",
        metadata: {},
        name: "Local runtime",
        updatedAt: "1970-01-01T00:00:00.000Z",
      });
    },
  };
}

function managedSessionsCompositionFor(ctx: AppCtx): SqlManagedSessionsComposition {
  const client = new CfD1SqlClient(ctx.var.tenantDb);
  const environments = managedSessionEnvironmentSource(client);
  const runtime = new CfManagedSessionRuntimeAdapter(
    new CfManagedRuntimeFetcher(ctx.env),
  );
  const workspaceId = ctx.var.tenant_id;
  const selfHostedWork = managedEnvironmentWorkApplicationFor(ctx)
    .port(environmentSessionWorkEnqueuerPort);
  const sessionLifecycleHooks = cfSessionLifecycle(ctx as never);
  return new SqlManagedSessionsComposition({
    client,
    // Event acceptance and runtime work admission must share one D1 batch.
    // SessionDO is only an execution host; a failed service-binding wakeup
    // therefore cannot erase already accepted work.
    executionOutbox: true,
    environments,
    lifecycle: new EnvironmentAwareSessionLifecycleRouter({
      environments,
      runtime,
      selfHostedWork,
      cleanupSession: async ({ workspaceId, sessionId }) => {
        await sessionLifecycleHooks.cascadeDeleteFiles?.({
          tenantId: workspaceId,
          sessionId,
        });
      },
    }),
    runtime,
    sealer: new CfManagedSessionSecretSealer(ctx.env.PLATFORM_ROOT_SECRET),
    clock: { now: () => new Date() },
    ids: {
      nextSessionId: () =>
        `session_${crypto.randomUUID().replaceAll("-", "")}`,
      nextEventId: () =>
        `sevt_${crypto.randomUUID().replaceAll("-", "")}`,
      nextOutcomeId: () =>
        `outc_${crypto.randomUUID().replaceAll("-", "")}`,
      nextResourceId: () =>
        `sesrsc_${crypto.randomUUID().replaceAll("-", "")}`,
    },
  });
}

const managedSessionsRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const composition = managedSessionsCompositionFor(ctx);
  const ports = composition.portsFor(ctx.var.tenant_id);
  return invokePackage(
    c,
    buildManagedSessionsApi({
      sessions: () => ports.sessions,
      sessionEvents: () => ports.sessionEvents,
      sessionResources: () => ports.sessionResources,
      sessionThreads: () => ports.sessionThreads,
      sessionThreadEvents: () => ports.sessionThreadEvents,
    }),
  );
});

const managedDeploymentSchedulePlanner = new CronDeploymentSchedulePlanner();
const managedEnvironmentWorkAvailability =
  new TimerEnvironmentWorkAvailabilityWaiter();

function managedDeploymentCipherFor(ctx: AppCtx): DeploymentResourceSecretCipher {
  const deploymentCrypto = ctx.env.PLATFORM_ROOT_SECRET === undefined
    ? null
    : new WebCryptoAesGcm(
        ctx.env.PLATFORM_ROOT_SECRET,
        "managed.deployments.resources",
      );
  return {
    seal: async ({ plaintext }) => {
      if (deploymentCrypto === null) {
        throw new Error(
          "PLATFORM_ROOT_SECRET is required for managed Deployment resource credentials",
        );
      }
      return { ciphertext: await deploymentCrypto.encrypt(plaintext) };
    },
    open: async ({ ciphertext }) => {
      if (deploymentCrypto === null) {
        throw new Error(
          "PLATFORM_ROOT_SECRET is required for managed Deployment resource credentials",
        );
      }
      return { plaintext: await deploymentCrypto.decrypt(ciphertext) };
    },
  };
}

function managedEnvironmentWorkCipherFor(
  ctx: AppCtx,
): EnvironmentWorkSecretCipher {
  const workCrypto = ctx.env.PLATFORM_ROOT_SECRET === undefined
    ? null
    : new WebCryptoAesGcm(
        ctx.env.PLATFORM_ROOT_SECRET,
        "managed.environment-work.secret",
      );
  return {
    seal: async ({ plaintext }) => {
      if (workCrypto === null) {
        throw new Error(
          "PLATFORM_ROOT_SECRET is required for managed Environment Work credentials",
        );
      }
      return { ciphertext: await workCrypto.encrypt(plaintext) };
    },
    open: async ({ ciphertext }) => {
      if (workCrypto === null) {
        throw new Error(
          "PLATFORM_ROOT_SECRET is required for managed Environment Work credentials",
        );
      }
      return { plaintext: await workCrypto.decrypt(ciphertext) };
    },
  };
}

function managedEnvironmentWorkApplicationFor(ctx: AppCtx) {
  const client = new CfD1SqlClient(ctx.var.tenantDb);
  const platformRootSecret = ctx.env.PLATFORM_ROOT_SECRET;
  if (!platformRootSecret) {
    throw new Error(
      "PLATFORM_ROOT_SECRET is required for managed Environment Work credentials",
    );
  }
  return createCloudflareManagedAgentsApp({
    workspaceId: ctx.var.tenant_id,
    sql: client,
    environmentWorkCipher: managedEnvironmentWorkCipherFor(ctx),
  }, {
    features: { preset: "none", environmentWork: true },
    clock: { now: () => new Date() },
    ids: {
      next: (namespace) =>
        `${namespace === "environment-work" ? "work" : namespace}_${crypto.randomUUID().replaceAll("-", "")}`,
    },
    modules: () => [
      providePort(
        environmentWorkEnvironmentSourcePort,
        managedSessionEnvironmentSource(client),
      ),
      providePort(
        environmentWorkAvailabilityWaiterPort,
        managedEnvironmentWorkAvailability,
      ),
      providePort(
        environmentWorkSessionCredentialIssuerPort,
        new SealedEnvironmentWorkSessionCredentialIssuer({
          crypto: new WebCryptoAesGcm(
            platformRootSecret,
            "managed.environment-work.session-token",
          ),
          now: () => new Date(),
          apiBaseUrl: new URL(ctx.req.url).origin,
        }),
      ),
      environmentWorkEnqueuerModule(),
    ],
  });
}

function managedDeploymentsApplicationFor(ctx: AppCtx) {
  const client = new CfD1SqlClient(ctx.var.tenantDb);
  const workspaceId = ctx.var.tenant_id;
  const sessions = managedSessionsCompositionFor(ctx).portsFor(workspaceId);
  return createCloudflareManagedAgentsApp({
    workspaceId,
    sql: client,
    deploymentCipher: managedDeploymentCipherFor(ctx),
    modules: [
      providePort(deploymentAgentSourcePort, new SqlDeploymentAgentSource(client)),
      providePort(
        deploymentEnvironmentSourcePort,
        managedSessionEnvironmentSource(client),
      ),
      providePort(deploymentFileSourcePort, new SqlFileMetadataPersistence(client)),
      providePort(deploymentMemoryStoreSourcePort, new SqlMemoryStoreSource(client)),
      providePort(deploymentSchedulePlannerPort, managedDeploymentSchedulePlanner),
      providePort(deploymentSessionLauncherPort, sessions.deploymentSessionLauncher),
      providePort(deploymentVaultSourcePort, new SqlDeploymentVaultSource(client)),
    ],
  }, {
    features: {
      preset: "none",
      deploymentRuns: true,
      deployments: true,
    },
    clock: { now: () => new Date() },
    ids: {
      next: (namespace) =>
        `${namespace === "deployment" ? "depl" : namespace === "deployment-run" ? "drun" : namespace}_${crypto.randomUUID().replaceAll("-", "")}`,
    },
  });
}

const managedDeploymentsRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const port = managedDeploymentsApplicationFor(ctx)
    .port(managedAgentsPortTokens.deployments);
  return invokePackage(c, buildManagedDeploymentRoutes(() => port));
});

const managedDeploymentRunsRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const port = managedDeploymentsApplicationFor(ctx)
    .port(managedAgentsPortTokens.deploymentRuns);
  return invokePackage(c, buildManagedDeploymentRunRoutes(() => port));
});

const managedEnvironmentWorkRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const port = managedEnvironmentWorkApplicationFor(ctx)
    .port(managedAgentsPortTokens.environmentWork);
  return invokePackage(c, buildManagedEnvironmentWorkRoutes(() => port));
});

function managedDreamCuratorFor(ctx: AppCtx) {
  const environment = ctx.env as Env & {
    ANTHROPIC_API_KEY?: string;
    ANTHROPIC_BASE_URL?: string;
    DREAM_CURATOR_MODE?: string;
  };
  return environment.DREAM_CURATOR_MODE === "dedup" ||
      environment.ANTHROPIC_API_KEY === undefined
    ? new DeduplicatingDreamCurator()
    : new AnthropicMessagesDreamCurator({
        apiKey: environment.ANTHROPIC_API_KEY,
        ...(environment.ANTHROPIC_BASE_URL !== undefined && {
          baseUrl: environment.ANTHROPIC_BASE_URL,
        }),
      });
}
function managedDreamsApplicationFor(ctx: AppCtx) {
  const client = new CfD1SqlClient(ctx.var.tenantDb);
  const workspaceId = ctx.var.tenant_id;
  const memoryStoreSource = new SqlMemoryStoreSource(client);
  return createCloudflareManagedAgentsApp({
    workspaceId,
    sql: client,
  }, {
    features: {
      preset: "none",
      dreams: true,
      memories: true,
      memoryStores: true,
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
      }_${crypto.randomUUID().replaceAll("-", "")}`,
    },
    modules: () => [
      providePort(dreamMemoryStoreSourcePort, memoryStoreSource),
      providePort(memoryStoreForMemorySourcePort, memoryStoreSource),
      providePort(memoryContentDescriptorPort, managedMemoryContent),
      providePort(memoryVersionActorPort, {
        kind: "service_account",
        serviceAccountId: "dream_executor",
      }),
      providePort(dreamSessionSourcePort, new SqlSessionSource(client)),
      providePort(dreamCuratorPort, managedDreamCuratorFor(ctx)),
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
              workspaceId,
              memoryStores: port(managedAgentsPortTokens.memoryStores),
              memories: port(managedAgentsPortTokens.memories),
            }),
          )],
        }),
      }),
      dreamExecutionModule(),
      inProcessDreamExecutionSchedulerModule({
        defer: (task) => ctx.executionCtx.waitUntil(task),
      }),
    ],
  });
}

const managedDreamsRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const port = managedDreamsApplicationFor(ctx)
    .port(managedAgentsPortTokens.dreams);
  return invokePackage(c, buildManagedDreamRoutes(() => port));
});

const managedModelsRoutes = buildManagedModelRoutes((context) => {
  const request = context.var as AppCtx["var"];
  return createCloudflareManagedAgentsApp({
    workspaceId: request.tenant_id,
    sql: new CfD1SqlClient(request.tenantDb),
  }, {
    features: { preset: "none", models: true },
    modules: () => [providePort(
      modelCatalogSourcePort,
      new ModelCardCatalogSource(request.services.modelCards),
    )],
  }).port(managedAgentsPortTokens.models);
});

function managedTunnelsApplicationFor(ctx: AppCtx) {
  const provisioner = new LocalTunnelProvisioner({
      domainSuffix:
        (ctx.env as Env & { TUNNEL_DOMAIN_SUFFIX?: string })
          .TUNNEL_DOMAIN_SUFFIX ?? "tunnels.localhost",
      nextTokenId: () =>
        `ttok_${crypto.randomUUID().replaceAll("-", "")}`,
    });
  const tokens = new WebCryptoTunnelTokenManager({
      rootSecret: ctx.env.PLATFORM_ROOT_SECRET,
      nextTokenId: () =>
        `ttok_${crypto.randomUUID().replaceAll("-", "")}`,
    });
  const certificateAuthority = new WebCryptoTunnelCertificateAuthority();
  return createCloudflareManagedAgentsApp({
    workspaceId: ctx.var.tenant_id,
  }, {
    features: {
      preset: "none",
      tunnelCertificates: true,
      tunnels: true,
    },
    sql: new CfD1SqlClient(ctx.var.tenantDb),
    clock: { now: () => new Date() },
    ids: {
      next: (namespace) =>
        `${namespace === "tunnel" ? "tnl" : "tcrt"}_${crypto.randomUUID().replaceAll("-", "")}`,
    },
    modules: () => [
      providePort(tunnelProvisionerPort, provisioner),
      providePort(tunnelTokenManagerPort, tokens),
      providePort(tunnelCertificateAuthorityPort, certificateAuthority),
    ],
  });
}

const managedTunnelsRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const application = managedTunnelsApplicationFor(ctx);
  const tunnels = application.port(managedAgentsPortTokens.tunnels);
  const certificates = application.port(
    managedAgentsPortTokens.tunnelCertificates,
  );

  const packageApp = new Hono();
  packageApp.route("/", buildManagedTunnelRoutes(() => tunnels));
  packageApp.route(
    "/",
    buildManagedTunnelCertificateRoutes(() => certificates),
  );
  return invokePackage(c, packageApp);
});

/**
 * Forward the outer Hono request into a freshly-built package app while
 * preserving (a) auth/tenant vars set by middleware (passed via per-call
 * middleware injected on the inner app), and (b) the relative URL the
 * package routes expect (`/`, `/:id`, etc.) — Hono's `app.route` only
 * strips the prefix when matching, not from `req.url`.
 */
function invokePackage(
  c: import("hono").Context,
  packageApp: { fetch: (req: Request, env?: unknown, ctx?: ExecutionContext) => Response | Promise<Response> },
): Promise<Response> | Response {
  const url = new URL(c.req.url);
  // Strip the outer mount prefix so e.g. `/v1/agents/abc` becomes `/abc`
  // before the package's `app.get("/:id")` sees it.
  const knownPrefixes = ["/v1/oma/", "/v1/"];
  let stripped = url.pathname;
  for (const p of knownPrefixes) {
    if (stripped.startsWith(p)) {
      // Drop the next path segment (resource name like "agents", "sessions").
      const rest = stripped.slice(p.length);
      const slashIdx = rest.indexOf("/");
      stripped = slashIdx === -1 ? "/" : rest.slice(slashIdx);
      break;
    }
  }
  url.pathname = stripped || "/";

  // Carry the outer auth vars (tenant_id, user_id) over the request via
  // headers so the inner app's middleware can re-hydrate them. Header
  // names are namespaced so they can't collide with user-controlled
  // headers; a stray client-supplied `x-oma-tenant-id` is overwritten.
  const headers = new Headers(c.req.raw.headers);
  const tenantId = (c.var as { tenant_id?: string }).tenant_id;
  const userId = (c.var as { user_id?: string }).user_id;
  if (tenantId) headers.set("x-oma-internal-tenant-id", tenantId);
  if (userId) headers.set("x-oma-internal-user-id", userId);

  // One-shot middleware: re-hydrate vars on the inner context.
  const wrapped = new Hono();
  wrapped.use("*", async (innerC, next) => {
    const t = headers.get("x-oma-internal-tenant-id");
    const u = headers.get("x-oma-internal-user-id");
    if (t) innerC.set("tenant_id" as never, t as never);
    if (u) innerC.set("user_id" as never, u as never);
    await next();
  });
  wrapped.route("/", packageApp as Parameters<typeof wrapped.route>[1]);

  return wrapped.fetch(
    new Request(url, {
      method: c.req.method,
      headers,
      body: ["GET", "HEAD"].includes(c.req.method) ? null : c.req.raw.body,
    }),
    c.env,
    c.executionCtx,
  );
}
app.route("/v1/agents", managedAgentsRoutes);
app.route("/v1/oma/agents", legacyAgentsRoutes);
app.route("/v1/environments", managedEnvironmentsRoutes);
app.route("/v1/environments", managedEnvironmentWorkRoutes);
app.route("/v1/oma/environments", legacyEnvironmentsRoutes);
app.route("/v1/sessions", managedSessionsRoutes);
app.route("/v1/oma/sessions", legacySessionsRoutes);
app.route("/v1/vaults", managedVaultsRoutes);
app.route("/v1/vaults", managedCredentialsRoutes);
app.route("/v1/user_profiles", managedUserProfilesRoutes);
app.route("/v1/oma/vaults", legacyVaultsRoutes);
app.route("/v1/oma/cap-cli/oauth", capCliOauthRoutes);
app.route("/v1/memory_stores", managedMemoryStoresRoutes);
app.route("/v1/memory_stores", managedMemoriesRoutes);
app.route("/v1/memory_stores", managedMemoryVersionsRoutes);
app.route("/v1/oma/memory_stores", legacyMemoryRoutes);
app.route("/v1/skills", managedSkillsRoutes);
app.route("/v1/skills", managedSkillVersionsRoutes);
app.route("/v1/deployments", managedDeploymentsRoutes);
app.route("/v1/deployment_runs", managedDeploymentRunsRoutes);
app.route("/v1/dreams", managedDreamsRoutes);
app.route("/v1/oma/dreams", dreamsRoutes);
app.route("/v1/tunnels", managedTunnelsRoutes);
app.route("/v1/models", managedModelsRoutes);
app.route("/v1/files", managedFilesRoutes);
app.route("/v1/oma/files", legacyFilesRoutes);
app.route("/v1/oma/skills", legacySkillsRoutes);
app.route("/v1/oma/models", modelsRoutes);
app.route("/v1/oma/stats", statsRoutes);

// Billing-API proxy needs the session-resolved tenant_id, so it must
// run authMiddleware first. The proxy handler below short-circuits
// before tenantDb/services middlewares (it doesn't need them).
app.use("/billing-api/*", authMiddleware);
app.use("/billing-api/*", rateLimitMiddleware);

// Billing-API proxy — same-origin escape hatch for hosted plugins.
//
// Hosted Console (apps/console plugins/billing/) lives on app.openma.dev
// while the billing worker lives on billing.openma.dev. Direct browser
// → billing-worker calls would need CORS + a spoofable tenant header,
// since better-auth cookies don't cross subdomain boundaries by default
// and the billing worker has no auth middleware.
//
// Solution: proxy /billing-api/* through here. authMiddleware above has
// already resolved c.var.tenant_id from the session cookie; we forward
// to the USAGE_METER_HTTP service binding and inject x-oma-tenant-id
// server-side so the header is no longer client-controlled.
//
// In self-host (OSS-only) USAGE_METER_HTTP is unbound and this returns
// 404 — the hosted billing plugin isn't loaded there anyway, so no
// browser code reaches this route.
app.all("/billing-api/*", async (c) => {
  const meter = (c.env as { USAGE_METER_HTTP?: Fetcher }).USAGE_METER_HTTP;
  if (!meter) return c.json({ error: "billing not configured" }, 404);
  const tenantId = c.get("tenant_id" as never) as string | undefined;
  if (!tenantId) return c.json({ error: "unauthorized" }, 401);

  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace(/^\/billing-api/, "");

  const headers = new Headers(c.req.raw.headers);
  headers.set("x-oma-tenant-id", tenantId);
  headers.delete("cookie"); // billing worker doesn't need it; reduces leak surface

  const init: RequestInit = {
    method: c.req.method,
    headers,
    body: c.req.method === "GET" || c.req.method === "HEAD"
      ? null
      : await c.req.raw.clone().arrayBuffer(),
  };
  return meter.fetch(url.toString(), init);
});
// MCP proxy bypasses /v1/* authMiddleware (declared in auth.ts as a
// path-prefix skip) — auth is the Bearer oma_* the ACP child sends.
app.route("/v1/oma/mcp-proxy", mcpProxyRoutes);

// /v1/oma/* aliases — OMA-only namespaces re-mounted under an `oma/` prefix
// so the public surface can grow into a clean two-tier API:
//   /v1/<resource>      — Anthropic-compatible (agents, sessions, vaults, ...)
//   /v1/oma/<resource>  — OMA-specific extensions (oauth, tenants, evals, ...)
//
// New code (and external callers) should prefer the /v1/oma/* paths.
// Internal Console/CLI keep using the bare paths until follow-up cleanup
// (the bare mounts above stay live for now). New OMA-only endpoints should
// be added here only, not above.
app.route("/v1/oma/clawhub", clawhubRoutes);
app.route("/v1/oma/api_keys", apiKeysRoutes);
app.route("/v1/oma/me", meRoutes);
app.route("/v1/oma/tenants", tenantsRoutes);
app.route("/v1/oma/evals", evalsRoutes);
app.route("/v1/oma/cost_report", costReportRoutes);
app.route("/v1/oma/integrations", integrationsRoutes);
app.route("/v1/oma/runtimes", runtimesRoutes);
app.route("/v1/oma/oauth", oauthRoutes);
app.route("/v1/oma/model_cards", modelCardsRoutes);
// /v1/oma/mcp-proxy is intentionally NOT aliased: auth.ts path-prefix skip is
// scoped to that exact prefix, and the proxy does its own session-ownership
// check downstream. Re-mounting under /v1/oma/mcp-proxy would route through
// the standard authMiddleware and break the ACP child's transport.
// Daemon-facing routes — outside /v1/* so authMiddleware doesn't run.
// Apply tenantDbMiddleware + servicesMiddleware so daemon endpoints (like
// /agents/runtime/sessions/:sid/bundle) can use c.get("services").
app.use("/agents/runtime/*", tenantDbMiddleware);
app.use("/agents/runtime/*", servicesMiddleware);
app.route("/agents/runtime", runtimeDaemonRoutes);

// /agents/runtime/_attach — WebSocket upgrade for `oma bridge daemon`. We
// validate the runtime bearer token here, then forward to the RuntimeRoom
// DO with x-runtime-id / x-runtime-user headers it trusts.
app.get("/agents/runtime/_attach", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.text("WebSocket only", 400);
  }
  if (!c.env.RUNTIME_ROOM) return c.text("RUNTIME_ROOM binding missing", 503);
  const auth = c.req.header("authorization") ?? "";
  const ok = await authenticateRuntimeToken(c.env, auth);
  if (!ok) return c.text("unauthorized", 401);
  const stub = c.env.RUNTIME_ROOM.get(c.env.RUNTIME_ROOM.idFromName(ok.runtime_id));
  const fwd = new Request(c.req.raw);
  fwd.headers.set("x-attach-role", "daemon");
  fwd.headers.set("x-runtime-id", ok.runtime_id);
  fwd.headers.set("x-runtime-user", ok.user_id);
  return stub.fetch(fwd);
});

// Internal endpoints (NOT auth-middleware'd; secured by header secret inside
// the route file). Called only by the integrations gateway worker via service
// binding.
app.route("/v1/oma/internal", internalRoutes);

// Proxy public integrations gateway paths to the INTEGRATIONS service binding
// so Linear/GitHub can hit the OAuth callback / webhook URLs at this worker's
// host. (Local dev convenience: avoids running integrations on a separate port.)
app.all("/linear/*", async (c) => {
  if (!c.env.INTEGRATIONS) return c.json({ error: "INTEGRATIONS binding missing" }, 503);
  return c.env.INTEGRATIONS.fetch(c.req.raw);
});
app.all("/linear-setup/*", async (c) => {
  if (!c.env.INTEGRATIONS) return c.json({ error: "INTEGRATIONS binding missing" }, 503);
  return c.env.INTEGRATIONS.fetch(c.req.raw);
});
app.all("/github/*", async (c) => {
  if (!c.env.INTEGRATIONS) return c.json({ error: "INTEGRATIONS binding missing" }, 503);
  return c.env.INTEGRATIONS.fetch(c.req.raw);
});
app.all("/github-setup/*", async (c) => {
  if (!c.env.INTEGRATIONS) return c.json({ error: "INTEGRATIONS binding missing" }, 503);
  return c.env.INTEGRATIONS.fetch(c.req.raw);
});

export default {
  fetch: app.fetch,
  // Cron entry — wrangler `triggers.crons` ticks every minute (`* * * * *`).
  // We rebuild the scheduler per tick (CF isolates are short-lived; the
  // builder is cheap), then dispatch by matching `controller.cron`.
  // Each registered handler runs under ctx.waitUntil so a slow tick
  // doesn't block the runtime.
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const scheduler = buildCfScheduler(env);
    for (const job of scheduler.list()) {
      if (job.cron !== controller.cron) continue;
      ctx.waitUntil(
        Promise.resolve(job.handler()).catch((err) => {
          logError({ op: `cron.${job.name}`, err }, `cron job ${job.name} failed`);
          recordEvent(env.ANALYTICS, {
            op: `cron.${job.name}.failed`,
            ...errFields(err),
          });
        }),
      );
    }
  },
  // Cloudflare Queue consumer for R2 Event Notifications on MEMORY_BUCKET.
  // The runtime-agnostic dispatcher routes to the main consumer or the
  // DLQ subscriber based on `batch.queue`. Handler bodies live in
  // packages/queue/handlers/* (main) and lib/cf-queue-handlers.ts (DLQ
  // notification + AE recording, which is CF-specific plumbing).
  async queue(batch: MessageBatch<R2EventMessage>, env: Env, _ctx: ExecutionContext): Promise<void> {
    const q = buildCfMemoryQueue(env);
    await dispatchCfMemoryQueueBatch(batch, q);
  },
};

// DO classes must be re-exported from the worker entry so wrangler can find
// them by class_name in durable_objects.bindings + migrations.
export { RuntimeRoom } from "./runtime-room";

/**
 * RPC entrypoint for the agent worker (cloud agent path) to forward MCP
 * requests through main's credential-injection layer without exposing the
 * vault to the agent's DO.
 *
 * Mirrors Anthropic Managed Agents' "credential proxy outside the harness"
 * design: the agent worker (the harness) only knows session_id +
 * server_name; the actual vault lookup, token injection, and upstream call
 * happen here in main, where the secrets already live. This means a
 * cloud-side prompt-injection attack against the agent's DO cannot read
 * any vault credential because the DO doesn't hold one.
 *
 * Auth model: this class is reachable only via wrangler service-binding
 * declarations — Workers without an explicit `services[].entrypoint` block
 * pointing at "McpProxyRpc" cannot invoke `mcpForward`. The binding itself
 * is the authentication primitive; no shared secret needed. The agent
 * worker passes `tenantId` because it has it from the SessionDO context;
 * we trust it the same way we'd trust any in-process function call from
 * sibling code, since the binding scope establishes that the caller is
 * our own deployment.
 *
 * Local-runtime path (claude-agent-acp daemon) keeps using the public
 * /v1/oma/mcp-proxy/<sid>/<server> HTTP endpoint with apiKey auth — the
 * daemon doesn't have a service binding, so it has to authenticate the
 * old way. Both paths converge on the same `resolveProxyTargetByTenant` +
 * `forwardToUpstream` helpers in routes/mcp-proxy.ts.
 */
export class McpProxyRpc extends WorkerEntrypoint<Env> {
  async managedSessionEventProduced(opts: {
    workspaceId: string;
    sessionId: string;
    event: string;
    executionFence?: import("@open-managed-agents/session-runtime-contract/coordination").SessionExecutionFence;
  }): Promise<
    | { type: "recorded" }
    | { type: "ignored" }
    | { type: "not_found" }
    | { type: "version_conflict" }
  > {
    let raw: unknown;
    try {
      raw = JSON.parse(opts.event);
    } catch {
      return { type: "ignored" };
    }
    const event = decodeRuntimeProducedSessionEvent(raw);
    if (event === null) return { type: "ignored" };
    const tenantDb = await buildCfTenantDbProvider(this.env).resolve(
      opts.workspaceId,
    );
    const persistence = new SqlSessionRuntimeProjectionPersistence(
      new CfD1SqlClient(tenantDb),
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await new SessionRuntimeProjectionApplicationService({
        workspaceId: opts.workspaceId,
        persistence,
      }).recordSessionRuntimeEvents({
        sessionId: opts.sessionId,
        events: [event],
        ...(opts.executionFence !== undefined && {
          executionFence: opts.executionFence,
        }),
      });
      if (result.type === "recorded") return { type: "recorded" };
      if (result.type === "not_found") return { type: "not_found" };
      if (result.type === "execution_fence_lost") return { type: "version_conflict" };
    }
    return { type: "version_conflict" };
  }

  async mcpForward(opts: {
    tenantId: string;
    sessionId: string;
    serverName: string;
    method: string;
    /** Inbound headers from the MCP client. The Authorization header here is
     *  the agent worker's own token (or empty); we always overwrite it with
     *  the upstream credential before forwarding. */
    headers: Record<string, string>;
    /** Stringified JSON-RPC body for POST. Empty / null for GET. */
    body: string | null;
  }): Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }> {
    const services = await getCfServicesForTenant(this.env, opts.tenantId);
    const target = await resolveProxyTargetByTenant(
      this.env,
      services,
      opts.tenantId,
      opts.sessionId,
      opts.serverName,
    );
    if (!target) {
      return {
        status: 403,
        headers: { "content-type": "application/json" },
        body: '{"error":"forbidden"}',
      };
    }
    const inboundHeaders = new Headers(opts.headers);
    const res = await forwardWithRefresh(
      services,
      opts.tenantId,
      target,
      opts.method,
      inboundHeaders,
      opts.body,
      { sessionId: opts.sessionId, serverName: opts.serverName, callerKind: "rpc-mcp" },
    );
    const respHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      respHeaders[k] = v;
    });
    return {
      status: res.status,
      headers: respHeaders,
      body: await res.text(),
    };
  }

  /**
   * Transparent HTTP proxy for cloud agent MCP traffic. Agent's tools.ts
   * gives the official MCP HTTP adapter a custom fetch that calls
   * `env.MAIN_MCP.fetch(req)` after stamping three metadata headers:
   *   - `x-oma-tenant`
   *   - `x-oma-session`
   *   - `x-oma-mcp-server`
   * We resolve the vault credential by `serverName` (mirrors the legacy
   * `mcpForward` path so inline `authorization_token` still works),
   * strip the metadata, replace the `authorization` header with the
   * upstream bearer, and forward to the URL the agent's transport
   * already knew (request URL is the upstream URL). Body / response
   * status / response headers (including rotated `Mcp-Session-Id`)
   * stream through unchanged.
   *
   * Vault credentials remain main-only — agent worker only sees the
   * Response. The official SDK transport handles Streamable-HTTP session
   * id rotation, SSE response framing, retries — none of that lives
   * in this Worker anymore. The hand-rolled BindingMCPTransport that
   * preceded this dropped session ids and broke session-ful servers
   * (Notion's tools/list never returned, hanging the whole turn).
   *
   * 401-refresh-and-retry: handled by `forwardWithRefresh` (shared with
   * the legacy mcpForward + HTTP /v1/oma/mcp-proxy paths). When the first
   * upstream response is 401 AND the resolved credential carries
   * `mcp_oauth` refresh metadata (refresh_token + token_endpoint), we
   * hit the token_endpoint, persist the rotated tokens back to D1, and
   * retry the upstream call once with the fresh bearer. Request body
   * is buffered up-front so the retry can replay it.
   */
  async fetch(request: Request): Promise<Response> {
    const tenantId = request.headers.get("x-oma-tenant");
    const sessionId = request.headers.get("x-oma-session");
    const serverName = request.headers.get("x-oma-mcp-server");
    if (!tenantId || !sessionId || !serverName) {
      return new Response(
        '{"error":"missing x-oma-tenant / x-oma-session / x-oma-mcp-server header"}',
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    const services = await getCfServicesForTenant(this.env, tenantId);
    const target = await resolveProxyTargetByTenant(
      this.env,
      services,
      tenantId,
      sessionId,
      serverName,
    );
    if (!target) {
      return new Response('{"error":"forbidden"}', {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }
    // Strip routing metadata before forwarding upstream. Everything else
    // (Mcp-Session-Id, content-type, accept, …) flows through.
    // forwardWithRefresh injects/replaces Authorization itself.
    const inboundHeaders = new Headers(request.headers);
    inboundHeaders.delete("x-oma-tenant");
    inboundHeaders.delete("x-oma-session");
    inboundHeaders.delete("x-oma-mcp-server");
    // Buffer body so forwardWithRefresh can replay on a 401-then-refresh
    // retry. MCP request bodies are JSON-RPC envelopes — sub-KB in
    // practice — so the buffering cost is negligible. Response body is
    // unaffected and still streams back.
    const body = ["GET", "HEAD"].includes(request.method)
      ? null
      : await request.arrayBuffer();
    return forwardWithRefresh(
      services,
      tenantId,
      target,
      request.method,
      inboundHeaders,
      body,
      { sessionId, serverName, callerKind: "rpc-mcp" },
    );
  }

  /**
   * Lightweight credential lookup for the transparent outbound proxy.
   * Returns just the auth token + type for the host, or null if no
   * credential matches. The agent worker injects the Authorization header
   * itself and forwards the request transparently — body and response
   * never cross the RPC boundary, preserving HEAD Content-Length, SigV4
   * signed headers, chunked encoding, streaming, etc.
   *
   * Replaces the body-buffered `outboundForward` for the common-case
   * Bearer-injection path. `outboundForward` remains for callers that
   * need 401-refresh-and-retry (mcp_oauth with refresh_token), since
   * that requires keeping the refresh token in main worker.
   *
   * Security model change: agent worker briefly holds the bearer token
   * in memory during a single request handler invocation. Container
   * still never sees plaintext (auth header is added on agent worker
   * side, the SDK's TLS-MITM re-encrypts back to container). Trade-off
   * vs the body-buffered path: agent worker compromise can leak tokens
   * observed during the brief window; in exchange, we get a working
   * transparent proxy.
   */
  async lookupOutboundCredential(opts: {
    tenantId: string;
    sessionId: string;
    hostname: string;
  }): Promise<{ type: "bearer"; token: string } | null> {
    const services = await getCfServicesForTenant(this.env, opts.tenantId);
    const cred = await resolveOutboundCredentialByHost(
      this.env,
      services,
      opts.tenantId,
      opts.sessionId,
      opts.hostname,
    );
    if (!cred) return null;
    return { type: "bearer", token: cred.upstreamToken };
  }

  /**
   * Per-repo GitHub credential lookup for the network-layer proxy.
   *
   * Returns:
   *   - null  → no credential available (caller passes through unauth'd):
   *             host isn't a GitHub host we route, OR session is gone /
   *             archived, OR session has no github_repository resources
   *   - {...} → the chosen token + scheme + owner/repo slug. Slug is for
   *             log correlation; the token never lands in any log.
   *
   * Pick rule: path-matched resource if the request URL has owner/repo
   * AND it matches a resource; otherwise the first declared resource's
   * token. See `resolveGithubCredentials` for the trade-off rationale.
   */
  async lookupGithubCredential(opts: {
    tenantId: string;
    sessionId: string;
    hostname: string;
    pathname: string;
  }): Promise<{ scheme: "Basic" | "Bearer"; token: string; slug: string } | null> {
    const services = await getCfServicesForTenant(this.env, opts.tenantId);
    return resolveGithubCredentials(
      services,
      opts.tenantId,
      opts.sessionId,
      opts.hostname,
      opts.pathname,
    );
  }


  /**
   * Outbound counterpart to `mcpForward` for sandbox-side HTTPS calls
   * (anything the cloud agent's container does via fetch / curl). The
   * agent worker's outbound interceptor (apps/agent/src/oma-sandbox.ts)
   * passes only `(tenantId, sessionId, hostname, request bytes)`; we
   * resolve the matching vault credential live, inject Authorization,
   * and fetch upstream. The agent's container never sees the credential
   * and the agent worker never even loads it into memory.
   *
   * Body is passed as a string for now (sandbox HTTPS calls in OMA are
   * typically JSON-shaped; binary uploads to upstream APIs are rare and
   * can be added by widening to ArrayBuffer when a real use case lands).
   * Pass-through when no credential matches: same behavior as the legacy
   * snapshot-based path — public APIs and pre-authenticated URLs work.
   */
  async outboundForward(opts: {
    tenantId: string;
    sessionId: string;
    /** Full upstream URL the sandbox is trying to reach. */
    url: string;
    method: string;
    headers: Record<string, string>;
    /**
     * Request body as raw bytes. ArrayBuffer over the RPC wire — preserves
     * binary content (wheels, tarballs, image layers) that string body
     * silently mangled via UTF-8 decode. CF Worker RPC supports
     * ArrayBuffer via structured-clone-like serialization. Per-call size
     * is capped (~32 MB) — multi-GB streaming uploads still need a
     * dedicated path.
     */
    body: ArrayBuffer | null;
  }): Promise<{
    status: number;
    headers: Record<string, string>;
    body: ArrayBuffer;
  }> {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(opts.url);
    } catch {
      return {
        status: 400,
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode('{"error":"invalid url"}').buffer as ArrayBuffer,
      };
    }

    const services = await getCfServicesForTenant(this.env, opts.tenantId);
    const cred = await resolveOutboundCredentialByHost(
      this.env,
      services,
      opts.tenantId,
      opts.sessionId,
      parsedUrl.hostname,
    );

    const inboundHeaders = new Headers(opts.headers);

    if (!cred) {
      // No matching credential — pass through without injection. Public
      // APIs and pre-authenticated URLs work this way; matches old
      // behavior of the snapshot interceptor (host miss → no header).
      // We still strip the CF-edge headers for cleanliness.
      inboundHeaders.delete("host");
      inboundHeaders.delete("cf-connecting-ip");
      inboundHeaders.delete("cf-ray");
      inboundHeaders.delete("x-forwarded-for");
      inboundHeaders.delete("x-forwarded-proto");
      inboundHeaders.delete("x-real-ip");
      const upstreamReq = new Request(opts.url, {
        method: opts.method,
        headers: inboundHeaders,
        body: ["GET", "HEAD"].includes(opts.method) ? undefined : opts.body,
      });
      const res = await fetch(upstreamReq);
      const respHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        respHeaders[k] = v;
      });
      return {
        status: res.status,
        headers: respHeaders,
        body: await res.arrayBuffer(),
      };
    }

    // Override target.upstreamUrl with the actual URL the sandbox wants
    // to hit (resolveOutboundCredentialByHost only knows the credential's
    // mcp_server_url, but for outbound the caller might be hitting any
    // path on that host). forwardWithRefresh injects token + auto-refreshes
    // on 401 if the credential is mcp_oauth.
    const target = { ...cred, upstreamUrl: opts.url };
    const res = await forwardWithRefresh(
      services,
      opts.tenantId,
      target,
      opts.method,
      inboundHeaders,
      opts.body,
      { sessionId: opts.sessionId, callerKind: "rpc-outbound" },
    );
    const respHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      respHeaders[k] = v;
    });
    return {
      status: res.status,
      headers: respHeaders,
      body: await res.arrayBuffer(),
    };
  }
}
