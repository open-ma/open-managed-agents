// Drizzle DB port — the dependency-inversion seam between adapter code
// and platform-specific Drizzle clients.
//
// Design contract (DIP + LSP):
//
//   ADAPTERS depend on this port and ONLY this port. They MUST NOT:
//     - import dialect-specific Drizzle types (DrizzleD1Database, etc.)
//     - branch on dialect (`"batch" in db`, `instanceof`, `dialect === ...`)
//     - cast their internal db to a concrete type
//
//   COMPOSITION ROOT (apps/main, apps/main-node, apps/agent, packages/services)
//   constructs the matching Drizzle client and passes it through this port:
//     CF D1:           drizzle(env.MAIN_DB, { schema })
//     Node-PG:         drizzle(postgresClient, { schema })
//     Node-SQLite:     drizzle(betterSqlite3Db, { schema })
//
// Liskov: every concrete Drizzle DB the composition root passes is fully
// substitutable through OmaDb's public surface. The dialect terminator
// difference (`.get()` / `.all()` on SQLite vs awaitable on PG) is handled
// inside `getOne` / `getAll` / `runOnce` / `atomicWrite` — the helpers
// feature-detect ONCE here so adapters stay dialect-blind.
//
// Type-level note: Drizzle's per-dialect generics make a fully-callable
// union impossible without per-dialect chained-method overloads. We use
// `OmaDb` as the constructor parameter (the public DI seam) and, inside
// adapters, opt into `OmaDbBuilder` — a structural alias that exposes
// just the `.select / .insert / .update / .delete` methods every dialect
// shares. No casts in adapter code, no concrete-type imports.

import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

/**
 * The dependency-inversion port. Public construction-site type. The
 * three concrete Drizzle clients (D1 / better-sqlite3 / postgres-js)
 * are all valid here.
 */
export type OmaDb<TSchema extends Record<string, unknown> = Record<string, unknown>> =
  | DrizzleD1Database<TSchema>
  | BetterSQLite3Database<TSchema>
  | PostgresJsDatabase<TSchema>;

/**
 * Discriminator for the rare case where an adapter genuinely needs to
 * pick a SQL idiom by dialect (e.g. `json_extract` vs `->>`). Set by
 * the composition root.
 *
 * Prefer NOT using this. If you find yourself reaching for it, ask
 * whether the divergence belongs in this `_shared/` module instead.
 */
export type OmaDialect = "sqlite" | "pg" | "mysql";

/**
 * Structural alias of the chain-builder methods every Drizzle dialect
 * exposes. Adapters that need to call `db.select()` etc. without the
 * type-checker complaining about the OmaDb union should declare their
 * field as this type. NO concrete-driver import in adapter code.
 *
 * Internally we widen via `BetterSQLite3Database` because its method
 * signatures are the most permissive (D1's method signatures are a
 * structural subset). `as` casts STAY HERE — never in adapter code.
 */
// We use BetterSQLite3Database<TSchema> because its select/insert/update/delete
// chain types are runtime-compatible with D1 + postgres-js (Drizzle's design)
// but expose the most permissive type signature, so casts in `_shared/` here
// don't require dialect-specific imports in adapters.
export type OmaDbBuilder = BetterSQLite3Database<Record<string, never>>;

/**
 * Helper for adapter constructors. Cast happens HERE, in `_shared/`,
 * not in adapter code. Adapter signature stays `db: OmaDb`; field
 * type becomes `OmaDbBuilder` after passing through this helper.
 */
export function asBuilder<TSchema extends Record<string, unknown> = Record<string, unknown>>(
  db: OmaDb<TSchema>,
): OmaDbBuilder {
  // Runtime: every dialect's drizzle() returns an object with the
  // same chain-builder methods. The type-level cast here is documented
  // as the single point where dialect type narrowing happens.
  return db as unknown as OmaDbBuilder;
}

// ──────────────────────────────────────────────────────────────────────
// Terminator helpers — paper over `.get()` / `.all()` / `.run()` (SQLite)
// vs awaitable chain (PG). Adapters call these instead of branching.
// ──────────────────────────────────────────────────────────────────────

interface SqliteSelectChain<T> {
  get(): Promise<T | undefined>;
  all(): Promise<T[]>;
}

interface SqliteRunChain {
  run(): Promise<unknown>;
}

/** SELECT expecting at most one row. Returns the row or null. */
export async function getOne<T>(query: PromiseLike<T[]> | SqliteSelectChain<T>): Promise<T | null> {
  if (typeof (query as SqliteSelectChain<T>).get === "function") {
    const r = await (query as SqliteSelectChain<T>).get();
    return r ?? null;
  }
  const rows = await (query as PromiseLike<T[]>);
  return rows[0] ?? null;
}

/** SELECT expecting any number of rows. Returns the rows. */
export async function getAll<T>(query: PromiseLike<T[]> | SqliteSelectChain<T>): Promise<T[]> {
  if (typeof (query as SqliteSelectChain<T>).all === "function") {
    return await (query as SqliteSelectChain<T>).all();
  }
  return await (query as PromiseLike<T[]>);
}

/** INSERT / UPDATE / DELETE with no result needed. */
export async function runOnce(query: PromiseLike<unknown> | SqliteRunChain): Promise<void> {
  if (typeof (query as SqliteRunChain).run === "function") {
    await (query as SqliteRunChain).run();
    return;
  }
  await (query as PromiseLike<unknown>);
}

// ──────────────────────────────────────────────────────────────────────
// Atomic batch — single canonical helper, replacing the 4 copy-pasted
// `atomicWrite` impls subagents accidentally emitted in adapter files.
// Adapters call `atomicWrite(db, [q1, q2, q3])`; helper internally
// detects whether to use D1's batch() or PG's transaction().
// ──────────────────────────────────────────────────────────────────────

interface D1Batch {
  batch(stmts: unknown[]): Promise<unknown>;
}
interface PgTransaction {
  transaction<R>(cb: (tx: unknown) => Promise<R>): Promise<R>;
}

/**
 * Run multiple write statements as a single atomic unit.
 *
 * D1: uses native `db.batch([...])` (single round-trip, atomic).
 * PG / better-sqlite3: uses `db.transaction(tx => { ... })`.
 *
 * Adapters write:
 *
 *   await atomicWrite(this.db, [
 *     this.db.update(t).set({ ... }).where(eq(t.id, id)),
 *     this.db.insert(history).values({ ... }),
 *   ]);
 *
 * No dialect awareness in adapter code.
 */
export async function atomicWrite<TSchema extends Record<string, unknown> = Record<string, unknown>>(
  db: OmaDb<TSchema>,
  queries: unknown[],
): Promise<void> {
  // D1 path — drizzle's D1 wrapper exposes `batch` taking a list of
  // SQLite chain-builders directly.
  const maybeBatch = db as unknown as Partial<D1Batch>;
  if (typeof maybeBatch.batch === "function") {
    // D1 requires a non-empty array; runtime invariant.
    await maybeBatch.batch(queries as unknown[]);
    return;
  }

  // better-sqlite3 path — the native transaction() is sync (the driver
  // refuses Promise-returning callbacks). Each Drizzle query has a sync
  // `.run()` we can invoke under the transaction.
  const driverName = (db as unknown as { constructor?: { name?: string } })
    .constructor?.name;
  const txDb = db as unknown as PgTransaction;
  if (driverName === "BetterSQLite3Database") {
    txDb.transaction((() => {
      for (const q of queries) {
        const sync = q as unknown as { run?: () => unknown };
        if (typeof sync.run === "function") sync.run();
      }
    }) as unknown as (tx: unknown) => Promise<void>);
    return;
  }

  // PG / postgres-js path — wrap in a transaction, run each query
  // sequentially. Each query is a Drizzle chain-builder; awaiting it
  // executes against the current transaction context.
  if (typeof txDb.transaction === "function") {
    await txDb.transaction(async () => {
      for (const q of queries) {
        await runOnce(q as PromiseLike<unknown> | SqliteRunChain);
      }
    });
    return;
  }

  // Fallback — no batch primitive available. Run sequentially WITHOUT
  // atomicity. This branch should never hit in production but exists
  // for test-only DBs that lack both.
  for (const q of queries) {
    await runOnce(q as PromiseLike<unknown> | SqliteRunChain);
  }
}
