/**
 * The single port the storage layer depends on for tenant→DB resolution.
 *
 * Implementations:
 *   - CfSharedAuthDbProvider (cf-shared-default.ts): returns env.AUTH_DB for
 *     every tenant. The Phase 1 default — zero behaviour change.
 *   - CfStaticBindingTenantDbProvider (cf-static.ts): looks up
 *     env[`TENANT_DB_<sanitized>`] for the tenant, falls back to env.AUTH_DB
 *     when no per-tenant binding exists (legacy tenants). Used in Phase 4
 *     after the CICD sync script populates wrangler.jsonc with one binding
 *     per active tenant from the control-plane `tenant_dbs` directory.
 *   - StaticTenantDbProvider (test-fakes.ts): pre-loaded map for tests.
 *
 * The async signature is intentional even though most implementations resolve
 * synchronously — leaves room for HTTP-API-backed adapters or sharding-table
 * lookups without changing the port shape.
 */
export interface TenantDbProvider {
  resolve(tenantId: string): Promise<D1Database>;
}
