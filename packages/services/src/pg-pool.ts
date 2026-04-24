// Lazy Postgres pool helper. Initializes once per worker isolate (or Node
// process) when the first pg-backed store is requested, then reuses the
// connection pool for all subsequent calls.
//
// Today this is a Cloudflare-Workers-friendly stub — it constructs the pool
// from the DATABASE_URL env var if the `postgres` driver is importable.
// Concrete pg adapter packages (when added) call getPgPool(env) to receive
// the pool and pass it into their PgXxxRepo constructors.
//
// Design notes:
//   - Module-level cache. Invalidated by setting the env DATABASE_URL value
//     differently between invocations would NOT clear it — restart the
//     worker (redeploy) if you need to switch DSN.
//   - Errors surface from the actual driver call when first used. We don't
//     dial-test the connection on initialization; that's the pool's job.
//   - On Cloudflare Workers, set up Hyperdrive and point DATABASE_URL at the
//     hyperdrive connection string for production. Direct-to-Postgres works
//     in local dev / Node deployments.
//
// The driver dependency is intentionally NOT pinned in this package's
// package.json — the package compiles and runs without pg installed. Only
// when a pg adapter is wired and an env actually requests pg does the
// import resolve. To enable in your deployment: `pnpm add postgres -w`.

import type { Env } from "@open-managed-agents/shared";

// `unknown` so this module compiles without `postgres` installed. The cast
// happens at the call site that actually uses the pool.
let cached: unknown | null = null;
let cachedDsn: string | null = null;

/**
 * Resolve a pg pool / sql client from env. Lazy: only imports the driver
 * the first time a pg-backed store is actually constructed.
 *
 * Returns `unknown` deliberately — the concrete adapter package knows what
 * driver shape it expects (postgres.js vs node-postgres) and casts.
 */
export async function getPgPool(env: Env): Promise<unknown> {
  const dsn = (env as unknown as { DATABASE_URL?: string }).DATABASE_URL;
  if (!dsn) {
    throw new Error(
      "getPgPool: DATABASE_URL is required when STORE_BACKENDS routes any store to pg",
    );
  }
  if (cached && cachedDsn === dsn) return cached;
  // Dynamic import so the package doesn't hard-depend on `postgres` at
  // build time. If you've routed traffic to pg without installing the
  // driver this will throw a clear MODULE_NOT_FOUND at runtime.
  const mod = (await import(/* @vite-ignore */ "postgres" as string).catch(
    (err) => {
      throw new Error(
        `getPgPool: failed to load 'postgres' driver — pnpm add postgres -w (cause: ${String(err)})`,
      );
    },
  )) as { default: (dsn: string) => unknown };
  cached = mod.default(dsn);
  cachedDsn = dsn;
  return cached;
}
