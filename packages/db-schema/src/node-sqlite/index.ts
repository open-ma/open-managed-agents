// Node self-host SQLite schema — union of cf-auth + cf-integrations +
// cf-router, all SQLite-typed (no PG-typed columns).
//
// Self-host SQLite runs on better-sqlite3 against the same SQLite engine
// D1 uses, so the cf-* table definitions apply unchanged. The only thing
// this barrel adds is "everything in one folder" for drizzle-kit to emit
// a single consolidated baseline (apps/main-node/migrations-sqlite/)
// rather than three.
//
// drizzle-kit consumes this barrel via drizzle.node-sqlite.config.ts.

export * from "../cf-auth";
export * from "../cf-integrations";
export * from "../cf-router";
export * from "./feishu-ops";
// `cf-auth` already exports the SQLite execution-control table.  Keep the
// Node barrel as a union without re-exporting a second declaration of the
// same table (which makes TypeScript report an ambiguous export).
