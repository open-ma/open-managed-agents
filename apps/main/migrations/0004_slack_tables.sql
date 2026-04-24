-- Slack integration tables. Parallel to linear_* tables; same shape with
-- Slack-specific column tweaks: signing_secret_cipher (per-app, not per-webhook),
-- user_token_cipher (xoxp- for mcp.slack.com), bot_vault_id (vault for direct
-- slack.com/api). Linear tables are untouched.
--
-- All tables include `tenant_id` NOT NULL — slack tables are introduced after
-- migration 0002_integrations_tenant_id.sql, so they get the column from
-- birth instead of being backfilled.

-- Per-publication Slack App credentials (A1 mode). Mirrors linear_apps with
-- signing_secret_cipher in place of webhook_secret_cipher (Slack's signing
-- secret is per-App and used for ALL events; Linear gives one secret per
-- webhook).
CREATE TABLE IF NOT EXISTS "slack_apps" (
  "id"                     TEXT PRIMARY KEY NOT NULL,
  "tenant_id"              TEXT NOT NULL,
  "publication_id"         TEXT UNIQUE,
  "client_id"              TEXT NOT NULL,
  "client_secret_cipher"   TEXT NOT NULL,        -- AES-GCM ciphertext
  "signing_secret_cipher"  TEXT NOT NULL,        -- AES-GCM ciphertext (Slack signing secret)
  "created_at"             INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_slack_apps_tenant"
  ON "slack_apps" ("tenant_id");

-- Workspace installations. install_kind is always 'dedicated' for v1 (Slack
-- has no shared B+ pattern yet). Carries TWO tokens — bot xoxb- in
-- access_token_cipher (same slot as Linear), user xoxp- in
-- user_token_cipher (Slack-only, required for mcp.slack.com).
CREATE TABLE IF NOT EXISTS "slack_installations" (
  "id"                    TEXT PRIMARY KEY NOT NULL,
  "tenant_id"             TEXT NOT NULL,
  "user_id"               TEXT NOT NULL,
  "provider_id"           TEXT NOT NULL,        -- always 'slack'
  "workspace_id"          TEXT NOT NULL,        -- team.id
  "workspace_name"        TEXT NOT NULL,
  "install_kind"          TEXT NOT NULL,        -- 'dedicated'
  "app_id"                TEXT,                 -- FK slack_apps.id
  "access_token_cipher"   TEXT NOT NULL,        -- xoxb- bot token
  "user_token_cipher"     TEXT,                 -- xoxp- user token (mcp.slack.com)
  "scopes"                TEXT NOT NULL,        -- JSON array; entries prefixed bot:/user:
  "bot_user_id"           TEXT NOT NULL,
  "vault_id"              TEXT,                 -- vault holding xoxp- (mcp.slack.com binding)
  "bot_vault_id"          TEXT,                 -- vault holding xoxb- (slack.com/api binding)
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

-- Agent ↔ workspace bindings. session_granularity defaults to 'per_thread' for
-- Slack (versus Linear's 'per_issue'). Schema otherwise identical.
CREATE TABLE IF NOT EXISTS "slack_publications" (
  "id"                    TEXT PRIMARY KEY NOT NULL,
  "tenant_id"             TEXT NOT NULL,
  "user_id"               TEXT NOT NULL,
  "agent_id"              TEXT NOT NULL,
  "installation_id"       TEXT NOT NULL REFERENCES "slack_installations"("id"),
  "environment_id"        TEXT NOT NULL,
  "mode"                  TEXT NOT NULL,        -- 'full'
  "status"                TEXT NOT NULL,        -- pending_setup|awaiting_install|live|needs_reauth|unpublished
  "persona_name"          TEXT NOT NULL,
  "persona_avatar_url"    TEXT,
  "capabilities"          TEXT NOT NULL,        -- JSON array of capability keys
  "session_granularity"   TEXT NOT NULL,        -- 'per_thread' | 'per_event'
  "created_at"            INTEGER NOT NULL,
  "unpublished_at"        INTEGER
);

CREATE INDEX IF NOT EXISTS "idx_slack_publications_installation"
  ON "slack_publications" ("installation_id");

CREATE INDEX IF NOT EXISTS "idx_slack_publications_user_agent"
  ON "slack_publications" ("user_id", "agent_id");

CREATE INDEX IF NOT EXISTS "idx_slack_publications_tenant"
  ON "slack_publications" ("tenant_id");

-- Webhook idempotency + ops backfill log. delivery_id is Slack's event_id
-- (e.g. `Ev01ABC…`).
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
  ON "slack_webhook_events" ("received_at");

CREATE INDEX IF NOT EXISTS "idx_slack_webhook_events_tenant"
  ON "slack_webhook_events" ("tenant_id");

-- Setup link tokens for non-admin handoff (publisher → workspace admin).
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

-- Per-thread session mapping. scope_key is "{channel_id}:{thread_ts | event_ts}"
-- — composed by SlackProvider before persistence; opaque here.
CREATE TABLE IF NOT EXISTS "slack_thread_sessions" (
  "publication_id" TEXT NOT NULL,
  "tenant_id"      TEXT NOT NULL,
  "scope_key"      TEXT NOT NULL,
  "session_id"     TEXT NOT NULL,
  "status"         TEXT NOT NULL,               -- active|completed|human_handoff|rerouted|escalated
  "created_at"     INTEGER NOT NULL,
  PRIMARY KEY ("publication_id", "scope_key")
);

CREATE INDEX IF NOT EXISTS "idx_slack_thread_sessions_active"
  ON "slack_thread_sessions" ("publication_id", "status");

CREATE INDEX IF NOT EXISTS "idx_slack_thread_sessions_tenant"
  ON "slack_thread_sessions" ("tenant_id");
