import type { SqlClient } from "@open-managed-agents/sql-client";

import type { WebhookEventStore } from "@open-managed-agents/integrations-core";

/**
 * Standalone D1 store for `github_webhook_events`. Previously GitHub
 * webhooks borrowed `linear_webhook_events` (a leftover from before
 * 0009_split_github_tables.sql split installations + publications). This
 * completes the split: GitHub now has its own dedup + audit table.
 *
 * GitHub dispatch is inline (no async queue), so the schema is the simple
 * audit-only shape — same as `slack_webhook_events`.
 */
export class SqlGitHubWebhookEventStore implements WebhookEventStore {
  constructor(private readonly db: SqlClient) {}

  async recordIfNew(
    deliveryId: string,
    tenantId: string,
    installationId: string,
    eventType: string,
    receivedAt: number,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO github_webhook_events
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
      .prepare(`UPDATE github_webhook_events SET session_id = ? WHERE delivery_id = ?`)
      .bind(sessionId, deliveryId)
      .run();
  }

  async attachPublication(deliveryId: string, publicationId: string): Promise<void> {
    await this.db
      .prepare(`UPDATE github_webhook_events SET publication_id = ? WHERE delivery_id = ?`)
      .bind(publicationId, deliveryId)
      .run();
  }

  async attachError(deliveryId: string, error: string): Promise<void> {
    await this.db
      .prepare(`UPDATE github_webhook_events SET error = ? WHERE delivery_id = ?`)
      .bind(error.slice(0, 2000), deliveryId)
      .run();
  }
}
