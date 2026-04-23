-- Linear integration tables. Owned (conceptually) by
-- packages/integrations-adapters-cf; lives here because wrangler discovers
-- migrations relative to the worker config and we share AUTH_DB with
-- apps/integrations.

-- Per-publication Linear App credentials (A1 mode only).
-- Each row pairs with at most one linear_publications row in mode='full'.
-- publication_id is nullable to support the A1 install flow: credentials are
-- stored before the publication exists (chicken/egg). It's set after OAuth
-- completes. UNIQUE on a nullable column allows multiple NULLs per SQLite.
CREATE TABLE IF NOT EXISTS "linear_apps" (
  "id"                    TEXT PRIMARY KEY NOT NULL,
  "publication_id"        TEXT UNIQUE,
  "client_id"             TEXT NOT NULL,
  "client_secret_cipher"  TEXT NOT NULL,        -- AES-GCM ciphertext
  "webhook_secret_cipher" TEXT NOT NULL,        -- AES-GCM ciphertext
  "created_at"            INTEGER NOT NULL
);

-- Workspace installations. One row per (workspace, install_kind, app_id) where
-- install_kind='shared' means the user installed the shared OMA Linear App
-- (B+) and 'dedicated' means a per-publication App from linear_apps (A1).
CREATE TABLE IF NOT EXISTS "linear_installations" (
  "id"                    TEXT PRIMARY KEY NOT NULL,
  "user_id"               TEXT NOT NULL,
  "provider_id"           TEXT NOT NULL,        -- 'linear' (future: 'slack' etc.)
  "workspace_id"          TEXT NOT NULL,
  "workspace_name"        TEXT NOT NULL,
  "install_kind"          TEXT NOT NULL,        -- 'shared' | 'dedicated'
  "app_id"                TEXT,                 -- FK linear_apps.id (A1 only)
  "access_token_cipher"   TEXT NOT NULL,
  "refresh_token_cipher"  TEXT,
  "scopes"                TEXT NOT NULL,        -- JSON array of strings
  "bot_user_id"           TEXT NOT NULL,
  "created_at"            INTEGER NOT NULL,
  "revoked_at"            INTEGER
);

-- One active install per (provider, workspace, kind, app). For shared installs
-- app_id is NULL; we coalesce so the unique constraint still applies.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_linear_installations_active"
  ON "linear_installations" ("provider_id", "workspace_id", "install_kind", COALESCE("app_id", ''))
  WHERE "revoked_at" IS NULL;

CREATE INDEX IF NOT EXISTS "idx_linear_installations_user"
  ON "linear_installations" ("user_id", "provider_id");

-- Agent ↔ workspace bindings. Each represents one OMA agent published to a
-- Linear workspace under a specific install.
CREATE TABLE IF NOT EXISTS "linear_publications" (
  "id"                    TEXT PRIMARY KEY NOT NULL,
  "user_id"               TEXT NOT NULL,
  "agent_id"              TEXT NOT NULL,
  "installation_id"       TEXT NOT NULL,        -- soft FK to linear_installations (cascade in app layer)
  "mode"                  TEXT NOT NULL,        -- 'full' | 'quick'
  "status"                TEXT NOT NULL,        -- pending_setup|awaiting_install|live|needs_reauth|unpublished
  "persona_name"          TEXT NOT NULL,
  "persona_avatar_url"    TEXT,
  "slash_command"         TEXT,                 -- B+ routing; NULL for A1
  "capabilities"          TEXT NOT NULL,        -- JSON array of capability keys
  "session_granularity"   TEXT NOT NULL,        -- 'per_issue' | 'per_event'
  "is_default_agent"      INTEGER NOT NULL,     -- 0/1; B+ default routing target
  "created_at"            INTEGER NOT NULL,
  "unpublished_at"        INTEGER
);

CREATE INDEX IF NOT EXISTS "idx_linear_publications_installation"
  ON "linear_publications" ("installation_id");

CREATE INDEX IF NOT EXISTS "idx_linear_publications_user_agent"
  ON "linear_publications" ("user_id", "agent_id");

-- At most one default agent per installation when live.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_linear_publications_default"
  ON "linear_publications" ("installation_id")
  WHERE "is_default_agent" = 1 AND "status" = 'live';

-- Webhook idempotency + ops backfill log. delivery_id is Linear's unique id.
CREATE TABLE IF NOT EXISTS "linear_webhook_events" (
  "delivery_id"     TEXT PRIMARY KEY NOT NULL,
  "installation_id" TEXT NOT NULL,
  "publication_id"  TEXT,                       -- set after routing
  "event_type"      TEXT NOT NULL,
  "received_at"     INTEGER NOT NULL,
  "session_id"      TEXT,                       -- set after dispatch
  "error"           TEXT
);

CREATE INDEX IF NOT EXISTS "idx_linear_webhook_events_received"
  ON "linear_webhook_events" ("received_at");

-- Setup link tokens for non-admin handoff (publisher → workspace admin).
CREATE TABLE IF NOT EXISTS "linear_setup_links" (
  "token"          TEXT PRIMARY KEY NOT NULL,
  "publication_id" TEXT NOT NULL,
  "created_by"     TEXT NOT NULL,
  "expires_at"     INTEGER NOT NULL,
  "used_at"        INTEGER,
  "used_by_email"  TEXT
);

CREATE INDEX IF NOT EXISTS "idx_linear_setup_links_expires"
  ON "linear_setup_links" ("expires_at");

-- Issue ↔ session mapping for per_issue session granularity.
CREATE TABLE IF NOT EXISTS "linear_issue_sessions" (
  "publication_id" TEXT NOT NULL,
  "issue_id"       TEXT NOT NULL,
  "session_id"     TEXT NOT NULL,
  "status"         TEXT NOT NULL,               -- active|completed|human_handoff|rerouted|escalated
  "created_at"     INTEGER NOT NULL,
  PRIMARY KEY ("publication_id", "issue_id")
);

CREATE INDEX IF NOT EXISTS "idx_linear_issue_sessions_active"
  ON "linear_issue_sessions" ("publication_id", "status");
