import { generateEvalRunId } from "@open-managed-agents/shared";
import { EvalRunNotFoundError } from "./errors";
import type {
  Clock,
  EvalRunListOptions,
  EvalRunRepo,
  EvalRunUpdateFields,
  IdGenerator,
  Logger,
} from "./ports";
import type { EvalRunRow, EvalRunStatus } from "./types";

export interface EvalRunServiceDeps {
  repo: EvalRunRepo;
  clock?: Clock;
  ids?: IdGenerator;
  logger?: Logger;
}

/**
 * EvalRunService — pure business logic over abstract ports.
 *
 * Owns:
 *   - atomic create (replaces evals.ts:114-118 two-put non-atomic pattern)
 *   - cross-tenant lookup via getById (used by cron tick)
 *   - cross-tenant active scan via listActive (replaces evalrun_active: KV index)
 *   - cascade delete on agent.delete (KV scan replacement)
 *   - markCompleted convenience for terminal-state transitions
 *   - hasActive{ByAgent,ByEnvironment} safety checks for delete refusals
 *
 * Does NOT own:
 *   - per-trial trajectory blobs (they remain in CONFIG_KV under `trajectory:`
 *     keys, referenced from inside the `results` JSON).
 *   - sandbox / session lifecycle for in-flight trials — eval-runner orchestrates
 *     those across the SessionDO + SessionService boundary.
 *   - opinion on the `results` JSON shape — it's an opaque blob; route +
 *     eval-runner own the EvalRunRecord shape.
 */
export class EvalRunService {
  private readonly repo: EvalRunRepo;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly logger: Logger;

  constructor(deps: EvalRunServiceDeps) {
    this.repo = deps.repo;
    this.clock = deps.clock ?? defaultClock;
    this.ids = deps.ids ?? defaultIds;
    this.logger = deps.logger ?? consoleLogger;
  }

  // ============================================================
  // Write paths
  // ============================================================

  /**
   * Atomic create — single row insert with all fields. Status defaults to
   * "pending" to match the existing route's behavior (status flips to
   * "running" on the first cron tick); pass `status: "running"` if the caller
   * already started the run synchronously.
   */
  async create(opts: {
    tenantId: string;
    agentId: string;
    environmentId: string;
    suite?: string;
    status?: EvalRunStatus;
    /** Initial state blob — typically the EvalTaskResult[] with pending trials. */
    results?: unknown;
    score?: number;
  }): Promise<EvalRunRow> {
    return this.repo.insert({
      id: this.ids.evalRunId(),
      tenantId: opts.tenantId,
      agentId: opts.agentId,
      environmentId: opts.environmentId,
      suite: opts.suite ?? null,
      status: opts.status ?? "pending",
      results: opts.results ?? null,
      score: opts.score ?? null,
      error: null,
      startedAt: this.clock.nowMs(),
    });
  }

  /**
   * In-flight state update — used by the cron tick (eval-runner.ts:72-74
   * saveRun replacement). Pass any subset of fields; omitted fields are
   * untouched. completed_at is NOT auto-stamped here — call markCompleted
   * for terminal transitions instead.
   */
  async update(opts: {
    tenantId: string;
    runId: string;
    status?: EvalRunStatus;
    results?: unknown;
    score?: number | null;
    error?: string | null;
  }): Promise<EvalRunRow> {
    await this.requireRun(opts);
    const fields: EvalRunUpdateFields = {};
    if (opts.status !== undefined) fields.status = opts.status;
    if (opts.results !== undefined) fields.results = opts.results;
    if (opts.score !== undefined) fields.score = opts.score;
    if (opts.error !== undefined) fields.error = opts.error;
    return this.repo.update(opts.tenantId, opts.runId, fields);
  }

  /**
   * Terminal-state transition — sets status (must be a terminal value),
   * completed_at = now, and optionally results + score + error. Replaces
   * the manual "set ended_at + saveRun" pattern in eval-runner.ts:301-306
   * and 333-335.
   */
  async markCompleted(opts: {
    tenantId: string;
    runId: string;
    status: "completed" | "failed";
    results?: unknown;
    score?: number;
    error?: string;
  }): Promise<EvalRunRow> {
    await this.requireRun(opts);
    const fields: EvalRunUpdateFields = {
      status: opts.status,
      completedAt: this.clock.nowMs(),
    };
    if (opts.results !== undefined) fields.results = opts.results;
    if (opts.score !== undefined) fields.score = opts.score;
    if (opts.error !== undefined) fields.error = opts.error;
    return this.repo.update(opts.tenantId, opts.runId, fields);
  }

  async delete(opts: { tenantId: string; runId: string }): Promise<void> {
    await this.requireRun(opts);
    await this.repo.delete(opts.tenantId, opts.runId);
  }

  /**
   * Cascade-delete every eval run for an agent. Used by the agent-delete
   * safety path: callers should first call `hasActiveByAgent` to refuse if
   * any run is still active, then either let runs naturally complete OR call
   * this to wipe everything.
   *
   * Returns deletion count for logging.
   */
  async deleteByAgent(opts: { tenantId: string; agentId: string }): Promise<number> {
    return this.repo.deleteByAgent(opts.tenantId, opts.agentId);
  }

  // ============================================================
  // Read paths
  // ============================================================

  async get(opts: {
    tenantId: string;
    runId: string;
  }): Promise<EvalRunRow | null> {
    return this.repo.get(opts.tenantId, opts.runId);
  }

  /**
   * Cross-tenant lookup by run id — used by the cron tick (eval-runner.ts)
   * which iterates the active list and needs the row + its tenant_id without
   * a separate index.
   */
  async getById(opts: { runId: string }): Promise<EvalRunRow | null> {
    return this.repo.getById(opts.runId);
  }

  async list(opts: {
    tenantId: string;
    agentId?: string;
    environmentId?: string;
    status?: EvalRunStatus;
    order?: "asc" | "desc";
    limit?: number;
  }): Promise<EvalRunRow[]> {
    const listOpts: EvalRunListOptions = {
      agentId: opts.agentId,
      environmentId: opts.environmentId,
      status: opts.status,
      order: opts.order ?? "desc",
      limit: opts.limit ?? 100,
    };
    return this.repo.list(opts.tenantId, listOpts);
  }

  /**
   * List runs filtered by agent — convenience for the agent-detail page and
   * any "what runs touched this agent?" query path. Delegates to list with
   * the indexed (tenant_id, agent_id, started_at DESC) path.
   */
  async listByAgent(opts: {
    tenantId: string;
    agentId: string;
    order?: "asc" | "desc";
    limit?: number;
  }): Promise<EvalRunRow[]> {
    return this.list({
      tenantId: opts.tenantId,
      agentId: opts.agentId,
      order: opts.order,
      limit: opts.limit,
    });
  }

  /**
   * Cross-tenant scan of pending+running runs — replaces the
   * `evalrun_active:` KV index that tickEvalRuns iterates. Indexed via
   * partial index on status so this stays O(active), not O(all).
   */
  async listActive(): Promise<EvalRunRow[]> {
    return this.repo.listActive();
  }

  /**
   * Agent-delete safety check: refuse if any pending/running run in the
   * tenant references this agent. Mirrors the sessions-store
   * `hasActiveByAgent` pattern.
   */
  async hasActiveByAgent(opts: {
    tenantId: string;
    agentId: string;
  }): Promise<boolean> {
    return this.repo.hasActiveByAgent(opts.tenantId, opts.agentId);
  }

  /** Environment-delete safety check — same shape as hasActiveByAgent. */
  async hasActiveByEnvironment(opts: {
    tenantId: string;
    environmentId: string;
  }): Promise<boolean> {
    return this.repo.hasActiveByEnvironment(opts.tenantId, opts.environmentId);
  }

  // ============================================================
  // Internals
  // ============================================================

  private async requireRun(opts: {
    tenantId: string;
    runId: string;
  }): Promise<EvalRunRow> {
    const row = await this.repo.get(opts.tenantId, opts.runId);
    if (!row) throw new EvalRunNotFoundError();
    return row;
  }
}

// ============================================================
// Default infra (used when callers don't override)
// ============================================================

const defaultClock: Clock = { nowMs: () => Date.now() };

const defaultIds: IdGenerator = { evalRunId: generateEvalRunId };

const consoleLogger: Logger = { warn: (msg, ctx) => console.warn(msg, ctx) };
