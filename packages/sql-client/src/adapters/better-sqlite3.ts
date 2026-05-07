// better-sqlite3 implementation of SqlClient.
//
// Why better-sqlite3 (vs node:sqlite or node-sqlite3):
//   - Synchronous API maps cleanly to a wrapped async port: zero callback
//     hell, transactions are first-class via db.transaction(fn).
//   - Best perf for embedded SQLite (single-process, no IPC overhead).
//   - Stable for years, well-tested in serverless Node (Lambda/Fly/Render).
//
// Driver dep is intentionally a peer with peerDependenciesMeta.optional so
// this package compiles without it. Consumers that actually want a Node
// backend install it: `pnpm add better-sqlite3`.
//
// SQL flavour: D1 IS SQLite under the hood, so 99% of D1-flavoured SQL runs
// here unchanged. Known divergences when porting D1 schemas:
//   - INTEGER PRIMARY KEY AUTOINCREMENT works the same.
//   - JSON1 functions (json_extract, json_each, etc.) work in better-sqlite3
//     since the bundled SQLite has JSON1 enabled.
//   - D1's `db.batch([stmt1, stmt2])` is mapped here to a single
//     `db.transaction(...)` invocation — same semantics (atomic, rollback on
//     any failure), different mechanism.

import type {
  SqlClient,
  SqlRunResult,
  SqlSelectResult,
  SqlStatement,
} from "../ports";

// Minimal structural types so this file compiles without `better-sqlite3`
// installed. The actual driver is dynamic-imported from createBetterSqlite3SqlClient.
interface BS3RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}
interface BS3Statement {
  run(...params: unknown[]): BS3RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface BS3Database {
  prepare(sql: string): BS3Statement;
  exec(sql: string): void;
  transaction<T extends (...args: unknown[]) => unknown>(fn: T): T & {
    deferred: T;
    immediate: T;
    exclusive: T;
  };
}

class BetterSqlite3SqlStatement implements SqlStatement {
  private params: unknown[] = [];
  constructor(private stmt: BS3Statement) {}

  bind(...params: unknown[]): SqlStatement {
    const next = new BetterSqlite3SqlStatement(this.stmt);
    next.params = params;
    return next;
  }

  async run<T = unknown>(): Promise<SqlRunResult<T>> {
    const r = this.stmt.run(...this.params);
    return {
      meta: {
        changes: r.changes,
        last_row_id: typeof r.lastInsertRowid === "bigint"
          ? Number(r.lastInsertRowid)
          : r.lastInsertRowid,
      },
      success: true,
    };
  }

  async first<T = unknown>(): Promise<T | null> {
    const r = this.stmt.get(...this.params);
    return (r ?? null) as T | null;
  }

  async all<T = unknown>(): Promise<SqlSelectResult<T>> {
    const r = this.stmt.all(...this.params);
    return {
      results: r as T[],
      meta: { changes: 0 },
    };
  }

  /** Internal — used by BetterSqlite3SqlClient.batch to execute under tx. */
  executeRun(): SqlRunResult<unknown> {
    const r = this.stmt.run(...this.params);
    return {
      meta: {
        changes: r.changes,
        last_row_id: typeof r.lastInsertRowid === "bigint"
          ? Number(r.lastInsertRowid)
          : r.lastInsertRowid,
      },
      success: true,
    };
  }
}

export class BetterSqlite3SqlClient implements SqlClient {
  constructor(private readonly db: BS3Database) {}

  prepare(sql: string): SqlStatement {
    return new BetterSqlite3SqlStatement(this.db.prepare(sql));
  }

  async batch<T = unknown>(stmts: SqlStatement[]): Promise<Array<SqlRunResult<T>>> {
    const txn = this.db.transaction(() => {
      const out: SqlRunResult<T>[] = [];
      for (const s of stmts) {
        if (!(s instanceof BetterSqlite3SqlStatement)) {
          throw new Error(
            "BetterSqlite3SqlClient.batch: foreign SqlStatement (not from this client's prepare)",
          );
        }
        out.push(s.executeRun() as SqlRunResult<T>);
      }
      return out;
    });
    return txn() as SqlRunResult<T>[];
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }
}

/**
 * Build a SqlClient backed by better-sqlite3. Lazy-imports the driver so
 * importing this package doesn't require better-sqlite3 to be installed
 * (CF deployments don't need it).
 *
 *   const sql = await createBetterSqlite3SqlClient("./data/oma.db");
 *   await sql.exec("CREATE TABLE ...");
 */
export async function createBetterSqlite3SqlClient(
  dbPath: string,
): Promise<SqlClient> {
  type BS3Module = { default: new (path: string) => BS3Database };
  const mod = (await import(/* @vite-ignore */ "better-sqlite3" as string).catch(
    (err) => {
      throw new Error(
        `createBetterSqlite3SqlClient: failed to load 'better-sqlite3' — ` +
          `pnpm add better-sqlite3 (cause: ${String(err)})`,
      );
    },
  )) as BS3Module;
  const db = new mod.default(dbPath);
  return new BetterSqlite3SqlClient(db);
}
