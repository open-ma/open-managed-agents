-- Split GitHub installations + publications out of the shared linear_*
-- tables into github_installations / github_publications.
--
-- Background: github_apps has always lived in its own table, but the
-- accompanying installation + publication rows shared linear_installations
-- / linear_publications and were distinguished only by provider_id ='github'
-- (with app_id pointing into github_apps). That made the AgentDetail
-- per-provider folds bleed across providers in the Console UI because the
-- repo's listByUserAndAgent reverse lookup couldn't filter by provider.
--
-- Schema is mirrored verbatim from linear_installations / linear_publications
-- (post-0002 shape, including tenant_id NOT NULL).
--
-- Backfill copies rows out of the linear tables (joined to github_apps to
-- find the github-flavored ones) then deletes the migrated rows. Idempotent
-- via INSERT OR IGNORE + IF NOT EXISTS — running twice is a no-op because
-- the second run finds nothing left to copy and nothing left to delete.
--
-- Slack already lives in slack_installations / slack_publications (migration
-- 0004); this brings GitHub to the same shape.

-- ─── github_installations ────────────────────────────────────────────────

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

-- ─── github_publications ─────────────────────────────────────────────────

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

-- ─── Backfill ────────────────────────────────────────────────────────────
-- Copy github-flavored rows from linear_installations / linear_publications
-- into the new tables. JOIN against github_apps identifies github installs
-- (their app_id points at a github_apps.id, never a linear_apps.id).
--
-- Order matters: installations first so the publications copy can resolve
-- installation_id. Then DELETE in reverse — publications before installations
-- so we don't dangle FK-shaped references.

INSERT OR IGNORE INTO "github_installations" (
  "id", "tenant_id", "user_id", "provider_id", "workspace_id", "workspace_name",
  "install_kind", "app_id", "access_token_cipher", "refresh_token_cipher",
  "scopes", "bot_user_id", "created_at", "revoked_at", "vault_id"
)
SELECT
  i."id", i."tenant_id", i."user_id", i."provider_id", i."workspace_id", i."workspace_name",
  i."install_kind", i."app_id", i."access_token_cipher", i."refresh_token_cipher",
  i."scopes", i."bot_user_id", i."created_at", i."revoked_at", i."vault_id"
FROM "linear_installations" i
JOIN "github_apps" g ON g."id" = i."app_id";

INSERT OR IGNORE INTO "github_publications" (
  "id", "tenant_id", "user_id", "agent_id", "installation_id", "mode", "status",
  "persona_name", "persona_avatar_url", "capabilities", "session_granularity",
  "created_at", "unpublished_at", "environment_id"
)
SELECT
  p."id", p."tenant_id", p."user_id", p."agent_id", p."installation_id", p."mode", p."status",
  p."persona_name", p."persona_avatar_url", p."capabilities", p."session_granularity",
  p."created_at", p."unpublished_at", p."environment_id"
FROM "linear_publications" p
WHERE p."installation_id" IN (SELECT "id" FROM "github_installations");

DELETE FROM "linear_publications"
  WHERE "installation_id" IN (SELECT "id" FROM "github_installations");

DELETE FROM "linear_installations"
  WHERE "id" IN (SELECT "id" FROM "github_installations");
