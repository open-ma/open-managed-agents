import type { TenantDbProvider } from "./ports";

/**
 * Test-only TenantDbProvider. Constructed with a default DB and an optional
 * map of (tenantId → DB) overrides — call sites can either inject one
 * shared in-memory D1 fake (most existing tests, where tenant routing
 * doesn't matter) or distinct fakes per tenant (when verifying isolation).
 *
 * No throw on miss: returns the default. Tests that want to assert "no DB
 * for unknown tenant" should construct without a default.
 */
export class StaticTenantDbProvider implements TenantDbProvider {
  constructor(
    private readonly defaultDb: D1Database | null,
    private readonly perTenant: Map<string, D1Database> = new Map(),
  ) {}

  set(tenantId: string, db: D1Database): void {
    this.perTenant.set(tenantId, db);
  }

  async resolve(tenantId: string): Promise<D1Database> {
    const db = this.perTenant.get(tenantId) ?? this.defaultDb;
    if (!db) {
      throw new Error(
        `StaticTenantDbProvider: no DB for tenantId=${tenantId} and no default set`,
      );
    }
    return db;
  }
}
