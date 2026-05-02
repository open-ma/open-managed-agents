import {
  generateResourceId,
  generateSessionId,
} from "@open-managed-agents/shared";
import { paginateVia } from "@open-managed-agents/shared";
import type {
  AgentConfig,
  EnvironmentConfig,
  SessionResource,
  SessionStatus,
} from "@open-managed-agents/shared";
import {
  SessionArchivedError,
  SessionMemoryStoreMaxExceededError,
  SessionNotFoundError,
  SessionResourceMaxExceededError,
  SessionResourceNotFoundError,
} from "./errors";
import type {
  Clock,
  IdGenerator,
  Logger,
  NewSessionResourceInput,
  SessionListOptions,
  SessionRepo,
  SessionUpdateFields,
} from "./ports";
import {
  MAX_MEMORY_STORE_RESOURCES_PER_SESSION,
  MAX_RESOURCES_PER_SESSION,
  SessionResourceRow,
  SessionRow,
} from "./types";

export interface SessionServiceDeps {
  repo: SessionRepo;
  clock?: Clock;
  ids?: IdGenerator;
  logger?: Logger;
}

/** Resource input shape for create/addResource — id + session_id + created_at
 *  are always assigned by the service. Callers pass the SessionResource sans
 *  those fields. */
export type NewResourceInput = Omit<SessionResource, "id" | "session_id" | "created_at">;

/**
 * SessionService — pure business logic over abstract ports.
 *
 * Owns:
 *   - per-session resource quota (MAX_RESOURCES_PER_SESSION) — was sessions.ts:869
 *   - per-session memory_store quota (MAX_MEMORY_STORE_RESOURCES_PER_SESSION) — was sessions.ts:188 + 893
 *   - archived-session immutability for new resources (sessions.ts:541 was for events;
 *     we apply the same block to resource adds for consistency)
 *   - cascade delete on session.delete (sessions, resources)
 *   - cascade delete on agent.delete (sessions.ts O(N) scan replacement)
 *   - sidx-style cross-tenant lookup via getById
 *   - metadata merge semantics (per-key delete on null) — was sessions.ts:489-498
 *
 * Does NOT own:
 *   - secret materials (env.value, github_repository.authorization_token).
 *     Those continue to live in CONFIG_KV under `t:{tenant}:secret:...` keys
 *     because they're write-only blobs the route layer reads alongside the
 *     resource. Sessions store records resource METADATA only.
 *   - file copy / R2 ops at session create — caller (route) handles those
 *     before calling service.create.
 *   - sandbox lifecycle (init/destroy) — handled by the route via the sandbox
 *     binding.
 */
export class SessionService {
  private readonly repo: SessionRepo;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly logger: Logger;

  constructor(deps: SessionServiceDeps) {
    this.repo = deps.repo;
    this.clock = deps.clock ?? defaultClock;
    this.ids = deps.ids ?? defaultIds;
    this.logger = deps.logger ?? consoleLogger;
  }

  // ============================================================
  // Write paths
  // ============================================================

  /**
   * Atomic session create. Optionally accepts initial resources — those are
   * inserted in the same D1 batch as the session row, replacing the KV-era
   * partial-failure window where a session existed but its resources didn't.
   *
   * Pre-validates per-session caps so a 21st memory_store at create time fails
   * before the batch fires.
   */
  async create(opts: {
    tenantId: string;
    agentId: string;
    environmentId: string;
    title?: string;
    status?: SessionStatus;
    vaultIds?: string[];
    agentSnapshot?: AgentConfig;
    environmentSnapshot?: EnvironmentConfig;
    metadata?: Record<string, unknown>;
    resources?: NewResourceInput[];
  }): Promise<{ session: SessionRow; resources: SessionResourceRow[] }> {
    const resources = opts.resources ?? [];
    if (resources.length > MAX_RESOURCES_PER_SESSION) {
      throw new SessionResourceMaxExceededError(MAX_RESOURCES_PER_SESSION);
    }
    const memoryStoreCount = resources.filter((r) => r.type === "memory_store").length;
    if (memoryStoreCount > MAX_MEMORY_STORE_RESOURCES_PER_SESSION) {
      throw new SessionMemoryStoreMaxExceededError(MAX_MEMORY_STORE_RESOURCES_PER_SESSION);
    }

    const sessionId = this.ids.sessionId();
    const createdAt = this.clock.nowMs();

    const resourceInputs: NewSessionResourceInput[] = resources.map((r) => {
      const resourceId = this.ids.resourceId();
      return {
        id: resourceId,
        sessionId,
        createdAt,
        // Stamp id + session_id + created_at on the embedded resource so the
        // round-tripped JSON matches the row's identity.
        resource: {
          ...(r as SessionResource),
          id: resourceId,
          session_id: sessionId,
          created_at: new Date(createdAt).toISOString(),
        },
      };
    });

    return await this.repo.insertWithResources(
      {
        id: sessionId,
        tenantId: opts.tenantId,
        agentId: opts.agentId,
        environmentId: opts.environmentId,
        title: opts.title ?? "",
        status: opts.status ?? "idle",
        vaultIds: opts.vaultIds ?? null,
        agentSnapshot: opts.agentSnapshot ?? null,
        environmentSnapshot: opts.environmentSnapshot ?? null,
        metadata: opts.metadata ?? null,
        createdAt,
      },
      resourceInputs,
    );
  }

  /**
   * Patch a session: title, metadata (merge with per-key delete on null),
   * status, snapshots. Bumps updated_at. Mirrors POST /v1/sessions/:id behavior
   * (sessions.ts:477-504).
   */
  async update(opts: {
    tenantId: string;
    sessionId: string;
    title?: string;
    /** Per-key merge — pass `{ key: null }` to drop a key. Pass undefined to skip. */
    metadata?: Record<string, unknown>;
    status?: SessionStatus;
    agentSnapshot?: AgentConfig;
    environmentSnapshot?: EnvironmentConfig;
  }): Promise<SessionRow> {
    const existing = await this.requireSession(opts);
    const update: SessionUpdateFields = { updatedAt: this.clock.nowMs() };
    if (opts.title !== undefined) update.title = opts.title;
    if (opts.status !== undefined) update.status = opts.status;
    if (opts.agentSnapshot !== undefined) update.agentSnapshot = opts.agentSnapshot;
    if (opts.environmentSnapshot !== undefined) update.environmentSnapshot = opts.environmentSnapshot;
    if (opts.metadata !== undefined) {
      update.metadata = mergeMetadata(existing.metadata, opts.metadata);
    }
    return this.repo.update(opts.tenantId, opts.sessionId, update);
  }

  /** Just status — convenience for the SessionDO write-back path. */
  async updateStatus(opts: {
    tenantId: string;
    sessionId: string;
    status: SessionStatus;
  }): Promise<SessionRow> {
    await this.requireSession(opts);
    return this.repo.update(opts.tenantId, opts.sessionId, {
      status: opts.status,
      updatedAt: this.clock.nowMs(),
    });
  }

  async archive(opts: { tenantId: string; sessionId: string }): Promise<SessionRow> {
    await this.requireSession(opts);
    return this.repo.archive(opts.tenantId, opts.sessionId, this.clock.nowMs());
  }

  /**
   * Hard-delete the session + cascade its session_resources in one batch.
   * Caller is responsible for: secret KV cleanup, sandbox destroy, sidx
   * cleanup. Service stays out of those because they live in different
   * subsystems (KV, sandbox binding) and would tangle ports.
   */
  async delete(opts: { tenantId: string; sessionId: string }): Promise<void> {
    await this.requireSession(opts);
    await this.repo.deleteWithResources(opts.tenantId, opts.sessionId);
  }

  /**
   * Cascade-delete every session for an agent (and all their resources). Used
   * by the agent-delete safety path: callers should first call
   * `hasActiveByAgent` to refuse if any session is still active, then either
   * archive remaining sessions OR call this to wipe everything.
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
    sessionId: string;
  }): Promise<SessionRow | null> {
    return this.repo.get(opts.tenantId, opts.sessionId);
  }

  /** Cross-tenant lookup by session id — replaces the `sidx:` reverse-index
   *  pattern in internal.ts:381-409. Returns the row including its tenant_id
   *  so internal endpoints can authorize downstream calls. */
  async getById(opts: { sessionId: string }): Promise<SessionRow | null> {
    return this.repo.getById(opts.sessionId);
  }

  async list(opts: {
    tenantId: string;
    agentId?: string;
    includeArchived?: boolean;
    order?: "asc" | "desc";
    limit?: number;
  }): Promise<SessionRow[]> {
    const listOpts: SessionListOptions = {
      agentId: opts.agentId,
      includeArchived: opts.includeArchived ?? false,
      order: opts.order ?? "desc",
      limit: opts.limit ?? 100,
    };
    return this.repo.list(opts.tenantId, listOpts);
  }

  /** Cursor-paginated list. Order: created_at DESC, id DESC tie-break.
   *  Optional `agentId` narrows to one agent's sessions. */
  async listPage(opts: {
    tenantId: string;
    agentId?: string;
    includeArchived?: boolean;
    limit?: number;
    cursor?: string;
  }): Promise<{ items: SessionRow[]; nextCursor?: string }> {
    return paginateVia({
      cursor: opts.cursor,
      limit: opts.limit,
      fetch: (after, limit) =>
        this.repo.listPage(opts.tenantId, {
          agentId: opts.agentId,
          includeArchived: opts.includeArchived ?? false,
          limit,
          after,
        }),
      extractCursor: (r) => ({
        createdAt: new Date(r.created_at).getTime(),
        id: r.id,
      }),
    });
  }

  /** Agent-delete safety check: refuse if any active session in the tenant
   *  references this agent. Replaces the agents.ts:340-348 KV list+filter. */
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
  // Resource ops
  // ============================================================

  /**
   * Add a resource to an existing session. Enforces the per-session count cap
   * (100) and the memory_store sub-cap (8). Refuses on archived sessions
   * (consistency with the events route's archived-session block).
   */
  async addResource(opts: {
    tenantId: string;
    sessionId: string;
    resource: NewResourceInput;
  }): Promise<SessionResourceRow> {
    const session = await this.requireSession(opts);
    if (session.archived_at) throw new SessionArchivedError();

    const total = await this.repo.countResources(opts.sessionId);
    if (total >= MAX_RESOURCES_PER_SESSION) {
      throw new SessionResourceMaxExceededError(MAX_RESOURCES_PER_SESSION);
    }
    if (opts.resource.type === "memory_store") {
      const memCount = await this.repo.countResourcesByType(opts.sessionId, "memory_store");
      if (memCount >= MAX_MEMORY_STORE_RESOURCES_PER_SESSION) {
        throw new SessionMemoryStoreMaxExceededError(MAX_MEMORY_STORE_RESOURCES_PER_SESSION);
      }
    }
    const resourceId = this.ids.resourceId();
    const createdAt = this.clock.nowMs();
    return this.repo.insertResource({
      id: resourceId,
      sessionId: opts.sessionId,
      createdAt,
      resource: {
        ...(opts.resource as SessionResource),
        id: resourceId,
        session_id: opts.sessionId,
        created_at: new Date(createdAt).toISOString(),
      },
    });
  }

  async listResources(opts: {
    tenantId: string;
    sessionId: string;
  }): Promise<SessionResourceRow[]> {
    await this.requireSession(opts);
    return this.repo.listResources(opts.sessionId);
  }

  /**
   * Untenanted resource list — used by SessionDO at warmup, where the DO
   * already trusts its own state's tenant_id. Lets the DO skip the
   * session-existence round-trip when it just needs the resource snapshot.
   */
  async listResourcesBySession(opts: {
    sessionId: string;
  }): Promise<SessionResourceRow[]> {
    return this.repo.listResources(opts.sessionId);
  }

  async getResource(opts: {
    tenantId: string;
    sessionId: string;
    resourceId: string;
  }): Promise<SessionResourceRow | null> {
    await this.requireSession(opts);
    return this.repo.getResource(opts.sessionId, opts.resourceId);
  }

  async deleteResource(opts: {
    tenantId: string;
    sessionId: string;
    resourceId: string;
  }): Promise<void> {
    await this.requireSession(opts);
    const existing = await this.repo.getResource(opts.sessionId, opts.resourceId);
    if (!existing) throw new SessionResourceNotFoundError();
    await this.repo.deleteResource(opts.sessionId, opts.resourceId);
  }

  /** Indexed COUNT for sessions.ts:853 quota check (called before a memory_store add). */
  async countActiveResources(opts: {
    sessionId: string;
  }): Promise<number> {
    return this.repo.countResources(opts.sessionId);
  }

  // ============================================================
  // Internals
  // ============================================================

  private async requireSession(opts: {
    tenantId: string;
    sessionId: string;
  }): Promise<SessionRow> {
    const row = await this.repo.get(opts.tenantId, opts.sessionId);
    if (!row) throw new SessionNotFoundError();
    return row;
  }
}

// ============================================================
// Helpers
// ============================================================

/**
 * Per-key merge: pass `{ a: 1, b: null }` to set `a=1` and delete `b`. Mirrors
 * the legacy KV behavior in sessions.ts:489-498. `existing` may be null (no
 * prior metadata) — treated as an empty object.
 */
function mergeMetadata(
  existing: Record<string, unknown> | null,
  patch: Record<string, unknown>,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = { ...(existing ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key];
    } else {
      out[key] = value;
    }
  }
  return Object.keys(out).length === 0 ? null : out;
}

// ============================================================
// Default infra
// ============================================================

const defaultClock: Clock = { nowMs: () => Date.now() };

const defaultIds: IdGenerator = {
  sessionId: generateSessionId,
  resourceId: generateResourceId,
};

const consoleLogger: Logger = { warn: (msg, ctx) => console.warn(msg, ctx) };
