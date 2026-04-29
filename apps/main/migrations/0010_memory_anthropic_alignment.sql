-- Migration 0010: Memory subsystem alignment with Anthropic Managed Agents Memory
-- (https://platform.claude.com/docs/en/managed-agents/memory)
--
-- BEFORE applying this migration in production, run:
--     pnpm tsx scripts/migrate-memories-to-r2.ts
-- which copies every existing memories.content into R2 keyed `<store_id>/<path>`
-- and back-fills memories.etag — without that step the bytes-of-truth is lost
-- when this migration drops the content column.
--
-- Schema deltas:
--   * `memories` table is rebuilt via the SQLite "DROP COLUMN dance":
--       - DROP `content`            (bytes-of-truth moves to R2)
--       - DROP `vector_synced_at`   (no more semantic search / Vectorize)
--       - ADD  `etag`               (R2 object etag for CAS via If-Match)
--   * `idx_memories_unsynced`       — dropped (used only by old reconciler)
--   * `memory_stores`, `memory_versions` — unchanged
--
-- The dance is needed because while D1 supports ALTER TABLE DROP COLUMN, doing
-- two drops + an add atomically in a single transaction is more reliable as a
-- table rebuild — and we get fresh PK/UNIQUE constraints in the process.

-- 1. Drop the old reconciler-only partial index. Safe even if it doesn't exist.
DROP INDEX IF EXISTS idx_memories_unsynced;

-- 2. Rebuild the memories table without content / vector_synced_at, with etag.
CREATE TABLE memories_new (
  id              TEXT PRIMARY KEY NOT NULL,
  store_id        TEXT NOT NULL,
  path            TEXT NOT NULL,
  content_sha256  TEXT NOT NULL,
  etag            TEXT,                 -- back-filled by the data migration script
  size_bytes      INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (store_id, path)
);

-- 3. Carry over all rows except the dropped columns. Existing rows get NULL
-- etag until the data migration script populates it.
INSERT INTO memories_new (id, store_id, path, content_sha256, etag, size_bytes, created_at, updated_at)
SELECT id, store_id, path, content_sha256, NULL, size_bytes, created_at, updated_at
FROM memories;

-- 4. Drop old + rename. SQLite's ALTER TABLE ... RENAME re-points indexes too.
DROP TABLE memories;
ALTER TABLE memories_new RENAME TO memories;

-- 5. Recreate the supporting index (dropped with the old table).
CREATE INDEX IF NOT EXISTS idx_memories_store_updated
  ON memories (store_id, updated_at DESC);
