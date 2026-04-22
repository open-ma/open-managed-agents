-- Memory subsystem migration: KV → D1 + Vectorize first-class.
--
-- Replaces the previous KV-only layout (mem:{store}:{id}, memver:{store}:{id},
-- mempath:{store}:{path}). The mempath hack index is gone — UNIQUE(store_id, path)
-- enforces one-memory-per-path at schema level.
--
-- Vectorize is the semantic search index, maintained on every write:
--   id="{store_id}:{memory_id}", values=embedding, metadata={tenant_id, store_id, memory_id, path}
-- D1 row's vector_synced_at column tracks Vectorize-side state. NULL = not yet
-- synced (or sync failed) — `oma memory reconcile` finds these via the partial
-- index and re-embeds them. We deliberately do NOT run a cron — sync is on-demand.

CREATE TABLE IF NOT EXISTS "memory_stores" (
  "id"           TEXT PRIMARY KEY NOT NULL,
  "tenant_id"    TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "description"  TEXT,
  "created_at"   INTEGER NOT NULL,
  "updated_at"   INTEGER,
  "archived_at"  INTEGER
);

CREATE INDEX IF NOT EXISTS "idx_memory_stores_tenant"
  ON "memory_stores" ("tenant_id", "created_at" DESC);

-- One row per (store_id, path). The UNIQUE constraint replaces the old
-- mempath:{store}:{path} → mem_id KV index entirely.
--
-- content lives in D1 because Vectorize metadata is capped at 10 KiB and
-- memory.content can be up to 100 KB. SQLite TEXT handles 100 KB without issue.
CREATE TABLE IF NOT EXISTS "memories" (
  "id"                TEXT PRIMARY KEY NOT NULL,
  "store_id"          TEXT NOT NULL REFERENCES "memory_stores"("id") ON DELETE CASCADE,
  "path"              TEXT NOT NULL,
  "content"           TEXT NOT NULL,
  "content_sha256"    TEXT NOT NULL,
  "size_bytes"        INTEGER NOT NULL,
  "created_at"        INTEGER NOT NULL,
  "updated_at"        INTEGER NOT NULL,
  -- Set to now() after vectorize.upsert returns success. NULL means the row
  -- exists in D1 but the vector index is behind. `oma memory reconcile` works
  -- on these.
  "vector_synced_at"  INTEGER,
  UNIQUE ("store_id", "path")
);

CREATE INDEX IF NOT EXISTS "idx_memories_store_updated"
  ON "memories" ("store_id", "updated_at" DESC);

-- Partial index — only rows that need reconciliation appear here. Lets the
-- reconciler scan stay O(unsynced) instead of O(total memories).
CREATE INDEX IF NOT EXISTS "idx_memories_unsynced"
  ON "memories" ("store_id", "id")
  WHERE "vector_synced_at" IS NULL;

-- Append-only audit log. Every successful mutation in MemoryStoreService emits
-- one row here in the same D1 batch as the memories upsert/delete, so the log
-- and the live state cannot diverge.
--
-- content is denormalized so historical content survives memory rename/delete
-- and can be redacted independently.
CREATE TABLE IF NOT EXISTS "memory_versions" (
  "id"              TEXT PRIMARY KEY NOT NULL,
  "memory_id"       TEXT NOT NULL,
  "store_id"        TEXT NOT NULL REFERENCES "memory_stores"("id") ON DELETE CASCADE,
  "operation"       TEXT NOT NULL,                   -- 'created' | 'modified' | 'deleted'
  "path"            TEXT,                            -- nullable so redact can clear it
  "content"         TEXT,                            -- nullable so redact can clear it
  "content_sha256"  TEXT,
  "size_bytes"      INTEGER,
  "actor_type"      TEXT NOT NULL,                   -- 'api_key' | 'user' | 'agent' | 'system'
  "actor_id"        TEXT NOT NULL,
  "created_at"      INTEGER NOT NULL,
  "redacted"        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS "idx_memory_versions_memory"
  ON "memory_versions" ("memory_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_memory_versions_store"
  ON "memory_versions" ("store_id", "created_at" DESC);
