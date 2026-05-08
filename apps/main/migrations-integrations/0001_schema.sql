-- ============================================================
-- INTEGRATIONS_DB schema — single canonical migration.
-- ============================================================
--
-- This is a SEPARATE D1 database from AUTH_DB, holding the integration
-- subsystem's tables only (linear_*, github_*, slack_*). Bootstrap path:
--
--   wrangler d1 create openma-integrations
--   # paste returned database_id into wrangler.jsonc INTEGRATIONS_DB binding
--   wrangler d1 migrations apply --database openma-integrations --remote \
--     --migrations-dir apps/main/migrations-integrations
--
-- For brown-field tenants whose data lives in AUTH_DB, run
--   pnpm tsx scripts/migrate-integrations-to-own-db.ts --target=remote
-- ONCE per environment to copy rows over. After verification, apply
-- apps/main/migrations/0014_drop_integration_tables.sql to AUTH_DB.
--
-- House style mirrors apps/main/migrations/0001_schema.sql:
--   - INTEGER timestamps (Unix ms)
--   - No FK constraints (cascade in app layer)
--   - Partial UNIQUE indexes for active-only constraints
--   - JSON blobs as TEXT
--   - tenant_id NOT NULL on every table (no nullable transition needed —
--     this is a green-field DB, not the AUTH_DB backfill story)
--
-- Two design changes vs. the AUTH_DB shape these tables came from:
--   1. GitHub webhook events are now in their OWN table (github_webhook_events)
--      instead of borrowing linear_webhook_events. Completes the split that
--      0009_split_github_tables.sql started.
--   2. Linear webhook_events + pending_events are MERGED into linear_events.
--      One table now serves three roles: dedup (delivery_id PK), audit
--      (received_at + error), and async dispatch queue (payload_json +
--      processed_at). See LinearEventStore in integrations-core for the
--      contract. Schema below documents column semantics.

-- ============================================================
-- LINEAR
-- ============================================================

-- Per-publication Linear App credentials (A1 mode only). Each row pairs
-- with at most one linear_publications row in mode='full'. publication_id
-- is nullable to support the A1 install flow (credentials before publication).
CREATE TABLE IF NOT EXISTS "linear_apps" (
  "id"                    TEXT PRIMARY KEY NOT NULL,
  "tenant_id"             TEXT NOT NULL,
  "publication_id"        TEXT UNIQUE,
  "client_id"             TEXT NOT NULL,
  "client_secret_cipher"  TEXT NOT NULL,
  "webhook_secret_cipher" TEXT NOT NULL,
  "created_at"            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_linear_apps_tenant"
  ON "linear_apps" ("tenant_id");

-- Workspace installations. install_kind: 'shared' (B+) | 'dedicated' (A1) |
-- 'personal_token' (PR #21). vault_id holds the bearer credential vault for
-- the external API.
CREATE TABLE IF NOT EXISTS "linear_installations" (
  "id"                    TEXT PRIMARY KEY NOT NULL,
  "tenant_id"             TEXT NOT NULL,
  "user_id"               TEXT NOT NULL,
  "provider_id"           TEXT NOT NULL,
  "workspace_id"          TEXT NOT NULL,
  "workspace_name"        TEXT NOT NULL,
  "install_kind"          TEXT NOT NULL,
  "app_id"                TEXT,
  "access_token_cipher"   TEXT NOT NULL,
  "refresh_token_cipher"  TEXT,
  "scopes"                TEXT NOT NULL,
  "bot_user_id"           TEXT NOT NULL,
  "created_at"            INTEGER NOT NULL,
  "revoked_at"            INTEGER,
  "vault_id"              TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_linear_installations_active"
  ON "linear_installations" ("provider_id", "workspace_id", "install_kind", COALESCE("app_id", ''))
  WHERE "revoked_at" IS NULL;

CREATE INDEX IF NOT EXISTS "idx_linear_installations_user"
  ON "linear_installations" ("user_id", "provider_id");

CREATE INDEX IF NOT EXISTS "idx_linear_installations_tenant"
  ON "linear_installations" ("tenant_id", "created_at" DESC);

-- Agent ↔ workspace bindings.
CREATE TABLE IF NOT EXISTS "linear_publications" (
  "id"                    TEXT PRIMARY KEY NOT NULL,
  "tenant_id"             TEXT NOT NULL,
  "user_id"               TEXT NOT NULL,
  "agent_id"              TEXT NOT NULL,
  "installation_id"       TEXT NOT NULL,
  "mode"                  TEXT NOT NULL,
  "status"                TEXT NOT NULL,
  "persona_name"          TEXT NOT NULL,
  "persona_avatar_url"    TEXT,
  "capabilities"          TEXT NOT NULL,
  "session_granularity"   TEXT NOT NULL,
  "created_at"            INTEGER NOT NULL,
  "unpublished_at"        INTEGER,
  "environment_id"        TEXT
);

CREATE INDEX IF NOT EXISTS "idx_linear_publications_installation"
  ON "linear_publications" ("installation_id");

CREATE INDEX IF NOT EXISTS "idx_linear_publications_user_agent"
  ON "linear_publications" ("user_id", "agent_id");

CREATE INDEX IF NOT EXISTS "idx_linear_publications_tenant"
  ON "linear_publications" ("tenant_id", "created_at" DESC);

-- ─── linear_events ─────────────────────────────────────────────────────────
-- Merged table (was linear_webhook_events + linear_pending_events).
-- Three roles in one row, transitioned via UPDATE:
--
--   1. DEDUP — delivery_id PK + INSERT OR IGNORE on webhook entry.
--      All other columns may be empty at this stage.
--
--   2. AUDIT — `error` column set when the webhook was deduped successfully
--      but the handler chose not to act (unparseable, no_live_publication,
--      kind=null, comment_from_bot_self, etc). Such rows have payload_json
--      NULL → invisible to drain.
--
--   3. QUEUE — when the handler decides the event is actionable, it sets
--      payload_json + event_kind + publication_id (markActionable in the
--      LinearEventStore port). The drain SELECTs WHERE payload_json IS NOT
--      NULL AND processed_at IS NULL — partial index keeps it cheap.
--      On successful dispatch the drain sets processed_at + processed_session_id;
--      on failure it sets processed_at + error.
CREATE TABLE IF NOT EXISTS "linear_events" (
  "delivery_id"            TEXT PRIMARY KEY NOT NULL,
  "tenant_id"              TEXT NOT NULL,
  "installation_id"        TEXT NOT NULL,
  "publication_id"         TEXT,
  "event_type"             TEXT NOT NULL,
  "received_at"            INTEGER NOT NULL,
  "session_id"             TEXT,
  "error"                  TEXT,
  -- queue role
  "event_kind"             TEXT,
  "payload_json"           TEXT,
  "processed_at"           INTEGER,
  "processed_session_id"   TEXT
);

CREATE INDEX IF NOT EXISTS "idx_linear_events_received"
  ON "linear_events" ("received_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_linear_events_tenant"
  ON "linear_events" ("tenant_id", "received_at" DESC);

-- Drain hot path: actionable + not yet processed. Partial keeps scan O(queue depth).
CREATE INDEX IF NOT EXISTS "idx_linear_events_unprocessed"
  ON "linear_events" ("received_at")
  WHERE "payload_json" IS NOT NULL AND "processed_at" IS NULL;

-- Per-publication ops listing.
CREATE INDEX IF NOT EXISTS "idx_linear_events_publication"
  ON "linear_events" ("publication_id", "received_at" DESC);

-- Setup link tokens for non-admin handoff (publisher → workspace admin).
CREATE TABLE IF NOT EXISTS "linear_setup_links" (
  "token"          TEXT PRIMARY KEY NOT NULL,
  "tenant_id"      TEXT NOT NULL,
  "publication_id" TEXT NOT NULL,
  "created_by"     TEXT NOT NULL,
  "expires_at"     INTEGER NOT NULL,
  "used_at"        INTEGER,
  "used_by_email"  TEXT
);

CREATE INDEX IF NOT EXISTS "idx_linear_setup_links_expires"
  ON "linear_setup_links" ("expires_at");

CREATE INDEX IF NOT EXISTS "idx_linear_setup_links_tenant"
  ON "linear_setup_links" ("tenant_id");

-- Issue ↔ session mapping for per_issue session granularity.
CREATE TABLE IF NOT EXISTS "linear_issue_sessions" (
  "publication_id" TEXT NOT NULL,
  "tenant_id"      TEXT NOT NULL,
  "issue_id"       TEXT NOT NULL,
  "session_id"     TEXT NOT NULL,
  "status"         TEXT NOT NULL,
  "created_at"     INTEGER NOT NULL,
  PRIMARY KEY ("publication_id", "issue_id")
);

CREATE INDEX IF NOT EXISTS "idx_linear_issue_sessions_active"
  ON "linear_issue_sessions" ("publication_id", "status");

CREATE INDEX IF NOT EXISTS "idx_linear_issue_sessions_tenant"
  ON "linear_issue_sessions" ("tenant_id");

-- Tracks comments the bot authored via the OMA Linear MCP `linear_post_comment`
-- tool. parentId on a Linear webhook resolves here → omaSessionId → dispatch.
CREATE TABLE IF NOT EXISTS "linear_authored_comments" (
  "comment_id"     TEXT PRIMARY KEY,
  "tenant_id"      TEXT NOT NULL,
  "oma_session_id" TEXT NOT NULL,
  "issue_id"       TEXT NOT NULL,
  "created_at"     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_linear_authored_comments_session"
  ON "linear_authored_comments" ("oma_session_id");

CREATE INDEX IF NOT EXISTS "idx_linear_authored_comments_tenant"
  ON "linear_authored_comments" ("tenant_id");

-- Autopilot dispatch rules (PR #21).
CREATE TABLE IF NOT EXISTS "linear_dispatch_rules" (
  "id"                     TEXT PRIMARY KEY NOT NULL,
  "tenant_id"              TEXT NOT NULL,
  "publication_id"         TEXT NOT NULL,
  "name"                   TEXT NOT NULL,
  "enabled"                INTEGER NOT NULL DEFAULT 1,
  "filter_label"           TEXT,
  "filter_states"          TEXT,
  "filter_project_id"      TEXT,
  "max_concurrent"         INTEGER NOT NULL DEFAULT 5,
  "poll_interval_seconds"  INTEGER NOT NULL DEFAULT 600,
  "last_polled_at"         INTEGER,
  "created_at"             INTEGER NOT NULL,
  "updated_at"             INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_linear_dispatch_rules_sweep"
  ON "linear_dispatch_rules" ("enabled", "last_polled_at");

CREATE INDEX IF NOT EXISTS "idx_linear_dispatch_rules_publication"
  ON "linear_dispatch_rules" ("publication_id");

CREATE INDEX IF NOT EXISTS "idx_linear_dispatch_rules_tenant"
  ON "linear_dispatch_rules" ("tenant_id", "created_at" DESC);

-- ============================================================
-- GITHUB
-- ============================================================

CREATE TABLE IF NOT EXISTS "github_apps" (
  "id"                    TEXT PRIMARY KEY NOT NULL,
  "tenant_id"             TEXT NOT NULL,
  "publication_id"        TEXT UNIQUE,
  "app_id"                TEXT NOT NULL,
  "app_slug"              TEXT NOT NULL,
  "bot_login"             TEXT NOT NULL,
  "client_id"             TEXT,
  "client_secret_cipher"  TEXT,
  "webhook_secret_cipher" TEXT NOT NULL,
  "private_key_cipher"    TEXT NOT NULL,
  "created_at"            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_github_apps_app_id"
  ON "github_apps" ("app_id");

CREATE INDEX IF NOT EXISTS "idx_github_apps_tenant"
  ON "github_apps" ("tenant_id");

CREATE TABLE IF NOT EXISTS "github_installations" (
  "id"                    TEXT PRIMARY KEY NOT NULL,
  "tenant_id"             TEXT NOT NULL,
  "user_id"               TEXT NOT NULL,
  "provider_id"           TEXT NOT NULL,
  "workspace_id"          TEXT NOT NULL,
  "workspace_name"        TEXT NOT NULL,
  "install_kind"          TEXT NOT NULL,
  "app_id"                TEXT,
  "access_token_cipher"   TEXT NOT NULL,
  "refresh_token_cipher"  TEXT,
  "scopes"                TEXT NOT NULL,
  "bot_user_id"           TEXT NOT NULL,
  "created_at"            INTEGER NOT NULL,
  "revoked_at"            INTEGER,
  "vault_id"              TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_github_installations_active"
  ON "github_installations" ("provider_id", "workspace_id", "install_kind", COALESCE("app_id", ''))
  WHERE "revoked_at" IS NULL;

CREATE INDEX IF NOT EXISTS "idx_github_installations_user"
  ON "github_installations" ("user_id", "provider_id", "revoked_at");

CREATE INDEX IF NOT EXISTS "idx_github_installations_tenant"
  ON "github_installations" ("tenant_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "github_publications" (
  "id"                    TEXT PRIMARY KEY NOT NULL,
  "tenant_id"             TEXT NOT NULL,
  "user_id"               TEXT NOT NULL,
  "agent_id"              TEXT NOT NULL,
  "installation_id"       TEXT NOT NULL,
  "mode"                  TEXT NOT NULL,
  "status"                TEXT NOT NULL,
  "persona_name"          TEXT NOT NULL,
  "persona_avatar_url"    TEXT,
  "capabilities"          TEXT NOT NULL,
  "session_granularity"   TEXT NOT NULL,
  "created_at"            INTEGER NOT NULL,
  "unpublished_at"        INTEGER,
  "environment_id"        TEXT
);

CREATE INDEX IF NOT EXISTS "idx_github_publications_installation"
  ON "github_publications" ("installation_id");

CREATE INDEX IF NOT EXISTS "idx_github_publications_user_agent"
  ON "github_publications" ("user_id", "agent_id");

CREATE INDEX IF NOT EXISTS "idx_github_publications_tenant"
  ON "github_publications" ("tenant_id", "created_at" DESC);

-- ─── github_webhook_events ─────────────────────────────────────────────────
-- NEW: GitHub webhook dedup + audit. Previously borrowed linear_webhook_events
-- (the share was a leftover from before 0009 split installations/publications).
-- delivery_id is GitHub's `x-github-delivery` header (UUID). GitHub does NOT
-- need an async queue: the gateway dispatches inline (CF subrequest budget
-- accommodates the path). So no event_kind / payload_json / processed_at
-- columns — same shape as slack_webhook_events.
CREATE TABLE IF NOT EXISTS "github_webhook_events" (
  "delivery_id"     TEXT PRIMARY KEY NOT NULL,
  "tenant_id"       TEXT NOT NULL,
  "installation_id" TEXT NOT NULL,
  "publication_id"  TEXT,
  "event_type"      TEXT NOT NULL,
  "received_at"     INTEGER NOT NULL,
  "session_id"      TEXT,
  "error"           TEXT
);

CREATE INDEX IF NOT EXISTS "idx_github_webhook_events_received"
  ON "github_webhook_events" ("received_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_github_webhook_events_tenant"
  ON "github_webhook_events" ("tenant_id", "received_at" DESC);

-- ============================================================
-- SLACK
-- ============================================================

CREATE TABLE IF NOT EXISTS "slack_apps" (
  "id"                     TEXT PRIMARY KEY NOT NULL,
  "tenant_id"              TEXT NOT NULL,
  "publication_id"         TEXT UNIQUE,
  "client_id"              TEXT NOT NULL,
  "client_secret_cipher"   TEXT NOT NULL,
  "signing_secret_cipher"  TEXT NOT NULL,
  "created_at"             INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_slack_apps_tenant"
  ON "slack_apps" ("tenant_id");

CREATE TABLE IF NOT EXISTS "slack_installations" (
  "id"                    TEXT PRIMARY KEY NOT NULL,
  "tenant_id"             TEXT NOT NULL,
  "user_id"               TEXT NOT NULL,
  "provider_id"           TEXT NOT NULL,
  "workspace_id"          TEXT NOT NULL,
  "workspace_name"        TEXT NOT NULL,
  "install_kind"          TEXT NOT NULL,
  "app_id"                TEXT,
  "access_token_cipher"   TEXT NOT NULL,
  "user_token_cipher"     TEXT,
  "scopes"                TEXT NOT NULL,
  "bot_user_id"           TEXT NOT NULL,
  "vault_id"              TEXT,
  "bot_vault_id"          TEXT,
  "created_at"            INTEGER NOT NULL,
  "revoked_at"            INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_slack_installations_active"
  ON "slack_installations" ("provider_id", "workspace_id", "install_kind", COALESCE("app_id", ''))
  WHERE "revoked_at" IS NULL;

CREATE INDEX IF NOT EXISTS "idx_slack_installations_user"
  ON "slack_installations" ("user_id", "provider_id");

CREATE INDEX IF NOT EXISTS "idx_slack_installations_tenant"
  ON "slack_installations" ("tenant_id");

CREATE TABLE IF NOT EXISTS "slack_publications" (
  "id"                    TEXT PRIMARY KEY NOT NULL,
  "tenant_id"             TEXT NOT NULL,
  "user_id"               TEXT NOT NULL,
  "agent_id"              TEXT NOT NULL,
  "installation_id"       TEXT NOT NULL,
  "environment_id"        TEXT NOT NULL,
  "mode"                  TEXT NOT NULL,
  "status"                TEXT NOT NULL,
  "persona_name"          TEXT NOT NULL,
  "persona_avatar_url"    TEXT,
  "capabilities"          TEXT NOT NULL,
  "session_granularity"   TEXT NOT NULL,
  "created_at"            INTEGER NOT NULL,
  "unpublished_at"        INTEGER
);

CREATE INDEX IF NOT EXISTS "idx_slack_publications_installation"
  ON "slack_publications" ("installation_id");

CREATE INDEX IF NOT EXISTS "idx_slack_publications_user_agent"
  ON "slack_publications" ("user_id", "agent_id");

CREATE INDEX IF NOT EXISTS "idx_slack_publications_tenant"
  ON "slack_publications" ("tenant_id");

CREATE TABLE IF NOT EXISTS "slack_webhook_events" (
  "delivery_id"     TEXT PRIMARY KEY NOT NULL,
  "tenant_id"       TEXT NOT NULL,
  "installation_id" TEXT NOT NULL,
  "publication_id"  TEXT,
  "event_type"      TEXT NOT NULL,
  "received_at"     INTEGER NOT NULL,
  "session_id"      TEXT,
  "error"           TEXT
);

CREATE INDEX IF NOT EXISTS "idx_slack_webhook_events_received"
  ON "slack_webhook_events" ("received_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_slack_webhook_events_tenant"
  ON "slack_webhook_events" ("tenant_id", "received_at" DESC);

CREATE TABLE IF NOT EXISTS "slack_setup_links" (
  "token"          TEXT PRIMARY KEY NOT NULL,
  "tenant_id"      TEXT NOT NULL,
  "publication_id" TEXT NOT NULL,
  "created_by"     TEXT NOT NULL,
  "expires_at"     INTEGER NOT NULL,
  "used_at"        INTEGER,
  "used_by_email"  TEXT
);

CREATE INDEX IF NOT EXISTS "idx_slack_setup_links_expires"
  ON "slack_setup_links" ("expires_at");

CREATE INDEX IF NOT EXISTS "idx_slack_setup_links_tenant"
  ON "slack_setup_links" ("tenant_id");

CREATE TABLE IF NOT EXISTS "slack_thread_sessions" (
  "publication_id"     TEXT NOT NULL,
  "tenant_id"          TEXT NOT NULL,
  "scope_key"          TEXT NOT NULL,
  "session_id"         TEXT NOT NULL,
  "status"             TEXT NOT NULL,
  "created_at"         INTEGER NOT NULL,
  "pending_scan_until" INTEGER,
  "last_scan_at"       INTEGER,
  "channel_name"       TEXT,
  PRIMARY KEY ("publication_id", "scope_key")
);

CREATE INDEX IF NOT EXISTS "idx_slack_thread_sessions_active"
  ON "slack_thread_sessions" ("publication_id", "status");

CREATE INDEX IF NOT EXISTS "idx_slack_thread_sessions_tenant"
  ON "slack_thread_sessions" ("tenant_id");
