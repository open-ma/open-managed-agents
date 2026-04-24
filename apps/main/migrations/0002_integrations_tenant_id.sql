-- Phase 0 of the per-tenant-D1 work: backfill tenant_id on the 8 integrations
-- tables that today derive tenant ownership only via FK-shaped joins
-- (user_id / publication_id / installation_id / oma_session_id), and pin
-- the column to NOT NULL in one shot.
--
-- "One shot" because there are no orphan rows in production / staging — every
-- existing row resolves to a tenant via its FK-shaped join. SQLite can't
-- ALTER a column to NOT NULL in place, so each table goes through the
-- standard CREATE __new / INSERT SELECT / DROP / RENAME swap.
--
-- The INSERT uses LEFT JOIN against the join source so that any row whose
-- tenant can't be resolved (a hypothetical orphan we missed) trips the
-- NOT NULL constraint and the whole migration rolls back. That's the
-- desired behaviour: better to fail loudly than silently insert an empty
-- tenant_id.
--
-- Code-side invariant added in this PR: every NewXxx adapter input has
-- tenantId: string (not string | null), and every domain row type's
-- tenantId is now string. There's no nullable transition to maintain.

-- ─── linear_installations: tenant via user.tenantId ──────────────────────
CREATE TABLE "linear_installations__new" (
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
INSERT INTO "linear_installations__new" (
  "id", "tenant_id", "user_id", "provider_id", "workspace_id", "workspace_name",
  "install_kind", "app_id", "access_token_cipher", "refresh_token_cipher",
  "scopes", "bot_user_id", "created_at", "revoked_at", "vault_id"
)
SELECT
  x."id", u."tenantId", x."user_id", x."provider_id", x."workspace_id", x."workspace_name",
  x."install_kind", x."app_id", x."access_token_cipher", x."refresh_token_cipher",
  x."scopes", x."bot_user_id", x."created_at", x."revoked_at", x."vault_id"
FROM "linear_installations" x
LEFT JOIN "user" u ON u."id" = x."user_id";
DROP TABLE "linear_installations";
ALTER TABLE "linear_installations__new" RENAME TO "linear_installations";
CREATE UNIQUE INDEX IF NOT EXISTS "idx_linear_installations_active"
  ON "linear_installations" ("provider_id", "workspace_id", "install_kind", COALESCE("app_id", ''))
  WHERE "revoked_at" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_linear_installations_user"
  ON "linear_installations" ("user_id", "provider_id", "revoked_at");
CREATE INDEX IF NOT EXISTS "idx_linear_installations_tenant"
  ON "linear_installations" ("tenant_id", "created_at" DESC);

-- ─── linear_publications: tenant via user.tenantId ───────────────────────
-- Must run AFTER linear_installations swap (no FK either way, just clarity).
CREATE TABLE "linear_publications__new" (
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
INSERT INTO "linear_publications__new" (
  "id", "tenant_id", "user_id", "agent_id", "installation_id", "mode", "status",
  "persona_name", "persona_avatar_url", "capabilities", "session_granularity",
  "created_at", "unpublished_at", "environment_id"
)
SELECT
  x."id", u."tenantId", x."user_id", x."agent_id", x."installation_id", x."mode", x."status",
  x."persona_name", x."persona_avatar_url", x."capabilities", x."session_granularity",
  x."created_at", x."unpublished_at", x."environment_id"
FROM "linear_publications" x
LEFT JOIN "user" u ON u."id" = x."user_id";
DROP TABLE "linear_publications";
ALTER TABLE "linear_publications__new" RENAME TO "linear_publications";
CREATE INDEX IF NOT EXISTS "idx_linear_publications_installation"
  ON "linear_publications" ("installation_id");
CREATE INDEX IF NOT EXISTS "idx_linear_publications_user_agent"
  ON "linear_publications" ("user_id", "agent_id");
CREATE INDEX IF NOT EXISTS "idx_linear_publications_tenant"
  ON "linear_publications" ("tenant_id", "created_at" DESC);

-- ─── linear_apps: tenant via linear_publications.tenant_id ───────────────
-- Must run AFTER linear_publications swap so the join sees the new tenant_id.
CREATE TABLE "linear_apps__new" (
  "id"                    TEXT PRIMARY KEY NOT NULL,
  "tenant_id"             TEXT NOT NULL,
  "publication_id"        TEXT UNIQUE,
  "client_id"             TEXT NOT NULL,
  "client_secret_cipher"  TEXT NOT NULL,
  "webhook_secret_cipher" TEXT NOT NULL,
  "created_at"            INTEGER NOT NULL
);
INSERT INTO "linear_apps__new" (
  "id", "tenant_id", "publication_id", "client_id", "client_secret_cipher",
  "webhook_secret_cipher", "created_at"
)
SELECT
  x."id", p."tenant_id", x."publication_id", x."client_id", x."client_secret_cipher",
  x."webhook_secret_cipher", x."created_at"
FROM "linear_apps" x
LEFT JOIN "linear_publications" p ON p."id" = x."publication_id";
DROP TABLE "linear_apps";
ALTER TABLE "linear_apps__new" RENAME TO "linear_apps";
CREATE INDEX IF NOT EXISTS "idx_linear_apps_tenant" ON "linear_apps" ("tenant_id");

-- ─── github_apps: same shape as linear_apps ──────────────────────────────
CREATE TABLE "github_apps__new" (
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
INSERT INTO "github_apps__new" (
  "id", "tenant_id", "publication_id", "app_id", "app_slug", "bot_login",
  "client_id", "client_secret_cipher", "webhook_secret_cipher",
  "private_key_cipher", "created_at"
)
SELECT
  x."id", p."tenant_id", x."publication_id", x."app_id", x."app_slug", x."bot_login",
  x."client_id", x."client_secret_cipher", x."webhook_secret_cipher",
  x."private_key_cipher", x."created_at"
FROM "github_apps" x
LEFT JOIN "linear_publications" p ON p."id" = x."publication_id";
DROP TABLE "github_apps";
ALTER TABLE "github_apps__new" RENAME TO "github_apps";
CREATE INDEX IF NOT EXISTS "idx_github_apps_app_id" ON "github_apps" ("app_id");
CREATE INDEX IF NOT EXISTS "idx_github_apps_tenant" ON "github_apps" ("tenant_id");

-- ─── linear_webhook_events: tenant via linear_installations ──────────────
CREATE TABLE "linear_webhook_events__new" (
  "delivery_id"     TEXT PRIMARY KEY NOT NULL,
  "tenant_id"       TEXT NOT NULL,
  "installation_id" TEXT NOT NULL,
  "publication_id"  TEXT,
  "event_type"      TEXT NOT NULL,
  "received_at"     INTEGER NOT NULL,
  "session_id"      TEXT,
  "error"           TEXT
);
INSERT INTO "linear_webhook_events__new" (
  "delivery_id", "tenant_id", "installation_id", "publication_id",
  "event_type", "received_at", "session_id", "error"
)
SELECT
  x."delivery_id", i."tenant_id", x."installation_id", x."publication_id",
  x."event_type", x."received_at", x."session_id", x."error"
FROM "linear_webhook_events" x
LEFT JOIN "linear_installations" i ON i."id" = x."installation_id";
DROP TABLE "linear_webhook_events";
ALTER TABLE "linear_webhook_events__new" RENAME TO "linear_webhook_events";
CREATE INDEX IF NOT EXISTS "idx_linear_webhook_events_received"
  ON "linear_webhook_events" ("received_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_linear_webhook_events_tenant"
  ON "linear_webhook_events" ("tenant_id", "received_at" DESC);

-- ─── linear_setup_links: tenant via user.tenantId (created_by → user) ────
CREATE TABLE "linear_setup_links__new" (
  "token"          TEXT PRIMARY KEY NOT NULL,
  "tenant_id"      TEXT NOT NULL,
  "publication_id" TEXT NOT NULL,
  "created_by"     TEXT NOT NULL,
  "expires_at"     INTEGER NOT NULL,
  "used_at"        INTEGER,
  "used_by_email"  TEXT
);
INSERT INTO "linear_setup_links__new" (
  "token", "tenant_id", "publication_id", "created_by", "expires_at",
  "used_at", "used_by_email"
)
SELECT
  x."token", u."tenantId", x."publication_id", x."created_by", x."expires_at",
  x."used_at", x."used_by_email"
FROM "linear_setup_links" x
LEFT JOIN "user" u ON u."id" = x."created_by";
DROP TABLE "linear_setup_links";
ALTER TABLE "linear_setup_links__new" RENAME TO "linear_setup_links";
CREATE INDEX IF NOT EXISTS "idx_linear_setup_links_expires"
  ON "linear_setup_links" ("expires_at");
CREATE INDEX IF NOT EXISTS "idx_linear_setup_links_tenant"
  ON "linear_setup_links" ("tenant_id", "expires_at");

-- ─── linear_issue_sessions: tenant via linear_publications ───────────────
CREATE TABLE "linear_issue_sessions__new" (
  "tenant_id"      TEXT NOT NULL,
  "publication_id" TEXT NOT NULL,
  "issue_id"       TEXT NOT NULL,
  "session_id"     TEXT NOT NULL,
  "status"         TEXT NOT NULL,
  "created_at"     INTEGER NOT NULL,
  PRIMARY KEY ("publication_id", "issue_id")
);
INSERT INTO "linear_issue_sessions__new" (
  "tenant_id", "publication_id", "issue_id", "session_id", "status", "created_at"
)
SELECT
  p."tenant_id", x."publication_id", x."issue_id", x."session_id", x."status", x."created_at"
FROM "linear_issue_sessions" x
LEFT JOIN "linear_publications" p ON p."id" = x."publication_id";
DROP TABLE "linear_issue_sessions";
ALTER TABLE "linear_issue_sessions__new" RENAME TO "linear_issue_sessions";
CREATE INDEX IF NOT EXISTS "idx_linear_issue_sessions_active"
  ON "linear_issue_sessions" ("publication_id", "status")
  WHERE "status" = 'active';
CREATE INDEX IF NOT EXISTS "idx_linear_issue_sessions_tenant"
  ON "linear_issue_sessions" ("tenant_id", "status");

-- ─── linear_authored_comments: tenant via sessions.tenant_id ─────────────
CREATE TABLE "linear_authored_comments__new" (
  "comment_id"     TEXT PRIMARY KEY,
  "tenant_id"      TEXT NOT NULL,
  "oma_session_id" TEXT NOT NULL,
  "issue_id"       TEXT NOT NULL,
  "created_at"     INTEGER NOT NULL
);
INSERT INTO "linear_authored_comments__new" (
  "comment_id", "tenant_id", "oma_session_id", "issue_id", "created_at"
)
SELECT
  x."comment_id", s."tenant_id", x."oma_session_id", x."issue_id", x."created_at"
FROM "linear_authored_comments" x
LEFT JOIN "sessions" s ON s."id" = x."oma_session_id";
DROP TABLE "linear_authored_comments";
ALTER TABLE "linear_authored_comments__new" RENAME TO "linear_authored_comments";
CREATE INDEX IF NOT EXISTS "idx_linear_authored_comments_session"
  ON "linear_authored_comments" ("oma_session_id");
CREATE INDEX IF NOT EXISTS "idx_linear_authored_comments_tenant"
  ON "linear_authored_comments" ("tenant_id", "created_at" DESC);
