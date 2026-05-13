// Thin re-export shim for the legacy import path. Test files
// (pg-better-auth.test.ts) import these from here; the actual schema
// lives in @open-managed-agents/schema.

import { applyTenantSchema } from "@open-managed-agents/schema";
import { ensureTenantSqlite as _ensureTenantSqlite } from "@open-managed-agents/auth-config";
import type { SqlClient } from "@open-managed-agents/sql-client";

export const ensureTenantSchema = applyTenantSchema;
export const ensureTenantSqlite = _ensureTenantSqlite;

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
    .prepare(
      `SELECT 1 AS one FROM membership WHERE user_id = ? AND tenant_id = ? LIMIT 1`,
    )
    .bind(userId, tenantId)
    .first<{ one: number }>();
  return row !== null;
}
