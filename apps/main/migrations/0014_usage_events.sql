-- 0014_usage_events.sql
--
-- Per-(tenant, session) sandbox active-time metering. The agent worker's
-- OmaSandbox writes a row at every onStop / onActivityExpired with the
-- elapsed wall-clock between warmup completion and stop. CF Containers
-- bill on exactly this active window (memory-second + vCPU-second), so
-- sandbox_active_seconds is the canonical "what to pass to billing" unit.
--
-- Used by:
--   - apps/main /v1/usage/* routes — Console "Usage" page (every
--     deployment, including self-hosters, sees its own per-session
--     active minutes for capacity planning + matching against the CF
--     dashboard bill).
--   - hosted billing worker (private) — when the optional BILLING
--     service binding is configured on apps/main, main mirrors each row
--     via env.BILLING.recordUsage(...) so the wallet ledger debits in
--     lockstep. Self-host deployments leave BILLING unbound; the rows
--     still land here for observability, the wallet bookkeeping is
--     simply skipped.
--
-- runtime_kind:
--   'cloud' = CF Container sandbox (billable in hosted)
--   'local' = agent.runtime_binding session, container never spun, $0
--             cost. Recorded for observability symmetry; useful for
--             local-runtime users to see their session activity in the
--             same Usage page.

CREATE TABLE IF NOT EXISTS "usage_events" (
  "id"                       TEXT PRIMARY KEY NOT NULL,
  "tenant_id"                TEXT NOT NULL,
  "session_id"               TEXT NOT NULL,
  "agent_id"                 TEXT,
  "environment_id"           TEXT,
  "event_type"               TEXT NOT NULL,
  "runtime_kind"             TEXT NOT NULL,
  "sandbox_active_seconds"   INTEGER NOT NULL DEFAULT 0,
  "started_at"               INTEGER NOT NULL,
  "ended_at"                 INTEGER NOT NULL,
  "exit_code"                INTEGER,
  "exit_reason"              TEXT,
  "metadata_json"            TEXT,
  "created_at"               INTEGER NOT NULL
);

-- Console list / aggregate queries: by tenant, newest first.
CREATE INDEX IF NOT EXISTS "idx_usage_events_tenant_started"
  ON "usage_events" ("tenant_id", "started_at" DESC);

-- Per-session drilldown (all warmup/sleep cycles within a single session).
CREATE INDEX IF NOT EXISTS "idx_usage_events_session"
  ON "usage_events" ("session_id", "started_at" DESC);
