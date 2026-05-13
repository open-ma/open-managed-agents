import type { SqlClient } from "@open-managed-agents/sql-client";

import type {
  IssueSession,
  IssueSessionRepo,
  IssueSessionStatus,
  SessionId,
} from "@open-managed-agents/integrations-core";

interface Row {
  tenant_id: string;
  publication_id: string;
  issue_id: string;
  session_id: string;
  status: string;
  created_at: number;
}

export class SqlIssueSessionRepo implements IssueSessionRepo {
  constructor(private readonly db: SqlClient) {}

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
    // tenant_id is preserved on conflict — re-delegations within the same
    // publication can never change tenant.
    await this.db
      .prepare(
        `INSERT INTO linear_issue_sessions
           (tenant_id, publication_id, issue_id, session_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(publication_id, issue_id) DO UPDATE SET
           session_id = excluded.session_id,
           status     = excluded.status,
           created_at = excluded.created_at`,
      )
      .bind(row.tenantId, row.publicationId, row.issueId, row.sessionId, row.status, row.createdAt)
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
      tenantId: row.tenant_id,
      publicationId: row.publication_id,
      issueId: row.issue_id,
      sessionId: row.session_id,
      status: row.status as IssueSessionStatus,
      createdAt: row.created_at,
    };
  }

  /**
   * PAT-mode atomic claim. We can't use webhooks to dedupe (no app source),
   * so the dispatch sweep MUST hold an exclusive lock on (publication, issue)
   * before calling sessions.create() — otherwise two concurrent ticks both
   * spawn workers for the same issue.
   *
   * Pattern: INSERT new row OR overwrite existing inactive row, atomically.
   * RETURNING tells us whether we actually wrote (= claimed). An existing
   * 'active' row blocks the WHERE on the conflict path, so RETURNING is
   * empty for "someone else already owns this".
   */
  async claim(input: {
    tenantId: string;
    publicationId: string;
    issueId: string;
    sessionId: SessionId;
    nowMs: number;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO linear_issue_sessions
           (tenant_id, publication_id, issue_id, session_id, status, created_at)
         VALUES (?, ?, ?, ?, 'active', ?)
         ON CONFLICT(publication_id, issue_id) DO UPDATE SET
           tenant_id  = excluded.tenant_id,
           session_id = excluded.session_id,
           status     = excluded.status,
           created_at = excluded.created_at
         WHERE linear_issue_sessions.status != 'active'
         RETURNING session_id`,
      )
      .bind(
        input.tenantId,
        input.publicationId,
        input.issueId,
        input.sessionId,
        input.nowMs,
      )
      .first<{ session_id: string }>();
    return result !== null;
  }
}
