// Service container — one canonical surface for all platform-agnostic
// services in OMA.
//
// Why this exists:
//   - Wiring decision (D1 vs Postgres vs SQLite vs in-memory) lives in ONE
//     place — the buildXxxServices factories below. Routes / DOs / cron all
//     depend on the `Services` interface; swapping deployment = swap factory.
//   - HTTP routes pick services off `c.var.services` (Hono request scope).
//   - DO / outbound worker / cron / anything outside Hono builds its own
//     instance via the same factory. Same `Services` type, no duplication.
//   - Tests use a TenantDbProvider fake plus the same factory.
//
// Adding a new store:
//   1. Add `<storeName>: <ServiceType>` to the `Services` interface
//   2. Add construction call to each `buildXxxServices` (CF + future Node + tests)
//   3. Consumers reference `c.var.services.<storeName>` (HTTP) or
//      `services.<storeName>` (everywhere else). No import changes anywhere.
//
// Per-tenant DB routing (Phase 1+):
//   - `buildCfServices(env, db)` takes a resolved D1Database — every adapter
//     constructed inside reads/writes against that one DB.
//   - The DB is resolved per-request by the new `tenantDbMiddleware`, which
//     calls `TenantDbProvider.resolve(tenantId)` after authMiddleware sets
//     `c.var.tenant_id`. Phase 1 default returns the shared `env.AUTH_DB`
//     for every tenant — zero behaviour change. Phase 4 swaps in the
//     static-binding resolver.
//
// The CFless escape hatch:
//   - Today only `buildCfServices` exists.
//   - When self-hosting on Node + Postgres becomes a real target, add a
//     `buildNodeServices(opts: { pg, ... })` that returns the same `Services`
//     shape from Postgres adapters. Entry file picks one based on env.
//   - Routes and business code don't change at all.

import type { MiddlewareHandler } from "hono";
import type { Env } from "@open-managed-agents/shared";
import {
  CredentialService,
  createCfCredentialService,
} from "@open-managed-agents/credentials-store";
import {
  MemoryStoreService,
  createCfMemoryStoreService,
} from "@open-managed-agents/memory-store";
import {
  VaultService,
  createCfVaultService,
} from "@open-managed-agents/vaults-store";
import {
  SessionService,
  createCfSessionService,
} from "@open-managed-agents/sessions-store";
import {
  FileService,
  createCfFileService,
} from "@open-managed-agents/files-store";
import {
  EvalRunService,
  createCfEvalRunService,
} from "@open-managed-agents/evals-store";
import {
  ModelCardService,
  createCfModelCardService,
} from "@open-managed-agents/model-cards-store";
import {
  AgentService,
  createCfAgentService,
} from "@open-managed-agents/agents-store";
import {
  EnvironmentService,
  createCfEnvironmentService,
} from "@open-managed-agents/environments-store";
import {
  OutboundSnapshotService,
  createCfOutboundSnapshotService,
} from "@open-managed-agents/outbound-snapshots-store";
import {
  SessionSecretService,
  createCfSessionSecretService,
} from "@open-managed-agents/session-secrets-store";
import {
  CfSharedAuthDbProvider,
  MetaTableTenantDbProvider,
  type TenantDbProvider,
} from "@open-managed-agents/tenant-db";
import {
  TenantShardDirectoryService,
  ShardPoolService,
  createCfTenantShardDirectoryService,
  createCfShardPoolService,
} from "@open-managed-agents/tenant-dbs-store";
import { parseStoreBackends, pickBackend } from "./store-backends";

export { parseStoreBackends, pickBackend } from "./store-backends";
export type { StoreBackendName, BackendFactories } from "./store-backends";
export { getPgPool } from "./pg-pool";

/**
 * The platform-agnostic service surface. Every service the application uses
 * (storage, integrations, etc.) shows up here as an abstract interface from
 * its store package — never a Cloudflare-specific class.
 */
export interface Services {
  credentials: CredentialService;
  memory: MemoryStoreService;
  vaults: VaultService;
  sessions: SessionService;
  files: FileService;
  evals: EvalRunService;
  modelCards: ModelCardService;
  agents: AgentService;
  environments: EnvironmentService;
  outboundSnapshots: OutboundSnapshotService;
  sessionSecrets: SessionSecretService;
  /** Control-plane: tenant_id → binding_name assignment. Hot-path read on
   *  every authenticated request via MetaTableTenantDbProvider. Always
   *  queries control-plane DB. */
  tenantShardDirectory: TenantShardDirectoryService;
  /** Control-plane: per-shard status / capacity / tenant count. Used for
   *  shard selection at sign-up + capacity monitoring. */
  shardPool: ShardPoolService;
}

/**
 * Default Hono context shape used by every OMA HTTP route. Combine in route
 * files like:
 *
 *   const app = new Hono<AppContext & { Variables: { tenant_id: string } }>();
 *
 * Or use `AppContextWithTenant` below for the common case.
 */
export interface AppContext {
  Bindings: Env;
  Variables: {
    services: Services;
    /** Resolved per-tenant DB. Set by `tenantDbMiddleware` before routes run. */
    tenantDb: D1Database;
  };
}

/**
 * Most authenticated routes need both the services container and the
 * `tenant_id` set by the auth middleware. Re-exported as the canonical
 * "authenticated route" Hono context.
 */
export interface AppContextWithTenant {
  Bindings: Env;
  Variables: {
    services: Services;
    tenantDb: D1Database;
    tenant_id: string;
    user_id?: string;
  };
}

// ============================================================
// Wiring factories — pick one based on deployment target
// ============================================================

/**
 * Production / staging on Cloudflare Workers. Wires every service against
 * the resolved per-tenant D1 database. The TenantDbProvider middleware
 * resolves the right DB for the current request before this factory runs.
 *
 * Per-store backend dispatch: each D1-backed store goes through `pickBackend`
 * so its concrete adapter can be swapped to pg / memory / future backends
 * via the `STORE_BACKENDS` env JSON without touching service or route code.
 * Tenant routing is the storage provider's concern, NOT the service layer —
 * the cf factory uses the per-tenant D1 binding, a pg factory could use
 * row-level tenant_id filters or schema-per-tenant, etc.
 *
 * KV-backed services (outbound snapshots, session secrets) and control-plane
 * services (tenant directory, installation index) are not dispatched today
 * because they have a single sensible backend.
 *
 * To wire a new backend (e.g. pg) for a store:
 *   1. Implement Pg<X>Repo + createPg<X>Service in packages/<store>-store
 *   2. Uncomment / add the `pg: () => createPg<X>Service(...)` line in the
 *      relevant pickBackend call below
 *   3. Set STORE_BACKENDS={"<key>":"pg"} in the worker's env
 */
export function buildServices(env: Env, db: D1Database): Services {
  const overrides = parseStoreBackends(env);
  return {
    credentials: pickBackend(overrides, "credentials", {
      cf: () => createCfCredentialService({ db }),
      // pg: () => createPgCredentialService({ pg: getPgPool(env) }),
    }),
    memory: pickBackend(overrides, "memory", {
      cf: () => createCfMemoryStoreService({ db, ai: env.AI, vectorize: env.VECTORIZE }),
      // pg: () => createPgMemoryStoreService({ pg: getPgPool(env), ai: env.AI, vectorize: env.VECTORIZE }),
    }),
    vaults: pickBackend(overrides, "vaults", {
      cf: () => createCfVaultService({ db }),
      // pg: () => createPgVaultService({ pg: getPgPool(env) }),
    }),
    sessions: pickBackend(overrides, "sessions", {
      cf: () => createCfSessionService({ db }),
      // pg: () => createPgSessionService({ pg: getPgPool(env) }),
    }),
    files: pickBackend(overrides, "files", {
      cf: () => createCfFileService({ db }),
      // pg: () => createPgFileService({ pg: getPgPool(env) }),
    }),
    evals: pickBackend(overrides, "evals", {
      cf: () => createCfEvalRunService({ db }),
      // pg: () => createPgEvalRunService({ pg: getPgPool(env) }),
    }),
    modelCards: pickBackend(overrides, "modelCards", {
      cf: () => createCfModelCardService({ db }),
      // pg: () => createPgModelCardService({ pg: getPgPool(env) }),
    }),
    agents: pickBackend(overrides, "agents", {
      cf: () => createCfAgentService({ db }),
      // pg: () => createPgAgentService({ pg: getPgPool(env) }),
    }),
    environments: pickBackend(overrides, "environments", {
      cf: () => createCfEnvironmentService({ db }),
      // pg: () => createPgEnvironmentService({ pg: getPgPool(env) }),
    }),
    outboundSnapshots: createCfOutboundSnapshotService(env),
    sessionSecrets: createCfSessionSecretService(env),
    // Control-plane services: always query env.AUTH_DB, never the per-tenant db.
    tenantShardDirectory: createCfTenantShardDirectoryService({ controlPlaneDb: env.AUTH_DB }),
    shardPool: createCfShardPoolService({ controlPlaneDb: env.AUTH_DB }),
  };
}

/**
 * Backwards-compat alias — old call sites still use `buildCfServices`. New
 * code should prefer `buildServices` since the function is no longer
 * Cloudflare-specific (a `pg` adapter, when wired, gets selected by env).
 */
export const buildCfServices = buildServices;

/**
 * Build the TenantDbProvider used by the middleware.
 *
 * Default (PER_TENANT_DB_ENABLED unset or "true"): the meta-table router
 * that reads `tenant_shard` from the control-plane DB, with a permanent
 * per-isolate cache and AUTH_DB fallback for tenants without a shard
 * assignment. In N=1 deployments (no entries in tenant_shard) every tenant
 * resolves to AUTH_DB → behaviour identical to the pre-sharding shared-DB
 * world.
 *
 * Killswitch (PER_TENANT_DB_ENABLED="false"): bypasses the meta lookup
 * entirely and returns AUTH_DB for every tenant. Use this to instantly roll
 * back if the meta table itself develops a problem.
 *
 * Tests should construct their own StaticTenantDbProvider via
 * @open-managed-agents/tenant-db/test-fakes and bypass this factory.
 */
export function buildCfTenantDbProvider(env: Env): TenantDbProvider {
  const flag = (env as unknown as { PER_TENANT_DB_ENABLED?: string }).PER_TENANT_DB_ENABLED;
  const disabled = flag === "false" || flag === "0";
  if (disabled) {
    return new CfSharedAuthDbProvider(env.AUTH_DB);
  }
  return new MetaTableTenantDbProvider(
    env as unknown as Record<string, unknown>,
    env.AUTH_DB,
    env.AUTH_DB,
  );
}

/**
 * Async helper for non-Hono entry points (Durable Objects, cron, eval-runner,
 * outbound worker). Resolves the per-tenant DB then builds the full Services
 * container against it.
 *
 * Hono routes use `tenantDbMiddleware` + `servicesMiddleware` instead, so
 * they don't need to call this directly.
 */
export async function getCfServicesForTenant(
  env: Env,
  tenantId: string,
): Promise<Services> {
  const provider = buildCfTenantDbProvider(env);
  const db = await provider.resolve(tenantId);
  return buildCfServices(env, db);
}

// Future:
//
// export function buildNodeServices(opts: { pg: pg.Pool; ... }): Services {
//   return {
//     credentials: createPgCredentialService(opts.pg),
//     memory: createPgMemoryStoreService(opts.pg),
//   };
// }
//
// export function buildSqliteServices(opts: { db: better-sqlite3.Database }): Services {
//   return { ... };
// }

// ============================================================
// Hono middleware — drop into apps/main entry
// ============================================================

/**
 * Resolve the per-tenant D1 binding for the current request and stash it on
 * `c.var.tenantDb`. Mount AFTER the auth middleware (which sets
 * `c.var.tenant_id`) and BEFORE `servicesMiddleware`.
 *
 *   app.use("*", authMiddleware);
 *   app.use("*", tenantDbMiddleware);
 *   app.use("*", servicesMiddleware);
 *
 * Routes that don't need the services container (e.g. /health, /auth/*)
 * still get the resolved DB on `c.var.tenantDb` — cheap, async-light.
 */
export const tenantDbMiddleware: MiddlewareHandler<{
  Bindings: Env;
  Variables: { tenant_id?: string; tenantDb: D1Database };
}> = async (c, next) => {
  const provider = buildCfTenantDbProvider(c.env);
  // Routes upstream of authMiddleware (e.g. /health, /auth/*) won't have
  // tenant_id set; resolve("" ) returns the shared AUTH_DB under the Phase 1
  // default, which is the right answer for those paths.
  const tenantId = c.get("tenant_id") ?? "";
  const tenantDb = await provider.resolve(tenantId);
  c.set("tenantDb", tenantDb);
  await next();
};

/**
 * Mount once at the top of the app. After this middleware runs every route
 * can read `c.var.services` to access the canonical service surface.
 *
 *   app.use("*", servicesMiddleware);
 *
 * Requires `c.var.tenantDb` to be set by `tenantDbMiddleware` first.
 */
export const servicesMiddleware: MiddlewareHandler<AppContext> = async (
  c,
  next,
) => {
  c.set("services", buildCfServices(c.env, c.var.tenantDb));
  await next();
};
