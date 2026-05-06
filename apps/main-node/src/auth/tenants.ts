// Tenant + membership management for the self-host Node side. Mirrors the
// helpers in apps/main/src/auth-config.ts (getTenantId, hasMembership,
// ensureTenant) but takes a SqlClient instead of D1Database — so it works
// against either backend (sqlite or pg) without forking.
//
// Tables:
//   - `tenant` (id, name, created_at, updated_at)
//   - `membership` (user_id, tenant_id, role, created_at) PK(user_id, tenant_id)
//
// We do NOT manage `user.tenantId` here — better-auth's hook updates the
// user row through the auth db (separate). That's fine; we use membership
// as the source of truth for "what tenants does this user belong to" and
// only consult user.tenantId in the auth middleware as a default-tenant
// hint.

import type { SqlClient } from "@open-managed-agents/sql-client";

export async function ensureTenantSchema(sql: SqlClient): Promise<void> {
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

export async function getDefaultTenantId(
  sql: SqlClient,
  userId: string,
): Promise<string | null> {
  const row = await sql
    .prepare(
      `SELECT tenant_id FROM membership WHERE user_id = ? ORDER BY created_at ASC, tenant_id ASC LIMIT 1`,
    )
    .bind(userId)
    .first<{ tenant_id: string }>();
  return row?.tenant_id ?? null;
}

export async function hasMembership(
  sql: SqlClient,
  userId: string,
  tenantId: string,
): Promise<boolean> {
  const row = await sql
    .prepare(`SELECT 1 AS one FROM membership WHERE user_id = ? AND tenant_id = ? LIMIT 1`)
    .bind(userId, tenantId)
    .first<{ one: number }>();
  return row !== null;
}

/**
 * Idempotent ensure-tenant. Used by:
 *   - better-auth user.create.after hook (sign-up path)
 *   - auth middleware self-heal for users that signed up before this hook
 *
 * Race-safe: concurrent invocations on the same userId may both attempt
 * tenant creation; the loser's INSERT OR IGNORE on membership prevents
 * a duplicate row, then re-reads the winner's tenant_id.
 */
export async function ensureTenantSqlite(
  sql: SqlClient,
  userId: string,
  userName: string | null | undefined,
  userEmail: string | null | undefined,
): Promise<string> {
  const existing = await getDefaultTenantId(sql, userId);
  if (existing) return existing;

  const tenantId = `tn_${randomHex(16)}`;
  const now = Date.now();
  const trimmedName = (userName ?? "").trim();
  const emailPrefix = (userEmail ?? "").split("@")[0]?.trim() ?? "";
  const display = trimmedName || emailPrefix || "User";
  const tenantName = `${display}'s workspace`;

  await sql
    .prepare(`INSERT INTO "tenant" (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
    .bind(tenantId, tenantName, now, now)
    .run();

  // Best-effort INSERT OR IGNORE for the race case.
  // SQLite + Postgres both accept ON CONFLICT DO NOTHING.
  await sql
    .prepare(
      `INSERT INTO "membership" (user_id, tenant_id, role, created_at)
       VALUES (?, ?, 'owner', ?)
       ON CONFLICT (user_id, tenant_id) DO NOTHING`,
    )
    .bind(userId, tenantId, now)
    .run();

  const final = await getDefaultTenantId(sql, userId);
  return final ?? tenantId;
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
