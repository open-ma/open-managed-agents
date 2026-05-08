/**
 * Tenant→shard routing for horizontally-sharded AUTH_DB.
 *
 * Architecture (see migrations-router/0001_schema.sql):
 *
 *   ROUTER_DB                                 AUTH_DB_00..AUTH_DB_03
 *   ┌────────────────────────────┐            ┌─────────────────────┐
 *   │ tenant_shard               │   lookup   │ user / sessions /   │
 *   │   tenant_id → binding_name │ ────────▶  │ agents / memories / │
 *   │ shard_pool                 │            │ ...                 │
 *   │   binding_name + status    │            │ (per-tenant data)   │
 *   └────────────────────────────┘            └─────────────────────┘
 *
 * Hot path: every request that touches per-tenant data resolves the
 * tenant's shard via this module before any AUTH_DB query. KV cache
 * (1hr TTL) keeps steady-state ROUTER_DB load near zero.
 *
 * Failure modes:
 *   - Unknown tenant_id (not in tenant_shard) → throws ShardLookupError.
 *     Caller should treat as 404, not assume default shard. Silent
 *     fallback would route writes for one tenant to a shard another
 *     tenant owns, corrupting data.
 *   - All shards full / draining → assignShardOnSignup throws. Operator
 *     intervention: provision more shards + INSERT shard_pool row.
 */

/**
 * The set of shard binding names. Order matters only for cosmetic
 * stability — the placement algorithm picks the least-loaded `open`
 * shard, not the first one in this list. Add new bindings here when
 * provisioning more shards.
 */
export const SHARD_BINDING_NAMES = [
  "AUTH_DB_00",
  "AUTH_DB_01",
  "AUTH_DB_02",
  "AUTH_DB_03",
] as const satisfies ReadonlyArray<keyof ShardBindings>;

export type ShardBindingName = (typeof SHARD_BINDING_NAMES)[number];

/**
 * Subset of Env that the shard router needs. Workers that route
 * tenant-keyed queries must declare these bindings in wrangler.jsonc.
 */
export interface ShardBindings {
  ROUTER_DB: D1Database;
  AUTH_DB_00: D1Database;
  AUTH_DB_01: D1Database;
  AUTH_DB_02: D1Database;
  AUTH_DB_03: D1Database;
  /** KV cache for tenant→shard mapping (1hr TTL). Reuses CONFIG_KV
   *  with `shard:tenant:` key prefix — no extra binding needed.
   *  Falls back to direct ROUTER_DB read when absent (useful in tests). */
  CONFIG_KV?: KVNamespace;
}

export class ShardLookupError extends Error {
  constructor(public readonly tenantId: string, message: string) {
    super(message);
    this.name = "ShardLookupError";
  }
}

const KV_CACHE_TTL_SEC = 3600;
const KV_KEY_PREFIX = "shard:tenant:";

/**
 * Resolve the AUTH_DB shard for a tenant. Cached path: KV → 1 RTT.
 * Cold path: ROUTER_DB lookup + KV write → 2 RTT.
 *
 * Throws ShardLookupError if the tenant has no row in tenant_shard.
 * Callers MUST handle this — silent default-shard fallback would
 * cross-contaminate tenant data.
 */
export async function getShardForTenant(
  env: ShardBindings,
  tenantId: string,
): Promise<D1Database> {
  const bindingName = await resolveBindingName(env, tenantId);
  const db = env[bindingName];
  if (!db) {
    throw new ShardLookupError(
      tenantId,
      `tenant_shard maps ${tenantId} → ${bindingName} but that binding is not configured on this worker. Update wrangler.jsonc.`,
    );
  }
  return db;
}

/**
 * Cache-aware lookup. Returns the binding name string. Exposed
 * separately from getShardForTenant so admin tools can inspect the
 * mapping without needing a live D1Database instance.
 */
export async function resolveBindingName(
  env: ShardBindings,
  tenantId: string,
): Promise<ShardBindingName> {
  const e = env;

  if (e.CONFIG_KV) {
    const cached = await e.CONFIG_KV.get(KV_KEY_PREFIX + tenantId);
    if (cached && isValidBindingName(cached)) return cached;
  }

  const row = await e.ROUTER_DB.prepare(
    "SELECT binding_name FROM tenant_shard WHERE tenant_id = ?",
  )
    .bind(tenantId)
    .first<{ binding_name: string }>();

  if (!row) {
    throw new ShardLookupError(
      tenantId,
      `Tenant ${tenantId} not assigned to any shard. Run assignShardOnSignup() at tenant creation.`,
    );
  }
  if (!isValidBindingName(row.binding_name)) {
    throw new ShardLookupError(
      tenantId,
      `tenant_shard.binding_name='${row.binding_name}' for ${tenantId} is not in SHARD_BINDING_NAMES. Stale assignment after a shard was deprovisioned?`,
    );
  }

  if (e.CONFIG_KV) {
    // Best-effort write — failure here only means next request pays
    // another ROUTER_DB read. Don't await on the critical path.
    e.CONFIG_KV
      .put(KV_KEY_PREFIX + tenantId, row.binding_name, {
        expirationTtl: KV_CACHE_TTL_SEC,
      })
      .catch(() => {});
  }

  return row.binding_name;
}

/**
 * Pick the least-loaded `open` shard and persist (tenant_id → shard).
 * Call this exactly once per tenant, at signup. Subsequent
 * getShardForTenant() reads see the assignment.
 *
 * Idempotent: if tenant_shard already has a row for tenantId, returns
 * the existing binding (no INSERT, no tenant_count bump). Safe to call
 * during signup retry.
 */
export async function assignShardOnSignup(
  env: ShardBindings,
  tenantId: string,
  nowMs: number = Date.now(),
): Promise<ShardBindingName> {
  const e = env;

  // Idempotency check first — common case for retried signups.
  const existing = await e.ROUTER_DB.prepare(
    "SELECT binding_name FROM tenant_shard WHERE tenant_id = ?",
  )
    .bind(tenantId)
    .first<{ binding_name: string }>();
  if (existing && isValidBindingName(existing.binding_name)) {
    return existing.binding_name;
  }

  const next = await e.ROUTER_DB.prepare(
    `SELECT binding_name FROM shard_pool
       WHERE status = 'open'
       ORDER BY tenant_count ASC, binding_name ASC
       LIMIT 1`,
  ).first<{ binding_name: string }>();

  if (!next) {
    throw new Error(
      "No open shards available. Provision more or set status='open' on a draining shard.",
    );
  }
  if (!isValidBindingName(next.binding_name)) {
    throw new Error(
      `shard_pool.binding_name='${next.binding_name}' is not in SHARD_BINDING_NAMES. Sync the seed.`,
    );
  }

  await e.ROUTER_DB.batch([
    e.ROUTER_DB.prepare(
      "INSERT INTO tenant_shard (tenant_id, binding_name, created_at) VALUES (?, ?, ?)",
    ).bind(tenantId, next.binding_name, nowMs),
    e.ROUTER_DB.prepare(
      "UPDATE shard_pool SET tenant_count = tenant_count + 1 WHERE binding_name = ?",
    ).bind(next.binding_name),
  ]);

  return next.binding_name;
}

/**
 * Fan-out helper for cross-tenant admin queries. Runs the same SQL on
 * every shard in parallel and concatenates the result rows. Use
 * sparingly — prefer per-tenant queries when possible. Common cases:
 *   - global session list for admin console
 *   - usage rollup across all tenants
 */
export async function queryAllShards<Row>(
  env: ShardBindings,
  sql: string,
  params: unknown[] = [],
): Promise<Row[]> {
  const e = env;
  const results = await Promise.all(
    SHARD_BINDING_NAMES.map(async (name) => {
      const db = e[name];
      if (!db) return [] as Row[];
      const r = await db
        .prepare(sql)
        .bind(...params)
        .all<Row>();
      return r.results ?? [];
    }),
  );
  return results.flat();
}

function isValidBindingName(s: string): s is ShardBindingName {
  return (SHARD_BINDING_NAMES as readonly string[]).includes(s);
}
