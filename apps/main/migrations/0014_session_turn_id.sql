-- 0014_session_turn_id.sql
--
-- Phase 1 of the unified-runtime refactor (see plan in
-- /Users/minimax/.claude/plans/nifty-prancing-flamingo.md).
--
-- Goal: replace the cf_agents_runs marker row mechanism with a unified
-- turn_id + turn_started_at on the sessions row. After this migration, both
-- CF (apps/agent SessionDO shell) and Node (apps/main-node) detect orphan
-- turns by SELECTing `WHERE status='running'`. cf_agents_runs stays in
-- place during the transition so in-flight legacy turns at deploy time
-- still get recovered by the old `_checkRunFibers` path; Phase 4 drops
-- the table entirely.
--
-- Note: cf_agents_runs is per-DO storage SQL (not the shared D1 these
-- migrations target), so this migration touches only the shared `sessions`
-- table — no backfill SQL needed here. When session-do.ts is refactored
-- in Phase 3, the new code will set turn_id on every beginTurn(), and
-- `_checkRunFibers` becomes a no-op once the table is empty.

ALTER TABLE "sessions" ADD COLUMN "turn_id" TEXT;
ALTER TABLE "sessions" ADD COLUMN "turn_started_at" INTEGER;

-- Partial index for the orphan scan: scoped to running rows only so the
-- index stays tiny (most rows are 'idle' / 'destroyed' / 'archived').
CREATE INDEX IF NOT EXISTS "idx_sessions_running"
  ON "sessions" ("tenant_id", "id")
  WHERE "status" = 'running';
