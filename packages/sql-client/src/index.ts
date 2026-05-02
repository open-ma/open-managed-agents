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

// better-sqlite3 adapter is exported here because it has no CF type
// dependencies; the driver itself is a peer dep so this remains import-safe
// when better-sqlite3 isn't installed (the createBetterSqlite3SqlClient
// call is the only thing that touches it).
export { createBetterSqlite3SqlClient } from "./adapters/better-sqlite3";
