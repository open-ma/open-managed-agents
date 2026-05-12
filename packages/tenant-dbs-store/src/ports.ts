// Persistence ports for the control-plane shard router tables.
//
// Two tables, both ALWAYS in the control-plane DB regardless of tenant
// sharding:
//
//   tenant_shard  — assignment record. tenant_id → binding_name. Missing row
//                   means tenant falls back to the default shard (AUTH_DB).
//                   Permanent: never updated unless we manually migrate a
//                   tenant between shards (rare admin op).
//
//   shard_pool    — operational state. binding_name → status / capacity.
//                   Drives "which shard should the next new tenant land on".
//                   Updated by the capacity monitor + admin scripts.
//
// Used by MetaTableTenantDbProvider (in @open-managed-agents/tenant-db) for
// the per-request `tenantId → D1Database` resolution. Cached per-isolate.

export interface TenantShardRow {
  tenantId: string;
  bindingName: string;
  createdAt: number;
}

export interface NewTenantShard {
  tenantId: string;
  bindingName: string;
}

export interface TenantShardDirectoryRepo {
  /** O(1) lookup. Used on hot path (every request) — caller caches. */
  get(tenantId: string): Promise<TenantShardRow | null>;
  /** First-time tenant assignment. Idempotent on PK collision (existing row
   *  preserved — never re-route a live tenant accidentally). */
  insert(row: NewTenantShard): Promise<TenantShardRow>;
  /** Manual migrate-tenant op only. Writes are visible only after worker
   *  restart due to per-isolate cache. */
  reassign(tenantId: string, bindingName: string): Promise<void>;
  /** For admin views. Returns ALL assigned tenants. */
  listAll(): Promise<readonly TenantShardRow[]>;
}

// ─── Shard pool ─────────────────────────────────────────────────────────

export type ShardStatus = "open" | "draining" | "full" | "archived";

export interface ShardPoolRow {
  bindingName: string;
  status: ShardStatus;
  tenantCount: number;
  sizeBytes: number | null;
  observedAt: number | null;
  notes: string | null;
}

export interface NewShardPool {
  bindingName: string;
  status?: ShardStatus;
  notes?: string;
}

export interface ShardPoolRepo {
  get(bindingName: string): Promise<ShardPoolRow | null>;
  /** Register a new shard binding. Status defaults to 'open'. */
  insert(row: NewShardPool): Promise<ShardPoolRow>;
  /** Pick the shard new tenants should land on. Returns the open shard with
   *  the lowest tenant_count (ties broken by smallest size_bytes). Returns
   *  null when no shard is open — caller falls back to AUTH_DB. */
  pickOpen(): Promise<ShardPoolRow | null>;
  setStatus(bindingName: string, status: ShardStatus): Promise<void>;
  setObservedSize(bindingName: string, sizeBytes: number, observedAt: number): Promise<void>;
  incrementTenantCount(bindingName: string): Promise<void>;
  listAll(): Promise<readonly ShardPoolRow[]>;
}

// ─── Memory store → tenant index ────────────────────────────────────────
//
// Lives in the same control-plane DB as tenant_shard / shard_pool.
// Populated synchronously when a memory store is created (REST POST
// /v1/memory). Consumed by the R2 memory-events queue consumer to
// resolve which AUTH_DB_NN shard owns a given memory_store — R2 events
// carry only the storage key (`<store_id>/<path>`), no tenant_id, so
// without this index the consumer would have to fall back to env.AUTH_DB
// and write cross-shard ghost rows for any tenant not on shard 0.

export interface MemoryStoreTenantRow {
  storeId: string;
  tenantId: string;
  createdAt: number;
}

export interface MemoryStoreTenantIndexRepo {
  /** O(1) lookup. Hot path — every R2 memory event hits this. Returns
   *  null for store_ids that pre-date the index (caller treats as
   *  "use the default shard"). */
  lookup(storeId: string): Promise<string | null>;
  /** Idempotent: re-running create-store on the same store_id MUST NOT
   *  re-route to a different tenant. PK collision is a no-op. */
  register(storeId: string, tenantId: string, nowMs: number): Promise<void>;
  /** For admin views / backfill scripts. */
  listAll(): Promise<readonly MemoryStoreTenantRow[]>;
}
