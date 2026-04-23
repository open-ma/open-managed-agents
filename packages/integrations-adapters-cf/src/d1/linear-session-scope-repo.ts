import type {
  SessionScope,
  SessionScopeRepo,
  SessionScopeStatus,
} from "@open-managed-agents/integrations-core";

interface Row {
  publication_id: string;
  issue_id: string;
  session_id: string;
  status: string;
  created_at: number;
}

/**
 * D1 session-scope repo for Linear. Table name (`linear_issue_sessions`) and
 * column name (`issue_id`) are kept for migration stability — semantically
 * `issue_id` now stores the generic `scopeKey` (Linear puts its issue id; other
 * providers using this same table layout would put their own per-scope key).
 */
export class D1LinearSessionScopeRepo implements SessionScopeRepo {
  constructor(private readonly db: D1Database) {}

  async getByScope(publicationId: string, scopeKey: string): Promise<SessionScope | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM linear_issue_sessions
         WHERE publication_id = ? AND issue_id = ?`,
      )
      .bind(publicationId, scopeKey)
      .first<Row>();
    return row ? this.toDomain(row) : null;
  }

  async insert(row: SessionScope): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO linear_issue_sessions
           (publication_id, issue_id, session_id, status, created_at)
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
        `UPDATE linear_issue_sessions SET status = ?
         WHERE publication_id = ? AND issue_id = ?`,
      )
      .bind(status, publicationId, scopeKey)
      .run();
  }

  async listActive(publicationId: string): Promise<readonly SessionScope[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM linear_issue_sessions
         WHERE publication_id = ? AND status = 'active'`,
      )
      .bind(publicationId)
      .all<Row>();
    return (results ?? []).map((r) => this.toDomain(r));
  }

  private toDomain(row: Row): SessionScope {
    return {
      publicationId: row.publication_id,
      scopeKey: row.issue_id,
      sessionId: row.session_id,
      status: row.status as SessionScopeStatus,
      createdAt: row.created_at,
    };
  }
}
