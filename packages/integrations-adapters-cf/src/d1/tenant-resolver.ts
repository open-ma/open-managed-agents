import type { TenantResolver } from "@open-managed-agents/integrations-core";

/**
 * D1 implementation of TenantResolver. Reads `user.tenantId` from the
 * better-auth control-plane table to resolve the OMA tenant for a given user.
 *
 * Throws when the user has no tenant — that's an integrity violation
 * (auth-config.ts ensureTenant guarantees every user gets one on sign-up,
 * and the cookie middleware in apps/main/src/auth.ts self-heals legacy
 * users on first request). Silently inserting a row with an empty tenantId
 * would defeat the point of the column.
 */
export class D1TenantResolver implements TenantResolver {
  constructor(private readonly db: D1Database) {}

  async resolveByUserId(userId: string): Promise<string> {
    const row = await this.db
      .prepare(`SELECT "tenantId" FROM "user" WHERE id = ?`)
      .bind(userId)
      .first<{ tenantId: string | null }>();
    if (!row) {
      throw new Error(`TenantResolver: no user found for userId=${userId}`);
    }
    if (!row.tenantId) {
      throw new Error(
        `TenantResolver: user ${userId} has no tenantId — fix the row before retrying`,
      );
    }
    return row.tenantId;
  }
}
