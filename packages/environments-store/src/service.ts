import {
  generateEnvId,
  type EnvironmentConfig,
} from "@open-managed-agents/shared";
import { EnvironmentNotFoundError } from "./errors";
import type {
  Clock,
  EnvironmentRepo,
  EnvironmentUpdateFields,
  IdGenerator,
  Logger,
  NewEnvironmentInput,
} from "./ports";
import type { EnvironmentRow, EnvironmentStatus } from "./types";

export interface EnvironmentServiceDeps {
  repo: EnvironmentRepo;
  clock?: Clock;
  ids?: IdGenerator;
  logger?: Logger;
}

/**
 * EnvironmentService — pure business logic over abstract ports.
 *
 * Owns the environment entity (id, name, status, config, sandbox_worker_name,
 * timestamps). Replaces the KV layout `t:{tenant}:env:{id}` previously used by
 * routes/environments.ts.
 *
 * Does NOT own:
 *   - Sandbox worker deployment (GitHub Actions dispatch + Cloudflare service
 *     binding registration). Routes handle the orchestration via triggerBuild
 *     and call back into update() with the resulting status / sandbox_worker_name.
 *   - Active-session safety check on delete — that's a cross-store concern
 *     and lives in the route handler (calls SessionService.hasActiveByEnvironment
 *     and EvalRunService.hasActiveByEnvironment before invoking us).
 *   - Snapshot persistence inside sessions / eval runs — those rows freeze
 *     the EnvironmentConfig at session-create time so trajectory replay still
 *     works after the environment definition mutates. Routes call
 *     `toEnvironmentConfig(row)` to convert before handing to those stores.
 */
export class EnvironmentService {
  private readonly repo: EnvironmentRepo;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly logger: Logger;

  constructor(deps: EnvironmentServiceDeps) {
    this.repo = deps.repo;
    this.clock = deps.clock ?? defaultClock;
    this.ids = deps.ids ?? defaultIds;
    this.logger = deps.logger ?? consoleLogger;
  }

  // ============================================================
  // Write paths
  // ============================================================

  async create(opts: {
    tenantId: string;
    name: string;
    description?: string | null;
    config: EnvironmentConfig["config"];
    /** Defaults to "ready" — set to "building" when triggering a CI build. */
    status?: EnvironmentStatus;
    sandboxWorkerName?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<EnvironmentRow> {
    const input: NewEnvironmentInput = {
      id: this.ids.environmentId(),
      tenantId: opts.tenantId,
      name: opts.name,
      description: opts.description ?? null,
      status: opts.status ?? "ready",
      sandboxWorkerName: opts.sandboxWorkerName ?? null,
      buildError: null,
      config: opts.config,
      metadata: opts.metadata ?? null,
      createdAt: this.clock.nowMs(),
    };
    return await this.repo.insert(input);
  }

  /**
   * Generic update — every field is optional. Pass `null` to clear a nullable
   * field (description / sandboxWorkerName / buildError / metadata). Pass
   * `undefined` (omit) to leave it untouched.
   *
   * `updated_at` is bumped automatically on every call; callers don't pass it.
   */
  async update(opts: {
    tenantId: string;
    environmentId: string;
    name?: string;
    description?: string | null;
    config?: EnvironmentConfig["config"];
    status?: EnvironmentStatus;
    sandboxWorkerName?: string | null;
    buildError?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<EnvironmentRow> {
    await this.requireEnvironment(opts);
    const update: EnvironmentUpdateFields = { updatedAt: this.clock.nowMs() };
    if (opts.name !== undefined) update.name = opts.name;
    if (opts.description !== undefined) update.description = opts.description;
    if (opts.config !== undefined) update.config = opts.config;
    if (opts.status !== undefined) update.status = opts.status;
    if (opts.sandboxWorkerName !== undefined) {
      update.sandboxWorkerName = opts.sandboxWorkerName;
    }
    if (opts.buildError !== undefined) update.buildError = opts.buildError;
    if (opts.metadata !== undefined) update.metadata = opts.metadata;
    return this.repo.update(opts.tenantId, opts.environmentId, update);
  }

  async archive(opts: {
    tenantId: string;
    environmentId: string;
  }): Promise<EnvironmentRow> {
    await this.requireEnvironment(opts);
    return this.repo.archive(
      opts.tenantId,
      opts.environmentId,
      this.clock.nowMs(),
    );
  }

  async delete(opts: {
    tenantId: string;
    environmentId: string;
  }): Promise<void> {
    await this.requireEnvironment(opts);
    await this.repo.delete(opts.tenantId, opts.environmentId);
  }

  // ============================================================
  // Read paths
  // ============================================================

  async get(opts: {
    tenantId: string;
    environmentId: string;
  }): Promise<EnvironmentRow | null> {
    return this.repo.get(opts.tenantId, opts.environmentId);
  }

  /**
   * List environments. Defaults to `includeArchived: true` to preserve the
   * historical KV behavior — the previous routes/environments.ts list path
   * scanned `t:{tenant}:env:` and returned every row regardless of
   * `archived_at`. Pass `false` from a route that wants to hide archived.
   */
  async list(opts: {
    tenantId: string;
    includeArchived?: boolean;
  }): Promise<EnvironmentRow[]> {
    return this.repo.list(opts.tenantId, {
      includeArchived: opts.includeArchived ?? true,
    });
  }

  // ============================================================
  // Internals
  // ============================================================

  private async requireEnvironment(opts: {
    tenantId: string;
    environmentId: string;
  }): Promise<EnvironmentRow> {
    const row = await this.repo.get(opts.tenantId, opts.environmentId);
    if (!row) throw new EnvironmentNotFoundError();
    return row;
  }
}

// ============================================================
// toEnvironmentConfig — exported helper used by HTTP handlers
// ============================================================

/**
 * Convert an internal {@link EnvironmentRow} to the API-shape
 * {@link EnvironmentConfig} from packages/shared. Drops `tenant_id`, drops
 * dedicated `null` columns the historical KV shape didn't expose (the legacy
 * EnvironmentConfig allowed `description?` / `sandbox_worker_name?` /
 * `build_error?` / `metadata?` / `updated_at?` / `archived_at?` — all encoded
 * as "field absent" rather than "field null"). Returns the same shape the
 * sessions store / eval runner persist as `environment_snapshot`.
 */
export function toEnvironmentConfig(row: EnvironmentRow): EnvironmentConfig {
  const env: EnvironmentConfig = {
    id: row.id,
    name: row.name,
    config: row.config,
    status: row.status,
    created_at: row.created_at,
  };
  if (row.description !== null) env.description = row.description;
  if (row.sandbox_worker_name !== null) {
    env.sandbox_worker_name = row.sandbox_worker_name;
  }
  if (row.build_error !== null) env.build_error = row.build_error;
  if (row.metadata !== null) env.metadata = row.metadata;
  if (row.updated_at !== null) env.updated_at = row.updated_at;
  if (row.archived_at !== null) env.archived_at = row.archived_at;
  return env;
}

// ============================================================
// Default infra (used when callers don't override)
// ============================================================

const defaultClock: Clock = { nowMs: () => Date.now() };

const defaultIds: IdGenerator = { environmentId: generateEnvId };

const consoleLogger: Logger = { warn: (msg, ctx) => console.warn(msg, ctx) };
