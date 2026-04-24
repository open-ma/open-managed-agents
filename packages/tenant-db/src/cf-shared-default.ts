import type { TenantDbProvider } from "./ports";

/**
 * Phase 1 default: ignore tenantId, always return the shared AUTH_DB binding.
 * This makes Phase 1 a pure refactor — every tenant's data continues to
 * land in the same physical D1 it does today.
 *
 * Replaced by CfStaticBindingTenantDbProvider once Phase 4 lands and the
 * CICD binding-sync pipeline starts populating per-tenant bindings.
 */
export class CfSharedAuthDbProvider implements TenantDbProvider {
  constructor(private readonly authDb: D1Database) {}

  async resolve(_tenantId: string): Promise<D1Database> {
    return this.authDb;
  }
}
