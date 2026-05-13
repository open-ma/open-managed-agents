import type { SqlClient } from "@open-managed-agents/sql-client";

import type {
  DispatchRule,
  DispatchRulePatch,
  DispatchRuleRepo,
  IdGenerator,
  NewDispatchRule,
} from "@open-managed-agents/integrations-core";

interface Row {
  id: string;
  tenant_id: string;
  publication_id: string;
  name: string;
  enabled: number;
  filter_label: string | null;
  filter_states: string | null;
  filter_project_id: string | null;
  max_concurrent: number;
  poll_interval_seconds: number;
  last_polled_at: number | null;
  created_at: number;
  updated_at: number;
}

export class SqlDispatchRuleRepo implements DispatchRuleRepo {
  constructor(
    private readonly db: SqlClient,
    private readonly ids: IdGenerator,
  ) {}

  async get(id: string): Promise<DispatchRule | null> {
    const row = await this.db
      .prepare(`SELECT * FROM linear_dispatch_rules WHERE id = ?`)
      .bind(id)
      .first<Row>();
    return row ? this.toDomain(row) : null;
  }

  async insert(input: NewDispatchRule): Promise<DispatchRule> {
    const id = this.ids.generate();
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO linear_dispatch_rules
           (id, tenant_id, publication_id, name, enabled,
            filter_label, filter_states, filter_project_id,
            max_concurrent, poll_interval_seconds,
            last_polled_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .bind(
        id,
        input.tenantId,
        input.publicationId,
        input.name,
        input.enabled ? 1 : 0,
        input.filterLabel,
        input.filterStates ? JSON.stringify(input.filterStates) : null,
        input.filterProjectId,
        input.maxConcurrent,
        input.pollIntervalSeconds,
        now,
        now,
      )
      .run();
    return {
      id,
      tenantId: input.tenantId,
      publicationId: input.publicationId,
      name: input.name,
      enabled: input.enabled,
      filterLabel: input.filterLabel,
      filterStates: input.filterStates,
      filterProjectId: input.filterProjectId,
      maxConcurrent: input.maxConcurrent,
      pollIntervalSeconds: input.pollIntervalSeconds,
      lastPolledAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async update(id: string, patch: DispatchRulePatch): Promise<DispatchRule | null> {
    // Build dynamic SET list from only the supplied fields. Avoids stomping
    // columns the caller didn't intend to change (especially enabled=false
    // when a partial update doesn't pass it).
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (patch.name !== undefined) { sets.push("name = ?"); binds.push(patch.name); }
    if (patch.enabled !== undefined) { sets.push("enabled = ?"); binds.push(patch.enabled ? 1 : 0); }
    if (patch.filterLabel !== undefined) { sets.push("filter_label = ?"); binds.push(patch.filterLabel); }
    if (patch.filterStates !== undefined) {
      sets.push("filter_states = ?");
      binds.push(patch.filterStates ? JSON.stringify(patch.filterStates) : null);
    }
    if (patch.filterProjectId !== undefined) { sets.push("filter_project_id = ?"); binds.push(patch.filterProjectId); }
    if (patch.maxConcurrent !== undefined) { sets.push("max_concurrent = ?"); binds.push(patch.maxConcurrent); }
    if (patch.pollIntervalSeconds !== undefined) {
      sets.push("poll_interval_seconds = ?");
      binds.push(patch.pollIntervalSeconds);
    }
    if (sets.length === 0) return this.get(id);
    sets.push("updated_at = ?");
    binds.push(Date.now());
    binds.push(id);
    await this.db
      .prepare(`UPDATE linear_dispatch_rules SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...binds)
      .run();
    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.db
      .prepare(`DELETE FROM linear_dispatch_rules WHERE id = ?`)
      .bind(id)
      .run();
    // D1 reports rows_written as the affected count for DELETE.
    const meta = res.meta as { rows_written?: number; changes?: number } | undefined;
    return (meta?.changes ?? meta?.rows_written ?? 0) > 0;
  }

  async listByPublication(publicationId: string): Promise<readonly DispatchRule[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM linear_dispatch_rules
         WHERE publication_id = ?
         ORDER BY created_at DESC`,
      )
      .bind(publicationId)
      .all<Row>();
    return (results ?? []).map((r) => this.toDomain(r));
  }

  /**
   * Hot path. Filter `enabled = 1` first (cheap, indexed), then "due" check
   * is `last_polled_at IS NULL OR last_polled_at + interval*1000 <= nowMs`.
   * SQLite handles the per-row arithmetic; no precomputed column needed at
   * this scale.
   */
  async listDueForSweep(nowMs: number, limit: number): Promise<readonly DispatchRule[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM linear_dispatch_rules
         WHERE enabled = 1
           AND (last_polled_at IS NULL
                OR last_polled_at + (poll_interval_seconds * 1000) <= ?)
         ORDER BY COALESCE(last_polled_at, 0) ASC
         LIMIT ?`,
      )
      .bind(nowMs, limit)
      .all<Row>();
    return (results ?? []).map((r) => this.toDomain(r));
  }

  async markPolled(id: string, polledAtMs: number): Promise<void> {
    await this.db
      .prepare(`UPDATE linear_dispatch_rules SET last_polled_at = ? WHERE id = ?`)
      .bind(polledAtMs, id)
      .run();
  }

  private toDomain(row: Row): DispatchRule {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      publicationId: row.publication_id,
      name: row.name,
      enabled: row.enabled === 1,
      filterLabel: row.filter_label,
      filterStates: row.filter_states ? (JSON.parse(row.filter_states) as string[]) : null,
      filterProjectId: row.filter_project_id,
      maxConcurrent: row.max_concurrent,
      pollIntervalSeconds: row.poll_interval_seconds,
      lastPolledAt: row.last_polled_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
