// Cloudflare D1 implementation of SqlClient.
//
// Direct passthrough — the SqlClient surface deliberately mirrors D1's
// binding API, so each method delegates verbatim to the underlying
// D1Database / D1PreparedStatement.

import type {
  SqlClient,
  SqlRunResult,
  SqlSelectResult,
  SqlStatement,
} from "../ports";

class CfD1SqlStatement implements SqlStatement {
  constructor(private stmt: D1PreparedStatement) {}

  bind(...params: unknown[]): SqlStatement {
    return new CfD1SqlStatement(this.stmt.bind(...(params as never[])));
  }

  async run<T = unknown>(): Promise<SqlRunResult<T>> {
    const r = await this.stmt.run<T>();
    return {
      results: r.results as T[] | undefined,
      meta: { changes: r.meta?.changes ?? 0, last_row_id: r.meta?.last_row_id },
      success: r.success,
    };
  }

  async first<T = unknown>(): Promise<T | null> {
    const r = await this.stmt.first<T>();
    return r ?? null;
  }

  async all<T = unknown>(): Promise<SqlSelectResult<T>> {
    const r = await this.stmt.all<T>();
    return {
      results: r.results as T[] | undefined,
      meta: { changes: r.meta?.changes ?? 0, last_row_id: r.meta?.last_row_id },
    };
  }

  /** Internal — used by CfD1SqlClient.batch to access the underlying D1 stmt. */
  unwrap(): D1PreparedStatement {
    return this.stmt;
  }
}

export class CfD1SqlClient implements SqlClient {
  constructor(private readonly db: D1Database) {}

  prepare(sql: string): SqlStatement {
    return new CfD1SqlStatement(this.db.prepare(sql));
  }

  async batch<T = unknown>(stmts: SqlStatement[]): Promise<Array<SqlRunResult<T>>> {
    const d1Stmts = stmts.map((s) => {
      // The batch contract: all statements MUST come from this client's
      // prepare(). Mixing adapters in one batch is undefined.
      if (!(s instanceof CfD1SqlStatement)) {
        throw new Error("CfD1SqlClient.batch: foreign SqlStatement (not from this client's prepare)");
      }
      return s.unwrap();
    });
    const results = await this.db.batch<T>(d1Stmts);
    return results.map((r) => ({
      results: r.results as T[] | undefined,
      meta: { changes: r.meta?.changes ?? 0, last_row_id: r.meta?.last_row_id },
      success: r.success,
    }));
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }
}

/** Convenience: wrap a D1Database binding as a SqlClient. */
export function sqlClientFromD1(db: D1Database): SqlClient {
  return new CfD1SqlClient(db);
}
