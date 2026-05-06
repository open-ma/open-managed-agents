import type { AgentConfig } from "@open-managed-agents/shared";
import type { PageCursor } from "@open-managed-agents/shared";
import {
  cursorBinds,
  cursorWhereSql,
  fetchN,
  trimPage,
} from "@open-managed-agents/shared";
import type { SqlClient } from "@open-managed-agents/sql-client";
import { AgentNotFoundError } from "../errors";
import type {
  AgentRepo,
  AgentUpdateFields,
  AgentVersionSnapshotInput,
  NewAgentInput,
} from "../ports";
import type { AgentRow, AgentVersionRow } from "../types";

/**
 * SQL implementation of {@link AgentRepo}. Owns the SQL against the `agents`
 * and `agent_versions` tables defined in apps/main/migrations/0002_agents_tables.sql.
 *
 * Backend-agnostic: takes a {@link SqlClient}, which works with Cloudflare D1
 * (CF deployments) and better-sqlite3 / Postgres (self-host). The schema is plain
 * SQLite-flavoured DDL — D1 IS SQLite, and better-sqlite3 reads the same
 * statements without modification. A future Postgres adapter would need a
 * separate migration with PG-flavour types but the repo logic stays.
 *
 * Atomicity:
 *   - updateWithVersionSnapshot uses client.batch so the snapshot INSERT and
 *     the current-row UPDATE succeed-or-fail together (replaces the legacy
 *     non-atomic KV.put then KV.put pattern).
 *   - deleteWithVersions uses client.batch to drop the agent + cascade its
 *     history rows (the schema has no FK by project convention).
 */
export class SqlAgentRepo implements AgentRepo {
  constructor(private readonly db: SqlClient) {}

  async insert(input: NewAgentInput): Promise<AgentRow> {
    await this.db
      .prepare(
        `INSERT INTO agents
           (id, tenant_id, config, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.tenantId,
        JSON.stringify(input.config),
        input.config.version,
        input.createdAt,
        input.createdAt,
      )
      .run();
    const row = await this.get(input.tenantId, input.id);
    if (!row) throw new Error("agent vanished after insert");
    return row;
  }

  async get(tenantId: string, agentId: string): Promise<AgentRow | null> {
    const row = await this.db
      .prepare(
        `SELECT id, tenant_id, config, version, created_at, updated_at, archived_at
         FROM agents WHERE id = ? AND tenant_id = ?`,
      )
      .bind(agentId, tenantId)
      .first<DbAgent>();
    return row ? toRow(row) : null;
  }

  async getById(agentId: string): Promise<AgentRow | null> {
    const row = await this.db
      .prepare(
        `SELECT id, tenant_id, config, version, created_at, updated_at, archived_at
         FROM agents WHERE id = ?`,
      )
      .bind(agentId)
      .first<DbAgent>();
    return row ? toRow(row) : null;
  }

  async list(
    tenantId: string,
    opts: { includeArchived: boolean },
  ): Promise<AgentRow[]> {
    const sql = opts.includeArchived
      ? `SELECT id, tenant_id, config, version, created_at, updated_at, archived_at
         FROM agents WHERE tenant_id = ? ORDER BY created_at ASC`
      : `SELECT id, tenant_id, config, version, created_at, updated_at, archived_at
         FROM agents WHERE tenant_id = ? AND archived_at IS NULL
         ORDER BY created_at ASC`;
    const result = await this.db.prepare(sql).bind(tenantId).all<DbAgent>();
    return (result.results ?? []).map(toRow);
  }

  async listPage(
    tenantId: string,
    opts: {
      includeArchived: boolean;
      limit: number;
      after?: PageCursor;
    },
  ): Promise<{ items: AgentRow[]; hasMore: boolean }> {
    const archived = opts.includeArchived ? "" : "AND archived_at IS NULL";
    const sql =
      `SELECT id, tenant_id, config, version, created_at, updated_at, archived_at ` +
      `FROM agents WHERE tenant_id = ? ${archived} ${cursorWhereSql(opts.after)} ` +
      `ORDER BY created_at DESC, id DESC LIMIT ?`;
    const result = await this.db
      .prepare(sql)
      .bind(tenantId, ...cursorBinds(opts.after), fetchN(opts.limit))
      .all<DbAgent>();
    return trimPage((result.results ?? []).map(toRow), opts.limit);
  }

  async updateWithVersionSnapshot(
    tenantId: string,
    agentId: string,
    update: AgentUpdateFields,
    priorSnapshot: AgentVersionSnapshotInput,
  ): Promise<AgentRow> {
    // Two-statement batch: write the prior snapshot to history then bump the
    // current row. Atomic by D1 batch semantics. No FK needed.
    const result = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO agent_versions
             (agent_id, tenant_id, version, snapshot, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          priorSnapshot.agentId,
          priorSnapshot.tenantId,
          priorSnapshot.version,
          JSON.stringify(priorSnapshot.snapshot),
          priorSnapshot.createdAt,
        ),
      this.db
        .prepare(
          `UPDATE agents SET config = ?, version = ?, updated_at = ?
           WHERE id = ? AND tenant_id = ?`,
        )
        .bind(
          JSON.stringify(update.config),
          update.version,
          update.updatedAt,
          agentId,
          tenantId,
        ),
    ]);
    // The UPDATE is the second statement — check its changes count.
    const updateMeta = result[1]?.meta;
    if (!updateMeta?.changes) throw new AgentNotFoundError();
    const row = await this.get(tenantId, agentId);
    if (!row) throw new AgentNotFoundError();
    return row;
  }

  async archive(
    tenantId: string,
    agentId: string,
    archivedAt: number,
  ): Promise<AgentRow> {
    // Read the existing config so we can bump archived_at inside the JSON
    // alongside the column for round-trip consistency with consumers that
    // read straight from the parsed config (e.g. SessionDO snapshot fallback).
    const existing = await this.get(tenantId, agentId);
    if (!existing) throw new AgentNotFoundError();
    const nextConfig: AgentConfig = {
      ...stripTenantId(existing),
      archived_at: msToIso(archivedAt),
    };
    const result = await this.db
      .prepare(
        `UPDATE agents SET archived_at = ?, updated_at = ?, config = ?
         WHERE id = ? AND tenant_id = ?`,
      )
      .bind(archivedAt, archivedAt, JSON.stringify(nextConfig), agentId, tenantId)
      .run();
    if (!result.meta?.changes) throw new AgentNotFoundError();
    const row = await this.get(tenantId, agentId);
    if (!row) throw new AgentNotFoundError();
    return row;
  }

  async deleteWithVersions(tenantId: string, agentId: string): Promise<void> {
    // Two-statement batch: drop history rows first then the agent row. Atomic
    // by D1 batch semantics. No FK needed.
    await this.db.batch([
      this.db
        .prepare(`DELETE FROM agent_versions WHERE agent_id = ?`)
        .bind(agentId),
      this.db
        .prepare(`DELETE FROM agents WHERE id = ? AND tenant_id = ?`)
        .bind(agentId, tenantId),
    ]);
  }

  async listVersions(
    tenantId: string,
    agentId: string,
  ): Promise<AgentVersionRow[]> {
    const result = await this.db
      .prepare(
        `SELECT agent_id, tenant_id, version, snapshot, created_at
         FROM agent_versions
         WHERE agent_id = ? AND tenant_id = ?
         ORDER BY version ASC`,
      )
      .bind(agentId, tenantId)
      .all<DbVersion>();
    return (result.results ?? []).map(toVersionRow);
  }

  async getVersion(
    tenantId: string,
    agentId: string,
    version: number,
  ): Promise<AgentVersionRow | null> {
    const row = await this.db
      .prepare(
        `SELECT agent_id, tenant_id, version, snapshot, created_at
         FROM agent_versions
         WHERE agent_id = ? AND tenant_id = ? AND version = ?`,
      )
      .bind(agentId, tenantId, version)
      .first<DbVersion>();
    return row ? toVersionRow(row) : null;
  }
}

interface DbAgent {
  id: string;
  tenant_id: string;
  config: string; // JSON
  version: number;
  created_at: number;
  updated_at: number | null;
  archived_at: number | null;
}

interface DbVersion {
  agent_id: string;
  tenant_id: string;
  version: number;
  snapshot: string; // JSON
  created_at: number;
}

function toRow(r: DbAgent): AgentRow {
  const cfg = JSON.parse(r.config) as AgentConfig;
  // Surface the mutable state from the columns into the AgentRow result so
  // the JSON blob and the columns stay consistent (insert + update keep them
  // in sync, but archive_at via the column path is the canonical one).
  return {
    ...cfg,
    tenant_id: r.tenant_id,
    version: r.version,
    created_at: msToIso(r.created_at),
    updated_at: r.updated_at !== null ? msToIso(r.updated_at) : undefined,
    archived_at: r.archived_at !== null ? msToIso(r.archived_at) : undefined,
  };
}

function toVersionRow(r: DbVersion): AgentVersionRow {
  return {
    agent_id: r.agent_id,
    tenant_id: r.tenant_id,
    version: r.version,
    snapshot: JSON.parse(r.snapshot) as AgentConfig,
    created_at: msToIso(r.created_at),
  };
}

function stripTenantId(row: AgentRow): AgentConfig {
  const { tenant_id: _t, ...rest } = row;
  return rest;
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}
