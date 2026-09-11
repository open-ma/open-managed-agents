// Centralized schema for the self-host runtime. Idempotent — every
// CREATE TABLE / CREATE INDEX uses IF NOT EXISTS, every ALTER TABLE
// tolerates "duplicate column" / "already exists".
//
// CF still uses the migration files in apps/main/migrations/ for D1
// push history. From now on, both runtimes also call applySchema() on
// boot so the inline DDL stays in one place.

import type { SqlClient } from "@open-managed-agents/sql-client";
import { ensureSchema as ensureEventLogSchema } from "@open-managed-agents/event-log/sql";

export type SqlDialect = "sqlite" | "postgres" | "mysql";

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
  } else if (dialect === "mysql") {
    // The main MySQL adapter installs these as part of its canonical schema.
    // Keep this idempotent bootstrap here as well because Better Auth owns
    // the column representation (native DATETIME values, not epoch millis).
    await sql.exec(`
      CREATE TABLE IF NOT EXISTS \`user\` (
        \`id\` VARCHAR(191) PRIMARY KEY NOT NULL,
        \`email\` VARCHAR(191) NOT NULL UNIQUE,
        \`emailVerified\` BOOLEAN NOT NULL DEFAULT FALSE,
        \`name\` LONGTEXT NOT NULL,
        \`image\` LONGTEXT,
        \`tenantId\` VARCHAR(191),
        \`role\` VARCHAR(191),
        \`createdAt\` DATETIME(3) NOT NULL,
        \`updatedAt\` DATETIME(3) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      CREATE TABLE IF NOT EXISTS \`session\` (
        \`id\` VARCHAR(191) PRIMARY KEY NOT NULL,
        \`userId\` VARCHAR(191) NOT NULL,
        \`token\` VARCHAR(191) NOT NULL UNIQUE,
        \`expiresAt\` DATETIME(3) NOT NULL,
        \`ipAddress\` LONGTEXT,
        \`userAgent\` LONGTEXT,
        \`createdAt\` DATETIME(3) NOT NULL,
        \`updatedAt\` DATETIME(3) NOT NULL,
        KEY \`idx_session_userId\` (\`userId\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      CREATE TABLE IF NOT EXISTS \`account\` (
        \`id\` VARCHAR(191) PRIMARY KEY NOT NULL,
        \`userId\` VARCHAR(191) NOT NULL,
        \`accountId\` VARCHAR(191) NOT NULL,
        \`providerId\` VARCHAR(191) NOT NULL,
        \`accessToken\` LONGTEXT,
        \`refreshToken\` LONGTEXT,
        \`idToken\` LONGTEXT,
        \`accessTokenExpiresAt\` DATETIME(3),
        \`refreshTokenExpiresAt\` DATETIME(3),
        \`scope\` LONGTEXT,
        \`password\` LONGTEXT,
        \`createdAt\` DATETIME(3) NOT NULL,
        \`updatedAt\` DATETIME(3) NOT NULL,
        KEY \`idx_account_userId\` (\`userId\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      CREATE TABLE IF NOT EXISTS \`verification\` (
        \`id\` VARCHAR(191) PRIMARY KEY NOT NULL,
        \`identifier\` VARCHAR(191) NOT NULL,
        \`value\` LONGTEXT NOT NULL,
        \`expiresAt\` DATETIME(3) NOT NULL,
        \`createdAt\` DATETIME(3),
        \`updatedAt\` DATETIME(3),
        KEY \`idx_verification_identifier\` (\`identifier\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
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
 * `tenant` + `membership` in apps/main/migrations/0001_schema.sql. Keep the
 * tenant timestamp names aligned with the canonical Drizzle schemas and
 * consolidated migrations so every SqlClient sees the same Port shape.
 */
export async function applyTenantSchema(sql: SqlClient): Promise<void> {
  await sql.exec(`
    CREATE TABLE IF NOT EXISTS "tenant" (
      "id"         TEXT PRIMARY KEY NOT NULL,
      "name"       TEXT NOT NULL,
      "createdAt"  BIGINT NOT NULL,
      "updatedAt"  BIGINT NOT NULL
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
