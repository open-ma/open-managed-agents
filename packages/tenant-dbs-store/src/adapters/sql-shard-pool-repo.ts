import type {
  NewShardPool,
  ShardPoolRepo,
  ShardPoolRow,
  ShardStatus,
} from "../ports";
import type { SqlClient } from "@open-managed-agents/sql-client";

interface Row {
  binding_name: string;
  status: string;
  tenant_count: number;
  size_bytes: number | null;
  observed_at: number | null;
  notes: string | null;
}

export class SqlShardPoolRepo implements ShardPoolRepo {
  constructor(private readonly db: SqlClient) {}

  async get(bindingName: string): Promise<ShardPoolRow | null> {
    const row = await this.db
      .prepare(`SELECT * FROM shard_pool WHERE binding_name = ?`)
      .bind(bindingName)
      .first<Row>();
    return row ? toDomain(row) : null;
  }

  async insert(input: NewShardPool): Promise<ShardPoolRow> {
    // Idempotent on PK collision — second registration of the same shard
    // preserves any operational state already accumulated.
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO shard_pool
           (binding_name, status, tenant_count, size_bytes, observed_at, notes)
         VALUES (?, ?, 0, NULL, NULL, ?)`,
      )
      .bind(input.bindingName, input.status ?? "open", input.notes ?? null)
      .run();
    const row = await this.get(input.bindingName);
    if (!row) throw new Error(`shard_pool row vanished after insert: ${input.bindingName}`);
    return row;
  }

  async pickOpen(): Promise<ShardPoolRow | null> {
    // Lowest tenant_count first; tie-break by smallest observed size; nulls
    // last (treat unknown size as "probably newest, use it").
    const row = await this.db
      .prepare(
        `SELECT * FROM shard_pool
         WHERE status = 'open'
         ORDER BY tenant_count ASC,
                  CASE WHEN size_bytes IS NULL THEN 1 ELSE 0 END,
                  size_bytes ASC
         LIMIT 1`,
      )
      .first<Row>();
    return row ? toDomain(row) : null;
  }

  async setStatus(bindingName: string, status: ShardStatus): Promise<void> {
    await this.db
      .prepare(`UPDATE shard_pool SET status = ? WHERE binding_name = ?`)
      .bind(status, bindingName)
      .run();
  }

  async setObservedSize(
    bindingName: string,
    sizeBytes: number,
    observedAt: number,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE shard_pool SET size_bytes = ?, observed_at = ? WHERE binding_name = ?`,
      )
      .bind(sizeBytes, observedAt, bindingName)
      .run();
  }

  async incrementTenantCount(bindingName: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE shard_pool SET tenant_count = tenant_count + 1 WHERE binding_name = ?`,
      )
      .bind(bindingName)
      .run();
  }

  async listAll(): Promise<readonly ShardPoolRow[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM shard_pool ORDER BY binding_name`)
      .all<Row>();
    return (results ?? []).map(toDomain);
  }
}

function toDomain(row: Row): ShardPoolRow {
  return {
    bindingName: row.binding_name,
    status: row.status as ShardStatus,
    tenantCount: row.tenant_count,
    sizeBytes: row.size_bytes,
    observedAt: row.observed_at,
    notes: row.notes,
  };
}
