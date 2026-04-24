import type {
  AppCredentials,
  AppRepo,
  Crypto,
  IdGenerator,
  NewAppCredentials,
} from "@open-managed-agents/integrations-core";

interface Row {
  id: string;
  tenant_id: string;
  publication_id: string | null;
  client_id: string;
  client_secret_cipher: string;
  signing_secret_cipher: string;
  created_at: number;
}

/**
 * D1 app repo for Slack. Mirrors D1AppRepo but uses `slack_apps` and stores
 * the per-App signing secret (not a per-webhook secret — Slack's signing
 * secret is one value per App used for ALL events). The base AppRepo
 * interface calls this slot `webhookSecret`/`getWebhookSecret`; semantically
 * for Slack it's the signing secret. Same shape, different name.
 */
export class D1SlackAppRepo implements AppRepo {
  constructor(
    private readonly db: D1Database,
    private readonly crypto: Crypto,
    private readonly ids: IdGenerator,
  ) {}

  async get(id: string): Promise<AppCredentials | null> {
    const row = await this.db
      .prepare(`SELECT * FROM slack_apps WHERE id = ?`)
      .bind(id)
      .first<Row>();
    return row ? this.toDomain(row) : null;
  }

  async getByPublication(publicationId: string): Promise<AppCredentials | null> {
    const row = await this.db
      .prepare(`SELECT * FROM slack_apps WHERE publication_id = ?`)
      .bind(publicationId)
      .first<Row>();
    return row ? this.toDomain(row) : null;
  }

  async getWebhookSecret(id: string): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT signing_secret_cipher FROM slack_apps WHERE id = ?`)
      .bind(id)
      .first<{ signing_secret_cipher: string }>();
    if (!row) return null;
    return this.crypto.decrypt(row.signing_secret_cipher);
  }

  async getClientSecret(id: string): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT client_secret_cipher FROM slack_apps WHERE id = ?`)
      .bind(id)
      .first<{ client_secret_cipher: string }>();
    if (!row) return null;
    return this.crypto.decrypt(row.client_secret_cipher);
  }

  async insert(row: NewAppCredentials): Promise<AppCredentials> {
    const id = row.id ?? this.ids.generate();
    const now = Date.now();
    const clientSecretCipher = await this.crypto.encrypt(row.clientSecret);
    const signingSecretCipher = await this.crypto.encrypt(row.webhookSecret);
    await this.db
      .prepare(
        `INSERT INTO slack_apps (
           id, tenant_id, publication_id, client_id, client_secret_cipher,
           signing_secret_cipher, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           client_id = excluded.client_id,
           client_secret_cipher = excluded.client_secret_cipher,
           signing_secret_cipher = excluded.signing_secret_cipher`,
      )
      .bind(id, row.tenantId, row.publicationId, row.clientId, clientSecretCipher, signingSecretCipher, now)
      .run();
    return {
      id,
      tenantId: row.tenantId,
      publicationId: row.publicationId,
      clientId: row.clientId,
      clientSecretCipher,
      webhookSecretCipher: signingSecretCipher,
      createdAt: now,
    };
  }

  async setPublicationId(id: string, publicationId: string): Promise<void> {
    await this.db
      .prepare(`UPDATE slack_apps SET publication_id = ? WHERE id = ?`)
      .bind(publicationId, id)
      .run();
  }

  async delete(id: string): Promise<void> {
    await this.db.prepare(`DELETE FROM slack_apps WHERE id = ?`).bind(id).run();
  }

  private toDomain(row: Row): AppCredentials {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      publicationId: row.publication_id,
      clientId: row.client_id,
      clientSecretCipher: row.client_secret_cipher,
      webhookSecretCipher: row.signing_secret_cipher,
      createdAt: row.created_at,
    };
  }
}
