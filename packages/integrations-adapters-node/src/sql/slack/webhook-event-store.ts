import type { SqlClient } from "@open-managed-agents/sql-client";

import type { WebhookEventStore } from "@open-managed-agents/integrations-core";

export class SqlSlackWebhookEventStore implements WebhookEventStore {
  constructor(private readonly db: SqlClient) {}

  /**
   * Atomic insert via ON CONFLICT DO NOTHING on the primary key. Returns true
   * if a row was actually inserted, false if the delivery_id was already
   * present. Portable across SQLite and PG.
   */
  async recordIfNew(
    deliveryId: string,
    tenantId: string,
    installationId: string,
    eventType: string,
    receivedAt: number,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO slack_webhook_events
           (delivery_id, tenant_id, installation_id, event_type, received_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (delivery_id) DO NOTHING`,
      )
      .bind(deliveryId, tenantId, installationId, eventType, receivedAt)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async attachSession(deliveryId: string, sessionId: string): Promise<void> {
    await this.db
      .prepare(`UPDATE slack_webhook_events SET session_id = ? WHERE delivery_id = ?`)
      .bind(sessionId, deliveryId)
      .run();
  }

  async attachPublication(deliveryId: string, publicationId: string): Promise<void> {
    await this.db
      .prepare(`UPDATE slack_webhook_events SET publication_id = ? WHERE delivery_id = ?`)
      .bind(publicationId, deliveryId)
      .run();
  }

  async attachError(deliveryId: string, error: string): Promise<void> {
    await this.db
      .prepare(`UPDATE slack_webhook_events SET error = ? WHERE delivery_id = ?`)
      .bind(error, deliveryId)
      .run();
  }
}
