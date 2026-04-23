-- Vault credentials migration: KV → D1.
--
-- Replaces the previous KV layout `t:{tenant}:cred:{vault}:{credential}` →
-- JSON blob. The old layout enforced UNIQUE(mcp_server_url) and
-- max-credentials-per-vault via list+loop in vaults.ts; both are now schema-level.
--
-- Soft FK to `vaults` (still KV-only as of OPE-7 scope) — vault_id is plain TEXT,
-- cascade archive is in app layer (vaults route handler) per project convention
-- (no FK).
--
-- Hot fields denormalized to dedicated columns so they can be indexed:
--   auth_type       — quick filter (e.g. all mcp_oauth in a vault)
--   mcp_server_url  — UNIQUE check + lookup-by-host (outbound proxy)
--   provider        — refresh-by-vault (sessions.ts:998 hot path)
-- Full CredentialAuth lives in `auth` (JSON) so adding new auth fields doesn't
-- need a migration. Writers MUST keep the denormalized columns in sync with
-- the JSON.

CREATE TABLE IF NOT EXISTS "credentials" (
  "id"             TEXT PRIMARY KEY NOT NULL,
  "tenant_id"      TEXT NOT NULL,
  "vault_id"       TEXT NOT NULL,    -- soft FK to vaults (cascade in app layer)
  "display_name"   TEXT NOT NULL,
  "auth_type"      TEXT NOT NULL,    -- mcp_oauth | static_bearer | command_secret
  "mcp_server_url" TEXT,             -- denormalized from auth JSON, NULL for command_secret
  "provider"       TEXT,             -- denormalized github | linear | NULL
  "auth"           TEXT NOT NULL,    -- JSON-serialized CredentialAuth (full record)
  "created_at"     INTEGER NOT NULL,
  "updated_at"     INTEGER,
  "archived_at"    INTEGER
);

-- Vault listing path: GET /v1/vaults/:id/credentials, sessions.ts prefetch.
CREATE INDEX IF NOT EXISTS "idx_credentials_vault"
  ON "credentials" ("tenant_id", "vault_id", "archived_at");

-- One ACTIVE credential per (tenant, vault, mcp_server_url). NULLs allowed
-- (command_secret has no mcp_server_url; partial index excludes NULLs and
-- archived rows so re-creating a credential after archive succeeds).
CREATE UNIQUE INDEX IF NOT EXISTS "idx_credentials_mcp_url_active"
  ON "credentials" ("tenant_id", "vault_id", "mcp_server_url")
  WHERE "mcp_server_url" IS NOT NULL AND "archived_at" IS NULL;

-- Provider-tagged credentials are scanned per-session at start time
-- (sessions.ts:998 refreshProviderCredentialsForSession). Partial keeps it
-- O(provider-tagged), not O(all creds).
CREATE INDEX IF NOT EXISTS "idx_credentials_provider"
  ON "credentials" ("tenant_id", "vault_id", "provider")
  WHERE "provider" IS NOT NULL;
