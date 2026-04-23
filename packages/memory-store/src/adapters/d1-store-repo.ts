import type { MemoryStoreRepo, NewMemoryStoreInput } from "../ports";
import type { MemoryStoreRow } from "../types";

/**
 * Cloudflare D1 implementation of {@link MemoryStoreRepo}. Owns the SQL
 * against the memory_stores table defined in apps/main/migrations/0007.
 */
export class D1MemoryStoreRepo implements MemoryStoreRepo {
  constructor(private readonly db: D1Database) {}

  async insert(input: NewMemoryStoreInput): Promise<MemoryStoreRow> {
    await this.db
      .prepare(
        `INSERT INTO memory_stores (id, tenant_id, name, description, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .bind(input.id, input.tenantId, input.name, input.description, input.createdAt)
      .run();
    return {
      id: input.id,
      tenant_id: input.tenantId,
      name: input.name,
      description: input.description,
      created_at: msToIso(input.createdAt),
      updated_at: null,
      archived_at: null,
    };
  }

  async get(tenantId: string, storeId: string): Promise<MemoryStoreRow | null> {
    const row = await this.db
      .prepare(
        `SELECT id, tenant_id, name, description, created_at, updated_at, archived_at
         FROM memory_stores WHERE id = ? AND tenant_id = ?`,
      )
      .bind(storeId, tenantId)
      .first<DbStore>();
    return row ? toRow(row) : null;
  }

  async list(
    tenantId: string,
    opts: { includeArchived: boolean },
  ): Promise<MemoryStoreRow[]> {
    const sql = opts.includeArchived
      ? `SELECT id, tenant_id, name, description, created_at, updated_at, archived_at
         FROM memory_stores WHERE tenant_id = ? ORDER BY created_at DESC`
      : `SELECT id, tenant_id, name, description, created_at, updated_at, archived_at
         FROM memory_stores WHERE tenant_id = ? AND archived_at IS NULL ORDER BY created_at DESC`;
    const result = await this.db.prepare(sql).bind(tenantId).all<DbStore>();
    return (result.results ?? []).map(toRow);
  }

  async archive(tenantId: string, storeId: string, archivedAt: number): Promise<MemoryStoreRow> {
    await this.db
      .prepare(
        `UPDATE memory_stores SET archived_at = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ?`,
      )
      .bind(archivedAt, archivedAt, storeId, tenantId)
      .run();
    const row = await this.get(tenantId, storeId);
    if (!row) throw new Error(`memory_stores ${storeId} vanished after archive`);
    return row;
  }

  async delete(tenantId: string, storeId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM memory_stores WHERE id = ? AND tenant_id = ?`)
      .bind(storeId, tenantId)
      .run();
  }

  async listMemoryIds(storeId: string): Promise<string[]> {
    const result = await this.db
      .prepare(`SELECT id FROM memories WHERE store_id = ?`)
      .bind(storeId)
      .all<{ id: string }>();
    return (result.results ?? []).map((r) => r.id);
  }
}

interface DbStore {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  created_at: number;
  updated_at: number | null;
  archived_at: number | null;
}

function toRow(r: DbStore): MemoryStoreRow {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    name: r.name,
    description: r.description,
    created_at: msToIso(r.created_at),
    updated_at: r.updated_at ? msToIso(r.updated_at) : null,
    archived_at: r.archived_at ? msToIso(r.archived_at) : null,
  };
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}
