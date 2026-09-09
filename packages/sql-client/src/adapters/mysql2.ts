// mysql2/promise implementation of SqlClient.
//
// The SqlClient contract is a small portable SQL profile shared by SQLite,
// PostgreSQL and MySQL. This adapter owns MySQL's two missing pieces:
// ON CONFLICT translation and transactional RETURNING emulation. Domain
// stores therefore stay behind their existing Ports and never branch on a
// concrete database.

import type {
  SqlClient,
  SqlRunResult,
  SqlSelectResult,
  SqlStatement,
} from "../ports";

type MysqlRow = Record<string, unknown>;

interface MysqlResultHeader {
  affectedRows?: number;
  insertId?: number;
}

type MysqlQueryResult = MysqlRow[] | MysqlResultHeader;

interface MysqlExecutor {
  execute(
    text: string,
    params?: unknown[],
  ): Promise<[MysqlQueryResult, unknown]>;
}

interface MysqlConnection extends MysqlExecutor {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

interface MysqlPool extends MysqlExecutor {
  query(text: string): Promise<[unknown, unknown]>;
  getConnection(): Promise<MysqlConnection>;
  end(): Promise<void>;
}

interface MysqlStatementOwner {
  pool: MysqlPool;
  primaryKeys: Map<string, string[]>;
}

interface PortableStatement {
  text: string;
  returning: string | null;
  upsert: boolean;
  parameterOrder: number[] | null;
}

function translatePortableStatement(input: string): PortableStatement {
  const portable = mysqlQuotedIdentifiers(input);
  const returningMatch = portable.match(/\s+RETURNING\s+([\s\S]+?)\s*;?\s*$/i);
  const returning = returningMatch?.[1].trim() ?? null;
  let text = returningMatch
    ? portable.slice(0, returningMatch.index).trimEnd()
    : portable;

  const doNothing = /\s+ON\s+CONFLICT\s*(?:\([^)]*\))?\s+DO\s+NOTHING\s*$/i;
  if (doNothing.test(text)) {
    text = text.replace(doNothing, "");
    text = text.replace(/^(\s*)INSERT\s+INTO\b/i, "$1INSERT IGNORE INTO");
    return { text, returning, upsert: true, parameterOrder: null };
  }

  const conflict = findTopLevelPhrase(text, "ON CONFLICT");
  if (conflict !== -1) {
    const update = text.slice(conflict).match(
      /^ON\s+CONFLICT\s*(?:\([^)]*\))?\s+DO\s+UPDATE\s+SET\s+/i,
    );
    if (!update) {
      throw new Error("Mysql2SqlClient: unsupported portable ON CONFLICT form");
    }
    const prefix = text.slice(0, conflict).trimEnd();
    const body = text.slice(conflict + update[0].length);
    const where = findTopLevelKeyword(body, "WHERE");
    const assignmentsText = where === -1 ? body : body.slice(0, where);
    const condition = where === -1 ? null : body.slice(where + "WHERE".length).trim();
    const prefixParameterCount = countPlaceholders(prefix);
    let assignmentParameterOffset = prefixParameterCount;
    const assignmentParameterOrders: number[][] = [];
    const assignments = splitTopLevel(assignmentsText).map((assignment) => {
      const equals = findTopLevelCharacter(assignment, "=");
      if (equals === -1) {
        throw new Error(`Mysql2SqlClient: invalid upsert assignment ${assignment}`);
      }
      const target = assignment.slice(0, equals).trim();
      const rawValue = assignment.slice(equals + 1).trim();
      const valueParameterCount = countPlaceholders(rawValue);
      assignmentParameterOrders.push(
        Array.from(
          { length: valueParameterCount },
          (_, index) => assignmentParameterOffset + index,
        ),
      );
      assignmentParameterOffset += valueParameterCount;
      const value = mysqlExcluded(rawValue);
      return condition === null
        ? `${target} = ${value}`
        : `${target} = IF((${mysqlExcluded(condition)}), ${value}, ${target})`;
    });
    text = `${prefix} ON DUPLICATE KEY UPDATE ${assignments.join(", ")}`;
    const conditionParameterCount = condition === null
      ? 0
      : countPlaceholders(condition);
    const conditionParameterOrder = Array.from(
      { length: conditionParameterCount },
      (_, index) => assignmentParameterOffset + index,
    );
    const parameterOrder = condition === null
      ? null
      : [
          ...Array.from({ length: prefixParameterCount }, (_, index) => index),
          ...assignmentParameterOrders.flatMap((valueOrder) => [
            ...conditionParameterOrder,
            ...valueOrder,
          ]),
        ];
    return { text, returning, upsert: true, parameterOrder };
  }

  return { text, returning, upsert: false, parameterOrder: null };
}

/**
 * The portable profile uses ANSI double quotes for identifiers. MySQL only
 * gives double quotes that meaning under ANSI_QUOTES, so normalize them in
 * the adapter rather than requiring a server-wide SQL mode or leaking MySQL
 * quoting into application stores. String literals and comments are copied
 * verbatim.
 */
function mysqlQuotedIdentifiers(input: string): string {
  let output = "";
  let index = 0;
  while (index < input.length) {
    const char = input[index];
    if (char === "'") {
      const end = copyQuoted(input, index, char);
      output += input.slice(index, end);
      index = end;
      continue;
    }
    if (char === "`") {
      const end = copyQuoted(input, index, char);
      output += input.slice(index, end);
      index = end;
      continue;
    }
    if (char === '"') {
      output += "`";
      index += 1;
      while (index < input.length) {
        if (input[index] === '"') {
          if (input[index + 1] === '"') {
            output += '"';
            index += 2;
            continue;
          }
          output += "`";
          index += 1;
          break;
        }
        output += input[index] === "`" ? "``" : input[index];
        index += 1;
      }
      continue;
    }
    if (char === "-" && input[index + 1] === "-") {
      const end = input.indexOf("\n", index + 2);
      const next = end === -1 ? input.length : end;
      output += input.slice(index, next);
      index = next;
      continue;
    }
    if (char === "#") {
      const end = input.indexOf("\n", index + 1);
      const next = end === -1 ? input.length : end;
      output += input.slice(index, next);
      index = next;
      continue;
    }
    if (char === "/" && input[index + 1] === "*") {
      const end = input.indexOf("*/", index + 2);
      const next = end === -1 ? input.length : end + 2;
      output += input.slice(index, next);
      index = next;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

function copyQuoted(input: string, start: number, quote: "'" | "`"): number {
  let index = start + 1;
  while (index < input.length) {
    if (input[index] === "\\") {
      index += 2;
      continue;
    }
    if (input[index] === quote) {
      if (input[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return input.length;
}

function mysqlExcluded(input: string): string {
  return input.replace(
    /\bexcluded\.([A-Za-z_][A-Za-z0-9_]*)\b/gi,
    (_match, column: string) => `VALUES(\`${column}\`)`,
  );
}

function findTopLevelPhrase(input: string, phrase: string): number {
  return findTopLevel(input, phrase, true);
}

function findTopLevelKeyword(input: string, keyword: string): number {
  return findTopLevel(input, keyword, true);
}

function findTopLevelCharacter(input: string, character: string): number {
  return findTopLevel(input, character, false);
}

function findTopLevel(input: string, needle: string, wordBoundary: boolean): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = 0; index <= input.length - needle.length; index += 1) {
    const char = input[index];
    if (quote !== null) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        if (input[index + 1] === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) continue;
    if (input.slice(index, index + needle.length).toUpperCase() !== needle.toUpperCase()) {
      continue;
    }
    if (wordBoundary) {
      const before = input[index - 1];
      const after = input[index + needle.length];
      if ((before && /[A-Za-z0-9_]/.test(before)) || (after && /[A-Za-z0-9_]/.test(after))) {
        continue;
      }
    }
    return index;
  }
  return -1;
}

function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < input.length) {
    const comma = findTopLevel(input.slice(start), ",", false);
    if (comma === -1) {
      parts.push(input.slice(start).trim());
      break;
    }
    parts.push(input.slice(start, start + comma).trim());
    start += comma + 1;
  }
  return parts.filter(Boolean);
}

function quoteIdentifier(identifier: string): string {
  return `\`${identifier.replaceAll("`", "``")}\``;
}

function parseUpdate(text: string): { table: string; set: string; where: string } {
  const tableMatch = text.match(/^\s*UPDATE\s+`?([A-Za-z_][A-Za-z0-9_]*)`?\s+/i);
  if (!tableMatch) throw new Error("Mysql2SqlClient: cannot parse UPDATE table");
  const setAt = findTopLevelKeyword(text, "SET");
  const whereAt = findTopLevelKeyword(text, "WHERE");
  if (setAt === -1 || whereAt === -1 || whereAt <= setAt) {
    throw new Error("Mysql2SqlClient: UPDATE RETURNING requires SET and WHERE");
  }
  return {
    table: tableMatch[1],
    set: text.slice(setAt + "SET".length, whereAt).trim(),
    where: text.slice(whereAt + "WHERE".length).trim().replace(/;$/, ""),
  };
}

/**
 * Queue claims commonly select one candidate from the same table in one
 * top-level WHERE term, then repeat the ownership/state predicates around it.
 * Once the candidate key has been read, MySQL must not repeat that self-select
 * in an UPDATE (ER_UPDATE_TABLE_USED). The remaining predicates are the CAS
 * guards and are re-evaluated by the mutation.
 */
function updateCasGuard(
  where: string,
  table: string,
): { sql: string; parameterOrder: number[] } {
  const terms = splitTopLevelAnd(where);
  let parameterOffset = 0;
  let removedCandidate = false;
  const guards: Array<{ sql: string; parameterOrder: number[] }> = [];
  const escapedTable = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sourceTable = new RegExp(
    `\\bFROM\\s+(?:\\\`${escapedTable}\\\`|${escapedTable})\\b`,
    "i",
  );
  for (const term of terms) {
    const parameterCount = countPlaceholders(term);
    const order = Array.from(
      { length: parameterCount },
      (_, index) => parameterOffset + index,
    );
    parameterOffset += parameterCount;
    const candidateSelector = /^\s*(?:\([^)]*\)|`?[A-Za-z_][A-Za-z0-9_]*`?)\s*=\s*\(\s*SELECT\b/i
      .test(term) && sourceTable.test(term);
    if (candidateSelector) {
      removedCandidate = true;
      continue;
    }
    guards.push({ sql: term, parameterOrder: order });
  }
  if (!removedCandidate) {
    return {
      sql: where,
      parameterOrder: Array.from(
        { length: countPlaceholders(where) },
        (_, index) => index,
      ),
    };
  }
  if (guards.length === 0) {
    throw new Error(
      "Mysql2SqlClient: same-table candidate UPDATE requires a trailing CAS guard",
    );
  }
  return {
    sql: guards.map((guard) => guard.sql).join(" AND "),
    parameterOrder: guards.flatMap((guard) => guard.parameterOrder),
  };
}

function splitTopLevelAnd(input: string): string[] {
  const terms: string[] = [];
  let offset = 0;
  while (offset < input.length) {
    const relative = findTopLevelKeyword(input.slice(offset), "AND");
    if (relative === -1) {
      terms.push(input.slice(offset).trim());
      break;
    }
    terms.push(input.slice(offset, offset + relative).trim());
    offset += relative + "AND".length;
  }
  return terms.filter(Boolean);
}

function parseInsert(text: string): {
  table: string;
  columns: string[];
  values: string[];
} {
  const match = text.match(
    /^\s*INSERT(?:\s+IGNORE)?\s+INTO\s+`?([A-Za-z_][A-Za-z0-9_]*)`?\s*\(([^)]*)\)\s*VALUES\s*\(/i,
  );
  if (!match || match.index === undefined) {
    throw new Error("Mysql2SqlClient: cannot parse INSERT RETURNING");
  }
  const valuesStart = match.index + match[0].length;
  let depth = 1;
  let quote: string | null = null;
  let valuesEnd = -1;
  for (let index = valuesStart; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== null) {
      if (char === "\\") index += 1;
      else if (char === quote) {
        if (text[index + 1] === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0) {
      valuesEnd = index;
      break;
    }
  }
  if (valuesEnd === -1) {
    throw new Error("Mysql2SqlClient: unterminated INSERT values");
  }
  return {
    table: match[1],
    columns: splitTopLevel(match[2]).map((column) =>
      column.trim().replace(/^`|`$/g, "")
    ),
    values: splitTopLevel(text.slice(valuesStart, valuesEnd)),
  };
}

function insertedKeyValues(
  insert: ReturnType<typeof parseInsert>,
  keys: string[],
  params: unknown[],
): unknown[] | null {
  const values = new Map<string, unknown>();
  let parameterOffset = 0;
  insert.values.forEach((expression, index) => {
    const placeholders = countPlaceholders(expression);
    if (expression.trim() === "?") {
      values.set(insert.columns[index], params[parameterOffset]);
    }
    parameterOffset += placeholders;
  });
  const result = keys.map((key) => values.get(key));
  return result.some((value) => value === undefined) ? null : result;
}

async function primaryKeyColumns(
  executor: MysqlExecutor,
  owner: MysqlStatementOwner,
  table: string,
): Promise<string[]> {
  const cached = owner.primaryKeys.get(table);
  if (cached) return cached;
  const [rows] = await executor.execute(
    `SHOW KEYS FROM ${quoteIdentifier(table)} WHERE Key_name = 'PRIMARY'`,
  );
  const keys = (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      name: String(row.Column_name),
      order: Number(row.Seq_in_index),
    }))
    .sort((left, right) => left.order - right.order)
    .map(({ name }) => name);
  owner.primaryKeys.set(table, keys);
  return keys;
}

function countPlaceholders(sql: string): number {
  let count = 0;
  let i = 0;
  while (i < sql.length) {
    const char = sql[i];

    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "\\" && quote !== "`") {
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (char === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      continue;
    }

    if (char === "#") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      continue;
    }

    if (char === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) {
        i += 1;
      }
      i = Math.min(i + 2, sql.length);
      continue;
    }

    if (char === "?") count += 1;
    i += 1;
  }
  return count;
}

function toRunResult<T>(result: MysqlQueryResult): SqlRunResult<T> {
  if (Array.isArray(result)) {
    return {
      results: result as T[],
      meta: { changes: 0 },
      success: true,
    };
  }

  const lastRowId = result.insertId;
  return {
    meta: {
      changes: result.affectedRows ?? 0,
      ...(typeof lastRowId === "number" && lastRowId > 0
        ? { last_row_id: lastRowId }
        : {}),
    },
    success: true,
  };
}

class Mysql2SqlStatement implements SqlStatement {
  private params: unknown[] = [];

  constructor(
    private readonly executor: MysqlExecutor,
    private readonly owner: MysqlStatementOwner,
    private readonly statement: PortableStatement,
    private readonly arity: number,
  ) {}

  bind(...params: unknown[]): SqlStatement {
    if (params.length !== this.arity) {
      throw new Error(
        `Mysql2SqlStatement.bind: expected ${this.arity} params, got ${params.length}`,
      );
    }
    const next = new Mysql2SqlStatement(
      this.executor,
      this.owner,
      this.statement,
      this.arity,
    );
    next.params = params;
    return next;
  }

  async run<T = unknown>(): Promise<SqlRunResult<T>> {
    if (this.statement.returning !== null) {
      const result = await this.executeReturning<T>();
      return {
        results: result.rows,
        meta: { changes: result.changes },
        success: true,
      };
    }
    return this.executeRunIn<T>(this.executor);
  }

  async first<T = unknown>(): Promise<T | null> {
    if (this.statement.returning !== null) {
      const result = await this.executeReturning<T>();
      return result.rows[0] ?? null;
    }
    const [result] = await this.executor.execute(
      this.statement.text,
      this.executionParams(),
    );
    if (!Array.isArray(result)) return null;
    return (result[0] ?? null) as T | null;
  }

  async all<T = unknown>(): Promise<SqlSelectResult<T>> {
    if (this.statement.returning !== null) {
      const result = await this.executeReturning<T>();
      return { results: result.rows, meta: { changes: result.changes } };
    }
    const [result] = await this.executor.execute(
      this.statement.text,
      this.executionParams(),
    );
    if (!Array.isArray(result)) {
      return {
        results: [],
        meta: { changes: result.affectedRows ?? 0 },
      };
    }
    return { results: result as T[], meta: { changes: 0 } };
  }

  belongsTo(owner: MysqlStatementOwner): boolean {
    return this.owner === owner;
  }

  async executeRunIn<T>(executor: MysqlExecutor): Promise<SqlRunResult<T>> {
    if (this.statement.returning !== null) {
      throw new Error("Mysql2SqlClient.batch does not accept RETURNING statements");
    }
    const [result] = await executor.execute(
      this.statement.text,
      this.executionParams(),
    );
    return toRunResult<T>(result);
  }

  private executionParams(): unknown[] {
    return this.statement.parameterOrder === null
      ? this.params
      : this.statement.parameterOrder.map((index) => this.params[index]);
  }

  private async executeReturning<T>(): Promise<{ rows: T[]; changes: number }> {
    const connection = await this.owner.pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = /^\s*UPDATE\b/i.test(this.statement.text)
        ? await this.executeUpdateReturning<T>(connection)
        : /^\s*INSERT\b/i.test(this.statement.text)
          ? await this.executeInsertReturning<T>(connection)
          : null;
      if (result === null) {
        throw new Error("Mysql2SqlClient: RETURNING is supported only for INSERT and UPDATE");
      }
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  private async executeUpdateReturning<T>(
    connection: MysqlConnection,
  ): Promise<{ rows: T[]; changes: number }> {
    const parsed = parseUpdate(this.statement.text);
    const keys = await primaryKeyColumns(connection, this.owner, parsed.table);
    if (keys.length === 0) {
      throw new Error(`Mysql2SqlClient: ${parsed.table} has no primary key for RETURNING`);
    }
    const setParameterCount = countPlaceholders(parsed.set);
    const setParameters = this.params.slice(0, setParameterCount);
    const whereParameters = this.params.slice(setParameterCount);
    const [selected] = await connection.execute(
      `SELECT ${keys.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(parsed.table)} ` +
        `WHERE ${parsed.where}`,
      whereParameters,
    );
    if (!Array.isArray(selected) || selected.length === 0) {
      return { rows: [], changes: 0 };
    }
    const keyRows = selected as MysqlRow[];
    const keyPredicate = keyRows
      .map(() => `(${keys.map((key) => `${quoteIdentifier(key)} = ?`).join(" AND ")})`)
      .join(" OR ");
    const keyParameters = keyRows.flatMap((row) => keys.map((key) => row[key]));
    const casGuard = updateCasGuard(parsed.where, parsed.table);
    const casGuardParameters = casGuard.parameterOrder.map(
      (index) => whereParameters[index],
    );
    if (countPlaceholders(casGuard.sql) !== casGuardParameters.length) {
      throw new Error(
        "Mysql2SqlClient: could not map queue-claim CAS guard parameters",
      );
    }
    const [mutation] = await connection.execute(
      `UPDATE ${quoteIdentifier(parsed.table)} SET ${parsed.set} ` +
        `WHERE (${keyPredicate}) AND (${casGuard.sql})`,
      [...setParameters, ...keyParameters, ...casGuardParameters],
    );
    const changes = Array.isArray(mutation) ? 0 : mutation.affectedRows ?? 0;
    if (changes === 0) return { rows: [], changes: 0 };
    const [returned] = await connection.execute(
      `SELECT ${this.statement.returning} FROM ${quoteIdentifier(parsed.table)} ` +
        `WHERE ${keyPredicate}`,
      keyParameters,
    );
    return {
      rows: (Array.isArray(returned) ? returned : []) as T[],
      changes,
    };
  }

  private async executeInsertReturning<T>(
    connection: MysqlConnection,
  ): Promise<{ rows: T[]; changes: number }> {
    const parsed = parseInsert(this.statement.text);
    const keys = await primaryKeyColumns(connection, this.owner, parsed.table);
    const keyValues = insertedKeyValues(parsed, keys, this.params);
    if (keyValues === null) {
      throw new Error(
        `Mysql2SqlClient: cannot derive ${parsed.table} primary key for INSERT RETURNING`,
      );
    }
    const [mutation] = await connection.execute(
      this.statement.text,
      this.executionParams(),
    );
    const rawChanges = Array.isArray(mutation) ? 0 : mutation.affectedRows ?? 0;
    if (rawChanges === 0) return { rows: [], changes: 0 };
    const predicate = keys.map((key) => `${quoteIdentifier(key)} = ?`).join(" AND ");
    const [returned] = await connection.execute(
      `SELECT ${this.statement.returning} FROM ${quoteIdentifier(parsed.table)} WHERE ${predicate}`,
      keyValues,
    );
    return {
      rows: (Array.isArray(returned) ? returned : []) as T[],
      // MySQL reports 2 for an upsert update; the portable profile reports
      // the one logical row affected.
      changes: this.statement.upsert ? 1 : rawChanges,
    };
  }
}

export class Mysql2SqlClient implements SqlClient {
  private readonly owner: MysqlStatementOwner;

  constructor(private readonly pool: MysqlPool) {
    this.owner = { pool, primaryKeys: new Map() };
  }

  prepare(text: string): SqlStatement {
    return new Mysql2SqlStatement(
      this.pool,
      this.owner,
      translatePortableStatement(text),
      countPlaceholders(text),
    );
  }

  async batch<T = unknown>(
    statements: SqlStatement[],
  ): Promise<Array<SqlRunResult<T>>> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const results: Array<SqlRunResult<T>> = [];
      for (const statement of statements) {
        if (
          !(statement instanceof Mysql2SqlStatement) ||
          !statement.belongsTo(this.owner)
        ) {
          throw new Error(
            "Mysql2SqlClient.batch: foreign SqlStatement (not from this client's prepare)",
          );
        }
        results.push(await statement.executeRunIn<T>(connection));
      }
      await connection.commit();
      return results;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export interface Mysql2SqlClientOptions {
  connectionLimit?: number;
  connectTimeout?: number;
  enableKeepAlive?: boolean;
  idleTimeout?: number;
  maxIdle?: number;
  queueLimit?: number;
  ssl?: unknown;
  waitForConnections?: boolean;
}

/**
 * Build a SqlClient backed by a mysql2 promise pool.
 *
 * `multipleStatements` is intentionally enabled only for `exec()`, whose
 * input is trusted migration/DDL owned by the application. All values in
 * normal store traffic still go through `execute(text, params)`.
 */
export async function createMysql2SqlClient(
  dsn: string,
  options: Mysql2SqlClientOptions = {},
): Promise<Mysql2SqlClient> {
  type Mysql2Module = {
    createPool(options: Record<string, unknown>): MysqlPool;
  };
  const mod = (await import(/* @vite-ignore */ "mysql2/promise" as string).catch(
    (error) => {
      throw new Error(
        `createMysql2SqlClient: failed to load 'mysql2' — ` +
          `pnpm add mysql2 (cause: ${String(error)})`,
      );
    },
  )) as Mysql2Module;

  const pool = mod.createPool({
    uri: dsn,
    // SqlClient.meta.changes means rows actually mutated. mysql2 enables
    // CLIENT_FOUND_ROWS by default, which reports a matched conditional
    // upsert as changed even when every IF branch kept the old value.
    flags: ["-FOUND_ROWS"],
    supportBigNumbers: true,
    bigNumberStrings: false,
    timezone: "Z",
    ...options,
    multipleStatements: true,
  });
  return new Mysql2SqlClient(pool);
}
