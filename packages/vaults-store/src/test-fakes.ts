// In-memory implementations of every port for unit tests. No D1 binding needed.

import { VaultNotFoundError } from "./errors";
import type {
  Clock,
  IdGenerator,
  Logger,
  NewVaultInput,
  VaultRepo,
  VaultUpdateFields,
} from "./ports";
import { VaultService } from "./service";
import type { VaultRow } from "./types";

interface InMemVault {
  id: string;
  tenant_id: string;
  name: string;
  created_at: number;
  updated_at: number | null;
  archived_at: number | null;
}

export class InMemoryVaultRepo implements VaultRepo {
  private readonly byId = new Map<string, InMemVault>();

  async insert(input: NewVaultInput): Promise<VaultRow> {
    const row: InMemVault = {
      id: input.id,
      tenant_id: input.tenantId,
      name: input.name,
      created_at: input.createdAt,
      updated_at: null,
      archived_at: null,
    };
    this.byId.set(input.id, row);
    return toRow(row);
  }

  async get(tenantId: string, vaultId: string): Promise<VaultRow | null> {
    const row = this.byId.get(vaultId);
    if (!row || row.tenant_id !== tenantId) return null;
    return toRow(row);
  }

  async exists(tenantId: string, vaultId: string): Promise<boolean> {
    const row = this.byId.get(vaultId);
    return !!row && row.tenant_id === tenantId;
  }

  async list(
    tenantId: string,
    opts: { includeArchived: boolean },
  ): Promise<VaultRow[]> {
    return Array.from(this.byId.values())
      .filter((r) => r.tenant_id === tenantId)
      .filter((r) => opts.includeArchived || r.archived_at === null)
      .sort((a, b) => a.created_at - b.created_at)
      .map(toRow);
  }

  async update(
    tenantId: string,
    vaultId: string,
    update: VaultUpdateFields,
  ): Promise<VaultRow> {
    const row = this.byId.get(vaultId);
    if (!row || row.tenant_id !== tenantId) throw new VaultNotFoundError();
    if (update.name !== undefined) row.name = update.name;
    row.updated_at = update.updatedAt;
    return toRow(row);
  }

  async archive(
    tenantId: string,
    vaultId: string,
    archivedAt: number,
  ): Promise<VaultRow> {
    const row = this.byId.get(vaultId);
    if (!row || row.tenant_id !== tenantId) throw new VaultNotFoundError();
    row.archived_at = archivedAt;
    row.updated_at = archivedAt;
    return toRow(row);
  }

  async delete(tenantId: string, vaultId: string): Promise<void> {
    const row = this.byId.get(vaultId);
    if (!row || row.tenant_id !== tenantId) return;
    this.byId.delete(vaultId);
  }
}

export class SequentialIdGenerator implements IdGenerator {
  private n = 0;
  vaultId(): string {
    return `vlt-${++this.n}`;
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
 * Convenience factory — full in-memory wiring with sane defaults.
 */
export function createInMemoryVaultService(opts?: {
  clock?: Clock;
  ids?: IdGenerator;
  logger?: Logger;
}): {
  service: VaultService;
  repo: InMemoryVaultRepo;
} {
  const repo = new InMemoryVaultRepo();
  const service = new VaultService({
    repo,
    clock: opts?.clock,
    ids: opts?.ids ?? new SequentialIdGenerator(),
    logger: opts?.logger ?? new SilentLogger(),
  });
  return { service, repo };
}

// ── helpers ──

function toRow(v: InMemVault): VaultRow {
  return {
    id: v.id,
    tenant_id: v.tenant_id,
    name: v.name,
    created_at: msToIso(v.created_at),
    updated_at: v.updated_at !== null ? msToIso(v.updated_at) : null,
    archived_at: v.archived_at !== null ? msToIso(v.archived_at) : null,
  };
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}
