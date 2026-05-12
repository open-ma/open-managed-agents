import type {
  MemoryStoreTenantIndexRepo,
  MemoryStoreTenantRow,
} from "../ports";
import type { SqlClient } from "@open-managed-agents/sql-client";

interface Row {
  store_id: string;
  tenant_id: string;
  created_at: number;
}

/**
 * SQL adapter for the memory_store → tenant index. Same shape as the
 * sibling tenant_shard / shard_pool repos: depends only on the SqlClient
 * port, no CF-specific types. Schema lives in
 * apps/main/migrations-router/0002_memory_store_tenant.sql.
 */
export class SqlMemoryStoreTenantIndexRepo implements MemoryStoreTenantIndexRepo {
  constructor(private readonly db: SqlClient) {}

  async lookup(storeId: string): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT tenant_id FROM memory_store_tenant WHERE store_id = ?`)
      .bind(storeId)
      .first<{ tenant_id: string }>();
    return row?.tenant_id ?? null;
  }

  async register(storeId: string, tenantId: string, nowMs: number): Promise<void> {
    // INSERT OR IGNORE: a retried createStore must NOT re-route the
    // store to a different tenant. First registration wins.
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO memory_store_tenant
           (store_id, tenant_id, created_at)
         VALUES (?, ?, ?)`,
      )
      .bind(storeId, tenantId, nowMs)
      .run();
  }

  async listAll(): Promise<readonly MemoryStoreTenantRow[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM memory_store_tenant ORDER BY created_at`)
      .all<Row>();
    return (results ?? []).map(toDomain);
  }
}

function toDomain(row: Row): MemoryStoreTenantRow {
  return {
    storeId: row.store_id,
    tenantId: row.tenant_id,
    createdAt: row.created_at,
  };
}
