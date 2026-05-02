import {
  cursorBinds,
  cursorWhereSql,
  fetchN,
  trimPage,
  type PageCursor,
} from "@open-managed-agents/shared";
import { VaultNotFoundError } from "../errors";
import type { NewVaultInput, VaultRepo, VaultUpdateFields } from "../ports";
import type { VaultRow } from "../types";

/**
 * Cloudflare D1 implementation of {@link VaultRepo}. Owns the SQL against
 * the `vaults` table defined in apps/main/migrations/0014_vaults_table.sql.
 */
export class D1VaultRepo implements VaultRepo {
  constructor(private readonly db: D1Database) {}

  async insert(input: NewVaultInput): Promise<VaultRow> {
    await this.db
      .prepare(
        `INSERT INTO vaults (id, tenant_id, name, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(input.id, input.tenantId, input.name, input.createdAt)
      .run();
    const row = await this.get(input.tenantId, input.id);
    if (!row) throw new Error("vault vanished after insert");
    return row;
  }

  async get(tenantId: string, vaultId: string): Promise<VaultRow | null> {
    const row = await this.db
      .prepare(
        `SELECT id, tenant_id, name, created_at, updated_at, archived_at
         FROM vaults WHERE id = ? AND tenant_id = ?`,
      )
      .bind(vaultId, tenantId)
      .first<DbVault>();
    return row ? toRow(row) : null;
  }

  async exists(tenantId: string, vaultId: string): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT 1 AS x FROM vaults WHERE id = ? AND tenant_id = ?`)
      .bind(vaultId, tenantId)
      .first<{ x: number }>();
    return !!row;
  }

  async list(
    tenantId: string,
    opts: { includeArchived: boolean },
  ): Promise<VaultRow[]> {
    const sql = opts.includeArchived
      ? `SELECT id, tenant_id, name, created_at, updated_at, archived_at
         FROM vaults WHERE tenant_id = ? ORDER BY created_at ASC`
      : `SELECT id, tenant_id, name, created_at, updated_at, archived_at
         FROM vaults WHERE tenant_id = ? AND archived_at IS NULL ORDER BY created_at ASC`;
    const result = await this.db.prepare(sql).bind(tenantId).all<DbVault>();
    return (result.results ?? []).map(toRow);
  }

  async listPage(
    tenantId: string,
    opts: {
      includeArchived: boolean;
      limit: number;
      after?: PageCursor;
    },
  ): Promise<{ items: VaultRow[]; hasMore: boolean }> {
    const archived = opts.includeArchived ? "" : "AND archived_at IS NULL";
    const sql =
      `SELECT id, tenant_id, name, created_at, updated_at, archived_at ` +
      `FROM vaults WHERE tenant_id = ? ${archived} ${cursorWhereSql(opts.after)} ` +
      `ORDER BY created_at DESC, id DESC LIMIT ?`;
    const result = await this.db
      .prepare(sql)
      .bind(tenantId, ...cursorBinds(opts.after), fetchN(opts.limit))
      .all<DbVault>();
    return trimPage((result.results ?? []).map(toRow), opts.limit);
  }

  async update(
    tenantId: string,
    vaultId: string,
    update: VaultUpdateFields,
  ): Promise<VaultRow> {
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (update.name !== undefined) {
      sets.push("name = ?");
      binds.push(update.name);
    }
    sets.push("updated_at = ?");
    binds.push(update.updatedAt);
    binds.push(vaultId, tenantId);

    const result = await this.db
      .prepare(
        `UPDATE vaults SET ${sets.join(", ")}
         WHERE id = ? AND tenant_id = ?`,
      )
      .bind(...binds)
      .run();
    if (!result.meta?.changes) throw new VaultNotFoundError();
    const row = await this.get(tenantId, vaultId);
    if (!row) throw new VaultNotFoundError();
    return row;
  }

  async archive(
    tenantId: string,
    vaultId: string,
    archivedAt: number,
  ): Promise<VaultRow> {
    const result = await this.db
      .prepare(
        `UPDATE vaults SET archived_at = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ?`,
      )
      .bind(archivedAt, archivedAt, vaultId, tenantId)
      .run();
    if (!result.meta?.changes) throw new VaultNotFoundError();
    const row = await this.get(tenantId, vaultId);
    if (!row) throw new VaultNotFoundError();
    return row;
  }

  async delete(tenantId: string, vaultId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM vaults WHERE id = ? AND tenant_id = ?`)
      .bind(vaultId, tenantId)
      .run();
  }
}

interface DbVault {
  id: string;
  tenant_id: string;
  name: string;
  created_at: number;
  updated_at: number | null;
  archived_at: number | null;
}

function toRow(r: DbVault): VaultRow {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    name: r.name,
    created_at: msToIso(r.created_at),
    updated_at: r.updated_at !== null ? msToIso(r.updated_at) : null,
    archived_at: r.archived_at !== null ? msToIso(r.archived_at) : null,
  };
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}
