-- 0016_session_terminated_at.sql
--
-- AMA's `terminated` lifecycle terminus needs to persist beyond the
-- SessionDO's per-DO storage so that:
--   - GET / LIST through D1 (without a sandbox round-trip) reflects
--     terminated state
--   - cost dashboards / queries that join on `sessions` see the
--     terminus
--   - DO eviction + cold-start (the DO storage survives, but if the
--     route layer wants to fail-fast without a DO RPC, it needs D1)
--
-- Sequence:
--   - Phase 0 (this migration): ADD COLUMN. Backfill all existing
--     rows to NULL — no row is "retroactively terminated".
--   - Phase 1: SessionDO.terminate() RPCs back through RuntimeAdapter
--     to set terminated_at + status='terminated' on D1.
--   - Phase 2: toApiSession surfaces terminated_at on the wire.
--
-- The status enum gains a 'terminated' value alongside the existing
-- 'idle' / 'running' / 'destroyed'. AMA's enum is just one bigger than
-- ours and this brings it in line.

ALTER TABLE "sessions" ADD COLUMN "terminated_at" INTEGER;

-- Partial index for the terminated scan: every dashboard / cost report
-- query that wants "all live sessions" filters out terminated_at IS NOT NULL.
-- Most rows will be NULL so the index stays small.
CREATE INDEX IF NOT EXISTS "idx_sessions_terminated"
  ON "sessions" ("tenant_id", "terminated_at")
  WHERE "terminated_at" IS NOT NULL;
