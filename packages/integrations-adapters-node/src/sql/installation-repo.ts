import type { SqlClient } from "@open-managed-agents/sql-client";

import type {
  Crypto,
  IdGenerator,
  Installation,
  InstallationRepo,
  InstallKind,
  NewInstallation,
  ProviderId,
  WorkspaceId,
} from "@open-managed-agents/integrations-core";

interface Row {
  id: string;
  tenant_id: string;
  user_id: string;
  provider_id: string;
  workspace_id: string;
  workspace_name: string;
  install_kind: string;
  app_id: string | null;
  access_token_cipher: string;
  refresh_token_cipher: string | null;
  scopes: string;
  bot_user_id: string;
  vault_id: string | null;
  created_at: number;
  revoked_at: number | null;
}

export class SqlInstallationRepo implements InstallationRepo {
  constructor(
    private readonly db: SqlClient,
    private readonly crypto: Crypto,
    private readonly ids: IdGenerator,
  ) {}

  async get(id: string): Promise<Installation | null> {
    const row = await this.db
      .prepare(`SELECT * FROM linear_installations WHERE id = ?`)
      .bind(id)
      .first<Row>();
    return row ? this.toDomain(row) : null;
  }

  async findByWorkspace(
    providerId: ProviderId,
    workspaceId: WorkspaceId,
    installKind: InstallKind,
    appId: string | null,
  ): Promise<Installation | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM linear_installations
         WHERE provider_id = ? AND workspace_id = ? AND install_kind = ?
           AND COALESCE(app_id, '') = COALESCE(?, '') AND revoked_at IS NULL
         LIMIT 1`,
      )
      .bind(providerId, workspaceId, installKind, appId)
      .first<Row>();
    return row ? this.toDomain(row) : null;
  }

  async listByUser(
    userId: string,
    providerId: ProviderId,
  ): Promise<readonly Installation[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM linear_installations
         WHERE user_id = ? AND provider_id = ? AND revoked_at IS NULL
         ORDER BY created_at DESC`,
      )
      .bind(userId, providerId)
      .all<Row>();
    return (results ?? []).map((r) => this.toDomain(r));
  }

  async getAccessToken(id: string): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT access_token_cipher FROM linear_installations
         WHERE id = ? AND revoked_at IS NULL`,
      )
      .bind(id)
      .first<{ access_token_cipher: string }>();
    if (!row) return null;
    return this.crypto.decrypt(row.access_token_cipher);
  }

  async getRefreshToken(id: string): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT refresh_token_cipher FROM linear_installations
         WHERE id = ? AND revoked_at IS NULL`,
      )
      .bind(id)
      .first<{ refresh_token_cipher: string | null }>();
    if (!row || !row.refresh_token_cipher) return null;
    return this.crypto.decrypt(row.refresh_token_cipher);
  }

  async setTokens(
    id: string,
    accessToken: string,
    refreshToken: string | null,
  ): Promise<void> {
    const accessCipher = await this.crypto.encrypt(accessToken);
    if (refreshToken === null) {
      // Leave the existing refresh row untouched. Linear actually rotates the
      // refresh token on every refresh — callers should pass it through — so
      // this branch only fires when upstream genuinely omitted it.
      await this.db
        .prepare(`UPDATE linear_installations SET access_token_cipher = ? WHERE id = ?`)
        .bind(accessCipher, id)
        .run();
      return;
    }
    const refreshCipher = await this.crypto.encrypt(refreshToken);
    await this.db
      .prepare(
        `UPDATE linear_installations
           SET access_token_cipher = ?, refresh_token_cipher = ?
         WHERE id = ?`,
      )
      .bind(accessCipher, refreshCipher, id)
      .run();
  }

  async insert(row: NewInstallation): Promise<Installation> {
    const id = this.ids.generate();
    const now = Date.now();
    const accessTokenCipher = await this.crypto.encrypt(row.accessToken);
    const refreshTokenCipher = row.refreshToken
      ? await this.crypto.encrypt(row.refreshToken)
      : null;
    await this.db
      .prepare(
        `INSERT INTO linear_installations (
           id, tenant_id, user_id, provider_id, workspace_id, workspace_name,
           install_kind, app_id, access_token_cipher, refresh_token_cipher,
           scopes, bot_user_id, created_at, revoked_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .bind(
        id,
        row.tenantId,
        row.userId,
        row.providerId,
        row.workspaceId,
        row.workspaceName,
        row.installKind,
        row.appId,
        accessTokenCipher,
        refreshTokenCipher,
        JSON.stringify(row.scopes),
        row.botUserId,
        now,
      )
      .run();
    return {
      id,
      tenantId: row.tenantId,
      userId: row.userId,
      providerId: row.providerId,
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceName,
      installKind: row.installKind,
      appId: row.appId,
      botUserId: row.botUserId,
      scopes: row.scopes,
      vaultId: null,
      createdAt: now,
      revokedAt: null,
    };
  }

  async setVaultId(id: string, vaultId: string): Promise<void> {
    await this.db
      .prepare(`UPDATE linear_installations SET vault_id = ? WHERE id = ?`)
      .bind(vaultId, id)
      .run();
  }

  async markRevoked(id: string, at: number): Promise<void> {
    await this.db
      .prepare(`UPDATE linear_installations SET revoked_at = ? WHERE id = ?`)
      .bind(at, id)
      .run();
  }

  private toDomain(row: Row): Installation {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      providerId: row.provider_id as ProviderId,
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name,
      installKind: row.install_kind as InstallKind,
      appId: row.app_id,
      botUserId: row.bot_user_id,
      scopes: JSON.parse(row.scopes) as string[],
      vaultId: row.vault_id,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    };
  }
}
