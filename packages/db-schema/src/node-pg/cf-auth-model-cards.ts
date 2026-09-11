// Model cards (Node-PG variant of cf-auth/model-cards).
//
// Keep this schema aligned with the post-0015 handle rename used by the
// service/repository: model_id is the tenant-unique handle and model is the
// provider wire-model. Existing Node-PG databases are upgraded by the
// follow-up migration in apps/main-node/migrations/0002_model_card_handle_rename.sql.

import { sql } from "drizzle-orm";
import { bigint, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

export const model_cards = pgTable(
  "model_cards",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    model_id: text("model_id").notNull(),
    provider: text("provider").notNull(),
    base_url: text("base_url"),
    custom_headers: text("custom_headers"),
    pi_config: text("pi_config"),
    api_key_cipher: text("api_key_cipher").notNull(),
    api_key_preview: text("api_key_preview").notNull(),
    // Integer flag (NOT boolean) to mirror CF / source SQL.
    is_default: bigint("is_default", { mode: "number" }).notNull().default(0),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    updated_at: bigint("updated_at", { mode: "number" }),
    archived_at: bigint("archived_at", { mode: "number" }),
    model: text("model").notNull().default(""),
  },
  (t) => [
    uniqueIndex("idx_model_cards_model_id").on(t.tenant_id, t.model_id),
    uniqueIndex("idx_model_cards_default").on(t.tenant_id).where(sql`"is_default" = 1`),
    index("idx_model_cards_tenant").on(t.tenant_id, t.created_at),
  ],
);
