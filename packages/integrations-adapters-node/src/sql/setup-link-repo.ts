import type { SqlClient } from "@open-managed-agents/sql-client";

import type {
  IdGenerator,
  NewSetupLink,
  SetupLink,
  SetupLinkRepo,
} from "@open-managed-agents/integrations-core";

interface Row {
  token: string;
  tenant_id: string;
  publication_id: string;
  created_by: string;
  expires_at: number;
  used_at: number | null;
  used_by_email: string | null;
}

export class SqlSetupLinkRepo implements SetupLinkRepo {
  constructor(
    private readonly db: SqlClient,
    private readonly ids: IdGenerator,
  ) {}

  async get(token: string): Promise<SetupLink | null> {
    const row = await this.db
      .prepare(`SELECT * FROM linear_setup_links WHERE token = ?`)
      .bind(token)
      .first<Row>();
    return row ? this.toDomain(row) : null;
  }

  async insert(row: NewSetupLink): Promise<SetupLink> {
    // 32 bytes of entropy, hex-encoded → 64 char URL-safe token.
    const token = this.ids.generate();
    await this.db
      .prepare(
        `INSERT INTO linear_setup_links
           (token, tenant_id, publication_id, created_by, expires_at, used_at, used_by_email)
         VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .bind(token, row.tenantId, row.publicationId, row.createdBy, row.expiresAt)
      .run();
    return {
      token,
      tenantId: row.tenantId,
      publicationId: row.publicationId,
      createdBy: row.createdBy,
      expiresAt: row.expiresAt,
      usedAt: null,
      usedByEmail: null,
    };
  }

  async markUsed(token: string, usedByEmail: string, usedAt: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE linear_setup_links SET used_at = ?, used_by_email = ? WHERE token = ?`,
      )
      .bind(usedAt, usedByEmail, token)
      .run();
  }

  async deleteExpired(now: number): Promise<number> {
    const result = await this.db
      .prepare(`DELETE FROM linear_setup_links WHERE expires_at < ?`)
      .bind(now)
      .run();
    return result.meta?.changes ?? 0;
  }

  private toDomain(row: Row): SetupLink {
    return {
      token: row.token,
      tenantId: row.tenant_id,
      publicationId: row.publication_id,
      createdBy: row.created_by,
      expiresAt: row.expires_at,
      usedAt: row.used_at,
      usedByEmail: row.used_by_email,
    };
  }
}
