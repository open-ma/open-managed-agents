export type {
  SqlClient,
  SqlStatement,
  SqlExecMeta,
  SqlSelectResult,
  SqlRunResult,
} from "./ports";

// CF (D1) adapter is exported via the subpath `./adapters/cf-d1` so that
// Node consumers can import the port + better-sqlite3 adapter without
// pulling Cloudflare Worker types into their tsconfig. The CF worker
// imports stay as before:
//   import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";

// Node SQL adapters are exported here because they have no CF type
// dependencies; their drivers are optional peers and loaded only by the
// corresponding createXxxClient factory.
export { createBetterSqlite3SqlClient } from "./adapters/better-sqlite3";
export { createPostgresSqlClient } from "./adapters/postgres";
export {
  createMysql2SqlClient,
  Mysql2SqlClient,
  type Mysql2SqlClientOptions,
} from "./adapters/mysql2";
