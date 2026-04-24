// Per-store backend selection mechanism.
//
// Each store in the Services container is backed by an adapter that lives in
// its own package (e.g. packages/agents-store/src/adapters/d1-agent-repo.ts
// for the D1 implementation). The service itself only depends on the
// abstract repo port — swapping backends means swapping the adapter, not
// touching service or route code.
//
// This module is the dispatch layer: given a store key (e.g. "agents") and
// a bag of backend factories (cf, pg, ...), pick the one named in env.
//
// Configuration: STORE_BACKENDS env var, JSON object mapping store key →
// backend name. Missing entries default to "cf".
//
//   STORE_BACKENDS={"agents":"pg","sessions":"cf"}
//
// Adding a new pg adapter:
//   1. Implement Pg<X>Repo in packages/<store>-store/src/adapters/pg-<x>-repo.ts
//   2. Export createPg<X>Service from that store's adapters/index.ts
//   3. In services/index.ts, register the pg factory in the pickBackend call
//   4. Set STORE_BACKENDS in env / wrangler vars to route traffic
//
// Tenant routing is the storage provider's concern, NOT the service layer.
// A pg adapter might use row-level tenant_id filtering; the per-tenant-D1
// adapter uses binding-per-tenant resolution; a hypothetical Postgres
// schema-per-tenant adapter would do schema search_path tricks. The Services
// surface is uniform regardless.

import type { Env } from "@open-managed-agents/shared";

export type StoreBackendName = "cf" | "pg" | "memory";

/**
 * Read the STORE_BACKENDS env override. Tolerates missing or malformed
 * values — both fall back to "every store uses cf default".
 */
export function parseStoreBackends(env: Env): Record<string, StoreBackendName> {
  const raw = (env as unknown as { STORE_BACKENDS?: string }).STORE_BACKENDS;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, StoreBackendName>;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    console.warn("[store-backends] STORE_BACKENDS is not valid JSON, ignoring");
    return {};
  }
}

/**
 * Backend factory bag. Each backend is a no-arg builder closure that knows
 * how to construct the service for that backend (caller provides the
 * captured deps — db handle, pg pool, etc.).
 */
export type BackendFactories<S> = {
  cf: () => S;
  pg?: () => S;
  memory?: () => S;
};

/**
 * Pick the backend factory named in env (or "cf" default) and run it. Throws
 * a clear error if the named backend has no factory registered — that's the
 * signal to wire up the new adapter in services/index.ts.
 */
export function pickBackend<S>(
  overrides: Record<string, StoreBackendName>,
  key: string,
  factories: BackendFactories<S>,
): S {
  const backend: StoreBackendName = overrides[key] ?? "cf";
  const factory = factories[backend];
  if (!factory) {
    throw new Error(
      `STORE_BACKENDS["${key}"]="${backend}" — but no ${backend} adapter is wired in services/index.ts for "${key}". ` +
        `Implement the adapter, register the factory in pickBackend(), then redeploy.`,
    );
  }
  return factory();
}
