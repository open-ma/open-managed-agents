import { EvalRunNotFoundError } from "../errors";
import type {
  EvalRunListOptions,
  EvalRunRepo,
  EvalRunUpdateFields,
  NewEvalRunInput,
} from "../ports";
import type { EvalRunRow, EvalRunStatus } from "../types";
import type { SqlClient } from "@open-managed-agents/sql-client";

/**
 * SqlClient-backed implementation of {@link EvalRunRepo}. Owns the SQL against
 * the `eval_runs` table defined in apps/main/migrations/0012_eval_runs_table.sql.
 *
 * Atomicity:
 *   - insert is a single INSERT — replaces the two-put non-atomic KV pattern
 *     in evals.ts:114-118 (eval-run record + active-index were separate puts).
 *   - delete and deleteByAgent are single DELETE statements; no resources to
 *     cascade (trajectory blobs live in CONFIG_KV under their own keys).
 */
export class SqlEvalRunRepo implements EvalRunRepo {
  constructor(private readonly db: SqlClient) {}

  async insert(input: NewEvalRunInput): Promise<EvalRunRow> {
    await this.db
      .prepare(
        `INSERT INTO eval_runs
           (id, tenant_id, agent_id, environment_id, suite, status,
            started_at, completed_at, results, score, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.tenantId,
        input.agentId,
        input.environmentId,
        input.suite,
        input.status,
        input.startedAt,
        input.results !== null && input.results !== undefined
          ? JSON.stringify(input.results)
          : null,
        input.score,
        input.error,
      )
      .run();
    const row = await this.get(input.tenantId, input.id);
    if (!row) throw new Error("eval_run vanished after insert");
    return row;
  }

  async get(tenantId: string, runId: string): Promise<EvalRunRow | null> {
    const row = await this.db
      .prepare(
        `SELECT id, tenant_id, agent_id, environment_id, suite, status,
                started_at, completed_at, results, score, error
         FROM eval_runs
         WHERE id = ? AND tenant_id = ?`,
      )
      .bind(runId, tenantId)
      .first<DbEvalRun>();
    return row ? toRow(row) : null;
  }

  async getById(runId: string): Promise<EvalRunRow | null> {
    const row = await this.db
      .prepare(
        `SELECT id, tenant_id, agent_id, environment_id, suite, status,
                started_at, completed_at, results, score, error
         FROM eval_runs
         WHERE id = ?`,
      )
      .bind(runId)
      .first<DbEvalRun>();
    return row ? toRow(row) : null;
  }

  async list(tenantId: string, opts: EvalRunListOptions): Promise<EvalRunRow[]> {
    const order = opts.order === "asc" ? "ASC" : "DESC";
    const where: string[] = ["tenant_id = ?"];
    const binds: unknown[] = [tenantId];
    if (opts.agentId) {
      where.push("agent_id = ?");
      binds.push(opts.agentId);
    }
    if (opts.environmentId) {
      where.push("environment_id = ?");
      binds.push(opts.environmentId);
    }
    if (opts.status) {
      where.push("status = ?");
      binds.push(opts.status);
    }
    binds.push(opts.limit);
    const sql = `SELECT id, tenant_id, agent_id, environment_id, suite, status,
                        started_at, completed_at, results, score, error
                 FROM eval_runs
                 WHERE ${where.join(" AND ")}
                 ORDER BY started_at ${order}
                 LIMIT ?`;
    const result = await this.db.prepare(sql).bind(...binds).all<DbEvalRun>();
    return (result.results ?? []).map(toRow);
  }

  async listActive(): Promise<EvalRunRow[]> {
    const result = await this.db
      .prepare(
        `SELECT id, tenant_id, agent_id, environment_id, suite, status,
                started_at, completed_at, results, score, error
         FROM eval_runs
         WHERE status IN ('pending', 'running')
         ORDER BY started_at ASC`,
      )
      .all<DbEvalRun>();
    return (result.results ?? []).map(toRow);
  }

  async hasActiveByAgent(tenantId: string, agentId: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS one FROM eval_runs
         WHERE tenant_id = ? AND agent_id = ? AND status IN ('pending', 'running')
         LIMIT 1`,
      )
      .bind(tenantId, agentId)
      .first<{ one: number }>();
    return !!row;
  }

  async hasActiveByEnvironment(
    tenantId: string,
    environmentId: string,
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS one FROM eval_runs
         WHERE tenant_id = ? AND environment_id = ? AND status IN ('pending', 'running')
         LIMIT 1`,
      )
      .bind(tenantId, environmentId)
      .first<{ one: number }>();
    return !!row;
  }

  async update(
    tenantId: string,
    runId: string,
    fields: EvalRunUpdateFields,
  ): Promise<EvalRunRow> {
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (fields.status !== undefined) {
      sets.push("status = ?");
      binds.push(fields.status);
    }
    if (fields.results !== undefined) {
      sets.push("results = ?");
      binds.push(
        fields.results !== null ? JSON.stringify(fields.results) : null,
      );
    }
    if (fields.score !== undefined) {
      sets.push("score = ?");
      binds.push(fields.score);
    }
    if (fields.error !== undefined) {
      sets.push("error = ?");
      binds.push(fields.error);
    }
    if (fields.completedAt !== undefined) {
      sets.push("completed_at = ?");
      binds.push(fields.completedAt);
    }
    if (!sets.length) {
      // Nothing to update — short-circuit and return the row as-is.
      const row = await this.get(tenantId, runId);
      if (!row) throw new EvalRunNotFoundError();
      return row;
    }
    binds.push(runId, tenantId);
    const result = await this.db
      .prepare(
        `UPDATE eval_runs SET ${sets.join(", ")}
         WHERE id = ? AND tenant_id = ?`,
      )
      .bind(...binds)
      .run();
    if (!result.meta?.changes) throw new EvalRunNotFoundError();
    const row = await this.get(tenantId, runId);
    if (!row) throw new EvalRunNotFoundError();
    return row;
  }

  async delete(tenantId: string, runId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM eval_runs WHERE id = ? AND tenant_id = ?`)
      .bind(runId, tenantId)
      .run();
  }

  async deleteByAgent(tenantId: string, agentId: string): Promise<number> {
    const result = await this.db
      .prepare(`DELETE FROM eval_runs WHERE tenant_id = ? AND agent_id = ?`)
      .bind(tenantId, agentId)
      .run();
    return result.meta?.changes ?? 0;
  }
}

interface DbEvalRun {
  id: string;
  tenant_id: string;
  agent_id: string;
  environment_id: string;
  suite: string | null;
  status: string;
  started_at: number;
  completed_at: number | null;
  results: string | null;
  score: number | null;
  error: string | null;
}

function toRow(r: DbEvalRun): EvalRunRow {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    agent_id: r.agent_id,
    environment_id: r.environment_id,
    suite: r.suite,
    status: r.status as EvalRunStatus,
    started_at: msToIso(r.started_at),
    completed_at: r.completed_at !== null ? msToIso(r.completed_at) : null,
    results: r.results !== null ? (JSON.parse(r.results) as unknown) : null,
    score: r.score,
    error: r.error,
  };
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}
