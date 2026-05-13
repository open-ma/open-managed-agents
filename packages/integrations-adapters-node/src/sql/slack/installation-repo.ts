import type { SqlClient } from "@open-managed-agents/sql-client";

import type {
  Crypto,
  IdGenerator,
  Installation,
  InstallKind,
  NewInstallation,
  ProviderId,
  WorkspaceId,
} from "@open-managed-agents/integrations-core";
import type { SlackInstallationRepo } from "@open-managed-agents/slack";

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
  user_token_cipher: string | null;
  scopes: string;
  bot_user_id: string;
  vault_id: string | null;
  bot_vault_id: string | null;
  created_at: number;
  revoked_at: number | null;
}

/**
 * D1 installation repo for Slack. Mirrors SqlInstallationRepo but uses
 * `slack_installations` and adds two Slack-only fields: `user_token_cipher`
 * (xoxp- token for mcp.slack.com) and `bot_vault_id` (vault for direct
 * slack.com/api calls). Implements the SlackInstallationRepo extension.
 */
export class SqlSlackInstallationRepo implements SlackInstallationRepo {
  constructor(
    private readonly db: SqlClient,
    private readonly crypto: Crypto,
    private readonly ids: IdGenerator,
  ) {}

  async get(id: string): Promise<Installation | null> {
    const row = await this.db
      .prepare(`SELECT * FROM slack_installations WHERE id = ?`)
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
        `SELECT * FROM slack_installations
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
        `SELECT * FROM slack_installations
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
        `SELECT access_token_cipher FROM slack_installations
         WHERE id = ? AND revoked_at IS NULL`,
      )
      .bind(id)
      .first<{ access_token_cipher: string }>();
    if (!row) return null;
    return this.crypto.decrypt(row.access_token_cipher);
  }

  async getUserToken(id: string): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT user_token_cipher FROM slack_installations
         WHERE id = ? AND revoked_at IS NULL`,
      )
      .bind(id)
      .first<{ user_token_cipher: string | null }>();
    if (!row || !row.user_token_cipher) return null;
    return this.crypto.decrypt(row.user_token_cipher);
  }

  /**
   * Slack xoxb-/xoxp- tokens are long-lived by default; rotation requires the
   * workspace to opt in to Token Rotation (we don't yet store refresh_token
   * for that path — see migration 0006). Always returns null.
   */
  async getRefreshToken(_id: string): Promise<string | null> {
    return null;
  }

  /**
   * Stub for the shared InstallationRepo contract. Slack doesn't rotate the
   * primary bot token via this path; if Token Rotation is added later, this
   * will land here. Throws to make accidental callers loud.
   */
  async setTokens(_id: string, _accessToken: string, _refreshToken: string | null): Promise<void> {
    throw new Error(
      "SqlSlackInstallationRepo.setTokens: Slack tokens are long-lived; rotation not yet supported",
    );
  }

  async insert(row: NewInstallation): Promise<Installation> {
    const id = this.ids.generate();
    const now = Date.now();
    const accessTokenCipher = await this.crypto.encrypt(row.accessToken);
    // Slack xoxb- tokens are long-lived by default; refresh-token rotation is
    // an opt-in workspace setting we don't yet support. NewInstallation.refreshToken
    // (a shared port field) is intentionally ignored here.
    await this.db
      .prepare(
        `INSERT INTO slack_installations (
           id, tenant_id, user_id, provider_id, workspace_id, workspace_name,
           install_kind, app_id, access_token_cipher, user_token_cipher,
           scopes, bot_user_id, created_at, revoked_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)`,
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

  async setUserToken(id: string, userToken: string): Promise<void> {
    const cipher = await this.crypto.encrypt(userToken);
    await this.db
      .prepare(`UPDATE slack_installations SET user_token_cipher = ? WHERE id = ?`)
      .bind(cipher, id)
      .run();
  }

  async setVaultId(id: string, vaultId: string): Promise<void> {
    await this.db
      .prepare(`UPDATE slack_installations SET vault_id = ? WHERE id = ?`)
      .bind(vaultId, id)
      .run();
  }

  async setBotVaultId(id: string, botVaultId: string): Promise<void> {
    await this.db
      .prepare(`UPDATE slack_installations SET bot_vault_id = ? WHERE id = ?`)
      .bind(botVaultId, id)
      .run();
  }

  async getBotVaultId(id: string): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT bot_vault_id FROM slack_installations WHERE id = ?`)
      .bind(id)
      .first<{ bot_vault_id: string | null }>();
    return row?.bot_vault_id ?? null;
  }

  async markRevoked(id: string, at: number): Promise<void> {
    await this.db
      .prepare(`UPDATE slack_installations SET revoked_at = ? WHERE id = ?`)
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
