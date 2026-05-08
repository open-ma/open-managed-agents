-- ============================================================
-- 0014: drop integration tables from AUTH_DB (post-cutover cleanup).
-- ============================================================
--
-- The integration subsystem (linear_*/github_*/slack_*) moved to its own
-- D1 database (INTEGRATIONS_DB) — see apps/main/migrations-integrations/
-- and the worktree branch `worktree-integrations-db-split`.
--
-- This migration removes the now-stranded tables from AUTH_DB. Apply
-- ONLY AFTER:
--   1. INTEGRATIONS_DB has been created and seeded via the new schema.
--   2. Data migration script has run (scripts/migrate-integrations-to-own-db.ts).
--   3. Production traffic has been cut over and verified for ≥1 week —
--      enough time for any rollback need to surface.
--
-- This is intentionally NOT a SQLite-safe rename swap; the tables are
-- expected to be empty (after cutover, all writes go to INTEGRATIONS_DB).
-- If non-empty, the data migration script wasn't run / was incomplete —
-- DROP would lose rows. Operator should manually verify table emptiness:
--
--   wrangler d1 execute openma-auth --remote --command "
--     SELECT 'linear_events' AS t, COUNT(*) AS n FROM linear_events
--     UNION ALL SELECT 'linear_pending_events', COUNT(*) FROM linear_pending_events
--     UNION ALL SELECT 'linear_apps', COUNT(*) FROM linear_apps
--     UNION ALL SELECT 'linear_installations', COUNT(*) FROM linear_installations
--     UNION ALL SELECT 'linear_publications', COUNT(*) FROM linear_publications
--     UNION ALL SELECT 'linear_setup_links', COUNT(*) FROM linear_setup_links
--     UNION ALL SELECT 'linear_issue_sessions', COUNT(*) FROM linear_issue_sessions
--     UNION ALL SELECT 'linear_authored_comments', COUNT(*) FROM linear_authored_comments
--     UNION ALL SELECT 'linear_dispatch_rules', COUNT(*) FROM linear_dispatch_rules
--     UNION ALL SELECT 'github_apps', COUNT(*) FROM github_apps
--     UNION ALL SELECT 'github_installations', COUNT(*) FROM github_installations
--     UNION ALL SELECT 'github_publications', COUNT(*) FROM github_publications
--     UNION ALL SELECT 'slack_apps', COUNT(*) FROM slack_apps
--     UNION ALL SELECT 'slack_installations', COUNT(*) FROM slack_installations
--     UNION ALL SELECT 'slack_publications', COUNT(*) FROM slack_publications
--     UNION ALL SELECT 'slack_webhook_events', COUNT(*) FROM slack_webhook_events
--     UNION ALL SELECT 'slack_setup_links', COUNT(*) FROM slack_setup_links
--     UNION ALL SELECT 'slack_thread_sessions', COUNT(*) FROM slack_thread_sessions"
--
-- All counts must be 0. If any aren't, STOP and re-run the migration script
-- in --resume mode against the missing tables before applying this.
--
-- The historic linear_webhook_events and linear_pending_events tables (which
-- predate the merge into linear_events) are also dropped — production AUTH_DB
-- still has them from the pre-merge schema.

DROP TABLE IF EXISTS "linear_apps";
DROP TABLE IF EXISTS "linear_installations";
DROP TABLE IF EXISTS "linear_publications";
DROP TABLE IF EXISTS "linear_webhook_events";
DROP TABLE IF EXISTS "linear_pending_events";
DROP TABLE IF EXISTS "linear_events";
DROP TABLE IF EXISTS "linear_setup_links";
DROP TABLE IF EXISTS "linear_issue_sessions";
DROP TABLE IF EXISTS "linear_authored_comments";
DROP TABLE IF EXISTS "linear_dispatch_rules";

DROP TABLE IF EXISTS "github_apps";
DROP TABLE IF EXISTS "github_installations";
DROP TABLE IF EXISTS "github_publications";
DROP TABLE IF EXISTS "github_webhook_events";

DROP TABLE IF EXISTS "slack_apps";
DROP TABLE IF EXISTS "slack_installations";
DROP TABLE IF EXISTS "slack_publications";
DROP TABLE IF EXISTS "slack_webhook_events";
DROP TABLE IF EXISTS "slack_setup_links";
DROP TABLE IF EXISTS "slack_thread_sessions";
