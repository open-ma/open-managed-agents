import type {
  SqlClient,
  SqlRunResult,
  SqlSelectResult,
  SqlStatement,
} from "../ports";

type QueryResult<T> = {
  rows: T[];
  changes: number;
};

class CfDoSqlStatement implements SqlStatement {
  constructor(
    private readonly sql: SqlStorage,
    private readonly query: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]): SqlStatement {
    return new CfDoSqlStatement(this.sql, this.query, params);
  }

  execute<T>(): QueryResult<T> {
    const cursor = this.sql.exec(this.query, ...this.params);
    const rows = cursor.toArray() as T[];
    const isMutation = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(this.query);
    const changes = isMutation
      ? Number(
          this.sql.exec("SELECT changes() AS affected_rows").one()
            .affected_rows ?? 0,
        )
      : 0;
    return {
      rows,
      changes,
    };
  }

  async run<T = unknown>(): Promise<SqlRunResult<T>> {
    const result = this.execute<T>();
    return {
      results: result.rows,
      meta: { changes: result.changes },
      success: true,
    };
  }

  async first<T = unknown>(): Promise<T | null> {
    return this.execute<T>().rows[0] ?? null;
  }

  async all<T = unknown>(): Promise<SqlSelectResult<T>> {
    const result = this.execute<T>();
    return {
      results: result.rows,
      meta: { changes: result.changes },
    };
  }
}

/** SqlClient adapter for one Durable Object's transactional SQLite store. */
export class CfDoSqlClient implements SqlClient {
  constructor(private readonly storage: DurableObjectStorage) {}

  prepare(sql: string): SqlStatement {
    return new CfDoSqlStatement(this.storage.sql, sql);
  }

  async batch<T = unknown>(
    statements: SqlStatement[],
  ): Promise<Array<SqlRunResult<T>>> {
    return this.storage.transactionSync(() => statements.map((statement) => {
      if (!(statement instanceof CfDoSqlStatement)) {
        throw new Error(
          "CfDoSqlClient.batch: foreign SqlStatement (not from this client's prepare)",
        );
      }
      const result = statement.execute<T>();
      return {
        results: result.rows,
        meta: { changes: result.changes },
        success: true,
      };
    }));
  }

  async exec(sql: string): Promise<void> {
    this.storage.sql.exec(sql);
  }
}

export function sqlClientFromDurableObjectStorage(
  storage: DurableObjectStorage,
): SqlClient {
  return new CfDoSqlClient(storage);
}
