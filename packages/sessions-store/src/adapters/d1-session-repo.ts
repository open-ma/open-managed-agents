import type {
  AgentConfig,
  EnvironmentConfig,
  PageCursor,
  SessionResource,
  SessionStatus,
} from "@open-managed-agents/shared";
import {
  cursorBinds,
  cursorWhereSql,
  fetchN,
  trimPage,
} from "@open-managed-agents/shared";
import { SessionNotFoundError } from "../errors";
import type {
  NewSessionInput,
  NewSessionResourceInput,
  SessionListOptions,
  SessionRepo,
  SessionUpdateFields,
} from "../ports";
import type { SessionResourceRow, SessionRow } from "../types";

/**
 * Cloudflare D1 implementation of {@link SessionRepo}. Owns the SQL against
 * the `sessions` and `session_resources` tables defined in
 * apps/main/migrations/0010_sessions_tables.sql.
 *
 * Atomicity:
 *   - insertWithResources uses D1.batch so a session row + N resource rows
 *     succeed-or-fail together (replaces the multi-key non-atomic KV pattern).
 *   - deleteWithResources uses D1.batch to drop the session + cascade its
 *     resources (the schema has no FK by project convention).
 *   - deleteByAgent uses two statements — list all session ids for the agent,
 *     then DELETE both tables — wrapped in batch.
 */
export class D1SessionRepo implements SessionRepo {
  constructor(private readonly db: D1Database) {}

  async insertWithResources(
    session: NewSessionInput,
    resources: NewSessionResourceInput[],
  ): Promise<{ session: SessionRow; resources: SessionResourceRow[] }> {
    const stmts: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT INTO sessions
             (id, tenant_id, agent_id, environment_id, title, status,
              vault_ids, agent_snapshot, environment_snapshot, metadata,
              created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          session.id,
          session.tenantId,
          session.agentId,
          session.environmentId,
          session.title,
          session.status,
          session.vaultIds !== null ? JSON.stringify(session.vaultIds) : null,
          session.agentSnapshot !== null ? JSON.stringify(session.agentSnapshot) : null,
          session.environmentSnapshot !== null ? JSON.stringify(session.environmentSnapshot) : null,
          session.metadata !== null ? JSON.stringify(session.metadata) : null,
          session.createdAt,
        ),
    ];
    for (const r of resources) {
      stmts.push(resourceInsertStmt(this.db, r));
    }
    await this.db.batch(stmts);

    const inserted = await this.get(session.tenantId, session.id);
    if (!inserted) throw new Error("session vanished after insertWithResources");
    const insertedResources = resources.length
      ? await this.listResources(session.id)
      : [];
    return { session: inserted, resources: insertedResources };
  }

  async get(tenantId: string, sessionId: string): Promise<SessionRow | null> {
    const row = await this.db
      .prepare(
        `SELECT id, tenant_id, agent_id, environment_id, title, status,
                vault_ids, agent_snapshot, environment_snapshot, metadata,
                created_at, updated_at, archived_at
         FROM sessions
         WHERE id = ? AND tenant_id = ?`,
      )
      .bind(sessionId, tenantId)
      .first<DbSession>();
    return row ? toSessionRow(row) : null;
  }

  async getById(sessionId: string): Promise<SessionRow | null> {
    const row = await this.db
      .prepare(
        `SELECT id, tenant_id, agent_id, environment_id, title, status,
                vault_ids, agent_snapshot, environment_snapshot, metadata,
                created_at, updated_at, archived_at
         FROM sessions
         WHERE id = ?`,
      )
      .bind(sessionId)
      .first<DbSession>();
    return row ? toSessionRow(row) : null;
  }

  async list(tenantId: string, opts: SessionListOptions): Promise<SessionRow[]> {
    const order = opts.order === "asc" ? "ASC" : "DESC";
    const where: string[] = ["tenant_id = ?"];
    const binds: unknown[] = [tenantId];
    if (opts.agentId) {
      where.push("agent_id = ?");
      binds.push(opts.agentId);
    }
    if (!opts.includeArchived) {
      where.push("archived_at IS NULL");
    }
    binds.push(opts.limit);
    const sql = `SELECT id, tenant_id, agent_id, environment_id, title, status,
                        vault_ids, agent_snapshot, environment_snapshot, metadata,
                        created_at, updated_at, archived_at
                 FROM sessions
                 WHERE ${where.join(" AND ")}
                 ORDER BY created_at ${order}
                 LIMIT ?`;
    const result = await this.db.prepare(sql).bind(...binds).all<DbSession>();
    return (result.results ?? []).map(toSessionRow);
  }

  async listPage(
    tenantId: string,
    opts: {
      agentId?: string;
      includeArchived: boolean;
      limit: number;
      after?: PageCursor;
    },
  ): Promise<{ items: SessionRow[]; hasMore: boolean }> {
    const where: string[] = ["tenant_id = ?"];
    const binds: unknown[] = [tenantId];
    if (opts.agentId) {
      where.push("agent_id = ?");
      binds.push(opts.agentId);
    }
    if (!opts.includeArchived) where.push("archived_at IS NULL");
    const cursorClause = cursorWhereSql(opts.after);
    if (cursorClause) {
      // cursorWhereSql returns "AND (...)" — strip the leading AND since
      // we're joining via " AND " in the WHERE composer.
      where.push(cursorClause.replace(/^AND\s+/, ""));
      binds.push(...cursorBinds(opts.after));
    }
    binds.push(fetchN(opts.limit));
    const sql = `SELECT id, tenant_id, agent_id, environment_id, title, status,
                        vault_ids, agent_snapshot, environment_snapshot, metadata,
                        created_at, updated_at, archived_at
                 FROM sessions
                 WHERE ${where.join(" AND ")}
                 ORDER BY created_at DESC, id DESC
                 LIMIT ?`;
    const result = await this.db.prepare(sql).bind(...binds).all<DbSession>();
    return trimPage((result.results ?? []).map(toSessionRow), opts.limit);
  }

  async hasActiveByAgent(tenantId: string, agentId: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS one FROM sessions
         WHERE tenant_id = ? AND agent_id = ? AND archived_at IS NULL
         LIMIT 1`,
      )
      .bind(tenantId, agentId)
      .first<{ one: number }>();
    return !!row;
  }

  async hasActiveByEnvironment(
    tenantId: string,
    environmentId: string,
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS one FROM sessions
         WHERE tenant_id = ? AND environment_id = ? AND archived_at IS NULL
         LIMIT 1`,
      )
      .bind(tenantId, environmentId)
      .first<{ one: number }>();
    return !!row;
  }

  async update(
    tenantId: string,
    sessionId: string,
    update: SessionUpdateFields,
  ): Promise<SessionRow> {
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (update.title !== undefined) {
      sets.push("title = ?");
      binds.push(update.title);
    }
    if (update.status !== undefined) {
      sets.push("status = ?");
      binds.push(update.status);
    }
    if (update.metadata !== undefined) {
      sets.push("metadata = ?");
      binds.push(update.metadata !== null ? JSON.stringify(update.metadata) : null);
    }
    if (update.agentSnapshot !== undefined) {
      sets.push("agent_snapshot = ?");
      binds.push(update.agentSnapshot !== null ? JSON.stringify(update.agentSnapshot) : null);
    }
    if (update.environmentSnapshot !== undefined) {
      sets.push("environment_snapshot = ?");
      binds.push(
        update.environmentSnapshot !== null
          ? JSON.stringify(update.environmentSnapshot)
          : null,
      );
    }
    sets.push("updated_at = ?");
    binds.push(update.updatedAt);
    binds.push(sessionId, tenantId);

    const result = await this.db
      .prepare(
        `UPDATE sessions SET ${sets.join(", ")}
         WHERE id = ? AND tenant_id = ?`,
      )
      .bind(...binds)
      .run();
    if (!result.meta?.changes) throw new SessionNotFoundError();
    const row = await this.get(tenantId, sessionId);
    if (!row) throw new SessionNotFoundError();
    return row;
  }

  async archive(
    tenantId: string,
    sessionId: string,
    archivedAt: number,
  ): Promise<SessionRow> {
    const result = await this.db
      .prepare(
        `UPDATE sessions SET archived_at = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ?`,
      )
      .bind(archivedAt, archivedAt, sessionId, tenantId)
      .run();
    if (!result.meta?.changes) throw new SessionNotFoundError();
    const row = await this.get(tenantId, sessionId);
    if (!row) throw new SessionNotFoundError();
    return row;
  }

  async deleteWithResources(tenantId: string, sessionId: string): Promise<void> {
    // Two-statement batch: drop resources first then the session row. Atomic
    // by D1 batch semantics. No FK needed.
    await this.db.batch([
      this.db
        .prepare(`DELETE FROM session_resources WHERE session_id = ?`)
        .bind(sessionId),
      this.db
        .prepare(`DELETE FROM sessions WHERE id = ? AND tenant_id = ?`)
        .bind(sessionId, tenantId),
    ]);
  }

  async deleteByAgent(tenantId: string, agentId: string): Promise<number> {
    // Discover session ids first so the resource cascade hits the right rows
    // and so the caller gets a deletion count. One round-trip then a 2-stmt
    // batch.
    const ids = await this.db
      .prepare(`SELECT id FROM sessions WHERE tenant_id = ? AND agent_id = ?`)
      .bind(tenantId, agentId)
      .all<{ id: string }>();
    const sessionIds = (ids.results ?? []).map((r) => r.id);
    if (!sessionIds.length) return 0;

    const placeholders = sessionIds.map(() => "?").join(", ");
    await this.db.batch([
      this.db
        .prepare(`DELETE FROM session_resources WHERE session_id IN (${placeholders})`)
        .bind(...sessionIds),
      this.db
        .prepare(`DELETE FROM sessions WHERE tenant_id = ? AND agent_id = ?`)
        .bind(tenantId, agentId),
    ]);
    return sessionIds.length;
  }

  // ── resource ops ──

  async insertResource(input: NewSessionResourceInput): Promise<SessionResourceRow> {
    await resourceInsertStmt(this.db, input).run();
    const row = await this.getResource(input.sessionId, input.id);
    if (!row) throw new Error("resource vanished after insert");
    return row;
  }

  async getResource(
    sessionId: string,
    resourceId: string,
  ): Promise<SessionResourceRow | null> {
    const row = await this.db
      .prepare(
        `SELECT id, session_id, type, config, created_at
         FROM session_resources
         WHERE id = ? AND session_id = ?`,
      )
      .bind(resourceId, sessionId)
      .first<DbResource>();
    return row ? toResourceRow(row) : null;
  }

  async listResources(sessionId: string): Promise<SessionResourceRow[]> {
    const result = await this.db
      .prepare(
        `SELECT id, session_id, type, config, created_at
         FROM session_resources
         WHERE session_id = ?
         ORDER BY created_at ASC`,
      )
      .bind(sessionId)
      .all<DbResource>();
    return (result.results ?? []).map(toResourceRow);
  }

  async countResources(sessionId: string): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS c FROM session_resources WHERE session_id = ?`)
      .bind(sessionId)
      .first<{ c: number }>();
    return row?.c ?? 0;
  }

  async countResourcesByType(
    sessionId: string,
    type: SessionResource["type"],
  ): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM session_resources WHERE session_id = ? AND type = ?`,
      )
      .bind(sessionId, type)
      .first<{ c: number }>();
    return row?.c ?? 0;
  }

  async deleteResource(sessionId: string, resourceId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM session_resources WHERE id = ? AND session_id = ?`)
      .bind(resourceId, sessionId)
      .run();
  }

  async deleteAllResourcesForSession(sessionId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM session_resources WHERE session_id = ?`)
      .bind(sessionId)
      .run();
  }
}

function resourceInsertStmt(
  db: D1Database,
  r: NewSessionResourceInput,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO session_resources (id, session_id, type, config, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(r.id, r.sessionId, r.resource.type, JSON.stringify(r.resource), r.createdAt);
}

interface DbSession {
  id: string;
  tenant_id: string;
  agent_id: string;
  environment_id: string;
  title: string;
  status: string;
  vault_ids: string | null;
  agent_snapshot: string | null;
  environment_snapshot: string | null;
  metadata: string | null;
  created_at: number;
  updated_at: number | null;
  archived_at: number | null;
}

interface DbResource {
  id: string;
  session_id: string;
  type: string;
  config: string;
  created_at: number;
}

function toSessionRow(r: DbSession): SessionRow {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    agent_id: r.agent_id,
    environment_id: r.environment_id,
    title: r.title,
    status: r.status as SessionStatus,
    vault_ids: r.vault_ids !== null ? (JSON.parse(r.vault_ids) as string[]) : null,
    agent_snapshot:
      r.agent_snapshot !== null ? (JSON.parse(r.agent_snapshot) as AgentConfig) : null,
    environment_snapshot:
      r.environment_snapshot !== null
        ? (JSON.parse(r.environment_snapshot) as EnvironmentConfig)
        : null,
    metadata:
      r.metadata !== null
        ? (JSON.parse(r.metadata) as Record<string, unknown>)
        : null,
    created_at: msToIso(r.created_at),
    updated_at: r.updated_at !== null ? msToIso(r.updated_at) : null,
    archived_at: r.archived_at !== null ? msToIso(r.archived_at) : null,
  };
}

function toResourceRow(r: DbResource): SessionResourceRow {
  const parsed = JSON.parse(r.config) as SessionResource;
  return {
    id: r.id,
    session_id: r.session_id,
    type: r.type as SessionResource["type"],
    resource: parsed,
    created_at: msToIso(r.created_at),
  };
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}
