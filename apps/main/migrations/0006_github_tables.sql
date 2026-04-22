-- GitHub integration tables. Same conceptual home as packages/integrations-
-- adapters-cf, lives here because wrangler discovers migrations relative to
-- the worker config and we share AUTH_DB with apps/integrations.
--
-- Distinct from `linear_apps` because GitHub Apps carry extra invariants the
-- Linear schema doesn't model (numeric app_id, public slug, bot login,
-- private key for App-JWT minting). The shared tables (linear_installations,
-- linear_publications, linear_webhook_events, linear_issue_sessions,
-- linear_setup_links) already carry a `provider_id` column and are reused
-- as-is — github rows live alongside linear rows there.

CREATE TABLE IF NOT EXISTS "github_apps" (
  "id"                    TEXT PRIMARY KEY NOT NULL,
  -- One App per publication (UNIQUE on nullable column allows multiple NULLs
  -- pre-install, just like linear_apps).
  "publication_id"        TEXT UNIQUE,
  -- GitHub's numeric app id (TEXT-typed to dodge JS bigint corner cases).
  -- iss claim of every App JWT we mint.
  "app_id"                TEXT NOT NULL,
  -- App's URL slug (github.com/apps/<slug>). Embedded in the install URL.
  "app_slug"              TEXT NOT NULL,
  -- Bot user login the App acts as on writes (e.g. "myapp[bot]"). The
  -- webhook parser uses this to detect "@mention" / "assigned-to-bot".
  "bot_login"             TEXT NOT NULL,
  -- Optional OAuth credentials — only needed if the App also serves
  -- "Sign in with GitHub". For pure App-bot use both can be NULL.
  "client_id"             TEXT,
  "client_secret_cipher"  TEXT,
  -- Webhook signing secret (HMAC-SHA-256). REQUIRED.
  "webhook_secret_cipher" TEXT NOT NULL,
  -- PEM-encoded RSA private key, used to mint short-lived App JWTs.
  -- REQUIRED.
  "private_key_cipher"    TEXT NOT NULL,
  "created_at"            INTEGER NOT NULL
);

-- Lookup by GitHub's numeric app_id is the hot path on webhook arrival
-- (we need to find the OMA-internal id from the X-GitHub-Event payload's
-- App context).
CREATE INDEX IF NOT EXISTS "idx_github_apps_app_id"
  ON "github_apps" ("app_id");
