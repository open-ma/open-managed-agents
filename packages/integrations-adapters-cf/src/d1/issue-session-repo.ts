import type {
  IssueSession,
  IssueSessionRepo,
  IssueSessionStatus,
} from "@open-managed-agents/integrations-core";

interface Row {
  publication_id: string;
  issue_id: string;
  session_id: string;
  status: string;
  created_at: number;
}

export class D1IssueSessionRepo implements IssueSessionRepo {
  constructor(private readonly db: D1Database) {}

  async getByIssue(publicationId: string, issueId: string): Promise<IssueSession | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM linear_issue_sessions
         WHERE publication_id = ? AND issue_id = ?`,
      )
      .bind(publicationId, issueId)
      .first<Row>();
    return row ? this.toDomain(row) : null;
  }

  async insert(row: IssueSession): Promise<void> {
    // UPSERT: per_issue mode reuses an existing row when re-delegated.
    // Without ON CONFLICT we 500 when a stale (status='inactive') row from
    // a prior delegation still occupies (publication_id, issue_id), which
    // is the natural state between the previous session ending and this
    // webhook arriving. excluded.* is SQLite syntax for the new VALUES.
    await this.db
      .prepare(
        `INSERT INTO linear_issue_sessions
           (publication_id, issue_id, session_id, status, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(publication_id, issue_id) DO UPDATE SET
           session_id = excluded.session_id,
           status     = excluded.status,
           created_at = excluded.created_at`,
      )
      .bind(row.publicationId, row.issueId, row.sessionId, row.status, row.createdAt)
      .run();
  }

  async updateStatus(
    publicationId: string,
    issueId: string,
    status: IssueSessionStatus,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE linear_issue_sessions SET status = ?
         WHERE publication_id = ? AND issue_id = ?`,
      )
      .bind(status, publicationId, issueId)
      .run();
  }

  async listActive(publicationId: string): Promise<readonly IssueSession[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM linear_issue_sessions
         WHERE publication_id = ? AND status = 'active'`,
      )
      .bind(publicationId)
      .all<Row>();
    return (results ?? []).map((r) => this.toDomain(r));
  }

  private toDomain(row: Row): IssueSession {
    return {
      publicationId: row.publication_id,
      issueId: row.issue_id,
      sessionId: row.session_id,
      status: row.status as IssueSessionStatus,
      createdAt: row.created_at,
    };
  }
}
