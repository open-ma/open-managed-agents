import type {
  Crypto,
  GitHubAppCredentials,
  GitHubAppRepo,
  IdGenerator,
  NewGitHubAppCredentials,
} from "@open-managed-agents/integrations-core";

interface Row {
  id: string;
  publication_id: string | null;
  app_id: string;
  app_slug: string;
  bot_login: string;
  client_id: string | null;
  client_secret_cipher: string | null;
  webhook_secret_cipher: string;
  private_key_cipher: string;
  created_at: number;
}

export class D1GitHubAppRepo implements GitHubAppRepo {
  constructor(
    private readonly db: D1Database,
    private readonly crypto: Crypto,
    private readonly ids: IdGenerator,
  ) {}

  async get(id: string): Promise<GitHubAppCredentials | null> {
    const row = await this.db
      .prepare(`SELECT * FROM github_apps WHERE id = ?`)
      .bind(id)
      .first<Row>();
    return row ? this.toDomain(row) : null;
  }

  async getByPublication(publicationId: string): Promise<GitHubAppCredentials | null> {
    const row = await this.db
      .prepare(`SELECT * FROM github_apps WHERE publication_id = ?`)
      .bind(publicationId)
      .first<Row>();
    return row ? this.toDomain(row) : null;
  }

  async getByAppId(appId: string): Promise<GitHubAppCredentials | null> {
    const row = await this.db
      .prepare(`SELECT * FROM github_apps WHERE app_id = ? LIMIT 1`)
      .bind(appId)
      .first<Row>();
    return row ? this.toDomain(row) : null;
  }

  async getWebhookSecret(id: string): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT webhook_secret_cipher FROM github_apps WHERE id = ?`)
      .bind(id)
      .first<{ webhook_secret_cipher: string }>();
    if (!row) return null;
    return this.crypto.decrypt(row.webhook_secret_cipher);
  }

  async getClientSecret(id: string): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT client_secret_cipher FROM github_apps WHERE id = ?`)
      .bind(id)
      .first<{ client_secret_cipher: string | null }>();
    if (!row || row.client_secret_cipher == null) return null;
    return this.crypto.decrypt(row.client_secret_cipher);
  }

  async getPrivateKey(id: string): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT private_key_cipher FROM github_apps WHERE id = ?`)
      .bind(id)
      .first<{ private_key_cipher: string }>();
    if (!row) return null;
    return this.crypto.decrypt(row.private_key_cipher);
  }

  async insert(row: NewGitHubAppCredentials): Promise<GitHubAppCredentials> {
    const id = row.id ?? this.ids.generate();
    const now = Date.now();
    const clientSecretCipher =
      row.clientSecret == null ? null : await this.crypto.encrypt(row.clientSecret);
    const webhookSecretCipher = await this.crypto.encrypt(row.webhookSecret);
    const privateKeyCipher = await this.crypto.encrypt(row.privateKey);
    // Upsert: a re-submit of the publish form (e.g. user pasted wrong key,
    // tries again with the same formToken) refreshes credentials in place
    // rather than failing on PRIMARY KEY conflict. publication_id and
    // created_at are preserved.
    await this.db
      .prepare(
        `INSERT INTO github_apps (
           id, publication_id, app_id, app_slug, bot_login,
           client_id, client_secret_cipher, webhook_secret_cipher,
           private_key_cipher, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           app_id = excluded.app_id,
           app_slug = excluded.app_slug,
           bot_login = excluded.bot_login,
           client_id = excluded.client_id,
           client_secret_cipher = excluded.client_secret_cipher,
           webhook_secret_cipher = excluded.webhook_secret_cipher,
           private_key_cipher = excluded.private_key_cipher`,
      )
      .bind(
        id,
        row.publicationId,
        row.appId,
        row.appSlug,
        row.botLogin,
        row.clientId,
        clientSecretCipher,
        webhookSecretCipher,
        privateKeyCipher,
        now,
      )
      .run();
    return {
      id,
      publicationId: row.publicationId,
      appId: row.appId,
      appSlug: row.appSlug,
      botLogin: row.botLogin,
      clientId: row.clientId,
      clientSecretCipher,
      webhookSecretCipher,
      privateKeyCipher,
      createdAt: now,
    };
  }

  async setPublicationId(id: string, publicationId: string): Promise<void> {
    await this.db
      .prepare(`UPDATE github_apps SET publication_id = ? WHERE id = ?`)
      .bind(publicationId, id)
      .run();
  }

  async delete(id: string): Promise<void> {
    await this.db.prepare(`DELETE FROM github_apps WHERE id = ?`).bind(id).run();
  }

  private toDomain(row: Row): GitHubAppCredentials {
    return {
      id: row.id,
      publicationId: row.publication_id,
      appId: row.app_id,
      appSlug: row.app_slug,
      botLogin: row.bot_login,
      clientId: row.client_id,
      clientSecretCipher: row.client_secret_cipher,
      webhookSecretCipher: row.webhook_secret_cipher,
      privateKeyCipher: row.private_key_cipher,
      createdAt: row.created_at,
    };
  }
}
