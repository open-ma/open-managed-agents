// KV store + API key tables (Node-PG variant of cf-auth/kv).

import { bigint, index, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

export const kv_entries = pgTable(
  "kv_entries",
  {
    tenant_id: text("tenant_id").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    expires_at: bigint("expires_at", { mode: "number" }),
  },
  (t) => [
    primaryKey({ columns: [t.tenant_id, t.key] }),
    // PG-side has the expires-at sweep index; SQLite-side does not (matches
    // packages/schema/src/index.ts).
    index("idx_kv_entries_expires").on(t.expires_at),
  ],
);

export const api_keys = pgTable(
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
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    last_used_at: bigint("last_used_at", { mode: "number" }),
    revoked_at: bigint("revoked_at", { mode: "number" }),
  },
  (t) => [index("idx_api_keys_tenant").on(t.tenant_id, t.revoked_at)],
);
