// Abstract ports the SessionService depends on. Same DIP pattern as
// packages/credentials-store/src/ports.ts — concrete adapters in src/adapters/
// implement these against Cloudflare bindings; src/test-fakes.ts provides
// in-memory implementations.
//
// Keep these tiny and runtime-agnostic: no Cloudflare types, no D1 query
// language. Pass plain data + return plain data. The schema is no-FK by
// project convention; cascade-by-{session, agent} lives in this port so
// adapters and the in-memory fake share one canonical implementation.

import type {
  AgentConfig,
  EnvironmentConfig,
  PageCursor,
  SessionResource,
  SessionStatus,
} from "@open-managed-agents/shared";
import type { SessionResourceRow, SessionRow } from "./types";

export interface NewSessionInput {
  id: string;
  tenantId: string;
  agentId: string;
  environmentId: string;
  title: string;
  status: SessionStatus;
  vaultIds: string[] | null;
  agentSnapshot: AgentConfig | null;
  environmentSnapshot: EnvironmentConfig | null;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

/** Resource payload going IN to insert — id + created_at + session_id come from the service. */
export interface NewSessionResourceInput {
  id: string;
  sessionId: string;
  /** Full SessionResource shape — id/session_id/created_at fields will be overwritten. */
  resource: SessionResource;
  createdAt: number;
}

export interface SessionUpdateFields {
  title?: string;
  status?: SessionStatus;
  /**
   * Full metadata replacement after the service merges with existing.
   * Pass `null` to clear, omit to leave untouched. The service handles per-key
   * merge semantics (per sessions.ts:489-498).
   */
  metadata?: Record<string, unknown> | null;
  agentSnapshot?: AgentConfig | null;
  environmentSnapshot?: EnvironmentConfig | null;
  updatedAt: number;
}

export interface SessionListOptions {
  /** Optional agent filter — uses indexed (tenant_id, agent_id) path. */
  agentId?: string;
  /** Whether to include rows with archived_at != NULL. */
  includeArchived: boolean;
  /** Sort by created_at — desc matches the GET list default (sessions.ts:393). */
  order: "asc" | "desc";
  /** Hard cap on returned rows. Adapter clamps to schema-defined max. */
  limit: number;
}

export interface SessionRepo {
  /**
   * Atomic create: session row + 0..N initial resource rows in one batch.
   * Replaces the multi-key non-atomic KV pattern (sessions.ts:285/328/342/363/375).
   */
  insertWithResources(
    session: NewSessionInput,
    resources: NewSessionResourceInput[],
  ): Promise<{ session: SessionRow; resources: SessionResourceRow[] }>;

  get(tenantId: string, sessionId: string): Promise<SessionRow | null>;

  /**
   * Cross-tenant lookup by id — replaces the `sidx:` reverse-index pattern
   * (internal.ts:381-409). `id` is globally unique so a direct WHERE id = ?
   * is O(1).
   */
  getById(sessionId: string): Promise<SessionRow | null>;

  list(tenantId: string, opts: SessionListOptions): Promise<SessionRow[]>;

  /**
   * Cursor-paginated list. Order: created_at DESC, id DESC tie-break (the
   * typical newest-first UI). Optional `agentId` filter narrows by indexed
   * column. The legacy `list` ASC option isn't carried forward — DESC is
   * the only paginated order; clients that want ASC can fetch + reverse.
   */
  listPage(
    tenantId: string,
    opts: {
      agentId?: string;
      includeArchived: boolean;
      limit: number;
      after?: PageCursor;
    },
  ): Promise<{ items: SessionRow[]; hasMore: boolean }>;

  /** Returns true if any non-archived session in the tenant references this agent. */
  hasActiveByAgent(tenantId: string, agentId: string): Promise<boolean>;

  /** Returns true if any non-archived session in the tenant references this environment. */
  hasActiveByEnvironment(tenantId: string, environmentId: string): Promise<boolean>;

  update(
    tenantId: string,
    sessionId: string,
    update: SessionUpdateFields,
  ): Promise<SessionRow>;

  archive(tenantId: string, sessionId: string, archivedAt: number): Promise<SessionRow>;

  /** Hard-delete a session AND cascade-delete its session_resources in one batch. */
  deleteWithResources(tenantId: string, sessionId: string): Promise<void>;

  /**
   * Cascade hard-delete every session for an agent (and all their resources).
   * Replaces the KV list+filter loop in agents.ts:340-348 / cleanup paths.
   * Returns the count of sessions deleted (so callers can log + emit metrics).
   */
  deleteByAgent(tenantId: string, agentId: string): Promise<number>;

  // ── session_resources operations ──

  insertResource(input: NewSessionResourceInput): Promise<SessionResourceRow>;

  /** Fetch a single resource. Tenant ownership is verified at the service layer
   * via a session lookup; the resource row carries no tenant_id by design (it
   * inherits from session_id). */
  getResource(sessionId: string, resourceId: string): Promise<SessionResourceRow | null>;

  listResources(sessionId: string): Promise<SessionResourceRow[]>;

  countResources(sessionId: string): Promise<number>;

  /** Per-type count for the memory_store quota check (sessions.ts:884-895). */
  countResourcesByType(sessionId: string, type: SessionResource["type"]): Promise<number>;

  deleteResource(sessionId: string, resourceId: string): Promise<void>;

  /** Replace the resource JSON column. The resource id and session id stay
   *  immutable; the rest of the SessionResource payload is overwritten with
   *  what the caller passes. AMA models PATCH /resources/:id as a body
   *  replacement on the SessionResource shape. */
  updateResource(
    sessionId: string,
    resourceId: string,
    resource: SessionResource,
  ): Promise<SessionResourceRow>;

  /** Wipe every resource for a session — used by /destroy paths and tests. */
  deleteAllResourcesForSession(sessionId: string): Promise<void>;
}

export interface Clock {
  nowMs(): number;
}

export interface IdGenerator {
  sessionId(): string;
  resourceId(): string;
}

export interface Logger {
  warn(msg: string, ctx?: unknown): void;
}
