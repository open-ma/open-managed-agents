import type {
  SessionScope,
  SessionScopeRepo,
  SessionScopeStatus,
} from "@open-managed-agents/integrations-core";

interface Row {
  publication_id: string;
  scope_key: string;
  session_id: string;
  status: string;
  created_at: number;
}

/**
 * D1 session-scope repo for Slack. Table `slack_thread_sessions`. The
 * scope_key column stores `${channel_id}:${thread_ts ?? event_ts}` — the
 * provider composes it before calling getByScope/insert.
 */
export class D1SlackSessionScopeRepo implements SessionScopeRepo {
  constructor(private readonly db: D1Database) {}

  async getByScope(publicationId: string, scopeKey: string): Promise<SessionScope | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM slack_thread_sessions
         WHERE publication_id = ? AND scope_key = ?`,
      )
      .bind(publicationId, scopeKey)
      .first<Row>();
    return row ? this.toDomain(row) : null;
  }

  async insert(row: SessionScope): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO slack_thread_sessions
           (publication_id, scope_key, session_id, status, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(row.publicationId, row.scopeKey, row.sessionId, row.status, row.createdAt)
      .run();
  }

  async updateStatus(
    publicationId: string,
    scopeKey: string,
    status: SessionScopeStatus,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE slack_thread_sessions SET status = ?
         WHERE publication_id = ? AND scope_key = ?`,
      )
      .bind(status, publicationId, scopeKey)
      .run();
  }

  async listActive(publicationId: string): Promise<readonly SessionScope[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM slack_thread_sessions
         WHERE publication_id = ? AND status = 'active'`,
      )
      .bind(publicationId)
      .all<Row>();
    return (results ?? []).map((r) => this.toDomain(r));
  }

  private toDomain(row: Row): SessionScope {
    return {
      publicationId: row.publication_id,
      scopeKey: row.scope_key,
      sessionId: row.session_id,
      status: row.status as SessionScopeStatus,
      createdAt: row.created_at,
    };
  }
}
