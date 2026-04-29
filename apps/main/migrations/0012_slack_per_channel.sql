-- Slack per_channel session granularity support.
--
-- Adds three nullable columns to slack_thread_sessions:
--   pending_scan_until — debounce watermark for channel-scope scan turns. When
--                        set to a future ms timestamp, an "armed" channel-scan
--                        has already been dispatched and incoming top-level
--                        messages within the window are silently throttled.
--                        Cleared by the agent (via provider helper) once the
--                        scheduled wakeup runs the actual conversations.history
--                        sweep. Self-healing: once the timestamp lapses, the
--                        next top-level message re-arms it.
--   last_scan_at       — ms timestamp of the most recent completed scan turn.
--                        Agent reads this on wake to bound `oldest=` in
--                        conversations.history calls.
--   channel_name       — cached channel display name. Updated on
--                        channel_rename without waking the agent; the agent
--                        reads it from session metadata on next wake.
--
-- All three are nullable. Existing per_thread rows leave them NULL — the
-- per_thread dispatch path doesn't touch them, so no backfill is needed.

ALTER TABLE "slack_thread_sessions" ADD COLUMN "pending_scan_until" INTEGER;
ALTER TABLE "slack_thread_sessions" ADD COLUMN "last_scan_at"       INTEGER;
ALTER TABLE "slack_thread_sessions" ADD COLUMN "channel_name"       TEXT;
