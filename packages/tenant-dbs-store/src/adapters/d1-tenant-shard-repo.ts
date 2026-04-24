import type {
  NewTenantShard,
  TenantShardDirectoryRepo,
  TenantShardRow,
} from "../ports";

interface Row {
  tenant_id: string;
  binding_name: string;
  created_at: number;
}

export class D1TenantShardDirectoryRepo implements TenantShardDirectoryRepo {
  constructor(private readonly db: D1Database) {}

  async get(tenantId: string): Promise<TenantShardRow | null> {
    const row = await this.db
      .prepare(`SELECT * FROM tenant_shard WHERE tenant_id = ?`)
      .bind(tenantId)
      .first<Row>();
    return row ? toDomain(row) : null;
  }

  async insert(input: NewTenantShard): Promise<TenantShardRow> {
    const now = Date.now();
    // INSERT OR IGNORE: re-running sign-up for an existing tenant must NOT
    // accidentally re-route to a different shard. The first assignment wins
    // and stays for the lifetime of the tenant.
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO tenant_shard
           (tenant_id, binding_name, created_at)
         VALUES (?, ?, ?)`,
      )
      .bind(input.tenantId, input.bindingName, now)
      .run();
    const row = await this.get(input.tenantId);
    if (!row) throw new Error(`tenant_shard row vanished after insert: ${input.tenantId}`);
    return row;
  }

  async reassign(tenantId: string, bindingName: string): Promise<void> {
    await this.db
      .prepare(`UPDATE tenant_shard SET binding_name = ? WHERE tenant_id = ?`)
      .bind(bindingName, tenantId)
      .run();
  }

  async listAll(): Promise<readonly TenantShardRow[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM tenant_shard ORDER BY created_at`)
      .all<Row>();
    return (results ?? []).map(toDomain);
  }
}

function toDomain(row: Row): TenantShardRow {
  return {
    tenantId: row.tenant_id,
    bindingName: row.binding_name,
    createdAt: row.created_at,
  };
}
