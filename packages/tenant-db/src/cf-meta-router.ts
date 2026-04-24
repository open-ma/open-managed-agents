import type { TenantDbProvider } from "./ports";

/**
 * Production TenantDbProvider: reads `tenant_shard` from the control-plane
 * DB to look up which D1 binding holds a tenant's data.
 *
 * Resolution rules:
 *   1. Cache hit → return cached D1Database (no control-plane round-trip)
 *   2. Cache miss → SELECT binding_name FROM tenant_shard WHERE tenant_id=?
 *   3. Row found → env[binding_name] (cache it)
 *   4. No row    → env.AUTH_DB (cache the fallback too)
 *
 * Cache strategy: per-isolate Map, never expires. Justification:
 *   - tenant→binding mapping is monotonic in normal operation (we only ever
 *     INSERT, never UPDATE, in the auto-assign path)
 *   - admin migrate-tenant ops are rare + manual + require worker restart
 *     (or `/admin/cache/flush` in a future enhancement) to take effect
 *   - never-expiring cache keeps hot path zero-cost after first hit
 *
 * The fallback to env.AUTH_DB is what makes N=1 deployments seamless: when
 * tenant_shard is empty, every tenant resolves to AUTH_DB, behaviour is
 * identical to the pre-sharding shared-DB world.
 */
export class MetaTableTenantDbProvider implements TenantDbProvider {
  private readonly cache = new Map<string, D1Database>();

  constructor(
    private readonly env: Record<string, unknown>,
    private readonly controlPlaneDb: D1Database,
    private readonly defaultBinding: D1Database = controlPlaneDb,
  ) {}

  async resolve(tenantId: string): Promise<D1Database> {
    const cached = this.cache.get(tenantId);
    if (cached) return cached;

    let row: { binding_name: string } | null = null;
    try {
      row = await this.controlPlaneDb
        .prepare(`SELECT binding_name FROM tenant_shard WHERE tenant_id = ?`)
        .bind(tenantId)
        .first<{ binding_name: string }>();
    } catch (err) {
      // Control-plane lookup itself failed (DB down, table missing). Fall
      // back to the default binding rather than 500'ing the request. The
      // cache then remembers the fallback — acceptable in N=1 deployments
      // and degrades gracefully in N>1 (a few requests on the wrong shard
      // until cache cycles via restart).
      console.warn(
        `[MetaTableTenantDbProvider] control-plane lookup failed for tenantId=${tenantId}: ${err}`,
      );
      this.cache.set(tenantId, this.defaultBinding);
      return this.defaultBinding;
    }

    let resolved = this.defaultBinding;
    if (row?.binding_name) {
      const binding = this.env[row.binding_name] as D1Database | undefined;
      if (!binding) {
        // tenant_shard claims this tenant lives on a binding that doesn't
        // exist in env. This is a real config bug — almost certainly forgot
        // to add the binding to wrangler.jsonc after registering the shard.
        // Throw so the operator notices, don't silently fall back.
        throw new Error(
          `MetaTableTenantDbProvider: tenant_shard row for tenantId=${tenantId} ` +
            `references binding "${row.binding_name}" but env doesn't have it. ` +
            `Add the binding to wrangler.jsonc and redeploy, or migrate the tenant.`,
        );
      }
      resolved = binding;
    }

    this.cache.set(tenantId, resolved);
    return resolved;
  }

  /** Test helper: clear the cache. Production code never calls this — cache
   *  is invalidated by worker restart. */
  __clearCache(): void {
    this.cache.clear();
  }
}
