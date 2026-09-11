// Model cards table (CF SQLite / D1).
//
// `api_key_cipher` is AES-256-GCM (WebCryptoAesGcm with the
// `model.cards.keys` HKDF label) — base64url(iv || ciphertext) plain TEXT.
//
// Sources:
//   apps/main/migrations/_archive/0001_schema.sql               (base shape)
//   apps/main/migrations/_archive/0013_cursor_pagination_indexes.sql
//   apps/main/migrations/_archive/0015_model_card_handle_rename.sql
//     (DROP display_name, ADD model NOT NULL DEFAULT '')

import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const model_cards = sqliteTable(
  "model_cards",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    // Post-0015 semantics: this is the tenant-unique USER-FACING handle
    // (agents reference it via agent.model). Was previously the LLM
    // model string; same column name, new meaning.
    model_id: text("model_id").notNull(),
    provider: text("provider").notNull(),
    base_url: text("base_url"),
    custom_headers: text("custom_headers"),
    pi_config: text("pi_config"),
    api_key_cipher: text("api_key_cipher").notNull(),
    api_key_preview: text("api_key_preview").notNull(),
    // Raw integer 0/1 flag — NOT mode:"boolean".
    is_default: integer("is_default").notNull().default(0),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at"),
    archived_at: integer("archived_at"),
    // Added 0015. The actual LLM model string sent to the provider.
    // PG-side (current) doesn't have this column — drift to be
    // reconciled in Phase 3 alongside the matching node-pg port.
    model: text("model").notNull().default(""),
  },
  (t) => [
    // Hard UNIQUE: one model_id (handle) per tenant.
    uniqueIndex("idx_model_cards_model_id").on(t.tenant_id, t.model_id),
    // Partial UNIQUE: at most one default per tenant. Service layer
    // does atomic clear-then-set so this is the safety net.
    uniqueIndex("idx_model_cards_default").on(t.tenant_id).where(sql`"is_default" = 1`),
    index("idx_model_cards_tenant").on(t.tenant_id, t.created_at),
    index("idx_model_cards_tenant_created_id").on(t.tenant_id, t.created_at, t.id),
  ],
);
