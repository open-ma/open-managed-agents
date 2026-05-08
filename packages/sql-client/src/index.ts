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

// better-sqlite3 / postgres adapters are exported here because neither has
// CF type dependencies; the drivers themselves are peer deps so this remains
// import-safe when neither is installed (the createXxxClient calls are the
// only things that touch them).
export { createBetterSqlite3SqlClient } from "./adapters/better-sqlite3";
export { createPostgresSqlClient } from "./adapters/postgres";

// Tenant→shard routing for horizontally-sharded AUTH_DB. CF type
// dependency (D1Database, KVNamespace) is fine here — Workers
// consumers are the primary callers; Node consumers don't shard.
export {
  SHARD_BINDING_NAMES,
  ShardLookupError,
  getShardForTenant,
  resolveBindingName,
  assignShardOnSignup,
  queryAllShards,
} from "./shard";
export type { ShardBindingName, ShardBindings } from "./shard";
