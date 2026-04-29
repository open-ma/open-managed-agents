-- Migration 0011: Workspace backup/restore registry
--
-- Backs the per-(tenant, environment) DirectoryBackup handles produced by
-- @cloudflare/sandbox createBackup() and consumed by restoreBackup(). Stores
-- the serialized handle (small JSON blob: { id, dir, localBucket? }) plus
-- enough metadata to GC + observe.
--
-- See apps/agent/src/runtime/workspace-backups.ts for the helpers, and the
-- session-do.ts hooks (warmup → restore latest, destroy → snapshot fresh).
-- Cloudflare's recommended pattern per their changelog (2026-02-23):
--   "Persist and reuse across sandbox sessions ... Easily store backup
--    handles in KV, D1, or Durable Object storage."

CREATE TABLE IF NOT EXISTS workspace_backups (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       TEXT    NOT NULL,
  environment_id  TEXT    NOT NULL,
  -- Serialized DirectoryBackup handle (CF SDK type). JSON: { id, dir, localBucket? }.
  backup_handle   TEXT    NOT NULL,
  -- Mirrors the TTL passed to createBackup. R2 lifecycle rule on
  -- managed-agents-backups deletes the squashfs after this; the row should
  -- be garbage-collected around the same time (cron in apps/main).
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  -- For provenance / debugging — which session created this snapshot.
  source_session_id TEXT
);

-- Most queries are "give me the most recent unexpired backup for this scope."
CREATE INDEX IF NOT EXISTS idx_workspace_backups_scope_recent
  ON workspace_backups (tenant_id, environment_id, created_at DESC);

-- Cleanup index — daily cron sweeps WHERE expires_at < now.
CREATE INDEX IF NOT EXISTS idx_workspace_backups_expires
  ON workspace_backups (expires_at);
