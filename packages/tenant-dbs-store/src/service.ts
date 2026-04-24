import type {
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

export type { ShardStatus };
