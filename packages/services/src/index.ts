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
//   - Tests use `buildTestServices()` and inject mocks where needed.
//
// Adding a new store:
//   1. Add `<storeName>: <ServiceType>` to the `Services` interface
//   2. Add construction call to each `buildXxxServices` (CF + future Node + tests)
//   3. Consumers reference `c.var.services.<storeName>` (HTTP) or
//      `services.<storeName>` (everywhere else). No import changes anywhere.
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

/**
 * The platform-agnostic service surface. Every service the application uses
 * (storage, integrations, etc.) shows up here as an abstract interface from
 * its store package — never a Cloudflare-specific class.
 */
export interface Services {
  credentials: CredentialService;
  memory: MemoryStoreService;
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
    tenant_id: string;
    user_id?: string;
  };
}

// ============================================================
// Wiring factories — pick one based on deployment target
// ============================================================

/**
 * Production / staging on Cloudflare Workers. Wires every service against
 * Cloudflare bindings (D1 today, possibly other CF primitives later).
 */
export function buildCfServices(env: Env): Services {
  return {
    credentials: createCfCredentialService(env),
    memory: createCfMemoryStoreService(env),
  };
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
 * Mount once at the top of the app. After this middleware runs every route
 * can read `c.var.services` to access the canonical service surface.
 *
 *   app.use("*", servicesMiddleware);
 */
export const servicesMiddleware: MiddlewareHandler<AppContext> = async (
  c,
  next,
) => {
  c.set("services", buildCfServices(c.env));
  await next();
};
