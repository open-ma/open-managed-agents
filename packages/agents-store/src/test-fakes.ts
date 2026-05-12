// In-memory implementations of every port for unit tests. Mirrors the
// cascade-on-delete behavior + history-snapshot atomicity of the D1 adapter
// so tests catch the same integrity violations.

import type { AgentConfig } from "@open-managed-agents/shared";
import { AgentNotFoundError } from "./errors";
import type {
  AgentRepo,
  AgentUpdateFields,
  AgentVersionSnapshotInput,
  Clock,
  IdGenerator,
  Logger,
  NewAgentInput,
} from "./ports";
import { AgentService } from "./service";
import type { AgentRow, AgentVersionRow } from "./types";

interface InMemAgent {
  id: string;
  tenant_id: string;
  config: AgentConfig;
  version: number;
  created_at: number;
  updated_at: number | null;
  archived_at: number | null;
}

interface InMemVersion {
  agent_id: string;
  tenant_id: string;
  version: number;
  snapshot: AgentConfig;
  created_at: number;
}

export class InMemoryAgentRepo implements AgentRepo {
  private readonly byId = new Map<string, InMemAgent>();
  /** Keyed by `${agentId}:v${version}` for O(1) lookup + cascade delete. */
  private readonly versionsByKey = new Map<string, InMemVersion>();

  async insert(input: NewAgentInput): Promise<AgentRow> {
    const row: InMemAgent = {
      id: input.id,
      tenant_id: input.tenantId,
      config: input.config,
      version: input.config.version,
      created_at: input.createdAt,
      updated_at: input.createdAt,
      archived_at: null,
    };
    this.byId.set(input.id, row);
    return toRow(row);
  }

  async get(tenantId: string, agentId: string): Promise<AgentRow | null> {
    const row = this.byId.get(agentId);
    if (!row || row.tenant_id !== tenantId) return null;
    return toRow(row);
  }

  async getById(agentId: string): Promise<AgentRow | null> {
    const row = this.byId.get(agentId);
    return row ? toRow(row) : null;
  }

  async list(
    tenantId: string,
    opts: { includeArchived: boolean },
  ): Promise<AgentRow[]> {
    return Array.from(this.byId.values())
      .filter((r) => r.tenant_id === tenantId)
      .filter((r) => opts.includeArchived || r.archived_at === null)
      .sort((a, b) => a.created_at - b.created_at)
      .map(toRow);
  }

  async listPage(
    tenantId: string,
    opts: {
      includeArchived: boolean;
      limit: number;
      after?: import("@open-managed-agents/shared").PageCursor;
      q?: string;
    },
  ): Promise<{ items: AgentRow[]; hasMore: boolean }> {
    const qLower = opts.q?.toLowerCase();
    let rows = Array.from(this.byId.values())
      .filter((r) => r.tenant_id === tenantId)
      .filter((r) => opts.includeArchived || r.archived_at === null)
      .filter((r) =>
        qLower ? (r.config.name ?? "").toLowerCase().includes(qLower) : true,
      )
      // Mirror the D1 query order: created_at DESC, id DESC.
      .sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id));
    if (opts.after) {
      const { createdAt: t, id } = opts.after;
      rows = rows.filter(
        (r) => r.created_at < t || (r.created_at === t && r.id < id),
      );
    }
    const hasMore = rows.length > opts.limit;
    return {
      items: (hasMore ? rows.slice(0, opts.limit) : rows).map(toRow),
      hasMore,
    };
  }

  async count(
    tenantId: string,
    opts: { includeArchived: boolean },
  ): Promise<number> {
    return Array.from(this.byId.values())
      .filter((r) => r.tenant_id === tenantId)
      .filter((r) => opts.includeArchived || r.archived_at === null)
      .length;
  }

  async updateWithVersionSnapshot(
    tenantId: string,
    agentId: string,
    update: AgentUpdateFields,
    priorSnapshot: AgentVersionSnapshotInput,
  ): Promise<AgentRow> {
    const row = this.byId.get(agentId);
    if (!row || row.tenant_id !== tenantId) throw new AgentNotFoundError();
    // Atomic: write the prior snapshot to history, then bump the current row.
    const versionKey = `${priorSnapshot.agentId}:v${priorSnapshot.version}`;
    this.versionsByKey.set(versionKey, {
      agent_id: priorSnapshot.agentId,
      tenant_id: priorSnapshot.tenantId,
      version: priorSnapshot.version,
      snapshot: priorSnapshot.snapshot,
      created_at: priorSnapshot.createdAt,
    });
    row.config = update.config;
    row.version = update.version;
    row.updated_at = update.updatedAt;
    return toRow(row);
  }

  async archive(
    tenantId: string,
    agentId: string,
    archivedAt: number,
  ): Promise<AgentRow> {
    const row = this.byId.get(agentId);
    if (!row || row.tenant_id !== tenantId) throw new AgentNotFoundError();
    row.archived_at = archivedAt;
    row.updated_at = archivedAt;
    // Mirror archived_at into the embedded config so consumers reading from
    // either the row or the JSON see a consistent value.
    row.config = { ...row.config, archived_at: msToIso(archivedAt) };
    return toRow(row);
  }

  async deleteWithVersions(tenantId: string, agentId: string): Promise<void> {
    const row = this.byId.get(agentId);
    if (!row || row.tenant_id !== tenantId) return;
    this.byId.delete(agentId);
    for (const [key, ver] of this.versionsByKey.entries()) {
      if (ver.agent_id === agentId) this.versionsByKey.delete(key);
    }
  }

  async listVersions(
    tenantId: string,
    agentId: string,
  ): Promise<AgentVersionRow[]> {
    return Array.from(this.versionsByKey.values())
      .filter((v) => v.agent_id === agentId && v.tenant_id === tenantId)
      .sort((a, b) => a.version - b.version)
      .map(toVersionRow);
  }

  async getVersion(
    tenantId: string,
    agentId: string,
    version: number,
  ): Promise<AgentVersionRow | null> {
    const row = this.versionsByKey.get(`${agentId}:v${version}`);
    if (!row || row.tenant_id !== tenantId) return null;
    return toVersionRow(row);
  }
}

export class SequentialIdGenerator implements IdGenerator {
  private n = 0;
  agentId(): string {
    return `agent-${++this.n}`;
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
export function createInMemoryAgentService(opts?: {
  clock?: Clock;
  ids?: IdGenerator;
  logger?: Logger;
}): {
  service: AgentService;
  repo: InMemoryAgentRepo;
} {
  const repo = new InMemoryAgentRepo();
  const service = new AgentService({
    repo,
    clock: opts?.clock,
    ids: opts?.ids ?? new SequentialIdGenerator(),
    logger: opts?.logger ?? new SilentLogger(),
  });
  return { service, repo };
}

// ── helpers ──

function toRow(a: InMemAgent): AgentRow {
  // Surface the mutable state into the embedded config for round-trip consistency.
  return {
    ...a.config,
    tenant_id: a.tenant_id,
    version: a.version,
    created_at: msToIso(a.created_at),
    updated_at: a.updated_at !== null ? msToIso(a.updated_at) : undefined,
    archived_at: a.archived_at !== null ? msToIso(a.archived_at) : undefined,
  };
}

function toVersionRow(v: InMemVersion): AgentVersionRow {
  return {
    agent_id: v.agent_id,
    tenant_id: v.tenant_id,
    version: v.version,
    snapshot: v.snapshot,
    created_at: msToIso(v.created_at),
  };
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}
