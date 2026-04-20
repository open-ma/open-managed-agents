import type { WebhookEventStore } from "@open-managed-agents/integrations-core";

export class D1WebhookEventStore implements WebhookEventStore {
  constructor(private readonly db: D1Database) {}

  /**
   * Atomic insert via INSERT OR IGNORE on the primary key. Returns true if a
   * row was actually inserted (new event), false if the delivery_id was
   * already present (duplicate — caller should short-circuit).
   */
  async recordIfNew(
    deliveryId: string,
    installationId: string,
    eventType: string,
    receivedAt: number,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO linear_webhook_events
           (delivery_id, installation_id, event_type, received_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(deliveryId, installationId, eventType, receivedAt)
      .run();
    // D1 returns meta.changes for INSERT OR IGNORE; 0 means duplicate.
    return (result.meta?.changes ?? 0) > 0;
  }

  async attachSession(deliveryId: string, sessionId: string): Promise<void> {
    await this.db
      .prepare(`UPDATE linear_webhook_events SET session_id = ? WHERE delivery_id = ?`)
      .bind(sessionId, deliveryId)
      .run();
  }

  async attachPublication(deliveryId: string, publicationId: string): Promise<void> {
    await this.db
      .prepare(`UPDATE linear_webhook_events SET publication_id = ? WHERE delivery_id = ?`)
      .bind(publicationId, deliveryId)
      .run();
  }

  async attachError(deliveryId: string, error: string): Promise<void> {
    await this.db
      .prepare(`UPDATE linear_webhook_events SET error = ? WHERE delivery_id = ?`)
      .bind(error, deliveryId)
      .run();
  }
}
