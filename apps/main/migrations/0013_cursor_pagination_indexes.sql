-- 0013_cursor_pagination_indexes.sql
--
-- Covering indexes for the cursor-paginated list queries added in the
-- "useCursorList + helper unification" change. Every list*Page query now
-- runs:
--
--   WHERE tenant_id = ? [AND archived_at IS NULL] [AND cursor predicate]
--   ORDER BY created_at DESC, id DESC
--   LIMIT N+1
--
-- Without an index over (tenant_id, created_at DESC, id DESC), SQLite
-- still uses the (tenant_id, ...) prefix to find matching rows, but then
-- materializes and sorts the entire tenant's slice in memory by
-- (created_at DESC, id DESC) before applying LIMIT. Fine for small
-- tenants; cliff for the day a tenant has thousands of agents/sessions.
--
-- The cursor predicate `(created_at < ?  OR  (created_at = ? AND id < ?))`
-- ALSO requires (created_at, id) to be index-ordered to be evaluated as
-- a range seek instead of a filter on the materialized set.
--
-- All five new indexes are CREATE INDEX IF NOT EXISTS — safe to re-apply,
-- and the legacy archived/created indexes are kept (other queries still
-- use them — e.g. existence checks via archived_at IS NULL).

-- Sessions (highest-volume list endpoint — tens of sessions per tenant
-- per day on a noisy workspace, every console mount + every agent panel
-- refresh hits this).
CREATE INDEX IF NOT EXISTS "idx_sessions_tenant_created_id"
  ON "sessions" ("tenant_id", "created_at" DESC, "id" DESC);

-- Agents.
CREATE INDEX IF NOT EXISTS "idx_agents_tenant_created_id"
  ON "agents" ("tenant_id", "created_at" DESC, "id" DESC);

-- Environments.
CREATE INDEX IF NOT EXISTS "idx_environments_tenant_created_id"
  ON "environments" ("tenant_id", "created_at" DESC, "id" DESC);

-- Vaults.
CREATE INDEX IF NOT EXISTS "idx_vaults_tenant_created_id"
  ON "vaults" ("tenant_id", "created_at" DESC, "id" DESC);

-- Model cards.
CREATE INDEX IF NOT EXISTS "idx_model_cards_tenant_created_id"
  ON "model_cards" ("tenant_id", "created_at" DESC, "id" DESC);
