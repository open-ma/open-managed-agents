-- linear_dispatch_rules: cron-driven autopilot for assigning Linear issues
-- to a publication's bot user. Symphony-style "Todo + label → bot work"
-- without requiring per-issue human delegation.
--
-- One rule belongs to exactly one publication. Multiple rules per
-- publication are allowed (different label / project / state combos), but
-- max_concurrent applies per-rule, not per-publication.
--
-- The sweep loops over enabled rules whose last_polled_at is older than
-- (now - poll_interval_seconds), runs a GraphQL query against Linear with
-- the publication's installation token, and assigns top-N matching issues
-- to publication.bot_user_id. Each assign fires Linear's IssueAssignedToYou
-- webhook (oauth_app installs only) which the existing dispatch path picks
-- up. For personal_token installs the sweep also calls sessions.create
-- directly since PATs have no webhook source.
--
-- filter_states stores a JSON-encoded TEXT[] (e.g. '["Todo","Backlog"]').
-- Empty array or null means "any active state". filter_label is optional
-- but recommended — leaving it null means "every issue in the matched
-- states becomes bot work", which is the OpenAI default but a footgun for
-- new tenants.

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

-- Sweep query: enabled rules whose last_polled_at is stale.
CREATE INDEX IF NOT EXISTS "idx_linear_dispatch_rules_sweep"
  ON "linear_dispatch_rules" ("enabled", "last_polled_at");

-- Per-publication listing for the admin API.
CREATE INDEX IF NOT EXISTS "idx_linear_dispatch_rules_publication"
  ON "linear_dispatch_rules" ("publication_id");

-- Tenant-scoped listing for cross-publication views.
CREATE INDEX IF NOT EXISTS "idx_linear_dispatch_rules_tenant"
  ON "linear_dispatch_rules" ("tenant_id", "created_at" DESC);
