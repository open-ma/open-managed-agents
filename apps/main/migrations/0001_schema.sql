-- ============================================================
-- OMA D1 schema — single canonical migration.
-- ============================================================
--
-- This file replaces the previous fragmented 0001-0014 migration history.
-- It encodes the FINAL schema of every D1-backed entity in OMA — no ALTER
-- TABLE drift, no FK constraints (cascade is in app layer per project
-- convention), partial UNIQUE for active-only constraints.
--
-- House style:
--   - INTEGER timestamps (Unix ms), converted to ISO string in adapters
--   - No FK constraints; service-layer cascade
--   - Partial UNIQUE indexes use SQLite syntax: "WHERE col IS NOT NULL AND ..."
--   - JSON blobs stored as TEXT (parsed in adapter)
--   - Quote table/column names so reserved words (e.g. "user") work
--
-- Index naming: idx_<table>_<purpose>
-- Tables grouped by subsystem (auth, integrations, agents, sessions, etc.)
--
-- KEEP IN SYNC with packages/<store>-store/INTEGRATION_GUIDE.md schema sections.

-- ============================================================
-- AUTH (better-auth)
-- Owned by better-auth library — schema is library-mandated.
-- DO NOT add FKs here even though they look natural; better-auth uses
-- its own delete cascades that don't need DB enforcement.
-- ============================================================

CREATE TABLE IF NOT EXISTS "tenant" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS "user" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "emailVerified" INTEGER NOT NULL DEFAULT 0,
  "image" TEXT,
  "tenantId" TEXT,
  "role" TEXT NOT NULL DEFAULT 'member',
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS "session" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "expiresAt" INTEGER NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "account" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" INTEGER,
  "refreshTokenExpiresAt" INTEGER,
  "scope" TEXT,
  "password" TEXT,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS "verification" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" INTEGER NOT NULL,
  "createdAt" INTEGER,
  "updatedAt" INTEGER
);

-- ============================================================
-- LINEAR INTEGRATION
-- Per-publication credentials, workspace installations, agent bindings,
-- webhook idempotency log.
-- ============================================================

-- Per-publication Linear App credentials (A1 mode only). Each row pairs
-- with at most one linear_publications row in mode='full'. publication_id
-- is nullable to support the A1 install flow (credentials before publication).
CREATE TABLE IF NOT EXISTS "linear_apps" (
  "id"                    TEXT PRIMARY KEY NOT NULL,
  "publication_id"        TEXT UNIQUE,
  "client_id"             TEXT NOT NULL,
  "client_secret_cipher"  TEXT NOT NULL,
  "webhook_secret_cipher" TEXT NOT NULL,
  "created_at"            INTEGER NOT NULL
);

-- Workspace installations. install_kind: 'shared' (B+) | 'dedicated' (A1).
-- vault_id holds the bearer credential vault for the external API.
CREATE TABLE IF NOT EXISTS "linear_installations" (
  "id"                    TEXT PRIMARY KEY NOT NULL,
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

-- Agent ↔ workspace bindings. Each row publishes one OMA agent to a
-- Linear workspace under a specific install.
-- Soft FK to linear_installations (cascade in app layer).
-- mode: 'full' | 'quick'
-- status: pending_setup|awaiting_install|live|needs_reauth|unpublished
-- session_granularity: 'per_issue' | 'per_event'
CREATE TABLE IF NOT EXISTS "linear_publications" (
  "id"                    TEXT PRIMARY KEY NOT NULL,
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

-- Webhook idempotency + ops backfill log. delivery_id is Linear's unique id.
CREATE TABLE IF NOT EXISTS "linear_webhook_events" (
  "delivery_id"     TEXT PRIMARY KEY NOT NULL,
  "installation_id" TEXT NOT NULL,
  "publication_id"  TEXT,
  "event_type"      TEXT NOT NULL,
  "received_at"     INTEGER NOT NULL,
  "session_id"      TEXT,
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
  "status"         TEXT NOT NULL,
  "created_at"     INTEGER NOT NULL,
  PRIMARY KEY ("publication_id", "issue_id")
);

CREATE INDEX IF NOT EXISTS "idx_linear_issue_sessions_active"
  ON "linear_issue_sessions" ("publication_id", "status");

-- Tracks comments the bot authored via the OMA Linear MCP `linear_post_comment`
-- tool. parentId on a Linear webhook resolves here → omaSessionId → dispatch.
CREATE TABLE IF NOT EXISTS "linear_authored_comments" (
  "comment_id"     TEXT PRIMARY KEY,
  "oma_session_id" TEXT NOT NULL,
  "issue_id"       TEXT NOT NULL,
  "created_at"     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_linear_authored_comments_session"
  ON "linear_authored_comments" ("oma_session_id");

-- ============================================================
-- GITHUB INTEGRATION
-- Distinct from linear_apps (extra invariants: numeric app_id, public slug,
-- bot login, private key for App-JWT minting). The shared install /
-- publication / webhook tables are reused (rows carry provider_id='github').
-- ============================================================

CREATE TABLE IF NOT EXISTS "github_apps" (
  "id"                    TEXT PRIMARY KEY NOT NULL,
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

-- ============================================================
-- VAULTS (packages/vaults-store)
-- Tenant-scoped credential collections. Credentials live in their own table.
-- ============================================================

CREATE TABLE IF NOT EXISTS "vaults" (
  "id"          TEXT PRIMARY KEY NOT NULL,
  "tenant_id"   TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "created_at"  INTEGER NOT NULL,
  "updated_at"  INTEGER,
  "archived_at" INTEGER
);

CREATE INDEX IF NOT EXISTS "idx_vaults_tenant"
  ON "vaults" ("tenant_id", "archived_at");

-- ============================================================
-- VAULT CREDENTIALS (packages/credentials-store)
-- Three auth types: mcp_oauth | static_bearer | command_secret.
-- Hot fields denormalized to dedicated columns for indexing; full
-- CredentialAuth as JSON in `auth`. Writers MUST keep them in sync.
--
-- `auth` is encrypted at rest via AES-256-GCM (WebCryptoAesGcm with the
-- `credentials.auth` HKDF label). Format: base64url(iv || ciphertext).
-- Wired in packages/services/src/index.ts. Hot-path columns (auth_type,
-- mcp_server_url, provider) stay plaintext — they're SQL index keys, not
-- secrets.
-- ============================================================

CREATE TABLE IF NOT EXISTS "credentials" (
  "id"             TEXT PRIMARY KEY NOT NULL,
  "tenant_id"      TEXT NOT NULL,
  "vault_id"       TEXT NOT NULL,
  "display_name"   TEXT NOT NULL,
  "auth_type"      TEXT NOT NULL,
  "mcp_server_url" TEXT,
  "provider"       TEXT,
  "auth"           TEXT NOT NULL,
  "created_at"     INTEGER NOT NULL,
  "updated_at"     INTEGER,
  "archived_at"    INTEGER
);

CREATE INDEX IF NOT EXISTS "idx_credentials_vault"
  ON "credentials" ("tenant_id", "vault_id", "archived_at");

-- One ACTIVE credential per (tenant, vault, mcp_server_url). NULLs allowed.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_credentials_mcp_url_active"
  ON "credentials" ("tenant_id", "vault_id", "mcp_server_url")
  WHERE "mcp_server_url" IS NOT NULL AND "archived_at" IS NULL;

-- Provider-tagged credentials are scanned per-session at start time
-- (refreshProviderCredentialsForSession). Partial keeps it O(provider-tagged).
CREATE INDEX IF NOT EXISTS "idx_credentials_provider"
  ON "credentials" ("tenant_id", "vault_id", "provider")
  WHERE "provider" IS NOT NULL;

-- ============================================================
-- MEMORY (packages/memory-store)
-- D1 is source of truth, Vectorize is best-effort search index.
-- vector_synced_at NULL = pending reconciliation (idx_memories_unsynced
-- partial keeps the reconciler scan O(unsynced)).
-- ============================================================

CREATE TABLE IF NOT EXISTS "memory_stores" (
  "id"           TEXT PRIMARY KEY NOT NULL,
  "tenant_id"    TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "description"  TEXT,
  "created_at"   INTEGER NOT NULL,
  "updated_at"   INTEGER,
  "archived_at"  INTEGER
);

CREATE INDEX IF NOT EXISTS "idx_memory_stores_tenant"
  ON "memory_stores" ("tenant_id", "created_at" DESC);

-- One row per (store_id, path). UNIQUE replaces the old mempath KV index.
-- Cascade to/from memory_stores is in adapter (D1MemoryStoreRepo.delete batch).
CREATE TABLE IF NOT EXISTS "memories" (
  "id"                TEXT PRIMARY KEY NOT NULL,
  "store_id"          TEXT NOT NULL,
  "path"              TEXT NOT NULL,
  "content"           TEXT NOT NULL,
  "content_sha256"    TEXT NOT NULL,
  "size_bytes"        INTEGER NOT NULL,
  "created_at"        INTEGER NOT NULL,
  "updated_at"        INTEGER NOT NULL,
  "vector_synced_at"  INTEGER,
  UNIQUE ("store_id", "path")
);

CREATE INDEX IF NOT EXISTS "idx_memories_store_updated"
  ON "memories" ("store_id", "updated_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_memories_unsynced"
  ON "memories" ("store_id", "id")
  WHERE "vector_synced_at" IS NULL;

-- Append-only audit log. Every mutation writes one row in the same D1 batch.
CREATE TABLE IF NOT EXISTS "memory_versions" (
  "id"              TEXT PRIMARY KEY NOT NULL,
  "memory_id"       TEXT NOT NULL,
  "store_id"        TEXT NOT NULL,
  "operation"       TEXT NOT NULL,
  "path"            TEXT,
  "content"         TEXT,
  "content_sha256"  TEXT,
  "size_bytes"      INTEGER,
  "actor_type"      TEXT NOT NULL,
  "actor_id"        TEXT NOT NULL,
  "created_at"      INTEGER NOT NULL,
  "redacted"        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS "idx_memory_versions_memory"
  ON "memory_versions" ("memory_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_memory_versions_store"
  ON "memory_versions" ("store_id", "created_at" DESC);

-- ============================================================
-- SESSIONS (packages/sessions-store)
-- Highest write-rate entity. Replaces t:{tenant}:session:{id} +
-- t:{tenant}:sesrsc:{session}:{id} KV layouts. Soft FKs to agents,
-- environments, vaults, memory_stores. Per-session event log lives in
-- SessionDO SQLite (separate concern). Per-resource secret blobs
-- (env_secret.value, github_repository token) stay in CONFIG_KV under
-- t:{tenant}:secret:{session}:{resource} (route layer owns those).
-- ============================================================

CREATE TABLE IF NOT EXISTS "sessions" (
  "id"                    TEXT PRIMARY KEY NOT NULL,
  "tenant_id"             TEXT NOT NULL,
  "agent_id"              TEXT NOT NULL,
  "environment_id"        TEXT NOT NULL,
  "title"                 TEXT NOT NULL DEFAULT '',
  "status"                TEXT NOT NULL,
  "vault_ids"             TEXT,
  "agent_snapshot"        TEXT,
  "environment_snapshot"  TEXT,
  "metadata"              TEXT,
  "created_at"            INTEGER NOT NULL,
  "updated_at"            INTEGER,
  "archived_at"           INTEGER
);

CREATE INDEX IF NOT EXISTS "idx_sessions_tenant_created"
  ON "sessions" ("tenant_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_sessions_tenant_agent"
  ON "sessions" ("tenant_id", "agent_id", "archived_at");

CREATE INDEX IF NOT EXISTS "idx_sessions_tenant_environment"
  ON "sessions" ("tenant_id", "environment_id", "archived_at");

CREATE TABLE IF NOT EXISTS "session_resources" (
  "id"          TEXT PRIMARY KEY NOT NULL,
  "session_id"  TEXT NOT NULL,
  "type"        TEXT NOT NULL,
  "config"      TEXT NOT NULL,
  "created_at"  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_session_resources_session"
  ON "session_resources" ("session_id", "created_at" ASC);

CREATE INDEX IF NOT EXISTS "idx_session_resources_session_type"
  ON "session_resources" ("session_id", "type");

-- ============================================================
-- FILES (packages/files-store) — metadata only, R2 owns the blob.
-- Replaces t:{tenant}:file:{id} + t:{tenant}:filebyscope:{scope}:{id}.
-- ============================================================

CREATE TABLE IF NOT EXISTS "files" (
  "id"           TEXT PRIMARY KEY NOT NULL,
  "tenant_id"    TEXT NOT NULL,
  "session_id"   TEXT,
  "scope"        TEXT NOT NULL,
  "filename"     TEXT NOT NULL,
  "media_type"   TEXT NOT NULL,
  "size_bytes"   INTEGER NOT NULL,
  "downloadable" INTEGER NOT NULL DEFAULT 0,
  "r2_key"       TEXT NOT NULL,
  "created_at"   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_files_tenant_created"
  ON "files" ("tenant_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_files_tenant_session_created"
  ON "files" ("tenant_id", "session_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_files_session"
  ON "files" ("session_id");

-- ============================================================
-- EVAL RUNS (packages/evals-store)
-- Per-trial trajectory blobs continue to live in CONFIG_KV under
-- t:{tenant}:trajectory:{id}; trajectory ids are referenced from inside
-- the `results` JSON.
-- ============================================================

CREATE TABLE IF NOT EXISTS "eval_runs" (
  "id"             TEXT PRIMARY KEY NOT NULL,
  "tenant_id"      TEXT NOT NULL,
  "agent_id"       TEXT NOT NULL,
  "environment_id" TEXT NOT NULL,
  "suite"          TEXT,
  "status"         TEXT NOT NULL,
  "started_at"     INTEGER NOT NULL,
  "completed_at"   INTEGER,
  "results"        TEXT,
  "score"          REAL,
  "error"          TEXT
);

CREATE INDEX IF NOT EXISTS "idx_eval_runs_tenant_started"
  ON "eval_runs" ("tenant_id", "started_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_eval_runs_tenant_agent_started"
  ON "eval_runs" ("tenant_id", "agent_id", "started_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_eval_runs_tenant_environment_started"
  ON "eval_runs" ("tenant_id", "environment_id", "started_at" DESC);

-- Cron tick scan: pending+running runs across all tenants. Partial keeps it
-- O(active) instead of O(all-runs).
CREATE INDEX IF NOT EXISTS "idx_eval_runs_status_active"
  ON "eval_runs" ("status", "started_at" ASC)
  WHERE "status" = 'pending' OR "status" = 'running';

-- ============================================================
-- MODEL CARDS (packages/model-cards-store)
-- Replaces t:{tenant}:modelcard:{id} + t:{tenant}:modelcard:{id}:key KV.
-- api_key_cipher is AES-256-GCM (WebCryptoAesGcm with the
-- `model.cards.keys` HKDF label). Format: base64url(iv || ciphertext).
-- Wired in packages/services/src/index.ts.
-- ============================================================

CREATE TABLE IF NOT EXISTS "model_cards" (
  "id"               TEXT PRIMARY KEY NOT NULL,
  "tenant_id"        TEXT NOT NULL,
  "model_id"         TEXT NOT NULL,
  "provider"         TEXT NOT NULL,
  "display_name"     TEXT NOT NULL,
  "base_url"         TEXT,
  "custom_headers"   TEXT,
  "api_key_cipher"   TEXT NOT NULL,
  "api_key_preview"  TEXT NOT NULL,
  "is_default"       INTEGER NOT NULL DEFAULT 0,
  "created_at"       INTEGER NOT NULL,
  "updated_at"       INTEGER,
  "archived_at"      INTEGER
);

-- HARD UNIQUE: one model_id per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_model_cards_model_id"
  ON "model_cards" ("tenant_id", "model_id");

-- PARTIAL UNIQUE: at most one default per tenant. Service uses an atomic
-- clear-then-set batch so this index never fires under normal use; it's
-- the safety net for concurrent-write bugs.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_model_cards_default"
  ON "model_cards" ("tenant_id")
  WHERE "is_default" = 1;

CREATE INDEX IF NOT EXISTS "idx_model_cards_tenant"
  ON "model_cards" ("tenant_id", "created_at");

-- ============================================================
-- AGENTS (packages/agents-store)
-- Two-table design: `agents` holds the current row (one per id);
-- `agent_versions` holds append-only historical snapshots written
-- BEFORE each update bump. Mirrors the memory_versions pattern.
-- Replaces the legacy KV layout:
--   t:{tenant}:agent:{id}            -> current AgentConfig
--   t:{tenant}:agent:{id}:v{version} -> historical snapshots
-- ============================================================

CREATE TABLE IF NOT EXISTS "agents" (
  "id"           TEXT PRIMARY KEY NOT NULL,
  "tenant_id"    TEXT NOT NULL,
  "config"       TEXT NOT NULL,
  "version"      INTEGER NOT NULL,
  "created_at"   INTEGER NOT NULL,
  "updated_at"   INTEGER,
  "archived_at"  INTEGER
);

CREATE INDEX IF NOT EXISTS "idx_agents_tenant"
  ON "agents" ("tenant_id", "archived_at");

CREATE TABLE IF NOT EXISTS "agent_versions" (
  "agent_id"    TEXT NOT NULL,
  "tenant_id"   TEXT NOT NULL,
  "version"     INTEGER NOT NULL,
  "snapshot"    TEXT NOT NULL,
  "created_at"  INTEGER NOT NULL,
  PRIMARY KEY ("agent_id", "version")
);

CREATE INDEX IF NOT EXISTS "idx_agent_versions_tenant_agent"
  ON "agent_versions" ("tenant_id", "agent_id", "version");

-- ============================================================
-- ENVIRONMENTS (packages/environments-store)
-- Tenant-scoped environment definitions. Replaces t:{tenant}:env:{id} KV.
-- Hot fields (status, sandbox_worker_name) denormalized as columns since
-- getSandboxBinding reads them on every session-attached request. The
-- config JSON carries packages, networking, sandbox build inputs, etc.
-- No FK on cross-store refs (sessions/evals reference env_id) — cascade
-- guard lives in the route handler via services.sessions.hasActiveByEnv.
-- ============================================================

CREATE TABLE IF NOT EXISTS "environments" (
  "id"                   TEXT PRIMARY KEY NOT NULL,
  "tenant_id"            TEXT NOT NULL,
  "name"                 TEXT NOT NULL,
  "description"          TEXT,
  "status"               TEXT NOT NULL,
  "sandbox_worker_name"  TEXT,
  "build_error"          TEXT,
  "config"               TEXT NOT NULL,
  "metadata"             TEXT,
  "created_at"           INTEGER NOT NULL,
  "updated_at"           INTEGER,
  "archived_at"          INTEGER
);

CREATE INDEX IF NOT EXISTS "idx_environments_tenant"
  ON "environments" ("tenant_id", "archived_at");
