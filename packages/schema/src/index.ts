// Centralized schema for the self-host runtime. Idempotent — every
// CREATE TABLE / CREATE INDEX uses IF NOT EXISTS, every ALTER TABLE
// tolerates "duplicate column" / "already exists".
//
// CF still uses the migration files in apps/main/migrations/ for D1
// push history. From now on, both runtimes also call applySchema() on
// boot so the inline DDL stays in one place.

import type { SqlClient } from "@open-managed-agents/sql-client";
import { ensureSchema as ensureEventLogSchema } from "@open-managed-agents/event-log/sql";

export type SqlDialect = "sqlite" | "postgres";

export interface ApplySchemaOptions {
  sql: SqlClient;
  dialect: SqlDialect;
  /** Skip the better-auth tables (CF uses D1 migrations for those; main-node
   *  manages them inline because better-auth's kysely adapter wants them on
   *  its own connection). */
  includeBetterAuth?: boolean;
}

/**
 * Tolerate the PG `pg_type_typname_nsp_index` collision that can occur
 * when two replicas race the bootstrap CREATE TABLE on a fresh database.
 */
async function withPgRaceRetry(
  fn: () => Promise<void>,
  isPg: boolean,
  attempts = 5,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await fn();
      return;
    } catch (err) {
      const msg = (err as Error).message ?? "";
      const isTypeRace = isPg && /pg_type|tuple concurrently|already exists/i.test(msg);
      if (!isTypeRace || i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 100 * (i + 1)));
    }
  }
}

async function addColumnIfMissing(
  sql: SqlClient,
  table: string,
  column: string,
  type: string,
): Promise<void> {
  try {
    await sql.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${type}`);
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (!/duplicate column name|already exists/i.test(msg)) throw err;
  }
}

export async function applySchema(opts: ApplySchemaOptions): Promise<void> {
  const { sql, dialect, includeBetterAuth = false } = opts;
  const isPg = dialect === "postgres";

  await withPgRaceRetry(async () => {
    await sql.exec(`
      CREATE TABLE IF NOT EXISTS "agents" (
        "id"           TEXT PRIMARY KEY NOT NULL,
        "tenant_id"    TEXT NOT NULL,
        "config"       TEXT NOT NULL,
        "version"      BIGINT NOT NULL,
        "created_at"   BIGINT NOT NULL,
        "updated_at"   BIGINT,
        "archived_at"  BIGINT
      );
      CREATE INDEX IF NOT EXISTS "idx_agents_tenant"
        ON "agents" ("tenant_id", "archived_at");

      CREATE TABLE IF NOT EXISTS "agent_versions" (
        "agent_id"   TEXT NOT NULL,
        "tenant_id"  TEXT NOT NULL,
        "version"    BIGINT NOT NULL,
        "snapshot"   TEXT NOT NULL,
        "created_at" BIGINT NOT NULL,
        PRIMARY KEY ("agent_id", "version")
      );

      CREATE TABLE IF NOT EXISTS "sessions" (
        "id"                    TEXT PRIMARY KEY NOT NULL,
        "tenant_id"             TEXT NOT NULL,
        "agent_id"              TEXT,
        "environment_id"        TEXT,
        "status"                TEXT NOT NULL,
        "title"                 TEXT,
        "vault_ids"             TEXT,
        "agent_snapshot"        TEXT,
        "environment_snapshot"  TEXT,
        "metadata"              TEXT,
        "turn_id"               TEXT,
        "turn_started_at"       BIGINT,
        "created_at"            BIGINT NOT NULL,
        "updated_at"            BIGINT,
        "archived_at"           BIGINT,
        "terminated_at"         BIGINT
      );
      CREATE INDEX IF NOT EXISTS "idx_sessions_status"
        ON "sessions" ("status", "tenant_id");
      CREATE INDEX IF NOT EXISTS "idx_sessions_tenant_archived"
        ON "sessions" ("tenant_id", "archived_at");

      CREATE TABLE IF NOT EXISTS "session_resources" (
        "id"             TEXT PRIMARY KEY NOT NULL,
        "session_id"     TEXT NOT NULL,
        "type"           TEXT NOT NULL,
        "memory_store_id" TEXT,
        "mount_path"     TEXT,
        "access"         TEXT,
        "instructions"   TEXT,
        "url"            TEXT,
        "checkout_type"  TEXT,
        "checkout_name"  TEXT,
        "checkout_sha"   TEXT,
        "name"           TEXT,
        "value"          TEXT,
        "created_at"     BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS "idx_session_resources_session"
        ON "session_resources" ("session_id", "type");

      CREATE TABLE IF NOT EXISTS "memory_stores" (
        "id"           TEXT PRIMARY KEY NOT NULL,
        "tenant_id"    TEXT NOT NULL,
        "name"         TEXT NOT NULL,
        "description"  TEXT,
        "created_at"   BIGINT NOT NULL,
        "updated_at"   BIGINT,
        "archived_at"  BIGINT
      );
      CREATE INDEX IF NOT EXISTS "idx_memory_stores_tenant"
        ON "memory_stores" ("tenant_id", "archived_at");

      CREATE TABLE IF NOT EXISTS "memories" (
        "id"             TEXT PRIMARY KEY NOT NULL,
        "store_id"       TEXT NOT NULL,
        "path"           TEXT NOT NULL,
        "content_sha256" TEXT NOT NULL,
        "etag"           TEXT NOT NULL,
        "size_bytes"     BIGINT NOT NULL,
        "created_at"     BIGINT NOT NULL,
        "updated_at"     BIGINT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_memories_store_path"
        ON "memories" ("store_id", "path");

      CREATE TABLE IF NOT EXISTS "memory_versions" (
        "id"             TEXT PRIMARY KEY NOT NULL,
        "memory_id"      TEXT NOT NULL,
        "store_id"       TEXT NOT NULL,
        "operation"      TEXT NOT NULL,
        "path"           TEXT NOT NULL,
        "content"        TEXT NOT NULL,
        "content_sha256" TEXT NOT NULL,
        "size_bytes"     BIGINT NOT NULL,
        "actor_type"     TEXT NOT NULL,
        "actor_id"       TEXT NOT NULL,
        "created_at"     BIGINT NOT NULL,
        "redacted"       INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS "idx_memory_versions_store"
        ON "memory_versions" ("store_id", "created_at" DESC);
      CREATE INDEX IF NOT EXISTS "idx_memory_versions_memory"
        ON "memory_versions" ("memory_id", "created_at" DESC);

      CREATE TABLE IF NOT EXISTS "vaults" (
        "id"          TEXT PRIMARY KEY NOT NULL,
        "tenant_id"   TEXT NOT NULL,
        "name"        TEXT NOT NULL,
        "created_at"  BIGINT NOT NULL,
        "updated_at"  BIGINT,
        "archived_at" BIGINT
      );
      CREATE INDEX IF NOT EXISTS "idx_vaults_tenant"
        ON "vaults" ("tenant_id", "archived_at");

      CREATE TABLE IF NOT EXISTS "credentials" (
        "id"             TEXT PRIMARY KEY NOT NULL,
        "tenant_id"      TEXT NOT NULL,
        "vault_id"       TEXT NOT NULL,
        "display_name"   TEXT NOT NULL,
        "auth_type"      TEXT NOT NULL,
        "mcp_server_url" TEXT,
        "provider"       TEXT,
        "auth"           TEXT NOT NULL,
        "created_at"     BIGINT NOT NULL,
        "updated_at"     BIGINT,
        "archived_at"    BIGINT
      );
      CREATE INDEX IF NOT EXISTS "idx_credentials_vault"
        ON "credentials" ("tenant_id", "vault_id", "archived_at");
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_credentials_mcp_url_active"
        ON "credentials" ("tenant_id", "vault_id", "mcp_server_url")
        WHERE "mcp_server_url" IS NOT NULL AND "archived_at" IS NULL;

      CREATE TABLE IF NOT EXISTS "session_memory_stores" (
        "session_id" TEXT NOT NULL,
        "store_id"   TEXT NOT NULL,
        "access"     TEXT NOT NULL DEFAULT 'read_write',
        "created_at" BIGINT NOT NULL,
        PRIMARY KEY ("session_id", "store_id")
      );

      CREATE TABLE IF NOT EXISTS "kv_entries" (
        "tenant_id"  TEXT NOT NULL,
        "key"        TEXT NOT NULL,
        "value"      TEXT NOT NULL,
        "expires_at" BIGINT,
        PRIMARY KEY ("tenant_id", "key")
      );
      CREATE INDEX IF NOT EXISTS "idx_kv_entries_expires"
        ON "kv_entries" ("expires_at");

      CREATE TABLE IF NOT EXISTS "api_keys" (
        "id"            TEXT PRIMARY KEY NOT NULL,
        "tenant_id"     TEXT NOT NULL,
        "user_id"       TEXT,
        "name"          TEXT NOT NULL,
        "prefix"        TEXT NOT NULL,
        "hash"          TEXT NOT NULL UNIQUE,
        "created_at"    BIGINT NOT NULL,
        "last_used_at"  BIGINT,
        "revoked_at"    BIGINT
      );
      CREATE INDEX IF NOT EXISTS "idx_api_keys_tenant"
        ON "api_keys" ("tenant_id", "revoked_at");

      CREATE TABLE IF NOT EXISTS "files" (
        "id"           TEXT PRIMARY KEY NOT NULL,
        "tenant_id"    TEXT NOT NULL,
        "session_id"   TEXT,
        "scope"        TEXT NOT NULL,
        "filename"     TEXT NOT NULL,
        "media_type"   TEXT NOT NULL,
        "size_bytes"   BIGINT NOT NULL,
        "downloadable" INTEGER NOT NULL DEFAULT 0,
        "r2_key"       TEXT NOT NULL,
        "created_at"   BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS "idx_files_tenant_created"
        ON "files" ("tenant_id", "created_at" DESC);
      CREATE INDEX IF NOT EXISTS "idx_files_tenant_session_created"
        ON "files" ("tenant_id", "session_id", "created_at" DESC);
      CREATE INDEX IF NOT EXISTS "idx_files_session"
        ON "files" ("session_id");

      CREATE TABLE IF NOT EXISTS "workspace_backups" (
        "id"                TEXT PRIMARY KEY NOT NULL,
        "tenant_id"         TEXT NOT NULL,
        "session_id"        TEXT NOT NULL,
        "blob_key"          TEXT NOT NULL,
        "size_bytes"        BIGINT NOT NULL,
        "created_at"        BIGINT NOT NULL,
        "expires_at"        BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS "idx_workspace_backups_session"
        ON "workspace_backups" ("session_id", "created_at" DESC);
      CREATE INDEX IF NOT EXISTS "idx_workspace_backups_expires"
        ON "workspace_backups" ("expires_at");
    `);

    await ensureEventLogSchema(sql, isPg ? "postgres" : "sqlite");
  }, isPg);

  // In-place migrations for upgrades — old rows may pre-date later columns.
  await addColumnIfMissing(sql, "sessions", "turn_id", "TEXT");
  await addColumnIfMissing(sql, "sessions", "turn_started_at", "BIGINT");
  await addColumnIfMissing(sql, "sessions", "environment_id", "TEXT");
  await addColumnIfMissing(sql, "sessions", "vault_ids", "TEXT");
  await addColumnIfMissing(sql, "sessions", "agent_snapshot", "TEXT");
  await addColumnIfMissing(sql, "sessions", "environment_snapshot", "TEXT");
  await addColumnIfMissing(sql, "sessions", "metadata", "TEXT");
  await addColumnIfMissing(sql, "sessions", "archived_at", "BIGINT");
  await addColumnIfMissing(sql, "sessions", "terminated_at", "BIGINT");

  if (includeBetterAuth) {
    await applyBetterAuthSchema({ sql, dialect });
  }
}

/**
 * better-auth's tables. Mirrors what `npx @better-auth/cli generate` produces
 * for emailAndPassword + additionalFields (tenantId, role).
 */
export async function applyBetterAuthSchema(opts: {
  sql: SqlClient;
  dialect: SqlDialect;
}): Promise<void> {
  const { sql, dialect } = opts;
  const isPg = dialect === "postgres";
  if (isPg) {
    await withPgRaceRetry(async () => {
      await sql.exec(`
        CREATE TABLE IF NOT EXISTS "user" (
          "id" TEXT PRIMARY KEY NOT NULL,
          "email" TEXT NOT NULL UNIQUE,
          "emailVerified" BOOLEAN NOT NULL DEFAULT FALSE,
          "name" TEXT NOT NULL,
          "image" TEXT,
          "tenantId" TEXT,
          "role" TEXT,
          "createdAt" TIMESTAMPTZ NOT NULL,
          "updatedAt" TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE IF NOT EXISTS "session" (
          "id" TEXT PRIMARY KEY NOT NULL,
          "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
          "token" TEXT NOT NULL UNIQUE,
          "expiresAt" TIMESTAMPTZ NOT NULL,
          "ipAddress" TEXT,
          "userAgent" TEXT,
          "createdAt" TIMESTAMPTZ NOT NULL,
          "updatedAt" TIMESTAMPTZ NOT NULL
        );
        CREATE INDEX IF NOT EXISTS "idx_session_userId" ON "session" ("userId");
        CREATE TABLE IF NOT EXISTS "account" (
          "id" TEXT PRIMARY KEY NOT NULL,
          "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
          "accountId" TEXT NOT NULL,
          "providerId" TEXT NOT NULL,
          "accessToken" TEXT,
          "refreshToken" TEXT,
          "idToken" TEXT,
          "accessTokenExpiresAt" TIMESTAMPTZ,
          "refreshTokenExpiresAt" TIMESTAMPTZ,
          "scope" TEXT,
          "password" TEXT,
          "createdAt" TIMESTAMPTZ NOT NULL,
          "updatedAt" TIMESTAMPTZ NOT NULL
        );
        CREATE INDEX IF NOT EXISTS "idx_account_userId" ON "account" ("userId");
        CREATE TABLE IF NOT EXISTS "verification" (
          "id" TEXT PRIMARY KEY NOT NULL,
          "identifier" TEXT NOT NULL,
          "value" TEXT NOT NULL,
          "expiresAt" TIMESTAMPTZ NOT NULL,
          "createdAt" TIMESTAMPTZ,
          "updatedAt" TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS "idx_verification_identifier"
          ON "verification" ("identifier");
      `);
    }, true);
  } else {
    // sqlite — better-auth's kysely adapter wants the better-sqlite3 native
    // db; main-node still applies these tables via a direct .exec() because
    // applySchema is called against the main SqlClient (different driver).
    // Caller passes a sql whose .exec() targets the auth db.
    await sql.exec(`
      CREATE TABLE IF NOT EXISTS "user" (
        "id" TEXT PRIMARY KEY NOT NULL,
        "email" TEXT NOT NULL UNIQUE,
        "emailVerified" INTEGER NOT NULL DEFAULT 0,
        "name" TEXT NOT NULL,
        "image" TEXT,
        "tenantId" TEXT,
        "role" TEXT,
        "createdAt" INTEGER NOT NULL,
        "updatedAt" INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS "session" (
        "id" TEXT PRIMARY KEY NOT NULL,
        "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
        "token" TEXT NOT NULL UNIQUE,
        "expiresAt" INTEGER NOT NULL,
        "ipAddress" TEXT,
        "userAgent" TEXT,
        "createdAt" INTEGER NOT NULL,
        "updatedAt" INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS "account" (
        "id" TEXT PRIMARY KEY NOT NULL,
        "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
        "accountId" TEXT NOT NULL,
        "providerId" TEXT NOT NULL,
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
    `);
  }
}

/**
 * Tenant + membership tables. Always installed regardless of better-auth.
 * Self-host runs these directly against the main SqlClient; CF declares
 * `tenant` + `membership` in apps/main/migrations/0001_schema.sql with the
 * legacy `createdAt`/`updatedAt` casing better-auth dropped on us.
 */
export async function applyTenantSchema(sql: SqlClient): Promise<void> {
  await sql.exec(`
    CREATE TABLE IF NOT EXISTS "tenant" (
      "id"         TEXT PRIMARY KEY NOT NULL,
      "name"       TEXT NOT NULL,
      "created_at" BIGINT NOT NULL,
      "updated_at" BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "membership" (
      "user_id"    TEXT NOT NULL,
      "tenant_id"  TEXT NOT NULL,
      "role"       TEXT NOT NULL,
      "created_at" BIGINT NOT NULL,
      PRIMARY KEY ("user_id", "tenant_id")
    );
    CREATE INDEX IF NOT EXISTS "idx_membership_user"
      ON "membership" ("user_id");
  `);
}

/**
 * S3 memory poller per-store lease — only one replica polls a given store
 * at a time. Lives in this package because the lease table is the same
 * idempotent CREATE pattern as the rest of the schema.
 */
export async function applyMemoryPollerSchema(opts: {
  sql: SqlClient;
  dialect: SqlDialect;
}): Promise<void> {
  const { sql, dialect } = opts;
  await withPgRaceRetry(async () => {
    await sql.exec(`
      CREATE TABLE IF NOT EXISTS "memory_blob_poller_lease" (
        "store_id"     TEXT PRIMARY KEY NOT NULL,
        "owner"        TEXT NOT NULL,
        "expires_at"   BIGINT NOT NULL,
        "last_seen_ms" BIGINT NOT NULL DEFAULT 0
      );
    `);
  }, dialect === "postgres");
}

/**
 * Integrations subsystem tables — Linear/GitHub/Slack publications, installs,
 * Apps, dispatch rules, webhook event logs, setup links, per-issue/per-thread
 * session bindings. Mirrors apps/main/migrations/0001_schema.sql + 0002 +
 * 0004 + 0007 + 0008 + 0009 + 0012 (post-tenant-id NOT NULL shape).
 *
 * Idempotent — every CREATE uses IF NOT EXISTS. Self-host calls this on
 * boot from main-node so the same SqlClient holds the integrations data;
 * CF stays on D1 migrations and never invokes this.
 */
export async function applyIntegrationsSchema(opts: {
  sql: SqlClient;
  dialect: SqlDialect;
}): Promise<void> {
  const { sql, dialect } = opts;
  const isPg = dialect === "postgres";
  // SQLite uses INTEGER, PG uses BIGINT — `INT8` works in both but
  // SQLite reads as INTEGER affinity so the typed conversions stay clean.
  const intT = isPg ? "BIGINT" : "INTEGER";
  await withPgRaceRetry(async () => {
    await sql.exec(`
      CREATE TABLE IF NOT EXISTS "linear_apps" (
        "id"                    TEXT PRIMARY KEY NOT NULL,
        "tenant_id"             TEXT NOT NULL,
        "publication_id"        TEXT,
        "client_id"             TEXT NOT NULL,
        "client_secret_cipher"  TEXT NOT NULL,
        "webhook_secret_cipher" TEXT NOT NULL,
        "created_at"            ${intT} NOT NULL
      );
      CREATE INDEX IF NOT EXISTS "idx_linear_apps_tenant" ON "linear_apps" ("tenant_id");

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
        "created_at"            ${intT} NOT NULL,
        "revoked_at"            ${intT},
        "vault_id"              TEXT
      );
      CREATE INDEX IF NOT EXISTS "idx_linear_installations_user"
        ON "linear_installations" ("user_id", "provider_id", "revoked_at");
      CREATE INDEX IF NOT EXISTS "idx_linear_installations_tenant"
        ON "linear_installations" ("tenant_id", "created_at" DESC);

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
        "created_at"            ${intT} NOT NULL,
        "unpublished_at"        ${intT},
        "environment_id"        TEXT
      );
      CREATE INDEX IF NOT EXISTS "idx_linear_publications_installation"
        ON "linear_publications" ("installation_id");
      CREATE INDEX IF NOT EXISTS "idx_linear_publications_user_agent"
        ON "linear_publications" ("user_id", "agent_id");
      CREATE INDEX IF NOT EXISTS "idx_linear_publications_tenant"
        ON "linear_publications" ("tenant_id", "created_at" DESC);

      CREATE TABLE IF NOT EXISTS "linear_setup_links" (
        "token"          TEXT PRIMARY KEY NOT NULL,
        "tenant_id"      TEXT NOT NULL,
        "publication_id" TEXT NOT NULL,
        "created_by"     TEXT NOT NULL,
        "expires_at"     ${intT} NOT NULL,
        "used_at"        ${intT},
        "used_by_email"  TEXT
      );
      CREATE INDEX IF NOT EXISTS "idx_linear_setup_links_expires"
        ON "linear_setup_links" ("expires_at");

      CREATE TABLE IF NOT EXISTS "linear_issue_sessions" (
        "tenant_id"      TEXT NOT NULL,
        "publication_id" TEXT NOT NULL,
        "issue_id"       TEXT NOT NULL,
        "session_id"     TEXT NOT NULL,
        "status"         TEXT NOT NULL,
        "created_at"     ${intT} NOT NULL,
        PRIMARY KEY ("publication_id", "issue_id")
      );
      CREATE INDEX IF NOT EXISTS "idx_linear_issue_sessions_active"
        ON "linear_issue_sessions" ("publication_id", "status");

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
        "last_polled_at"         ${intT},
        "created_at"             ${intT} NOT NULL,
        "updated_at"             ${intT} NOT NULL
      );
      CREATE INDEX IF NOT EXISTS "idx_linear_dispatch_rules_sweep"
        ON "linear_dispatch_rules" ("enabled", "last_polled_at");
      CREATE INDEX IF NOT EXISTS "idx_linear_dispatch_rules_publication"
        ON "linear_dispatch_rules" ("publication_id");

      CREATE TABLE IF NOT EXISTS "linear_events" (
        "delivery_id"           TEXT PRIMARY KEY NOT NULL,
        "tenant_id"             TEXT NOT NULL,
        "installation_id"       TEXT NOT NULL,
        "publication_id"        TEXT,
        "event_type"            TEXT NOT NULL,
        "event_kind"            TEXT,
        "payload_json"          TEXT,
        "received_at"           ${intT} NOT NULL,
        "session_id"            TEXT,
        "processed_at"          ${intT},
        "processed_session_id"  TEXT,
        "error"                 TEXT,
        "error_message"         TEXT
      );
      CREATE INDEX IF NOT EXISTS "idx_linear_events_received"
        ON "linear_events" ("received_at");
      CREATE INDEX IF NOT EXISTS "idx_linear_events_publication"
        ON "linear_events" ("publication_id", "received_at" DESC);

      CREATE TABLE IF NOT EXISTS "github_apps" (
        "id"                    TEXT PRIMARY KEY NOT NULL,
        "tenant_id"             TEXT NOT NULL,
        "publication_id"        TEXT,
        "app_id"                TEXT NOT NULL,
        "app_slug"              TEXT NOT NULL,
        "bot_login"             TEXT NOT NULL,
        "client_id"             TEXT,
        "client_secret_cipher"  TEXT,
        "webhook_secret_cipher" TEXT NOT NULL,
        "private_key_cipher"    TEXT NOT NULL,
        "created_at"            ${intT} NOT NULL
      );
      CREATE INDEX IF NOT EXISTS "idx_github_apps_app_id" ON "github_apps" ("app_id");

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
        "created_at"            ${intT} NOT NULL,
        "revoked_at"            ${intT},
        "vault_id"              TEXT
      );
      CREATE INDEX IF NOT EXISTS "idx_github_installations_user"
        ON "github_installations" ("user_id", "provider_id", "revoked_at");

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
        "created_at"            ${intT} NOT NULL,
        "unpublished_at"        ${intT},
        "environment_id"        TEXT
      );
      CREATE INDEX IF NOT EXISTS "idx_github_publications_installation"
        ON "github_publications" ("installation_id");
      CREATE INDEX IF NOT EXISTS "idx_github_publications_user_agent"
        ON "github_publications" ("user_id", "agent_id");

      CREATE TABLE IF NOT EXISTS "github_webhook_events" (
        "delivery_id"     TEXT PRIMARY KEY NOT NULL,
        "tenant_id"       TEXT NOT NULL,
        "installation_id" TEXT NOT NULL,
        "publication_id"  TEXT,
        "event_type"      TEXT NOT NULL,
        "received_at"     ${intT} NOT NULL,
        "session_id"      TEXT,
        "error"           TEXT
      );
      CREATE INDEX IF NOT EXISTS "idx_github_webhook_events_received"
        ON "github_webhook_events" ("received_at");

      CREATE TABLE IF NOT EXISTS "slack_apps" (
        "id"                     TEXT PRIMARY KEY NOT NULL,
        "tenant_id"              TEXT NOT NULL,
        "publication_id"         TEXT,
        "client_id"              TEXT NOT NULL,
        "client_secret_cipher"   TEXT NOT NULL,
        "signing_secret_cipher"  TEXT NOT NULL,
        "created_at"             ${intT} NOT NULL
      );
      CREATE INDEX IF NOT EXISTS "idx_slack_apps_tenant" ON "slack_apps" ("tenant_id");

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
        "created_at"            ${intT} NOT NULL,
        "revoked_at"            ${intT}
      );
      CREATE INDEX IF NOT EXISTS "idx_slack_installations_user"
        ON "slack_installations" ("user_id", "provider_id");

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
        "created_at"            ${intT} NOT NULL,
        "unpublished_at"        ${intT}
      );
      CREATE INDEX IF NOT EXISTS "idx_slack_publications_installation"
        ON "slack_publications" ("installation_id");
      CREATE INDEX IF NOT EXISTS "idx_slack_publications_user_agent"
        ON "slack_publications" ("user_id", "agent_id");

      CREATE TABLE IF NOT EXISTS "slack_webhook_events" (
        "delivery_id"     TEXT PRIMARY KEY NOT NULL,
        "tenant_id"       TEXT NOT NULL,
        "installation_id" TEXT NOT NULL,
        "publication_id"  TEXT,
        "event_type"      TEXT NOT NULL,
        "received_at"     ${intT} NOT NULL,
        "session_id"      TEXT,
        "error"           TEXT
      );
      CREATE INDEX IF NOT EXISTS "idx_slack_webhook_events_received"
        ON "slack_webhook_events" ("received_at");

      CREATE TABLE IF NOT EXISTS "slack_setup_links" (
        "token"          TEXT PRIMARY KEY NOT NULL,
        "tenant_id"      TEXT NOT NULL,
        "publication_id" TEXT NOT NULL,
        "created_by"     TEXT NOT NULL,
        "expires_at"     ${intT} NOT NULL,
        "used_at"        ${intT},
        "used_by_email"  TEXT
      );
      CREATE INDEX IF NOT EXISTS "idx_slack_setup_links_expires"
        ON "slack_setup_links" ("expires_at");

      CREATE TABLE IF NOT EXISTS "slack_thread_sessions" (
        "publication_id"      TEXT NOT NULL,
        "tenant_id"           TEXT NOT NULL,
        "scope_key"           TEXT NOT NULL,
        "session_id"          TEXT NOT NULL,
        "status"              TEXT NOT NULL,
        "created_at"          ${intT} NOT NULL,
        "pending_scan_until"  ${intT},
        "last_scan_at"        ${intT},
        "channel_name"        TEXT,
        PRIMARY KEY ("publication_id", "scope_key")
      );
      CREATE INDEX IF NOT EXISTS "idx_slack_thread_sessions_active"
        ON "slack_thread_sessions" ("publication_id", "status");
    `);
  }, isPg);
}
