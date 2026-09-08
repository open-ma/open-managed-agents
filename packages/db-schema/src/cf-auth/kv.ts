// KV store + API key tables (CF SQLite / D1).
//
// Both ship via the inline applySchema() in packages/schema/src/index.ts —
// CF historically stored these in CONFIG_KV / D1 KV instead of D1 rows.
// They land in MAIN_DB on the SQL path so single-D1 self-host has one
// home for everything.
//
// Tables:
//   kv_entries  — generic tenant-scoped KV. PK is (tenant_id, key).
//   api_keys    — bearer credentials (oma_*). hash = sha256(rawKey) hex.
//
// Source: packages/schema/src/index.ts (kv_entries + api_keys sections).
// No _archive migration; these are SQL-backend-only tables.

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { primaryKey } from "drizzle-orm/sqlite-core";

export const kv_entries = sqliteTable(
  "kv_entries",
  {
    tenant_id: text("tenant_id").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    expires_at: integer("expires_at"),
  },
  (t) => [primaryKey({ columns: [t.tenant_id, t.key] })],
);

export const api_keys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    user_id: text("user_id"),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    hash: text("hash").notNull().unique(),
    credential_type: text("credential_type").notNull().default("workspace"),
    environment_id: text("environment_id"),
    created_at: integer("created_at").notNull(),
    last_used_at: integer("last_used_at"),
    revoked_at: integer("revoked_at"),
  },
  (t) => [index("idx_api_keys_tenant").on(t.tenant_id, t.revoked_at)],
);
