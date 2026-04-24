// Abstract ports the EvalRunService depends on. Same DIP pattern as
// packages/credentials-store/src/ports.ts — concrete adapters in src/adapters/
// implement these against Cloudflare bindings; src/test-fakes.ts provides
// in-memory implementations.
//
// Keep these tiny and runtime-agnostic: no Cloudflare types, no D1 query
// language. Pass plain data + return plain data. The schema is no-FK by
// project convention; cascade-by-{agent,environment} lives in this port so
// adapters and the in-memory fake share one canonical implementation.

import type { EvalRunRow, EvalRunStatus } from "./types";

export interface NewEvalRunInput {
  id: string;
  tenantId: string;
  agentId: string;
  environmentId: string;
  suite: string | null;
  status: EvalRunStatus;
  /** Opaque JSON serialized into the `results` column. May be null for empty initial state. */
  results: unknown;
  score: number | null;
  error: string | null;
  startedAt: number;
}

export interface EvalRunUpdateFields {
  status?: EvalRunStatus;
  results?: unknown;
  score?: number | null;
  error?: string | null;
  /** Pass null to clear (e.g. when re-opening a terminated run); omit to leave untouched. */
  completedAt?: number | null;
}

export interface EvalRunListOptions {
  /** Optional agent filter — uses indexed (tenant_id, agent_id, started_at) path. */
  agentId?: string;
  /** Optional environment filter — uses indexed (tenant_id, environment_id, started_at) path. */
  environmentId?: string;
  /** Optional status filter for "list active" / "list completed" hot paths. */
  status?: EvalRunStatus;
  /** Sort by started_at — desc matches the GET list default (evals.ts:149). */
  order: "asc" | "desc";
  /** Hard cap on returned rows. Adapter clamps to schema-defined max. */
  limit: number;
}

export interface EvalRunRepo {
  /**
   * Atomic insert. Replaces the two-put non-atomic KV pattern in
   * evals.ts:114-118 (eval-run record + active-index were separate puts).
   */
  insert(input: NewEvalRunInput): Promise<EvalRunRow>;

  get(tenantId: string, runId: string): Promise<EvalRunRow | null>;

  /**
   * Cross-tenant lookup by id — used by the cron tick (eval-runner.ts:67-70)
   * which iterates the active list and needs to load runs without re-deriving
   * tenantId. `id` is globally unique so a direct WHERE id = ? is O(1).
   */
  getById(runId: string): Promise<EvalRunRow | null>;

  list(tenantId: string, opts: EvalRunListOptions): Promise<EvalRunRow[]>;

  /**
   * Cross-tenant scan of pending+running runs — replaces the
   * `evalrun_active:` KV index iterated by tickEvalRuns (eval-runner.ts:315).
   * Indexed via partial index on status.
   */
  listActive(): Promise<EvalRunRow[]>;

  /** Returns true if any non-terminal run in the tenant references this agent. */
  hasActiveByAgent(tenantId: string, agentId: string): Promise<boolean>;

  /** Returns true if any non-terminal run in the tenant references this environment. */
  hasActiveByEnvironment(tenantId: string, environmentId: string): Promise<boolean>;

  update(
    tenantId: string,
    runId: string,
    fields: EvalRunUpdateFields,
  ): Promise<EvalRunRow>;

  delete(tenantId: string, runId: string): Promise<void>;

  /**
   * Cascade hard-delete every run for an agent. Replaces the agents.ts cleanup
   * the route layer would otherwise need to do via list+loop. Returns the
   * count of runs deleted (so callers can log + emit metrics).
   */
  deleteByAgent(tenantId: string, agentId: string): Promise<number>;
}

export interface Clock {
  nowMs(): number;
}

export interface IdGenerator {
  evalRunId(): string;
}

export interface Logger {
  warn(msg: string, ctx?: unknown): void;
}
