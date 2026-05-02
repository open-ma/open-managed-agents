// In-memory implementations of every port for unit tests. Mirrors the
// cascade-on-delete behavior of the D1 adapter so tests catch the same
// integrity violations.

import type {
  AgentConfig,
  EnvironmentConfig,
  SessionResource,
  SessionStatus,
} from "@open-managed-agents/shared";
import { SessionNotFoundError } from "./errors";
import type {
  Clock,
  IdGenerator,
  Logger,
  NewSessionInput,
  NewSessionResourceInput,
  SessionListOptions,
  SessionRepo,
  SessionUpdateFields,
} from "./ports";
import { SessionService } from "./service";
import type { SessionResourceRow, SessionRow } from "./types";

interface InMemSession {
  id: string;
  tenant_id: string;
  agent_id: string;
  environment_id: string;
  title: string;
  status: SessionStatus;
  vault_ids: string[] | null;
  agent_snapshot: AgentConfig | null;
  environment_snapshot: EnvironmentConfig | null;
  metadata: Record<string, unknown> | null;
  created_at: number;
  updated_at: number | null;
  archived_at: number | null;
}

interface InMemResource {
  id: string;
  session_id: string;
  type: SessionResource["type"];
  resource: SessionResource;
  created_at: number;
}

export class InMemorySessionRepo implements SessionRepo {
  private readonly sessions = new Map<string, InMemSession>();
  private readonly resources = new Map<string, InMemResource>();

  async insertWithResources(
    session: NewSessionInput,
    resources: NewSessionResourceInput[],
  ): Promise<{ session: SessionRow; resources: SessionResourceRow[] }> {
    const row: InMemSession = {
      id: session.id,
      tenant_id: session.tenantId,
      agent_id: session.agentId,
      environment_id: session.environmentId,
      title: session.title,
      status: session.status,
      vault_ids: session.vaultIds,
      agent_snapshot: session.agentSnapshot,
      environment_snapshot: session.environmentSnapshot,
      metadata: session.metadata,
      created_at: session.createdAt,
      updated_at: null,
      archived_at: null,
    };
    this.sessions.set(session.id, row);

    const insertedResources: SessionResourceRow[] = [];
    for (const r of resources) {
      const memRes: InMemResource = {
        id: r.id,
        session_id: r.sessionId,
        type: r.resource.type,
        resource: r.resource,
        created_at: r.createdAt,
      };
      this.resources.set(r.id, memRes);
      insertedResources.push(toResourceRow(memRes));
    }
    return { session: toSessionRow(row), resources: insertedResources };
  }

  async get(tenantId: string, sessionId: string): Promise<SessionRow | null> {
    const row = this.sessions.get(sessionId);
    if (!row || row.tenant_id !== tenantId) return null;
    return toSessionRow(row);
  }

  async getById(sessionId: string): Promise<SessionRow | null> {
    const row = this.sessions.get(sessionId);
    return row ? toSessionRow(row) : null;
  }

  async list(tenantId: string, opts: SessionListOptions): Promise<SessionRow[]> {
    let rows = Array.from(this.sessions.values()).filter((s) => s.tenant_id === tenantId);
    if (opts.agentId) rows = rows.filter((s) => s.agent_id === opts.agentId);
    if (!opts.includeArchived) rows = rows.filter((s) => s.archived_at === null);
    rows.sort((a, b) => (opts.order === "asc" ? a.created_at - b.created_at : b.created_at - a.created_at));
    return rows.slice(0, opts.limit).map(toSessionRow);
  }

  async listPage(
    tenantId: string,
    opts: {
      agentId?: string;
      includeArchived: boolean;
      limit: number;
      after?: import("@open-managed-agents/shared").PageCursor;
    },
  ): Promise<{ items: SessionRow[]; hasMore: boolean }> {
    let rows = Array.from(this.sessions.values()).filter(
      (s) => s.tenant_id === tenantId,
    );
    if (opts.agentId) rows = rows.filter((s) => s.agent_id === opts.agentId);
    if (!opts.includeArchived) rows = rows.filter((s) => s.archived_at === null);
    rows.sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id));
    if (opts.after) {
      const { createdAt: t, id } = opts.after;
      rows = rows.filter(
        (r) => r.created_at < t || (r.created_at === t && r.id < id),
      );
    }
    const hasMore = rows.length > opts.limit;
    return {
      items: (hasMore ? rows.slice(0, opts.limit) : rows).map(toSessionRow),
      hasMore,
    };
  }

  async hasActiveByAgent(tenantId: string, agentId: string): Promise<boolean> {
    for (const s of this.sessions.values()) {
      if (
        s.tenant_id === tenantId &&
        s.agent_id === agentId &&
        s.archived_at === null
      ) {
        return true;
      }
    }
    return false;
  }

  async hasActiveByEnvironment(tenantId: string, environmentId: string): Promise<boolean> {
    for (const s of this.sessions.values()) {
      if (
        s.tenant_id === tenantId &&
        s.environment_id === environmentId &&
        s.archived_at === null
      ) {
        return true;
      }
    }
    return false;
  }

  async update(
    tenantId: string,
    sessionId: string,
    update: SessionUpdateFields,
  ): Promise<SessionRow> {
    const row = this.sessions.get(sessionId);
    if (!row || row.tenant_id !== tenantId) throw new SessionNotFoundError();
    if (update.title !== undefined) row.title = update.title;
    if (update.status !== undefined) row.status = update.status;
    if (update.metadata !== undefined) row.metadata = update.metadata;
    if (update.agentSnapshot !== undefined) row.agent_snapshot = update.agentSnapshot;
    if (update.environmentSnapshot !== undefined) row.environment_snapshot = update.environmentSnapshot;
    row.updated_at = update.updatedAt;
    return toSessionRow(row);
  }

  async archive(
    tenantId: string,
    sessionId: string,
    archivedAt: number,
  ): Promise<SessionRow> {
    const row = this.sessions.get(sessionId);
    if (!row || row.tenant_id !== tenantId) throw new SessionNotFoundError();
    row.archived_at = archivedAt;
    row.updated_at = archivedAt;
    return toSessionRow(row);
  }

  async deleteWithResources(tenantId: string, sessionId: string): Promise<void> {
    const row = this.sessions.get(sessionId);
    if (!row || row.tenant_id !== tenantId) return;
    this.sessions.delete(sessionId);
    for (const [id, r] of this.resources.entries()) {
      if (r.session_id === sessionId) this.resources.delete(id);
    }
  }

  async deleteByAgent(tenantId: string, agentId: string): Promise<number> {
    const sessionsToDelete: string[] = [];
    for (const s of this.sessions.values()) {
      if (s.tenant_id === tenantId && s.agent_id === agentId) {
        sessionsToDelete.push(s.id);
      }
    }
    for (const id of sessionsToDelete) {
      this.sessions.delete(id);
      for (const [rid, r] of this.resources.entries()) {
        if (r.session_id === id) this.resources.delete(rid);
      }
    }
    return sessionsToDelete.length;
  }

  // ── resource ops ──

  async insertResource(input: NewSessionResourceInput): Promise<SessionResourceRow> {
    const row: InMemResource = {
      id: input.id,
      session_id: input.sessionId,
      type: input.resource.type,
      resource: input.resource,
      created_at: input.createdAt,
    };
    this.resources.set(input.id, row);
    return toResourceRow(row);
  }

  async getResource(
    sessionId: string,
    resourceId: string,
  ): Promise<SessionResourceRow | null> {
    const row = this.resources.get(resourceId);
    if (!row || row.session_id !== sessionId) return null;
    return toResourceRow(row);
  }

  async listResources(sessionId: string): Promise<SessionResourceRow[]> {
    return Array.from(this.resources.values())
      .filter((r) => r.session_id === sessionId)
      .sort((a, b) => a.created_at - b.created_at)
      .map(toResourceRow);
  }

  async countResources(sessionId: string): Promise<number> {
    let n = 0;
    for (const r of this.resources.values()) if (r.session_id === sessionId) n++;
    return n;
  }

  async countResourcesByType(
    sessionId: string,
    type: SessionResource["type"],
  ): Promise<number> {
    let n = 0;
    for (const r of this.resources.values()) {
      if (r.session_id === sessionId && r.type === type) n++;
    }
    return n;
  }

  async deleteResource(sessionId: string, resourceId: string): Promise<void> {
    const row = this.resources.get(resourceId);
    if (!row || row.session_id !== sessionId) return;
    this.resources.delete(resourceId);
  }

  async deleteAllResourcesForSession(sessionId: string): Promise<void> {
    for (const [id, r] of this.resources.entries()) {
      if (r.session_id === sessionId) this.resources.delete(id);
    }
  }
}

export class SequentialIdGenerator implements IdGenerator {
  private sessionN = 0;
  private resourceN = 0;
  sessionId(): string {
    return `sess-${++this.sessionN}`;
  }
  resourceId(): string {
    return `sesrsc-${++this.resourceN}`;
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
export function createInMemorySessionService(opts?: {
  clock?: Clock;
  ids?: IdGenerator;
  logger?: Logger;
}): {
  service: SessionService;
  repo: InMemorySessionRepo;
} {
  const repo = new InMemorySessionRepo();
  const service = new SessionService({
    repo,
    clock: opts?.clock,
    ids: opts?.ids ?? new SequentialIdGenerator(),
    logger: opts?.logger ?? new SilentLogger(),
  });
  return { service, repo };
}

// ── helpers ──

function toSessionRow(s: InMemSession): SessionRow {
  return {
    id: s.id,
    tenant_id: s.tenant_id,
    agent_id: s.agent_id,
    environment_id: s.environment_id,
    title: s.title,
    status: s.status,
    vault_ids: s.vault_ids,
    agent_snapshot: s.agent_snapshot,
    environment_snapshot: s.environment_snapshot,
    metadata: s.metadata,
    created_at: msToIso(s.created_at),
    updated_at: s.updated_at !== null ? msToIso(s.updated_at) : null,
    archived_at: s.archived_at !== null ? msToIso(s.archived_at) : null,
  };
}

function toResourceRow(r: InMemResource): SessionResourceRow {
  return {
    id: r.id,
    session_id: r.session_id,
    type: r.type,
    resource: r.resource,
    created_at: msToIso(r.created_at),
  };
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}
