import type { EnvironmentConfig } from "@open-managed-agents/shared";
import { EnvironmentNotFoundError } from "../errors";
import type {
  EnvironmentRepo,
  EnvironmentUpdateFields,
  NewEnvironmentInput,
} from "../ports";
import type { EnvironmentRow, EnvironmentStatus } from "../types";

/**
 * Cloudflare D1 implementation of {@link EnvironmentRepo}. Owns the SQL against
 * the `environments` table defined in apps/main/migrations/0003_environments_table.sql.
 *
 * Hot fields (status, sandbox_worker_name) live in their own columns so the
 * sandbox-binding resolver in routes/sessions.ts (and friends) can read them
 * without parsing the `config` JSON.
 */
export class D1EnvironmentRepo implements EnvironmentRepo {
  constructor(private readonly db: D1Database) {}

  async insert(input: NewEnvironmentInput): Promise<EnvironmentRow> {
    await this.db
      .prepare(
        `INSERT INTO environments
           (id, tenant_id, name, description, status, sandbox_worker_name,
            build_error, config, metadata, image_strategy, image_handle, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.tenantId,
        input.name,
        input.description,
        input.status,
        input.sandboxWorkerName,
        input.buildError,
        JSON.stringify(input.config),
        input.metadata !== null ? JSON.stringify(input.metadata) : null,
        input.imageStrategy ?? null,
        input.imageHandle !== undefined && input.imageHandle !== null ? JSON.stringify(input.imageHandle) : null,
        input.createdAt,
      )
      .run();
    const row = await this.get(input.tenantId, input.id);
    if (!row) throw new Error("environment vanished after insert");
    return row;
  }

  async get(
    tenantId: string,
    environmentId: string,
  ): Promise<EnvironmentRow | null> {
    const row = await this.db
      .prepare(
        `SELECT id, tenant_id, name, description, status, sandbox_worker_name,
                build_error, config, metadata, image_strategy, image_handle,
                created_at, updated_at, archived_at
         FROM environments
         WHERE id = ? AND tenant_id = ?`,
      )
      .bind(environmentId, tenantId)
      .first<DbEnvironment>();
    return row ? toRow(row) : null;
  }

  async list(
    tenantId: string,
    opts: { includeArchived: boolean },
  ): Promise<EnvironmentRow[]> {
    const sql = opts.includeArchived
      ? `SELECT id, tenant_id, name, description, status, sandbox_worker_name,
                build_error, config, metadata, image_strategy, image_handle,
                created_at, updated_at, archived_at
         FROM environments WHERE tenant_id = ? ORDER BY created_at ASC`
      : `SELECT id, tenant_id, name, description, status, sandbox_worker_name,
                build_error, config, metadata, image_strategy, image_handle,
                created_at, updated_at, archived_at
         FROM environments WHERE tenant_id = ? AND archived_at IS NULL
         ORDER BY created_at ASC`;
    const result = await this.db.prepare(sql).bind(tenantId).all<DbEnvironment>();
    return (result.results ?? []).map(toRow);
  }

  async update(
    tenantId: string,
    environmentId: string,
    update: EnvironmentUpdateFields,
  ): Promise<EnvironmentRow> {
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (update.name !== undefined) {
      sets.push("name = ?");
      binds.push(update.name);
    }
    if (update.description !== undefined) {
      sets.push("description = ?");
      binds.push(update.description);
    }
    if (update.status !== undefined) {
      sets.push("status = ?");
      binds.push(update.status);
    }
    if (update.sandboxWorkerName !== undefined) {
      sets.push("sandbox_worker_name = ?");
      binds.push(update.sandboxWorkerName);
    }
    if (update.buildError !== undefined) {
      sets.push("build_error = ?");
      binds.push(update.buildError);
    }
    if (update.config !== undefined) {
      sets.push("config = ?");
      binds.push(JSON.stringify(update.config));
    }
    if (update.metadata !== undefined) {
      sets.push("metadata = ?");
      binds.push(update.metadata !== null ? JSON.stringify(update.metadata) : null);
    }
    if (update.imageStrategy !== undefined) {
      sets.push("image_strategy = ?");
      binds.push(update.imageStrategy);
    }
    if (update.imageHandle !== undefined) {
      sets.push("image_handle = ?");
      binds.push(update.imageHandle !== null ? JSON.stringify(update.imageHandle) : null);
    }
    sets.push("updated_at = ?");
    binds.push(update.updatedAt);
    binds.push(environmentId, tenantId);

    const result = await this.db
      .prepare(
        `UPDATE environments SET ${sets.join(", ")}
         WHERE id = ? AND tenant_id = ?`,
      )
      .bind(...binds)
      .run();
    if (!result.meta?.changes) throw new EnvironmentNotFoundError();
    const row = await this.get(tenantId, environmentId);
    if (!row) throw new EnvironmentNotFoundError();
    return row;
  }

  async archive(
    tenantId: string,
    environmentId: string,
    archivedAt: number,
  ): Promise<EnvironmentRow> {
    const result = await this.db
      .prepare(
        `UPDATE environments SET archived_at = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ?`,
      )
      .bind(archivedAt, archivedAt, environmentId, tenantId)
      .run();
    if (!result.meta?.changes) throw new EnvironmentNotFoundError();
    const row = await this.get(tenantId, environmentId);
    if (!row) throw new EnvironmentNotFoundError();
    return row;
  }

  async delete(tenantId: string, environmentId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM environments WHERE id = ? AND tenant_id = ?`)
      .bind(environmentId, tenantId)
      .run();
  }
}

interface DbEnvironment {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  status: string;
  sandbox_worker_name: string | null;
  build_error: string | null;
  config: string; // JSON
  metadata: string | null; // JSON
  image_strategy: string | null;
  image_handle: string | null; // JSON
  created_at: number;
  updated_at: number | null;
  archived_at: number | null;
}

function toRow(r: DbEnvironment): EnvironmentRow {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    name: r.name,
    description: r.description,
    status: r.status as EnvironmentStatus,
    sandbox_worker_name: r.sandbox_worker_name,
    build_error: r.build_error,
    config: JSON.parse(r.config) as EnvironmentConfig["config"],
    metadata: r.metadata !== null ? (JSON.parse(r.metadata) as Record<string, unknown>) : null,
    image_strategy: (r.image_strategy as EnvironmentRow["image_strategy"]) ?? null,
    image_handle: r.image_handle !== null ? (JSON.parse(r.image_handle) as Record<string, unknown>) : null,
    created_at: msToIso(r.created_at),
    updated_at: r.updated_at !== null ? msToIso(r.updated_at) : null,
    archived_at: r.archived_at !== null ? msToIso(r.archived_at) : null,
  };
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}
