-- linear_pending_events: queue of webhook-triggered events awaiting async dispatch.
--
-- New architecture (see PR description): webhook handler no longer spawns
-- sessions synchronously. It (a) for AgentSessionEvent, fires a one-shot
-- AgentActivity ack to close the panel, then (b) writes the parsed event
-- here and returns 200 to Linear in <500ms. The cron sweep drains this
-- table on each tick, calling sessions.create per event. This decouples
-- Linear's tight webhook deadline from the cold-start cost of SessionDO +
-- sandbox boot.
--
-- payload_json: serialized NormalizedWebhookEvent. Re-parsed at drain time
-- and passed to LinearProvider.processPendingEvent. Storing the full
-- normalized blob (rather than just the raw Linear payload) means drain
-- code doesn't need to re-run parseWebhook and stays decoupled from the
-- raw envelope shape.
--
-- processed_at NULL → still in queue. Set on successful dispatch.
-- error_message: set on dispatch failure. Operator decides whether to
-- retry by clearing processed_at + error_message, or to GC by leaving
-- them as a record.

CREATE TABLE IF NOT EXISTS "linear_pending_events" (
  "id"                     TEXT PRIMARY KEY NOT NULL,
  "tenant_id"              TEXT NOT NULL,
  "publication_id"         TEXT NOT NULL,
  "event_kind"             TEXT NOT NULL,
  "issue_id"               TEXT,
  "issue_identifier"       TEXT,
  "workspace_id"           TEXT,
  "payload_json"           TEXT NOT NULL,
  "received_at"            INTEGER NOT NULL,
  "processed_at"           INTEGER,
  "processed_session_id"   TEXT,
  "error_message"          TEXT
);

-- Hot path: drain query is "WHERE processed_at IS NULL ORDER BY received_at ASC LIMIT N".
-- Partial index keeps it cheap regardless of how many processed rows accumulate.
CREATE INDEX IF NOT EXISTS "idx_linear_pending_events_unprocessed"
  ON "linear_pending_events" ("received_at")
  WHERE "processed_at" IS NULL;

-- Per-publication listing for ops debugging.
CREATE INDEX IF NOT EXISTS "idx_linear_pending_events_publication"
  ON "linear_pending_events" ("publication_id", "received_at" DESC);

-- Tenant-scoped listing for cross-publication views.
CREATE INDEX IF NOT EXISTS "idx_linear_pending_events_tenant"
  ON "linear_pending_events" ("tenant_id", "received_at" DESC);
