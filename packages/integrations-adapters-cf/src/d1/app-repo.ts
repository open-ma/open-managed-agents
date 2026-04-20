import type {
  AppCredentials,
  AppRepo,
  Crypto,
  IdGenerator,
  NewAppCredentials,
} from "@open-managed-agents/integrations-core";

interface Row {
  id: string;
  publication_id: string | null;
  client_id: string;
  client_secret_cipher: string;
  webhook_secret_cipher: string;
  created_at: number;
}

export class D1AppRepo implements AppRepo {
  constructor(
    private readonly db: D1Database,
    private readonly crypto: Crypto,
    private readonly ids: IdGenerator,
  ) {}

  async get(id: string): Promise<AppCredentials | null> {
    const row = await this.db
      .prepare(`SELECT * FROM linear_apps WHERE id = ?`)
      .bind(id)
      .first<Row>();
    return row ? this.toDomain(row) : null;
  }

  async getByPublication(publicationId: string): Promise<AppCredentials | null> {
    const row = await this.db
      .prepare(`SELECT * FROM linear_apps WHERE publication_id = ?`)
      .bind(publicationId)
      .first<Row>();
    return row ? this.toDomain(row) : null;
  }

  async getWebhookSecret(id: string): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT webhook_secret_cipher FROM linear_apps WHERE id = ?`)
      .bind(id)
      .first<{ webhook_secret_cipher: string }>();
    if (!row) return null;
    return this.crypto.decrypt(row.webhook_secret_cipher);
  }

  async getClientSecret(id: string): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT client_secret_cipher FROM linear_apps WHERE id = ?`)
      .bind(id)
      .first<{ client_secret_cipher: string }>();
    if (!row) return null;
    return this.crypto.decrypt(row.client_secret_cipher);
  }

  async insert(row: NewAppCredentials): Promise<AppCredentials> {
    const id = this.ids.generate();
    const now = Date.now();
    const clientSecretCipher = await this.crypto.encrypt(row.clientSecret);
    const webhookSecretCipher = await this.crypto.encrypt(row.webhookSecret);
    await this.db
      .prepare(
        `INSERT INTO linear_apps (
           id, publication_id, client_id, client_secret_cipher,
           webhook_secret_cipher, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, row.publicationId, row.clientId, clientSecretCipher, webhookSecretCipher, now)
      .run();
    return {
      id,
      publicationId: row.publicationId,
      clientId: row.clientId,
      clientSecretCipher,
      webhookSecretCipher,
      createdAt: now,
    };
  }

  async setPublicationId(id: string, publicationId: string): Promise<void> {
    await this.db
      .prepare(`UPDATE linear_apps SET publication_id = ? WHERE id = ?`)
      .bind(publicationId, id)
      .run();
  }

  async delete(id: string): Promise<void> {
    await this.db.prepare(`DELETE FROM linear_apps WHERE id = ?`).bind(id).run();
  }

  private toDomain(row: Row): AppCredentials {
    return {
      id: row.id,
      publicationId: row.publication_id,
      clientId: row.client_id,
      clientSecretCipher: row.client_secret_cipher,
      webhookSecretCipher: row.webhook_secret_cipher,
      createdAt: row.created_at,
    };
  }
}
