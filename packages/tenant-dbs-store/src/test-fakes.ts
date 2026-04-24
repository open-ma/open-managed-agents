import type {
  NewShardPool,
  NewTenantShard,
  ShardPoolRepo,
  ShardPoolRow,
  ShardStatus,
  TenantShardDirectoryRepo,
  TenantShardRow,
} from "./ports";

export class InMemoryTenantShardDirectoryRepo implements TenantShardDirectoryRepo {
  private rows = new Map<string, TenantShardRow>();
  private clock: () => number;

  constructor(clock: () => number = () => Date.now()) {
    this.clock = clock;
  }

  async get(tenantId: string): Promise<TenantShardRow | null> {
    return this.rows.get(tenantId) ?? null;
  }

  async insert(input: NewTenantShard): Promise<TenantShardRow> {
    // INSERT OR IGNORE semantics: existing row preserved, never re-routed.
    const existing = this.rows.get(input.tenantId);
    if (existing) return existing;
    const row: TenantShardRow = {
      tenantId: input.tenantId,
      bindingName: input.bindingName,
      createdAt: this.clock(),
    };
    this.rows.set(input.tenantId, row);
    return row;
  }

  async reassign(tenantId: string, bindingName: string): Promise<void> {
    const row = this.rows.get(tenantId);
    if (row) this.rows.set(tenantId, { ...row, bindingName });
  }

  async listAll(): Promise<readonly TenantShardRow[]> {
    return [...this.rows.values()].sort((a, b) => a.createdAt - b.createdAt);
  }
}

export class InMemoryShardPoolRepo implements ShardPoolRepo {
  private rows = new Map<string, ShardPoolRow>();

  async get(bindingName: string): Promise<ShardPoolRow | null> {
    return this.rows.get(bindingName) ?? null;
  }

  async insert(input: NewShardPool): Promise<ShardPoolRow> {
    const existing = this.rows.get(input.bindingName);
    if (existing) return existing;
    const row: ShardPoolRow = {
      bindingName: input.bindingName,
      status: input.status ?? "open",
      tenantCount: 0,
      sizeBytes: null,
      observedAt: null,
      notes: input.notes ?? null,
    };
    this.rows.set(input.bindingName, row);
    return row;
  }

  async pickOpen(): Promise<ShardPoolRow | null> {
    const open = [...this.rows.values()].filter((r) => r.status === "open");
    if (open.length === 0) return null;
    open.sort((a, b) => {
      if (a.tenantCount !== b.tenantCount) return a.tenantCount - b.tenantCount;
      const aSize = a.sizeBytes ?? -1;
      const bSize = b.sizeBytes ?? -1;
      return aSize - bSize;
    });
    return open[0];
  }

  async setStatus(bindingName: string, status: ShardStatus): Promise<void> {
    const row = this.rows.get(bindingName);
    if (row) this.rows.set(bindingName, { ...row, status });
  }

  async setObservedSize(
    bindingName: string,
    sizeBytes: number,
    observedAt: number,
  ): Promise<void> {
    const row = this.rows.get(bindingName);
    if (row) this.rows.set(bindingName, { ...row, sizeBytes, observedAt });
  }

  async incrementTenantCount(bindingName: string): Promise<void> {
    const row = this.rows.get(bindingName);
    if (row) this.rows.set(bindingName, { ...row, tenantCount: row.tenantCount + 1 });
  }

  async listAll(): Promise<readonly ShardPoolRow[]> {
    return [...this.rows.values()].sort((a, b) =>
      a.bindingName.localeCompare(b.bindingName),
    );
  }
}
