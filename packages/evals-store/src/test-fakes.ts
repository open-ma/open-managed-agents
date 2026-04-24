// In-memory implementations of every port for unit tests. Mirrors the
// indexed-list + cascade behavior of the D1 adapter so tests catch the same
// integrity violations.

import { EvalRunNotFoundError } from "./errors";
import type {
  Clock,
  EvalRunListOptions,
  EvalRunRepo,
  EvalRunUpdateFields,
  IdGenerator,
  Logger,
  NewEvalRunInput,
} from "./ports";
import { EvalRunService } from "./service";
import type { EvalRunRow, EvalRunStatus } from "./types";

interface InMemEvalRun {
  id: string;
  tenant_id: string;
  agent_id: string;
  environment_id: string;
  suite: string | null;
  status: EvalRunStatus;
  started_at: number;
  completed_at: number | null;
  results: unknown;
  score: number | null;
  error: string | null;
}

const ACTIVE_STATUSES: ReadonlySet<EvalRunStatus> = new Set(["pending", "running"]);

export class InMemoryEvalRunRepo implements EvalRunRepo {
  private readonly byId = new Map<string, InMemEvalRun>();

  async insert(input: NewEvalRunInput): Promise<EvalRunRow> {
    const row: InMemEvalRun = {
      id: input.id,
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      environment_id: input.environmentId,
      suite: input.suite,
      status: input.status,
      started_at: input.startedAt,
      completed_at: null,
      // Round-trip the JSON immediately so tests that mutate the input object
      // after insert don't accidentally modify stored state. Mirrors the
      // JSON.stringify the D1 adapter performs at write time.
      results: cloneJson(input.results),
      score: input.score,
      error: input.error,
    };
    this.byId.set(input.id, row);
    return toRow(row);
  }

  async get(tenantId: string, runId: string): Promise<EvalRunRow | null> {
    const row = this.byId.get(runId);
    if (!row || row.tenant_id !== tenantId) return null;
    return toRow(row);
  }

  async getById(runId: string): Promise<EvalRunRow | null> {
    const row = this.byId.get(runId);
    return row ? toRow(row) : null;
  }

  async list(tenantId: string, opts: EvalRunListOptions): Promise<EvalRunRow[]> {
    let rows = Array.from(this.byId.values()).filter((r) => r.tenant_id === tenantId);
    if (opts.agentId) rows = rows.filter((r) => r.agent_id === opts.agentId);
    if (opts.environmentId) rows = rows.filter((r) => r.environment_id === opts.environmentId);
    if (opts.status) rows = rows.filter((r) => r.status === opts.status);
    rows.sort((a, b) =>
      opts.order === "asc" ? a.started_at - b.started_at : b.started_at - a.started_at,
    );
    return rows.slice(0, opts.limit).map(toRow);
  }

  async listActive(): Promise<EvalRunRow[]> {
    return Array.from(this.byId.values())
      .filter((r) => ACTIVE_STATUSES.has(r.status))
      .sort((a, b) => a.started_at - b.started_at)
      .map(toRow);
  }

  async hasActiveByAgent(tenantId: string, agentId: string): Promise<boolean> {
    for (const r of this.byId.values()) {
      if (
        r.tenant_id === tenantId &&
        r.agent_id === agentId &&
        ACTIVE_STATUSES.has(r.status)
      ) {
        return true;
      }
    }
    return false;
  }

  async hasActiveByEnvironment(
    tenantId: string,
    environmentId: string,
  ): Promise<boolean> {
    for (const r of this.byId.values()) {
      if (
        r.tenant_id === tenantId &&
        r.environment_id === environmentId &&
        ACTIVE_STATUSES.has(r.status)
      ) {
        return true;
      }
    }
    return false;
  }

  async update(
    tenantId: string,
    runId: string,
    fields: EvalRunUpdateFields,
  ): Promise<EvalRunRow> {
    const row = this.byId.get(runId);
    if (!row || row.tenant_id !== tenantId) throw new EvalRunNotFoundError();
    if (fields.status !== undefined) row.status = fields.status;
    if (fields.results !== undefined) row.results = cloneJson(fields.results);
    if (fields.score !== undefined) row.score = fields.score;
    if (fields.error !== undefined) row.error = fields.error;
    if (fields.completedAt !== undefined) row.completed_at = fields.completedAt;
    return toRow(row);
  }

  async delete(tenantId: string, runId: string): Promise<void> {
    const row = this.byId.get(runId);
    if (!row || row.tenant_id !== tenantId) return;
    this.byId.delete(runId);
  }

  async deleteByAgent(tenantId: string, agentId: string): Promise<number> {
    const ids: string[] = [];
    for (const r of this.byId.values()) {
      if (r.tenant_id === tenantId && r.agent_id === agentId) ids.push(r.id);
    }
    for (const id of ids) this.byId.delete(id);
    return ids.length;
  }
}

export class SequentialIdGenerator implements IdGenerator {
  private n = 0;
  evalRunId(): string {
    return `evrun-${++this.n}`;
  }
}

export class ManualClock implements Clock {
  constructor(private ms: number = 0) {}
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
  set(ms: number): void {
    this.ms = ms;
  }
}

export class SilentLogger implements Logger {
  warn(): void {}
}

/**
 * Convenience factory — full in-memory wiring with sane defaults. Tests can
 * pass overrides for any port (e.g. a ManualClock for deterministic timestamps).
 */
export function createInMemoryEvalRunService(opts?: {
  clock?: Clock;
  ids?: IdGenerator;
  logger?: Logger;
}): {
  service: EvalRunService;
  repo: InMemoryEvalRunRepo;
} {
  const repo = new InMemoryEvalRunRepo();
  const service = new EvalRunService({
    repo,
    clock: opts?.clock,
    ids: opts?.ids ?? new SequentialIdGenerator(),
    logger: opts?.logger ?? new SilentLogger(),
  });
  return { service, repo };
}

// ── helpers ──

function toRow(r: InMemEvalRun): EvalRunRow {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    agent_id: r.agent_id,
    environment_id: r.environment_id,
    suite: r.suite,
    status: r.status,
    started_at: msToIso(r.started_at),
    completed_at: r.completed_at !== null ? msToIso(r.completed_at) : null,
    // Clone on read so tests / callers can't accidentally mutate stored state
    // (mirrors the JSON.parse the D1 adapter performs at read time).
    results: cloneJson(r.results),
    score: r.score,
    error: r.error,
  };
}

function cloneJson<T>(value: T): T {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}
