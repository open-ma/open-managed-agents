// postgres.js implementation of SqlClient.
//
// Wires the existing SQLite-flavoured repo SQL onto a Postgres backend by
// translating the two main syntactic differences at the SqlClient layer:
//
//   1. Param placeholders. Repos write `WHERE id = ?` (D1/SQLite style);
//      Postgres uses `$1, $2, ...`. PostgresSqlStatement counts the `?`s
//      in the SQL when prepare() is called and rewrites them to numbered
//      placeholders before sending. ?-inside-string-literals is preserved
//      via a small scanner.
//
//   2. RETURNING for last_row_id. Postgres has no implicit "last insert
//      rowid" — SQL must explicitly RETURN. The repos in this codebase
//      don't use AUTOINCREMENT (every entity carries an explicit string id
//      generated app-side), so meta.last_row_id is left undefined. If a
//      future repo needs it, append `RETURNING id` to the INSERT and read
//      from result.results[0].id.
//
// SQL flavour assumptions (verified for OMA's existing repos):
//   - All ids are TEXT/string; no INTEGER PRIMARY KEY AUTOINCREMENT.
//   - JSON columns stored as TEXT (not jsonb). Repos JSON.parse on read.
//   - Timestamps stored as INTEGER (ms). Postgres BIGINT works fine —
//     bootstrap DDL needs to declare BIGINT (not INTEGER, which is 32-bit
//     in PG and would overflow ~2038).
//   - Booleans: not used directly (we store 0/1 or nulls). PG-side schema
//     should declare those columns as SMALLINT to match SQLite semantics.
//
// The driver dep is a peer (peerDependencies in package.json) and lazy-
// loaded by createPostgresSqlClient so importing this package doesn't
// require `postgres` to be installed.

import type {
  SqlClient,
  SqlRunResult,
  SqlSelectResult,
  SqlStatement,
} from "../ports";

// Minimal structural type for the postgres.js callable. Matches:
//   const sql = postgres(dsn)
//   await sql.unsafe(text, params)              // Result<T>[] | Result<T>
//   await sql.begin(async (sql) => { ... })     // transaction
type PgRow = Record<string, unknown>;
interface PgQueryResult extends Array<PgRow> {
  count?: number;
}
interface PgSql {
  unsafe(text: string, params?: unknown[]): Promise<PgQueryResult>;
  begin<T>(fn: (sql: PgSql) => Promise<T>): Promise<T>;
  end?(opts?: { timeout?: number }): Promise<void>;
}

/**
 * Translate `?` placeholders to `$1, $2, ...` while preserving `?` chars
 * that appear inside SQL string literals ('...' or "..."). Returns the
 * translated SQL and the placeholder count for arity validation.
 */
function translatePlaceholders(sql: string): { text: string; count: number } {
  let out = "";
  let n = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === "\"") {
      // Skip to matching close quote, handling doubled-quote escape ('').
      const quote = c;
      out += c;
      i++;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            out += quote + quote;
            i += 2;
            continue;
          }
          out += quote;
          i++;
          break;
        }
        out += sql[i];
        i++;
      }
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      // Line comment.
      while (i < sql.length && sql[i] !== "\n") { out += sql[i]; i++; }
      continue;
    }
    if (c === "?") {
      n++;
      out += `$${n}`;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return { text: out, count: n };
}

class PostgresSqlStatement implements SqlStatement {
  private params: unknown[] = [];
  constructor(
    private readonly sql: PgSql,
    private readonly text: string,
    private readonly arity: number,
  ) {}

  bind(...params: unknown[]): SqlStatement {
    if (params.length !== this.arity) {
      throw new Error(
        `PostgresSqlStatement.bind: expected ${this.arity} params, got ${params.length}`,
      );
    }
    const next = new PostgresSqlStatement(this.sql, this.text, this.arity);
    next.params = params;
    return next;
  }

  async run<T = unknown>(): Promise<SqlRunResult<T>> {
    const r = await this.sql.unsafe(this.text, this.params as unknown[]);
    return {
      meta: { changes: r.count ?? r.length ?? 0 },
      // Some statements (INSERT ... RETURNING, UPDATE ... RETURNING) return
      // rows even from .run() — surface them so callers that want them can
      // read result.results without re-executing.
      results: r as unknown as T[],
      success: true,
    };
  }

  async first<T = unknown>(): Promise<T | null> {
    const r = await this.sql.unsafe(this.text, this.params as unknown[]);
    return ((r[0] ?? null) as T | null);
  }

  async all<T = unknown>(): Promise<SqlSelectResult<T>> {
    const r = await this.sql.unsafe(this.text, this.params as unknown[]);
    return { results: r as unknown as T[], meta: { changes: r.count ?? 0 } };
  }

  /** Internal — used by PostgresSqlClient.batch to execute under a tx. */
  async executeRunIn(tx: PgSql): Promise<SqlRunResult<unknown>> {
    const r = await tx.unsafe(this.text, this.params as unknown[]);
    return {
      meta: { changes: r.count ?? r.length ?? 0 },
      results: r as unknown as unknown[],
      success: true,
    };
  }
}

export class PostgresSqlClient implements SqlClient {
  constructor(private readonly sql: PgSql) {}

  prepare(text: string): SqlStatement {
    const { text: translated, count } = translatePlaceholders(text);
    return new PostgresSqlStatement(this.sql, translated, count);
  }

  async batch<T = unknown>(stmts: SqlStatement[]): Promise<Array<SqlRunResult<T>>> {
    return this.sql.begin<Array<SqlRunResult<T>>>(async (tx) => {
      const out: SqlRunResult<T>[] = [];
      for (const s of stmts) {
        if (!(s instanceof PostgresSqlStatement)) {
          throw new Error(
            "PostgresSqlClient.batch: foreign SqlStatement (not from this client's prepare)",
          );
        }
        out.push((await s.executeRunIn(tx)) as SqlRunResult<T>);
      }
      return out;
    });
  }

  /**
   * Execute multi-statement DDL. postgres.js's `.unsafe(text)` runs the
   * whole thing as a single simple-query, which permits ;-separated
   * statements (CREATE TABLE; CREATE INDEX; ...).
   */
  async exec(sql: string): Promise<void> {
    await this.sql.unsafe(sql);
  }
}

/**
 * Build a SqlClient backed by postgres.js. Lazy-imports the driver — caller
 * doesn't need it at install time unless they actually point at PG.
 *
 *   const sql = await createPostgresSqlClient(process.env.DATABASE_URL!);
 *   await sql.exec("CREATE TABLE ...");
 *
 * BIGINT type-parser: postgres.js returns BIGINT as a string by default
 * (preserving precision past Number.MAX_SAFE_INTEGER). All our store repos
 * declare BIGINT timestamp columns as `number` and feed them to
 * `new Date(ms)`. ms timestamps comfortably fit in a JS number until year
 * 287396, so coercing here is safe and saves every repo from doing
 * `Number(row.created_at)` itself.
 */
export async function createPostgresSqlClient(dsn: string): Promise<SqlClient> {
  type PgFactory = ((dsn: string, opts?: unknown) => PgSql);
  type PgModule = { default: PgFactory };
  const mod = (await import(/* @vite-ignore */ "postgres" as string).catch(
    (err) => {
      throw new Error(
        `createPostgresSqlClient: failed to load 'postgres' — ` +
          `pnpm add postgres (cause: ${String(err)})`,
      );
    },
  )) as PgModule;
  const sql = mod.default(dsn, {
    types: {
      // OID 20 = BIGINT (int8). Coerce to JS number — fine for ms timestamps,
      // counters, and sizes well below 2^53.
      bigint: { to: 20, from: [20], serialize: (v: number) => v.toString(), parse: (v: string) => Number(v) },
    },
  });
  return new PostgresSqlClient(sql);
}
