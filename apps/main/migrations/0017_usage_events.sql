-- 0017_usage_events.sql — raw resource-usage event log.
--
-- OSS owns this table. Knows nothing about money or rates — it just counts
-- seconds. The hosted billing worker reads via /v1/internal/usage_events,
-- applies its rate map, debits credit_ledger, then POSTs ack with the ids.
--
-- Three resource kinds today (see packages/services/src/usage.ts UsageKind):
--   session_alive_seconds   — wall-clock from session-create to terminate
--   sandbox_active_seconds  — container running (start → stop)
--   browser_active_seconds  — Playwright Page open (first call → close)
--
-- billed_at is the marker the billing worker sets via ack. The unbilled
-- partial index keeps the hot listUnbilled scan O(unbilled-rows) instead
-- of O(all-time-rows-this-tenant).

CREATE TABLE IF NOT EXISTS usage_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  agent_id    TEXT,
  kind        TEXT NOT NULL,
  value       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  billed_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_usage_events_unbilled
  ON usage_events (tenant_id, id) WHERE billed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_usage_events_session
  ON usage_events (session_id);
