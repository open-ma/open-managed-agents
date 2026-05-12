import type {
  MemoryStoreTenantIndexRepo,
  MemoryStoreTenantRow,
  NewShardPool,
  NewTenantShard,
  ShardPoolRepo,
  ShardPoolRow,
  ShardStatus,
  TenantShardDirectoryRepo,
  TenantShardRow,
} from "./ports";

/**
 * Service wrapper around TenantShardDirectoryRepo. Hot path on every
 * authenticated request via MetaTableTenantDbProvider — keep thin.
 */
export class TenantShardDirectoryService {
  constructor(private readonly repo: TenantShardDirectoryRepo) {}

  get(tenantId: string): Promise<TenantShardRow | null> {
    return this.repo.get(tenantId);
  }

  /** Called once per tenant at sign-up (or first access for legacy tenants). */
  assign(input: NewTenantShard): Promise<TenantShardRow> {
    return this.repo.insert(input);
  }

  /** Admin-only — wipe + re-route. Cache-invalidating, requires worker restart. */
  migrateTo(tenantId: string, bindingName: string): Promise<void> {
    return this.repo.reassign(tenantId, bindingName);
  }

  listAll(): Promise<readonly TenantShardRow[]> {
    return this.repo.listAll();
  }
}

/**
 * Service wrapper around ShardPoolRepo. Used by:
 *   - sign-up flow to pick a shard for a new tenant (`pickOpen`)
 *   - capacity monitor cron to update size + flip status (`setObservedSize`,
 *     `setStatus`)
 *   - admin scripts to register a new shard (`register`)
 */
export class ShardPoolService {
  constructor(private readonly repo: ShardPoolRepo) {}

  /** Register a new shard binding. Idempotent — second call no-ops. */
  register(input: NewShardPool): Promise<ShardPoolRow> {
    return this.repo.insert(input);
  }

  /** Returns null when no shard is open — caller should fall back to default. */
  pickShardForNewTenant(): Promise<ShardPoolRow | null> {
    return this.repo.pickOpen();
  }

  markStatus(bindingName: string, status: ShardStatus): Promise<void> {
    return this.repo.setStatus(bindingName, status);
  }

  recordObservedSize(bindingName: string, sizeBytes: number): Promise<void> {
    return this.repo.setObservedSize(bindingName, sizeBytes, Date.now());
  }

  incrementTenantCount(bindingName: string): Promise<void> {
    return this.repo.incrementTenantCount(bindingName);
  }

  listAll(): Promise<readonly ShardPoolRow[]> {
    return this.repo.listAll();
  }
}

/**
 * Service wrapper around MemoryStoreTenantIndexRepo. Used by:
 *   - REST POST /v1/memory (route handler) to register on store creation
 *   - apps/main/src/queue/memory-events.ts to look up tenant from
 *     R2 event's storage key
 *
 * Both paths consume only this service — no direct SQL, no D1Database
 * in the call chain. CF wiring is in packages/services.
 */
export class MemoryStoreTenantIndexService {
  constructor(private readonly repo: MemoryStoreTenantIndexRepo) {}

  /** Returns null for legacy stores not in the index — caller falls back. */
  lookup(storeId: string): Promise<string | null> {
    return this.repo.lookup(storeId);
  }

  /** Idempotent — safe to call from a retry on store creation. */
  register(storeId: string, tenantId: string, nowMs: number = Date.now()): Promise<void> {
    return this.repo.register(storeId, tenantId, nowMs);
  }

  listAll(): Promise<readonly MemoryStoreTenantRow[]> {
    return this.repo.listAll();
  }
}

export type { ShardStatus };
