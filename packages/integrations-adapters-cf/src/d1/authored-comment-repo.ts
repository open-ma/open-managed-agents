import type { AuthoredComment, AuthoredCommentRepo } from "@open-managed-agents/integrations-core";

interface Row {
  comment_id: string;
  oma_session_id: string;
  issue_id: string;
  created_at: number;
}

export class D1AuthoredCommentRepo implements AuthoredCommentRepo {
  constructor(private readonly db: D1Database) {}

  async get(commentId: string): Promise<AuthoredComment | null> {
    const row = await this.db
      .prepare(`SELECT * FROM linear_authored_comments WHERE comment_id = ?`)
      .bind(commentId)
      .first<Row>();
    return row ? this.toDomain(row) : null;
  }

  async insert(row: AuthoredComment): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO linear_authored_comments
           (comment_id, oma_session_id, issue_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(row.commentId, row.omaSessionId, row.issueId, row.createdAt)
      .run();
  }

  private toDomain(row: Row): AuthoredComment {
    return {
      commentId: row.comment_id,
      omaSessionId: row.oma_session_id,
      issueId: row.issue_id,
      createdAt: row.created_at,
    };
  }
}
