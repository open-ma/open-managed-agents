// In-memory implementations of every port for unit tests. Mirrors the D1
// adapter semantics — same NOT-NULL / nullable behavior, same archived-row
// handling — so unit tests catch the same bugs the integration suite would.

import type { EnvironmentConfig } from "@open-managed-agents/shared";
import { EnvironmentNotFoundError } from "./errors";
import type {
  Clock,
  EnvironmentRepo,
  EnvironmentUpdateFields,
  IdGenerator,
  Logger,
  NewEnvironmentInput,
} from "./ports";
import { EnvironmentService } from "./service";
import type { EnvironmentRow, EnvironmentStatus } from "./types";

interface InMemEnvironment {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  status: EnvironmentStatus;
  sandbox_worker_name: string | null;
  build_error: string | null;
  config: EnvironmentConfig["config"];
  metadata: Record<string, unknown> | null;
  image_strategy: "base_snapshot" | "dockerfile" | null;
  image_handle: Record<string, unknown> | null;
  created_at: number;
  updated_at: number | null;
  archived_at: number | null;
}

export class InMemoryEnvironmentRepo implements EnvironmentRepo {
  private readonly byId = new Map<string, InMemEnvironment>();

  async insert(input: NewEnvironmentInput): Promise<EnvironmentRow> {
    const row: InMemEnvironment = {
      id: input.id,
      tenant_id: input.tenantId,
      name: input.name,
      description: input.description,
      status: input.status,
      sandbox_worker_name: input.sandboxWorkerName,
      build_error: input.buildError,
      config: input.config,
      metadata: input.metadata,
      image_strategy: input.imageStrategy ?? null,
      image_handle: input.imageHandle ?? null,
      created_at: input.createdAt,
      updated_at: null,
      archived_at: null,
    };
    this.byId.set(input.id, row);
    return toRow(row);
  }

  async get(
    tenantId: string,
    environmentId: string,
  ): Promise<EnvironmentRow | null> {
    const row = this.byId.get(environmentId);
    if (!row || row.tenant_id !== tenantId) return null;
    return toRow(row);
  }

  async list(
    tenantId: string,
    opts: { includeArchived: boolean },
  ): Promise<EnvironmentRow[]> {
    return Array.from(this.byId.values())
      .filter((r) => r.tenant_id === tenantId)
      .filter((r) => opts.includeArchived || r.archived_at === null)
      .sort((a, b) => a.created_at - b.created_at)
      .map(toRow);
  }

  async update(
    tenantId: string,
    environmentId: string,
    update: EnvironmentUpdateFields,
  ): Promise<EnvironmentRow> {
    const row = this.byId.get(environmentId);
    if (!row || row.tenant_id !== tenantId) {
      throw new EnvironmentNotFoundError();
    }
    if (update.name !== undefined) row.name = update.name;
    if (update.description !== undefined) row.description = update.description;
    if (update.status !== undefined) row.status = update.status;
    if (update.sandboxWorkerName !== undefined) {
      row.sandbox_worker_name = update.sandboxWorkerName;
    }
    if (update.buildError !== undefined) row.build_error = update.buildError;
    if (update.config !== undefined) row.config = update.config;
    if (update.metadata !== undefined) row.metadata = update.metadata;
    if (update.imageStrategy !== undefined) row.image_strategy = update.imageStrategy;
    if (update.imageHandle !== undefined) row.image_handle = update.imageHandle;
    row.updated_at = update.updatedAt;
    return toRow(row);
  }

  async archive(
    tenantId: string,
    environmentId: string,
    archivedAt: number,
  ): Promise<EnvironmentRow> {
    const row = this.byId.get(environmentId);
    if (!row || row.tenant_id !== tenantId) {
      throw new EnvironmentNotFoundError();
    }
    row.archived_at = archivedAt;
    row.updated_at = archivedAt;
    return toRow(row);
  }

  async delete(tenantId: string, environmentId: string): Promise<void> {
    const row = this.byId.get(environmentId);
    if (!row || row.tenant_id !== tenantId) return;
    this.byId.delete(environmentId);
  }
}

export class SequentialIdGenerator implements IdGenerator {
  private n = 0;
  environmentId(): string {
    return `env-${++this.n}`;
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
export function createInMemoryEnvironmentService(opts?: {
  clock?: Clock;
  ids?: IdGenerator;
  logger?: Logger;
}): {
  service: EnvironmentService;
  repo: InMemoryEnvironmentRepo;
} {
  const repo = new InMemoryEnvironmentRepo();
  const service = new EnvironmentService({
    repo,
    clock: opts?.clock,
    ids: opts?.ids ?? new SequentialIdGenerator(),
    logger: opts?.logger ?? new SilentLogger(),
  });
  return { service, repo };
}

// ── helpers ──

function toRow(e: InMemEnvironment): EnvironmentRow {
  return {
    id: e.id,
    tenant_id: e.tenant_id,
    name: e.name,
    description: e.description,
    status: e.status,
    sandbox_worker_name: e.sandbox_worker_name,
    build_error: e.build_error,
    config: e.config,
    metadata: e.metadata,
    image_strategy: e.image_strategy,
    image_handle: e.image_handle,
    created_at: msToIso(e.created_at),
    updated_at: e.updated_at !== null ? msToIso(e.updated_at) : null,
    archived_at: e.archived_at !== null ? msToIso(e.archived_at) : null,
  };
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}
