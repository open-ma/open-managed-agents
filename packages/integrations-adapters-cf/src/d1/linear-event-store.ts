import type { LinearEventStore, LinearActionableEvent } from "@open-managed-agents/integrations-core";

interface LinearEventRow {
  delivery_id: string;
  tenant_id: string;
  installation_id: string;
  publication_id: string | null;
  event_type: string;
  received_at: number;
  session_id: string | null;
  error: string | null;
  event_kind: string | null;
  payload_json: string | null;
  processed_at: number | null;
  processed_session_id: string | null;
}

/**
 * D1 adapter for the merged `linear_events` table. Replaces the previous
 * pair of D1WebhookEventStore + D1PendingEventRepo. One row plays three
 * roles in sequence:
 *
 *   recordIfNew → INSERT OR IGNORE skeleton (delivery_id PK ⇒ dedup)
 *   markActionable → set payload_json + event_kind + publication_id (enter queue)
 *   markProcessed | markFailed → set processed_at (leave queue)
 *
 * Rows that the handler chose not to act on stay payload_json=NULL with
 * `error` set; they're invisible to the drain index.
 */
export class D1LinearEventStore implements LinearEventStore {
  constructor(private readonly db: D1Database) {}

  async recordIfNew(
    deliveryId: string,
    tenantId: string,
    installationId: string,
    eventType: string,
    receivedAt: number,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO linear_events
           (delivery_id, tenant_id, installation_id, event_type, received_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(deliveryId, tenantId, installationId, eventType, receivedAt)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async attachSession(deliveryId: string, sessionId: string): Promise<void> {
    await this.db
      .prepare(`UPDATE linear_events SET session_id = ? WHERE delivery_id = ?`)
      .bind(sessionId, deliveryId)
      .run();
  }

  async attachPublication(deliveryId: string, publicationId: string): Promise<void> {
    await this.db
      .prepare(`UPDATE linear_events SET publication_id = ? WHERE delivery_id = ?`)
      .bind(publicationId, deliveryId)
      .run();
  }

  async attachError(deliveryId: string, error: string): Promise<void> {
    await this.db
      .prepare(`UPDATE linear_events SET error = ? WHERE delivery_id = ?`)
      .bind(error.slice(0, 2000), deliveryId)
      .run();
  }

  async markActionable(
    deliveryId: string,
    eventKind: string,
    publicationId: string,
    payloadJson: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE linear_events
           SET event_kind = ?, publication_id = ?, payload_json = ?
         WHERE delivery_id = ?`,
      )
      .bind(eventKind, publicationId, payloadJson, deliveryId)
      .run();
  }

  async listUnprocessed(limit: number): Promise<readonly LinearActionableEvent[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM linear_events
         WHERE payload_json IS NOT NULL AND processed_at IS NULL
         ORDER BY received_at ASC
         LIMIT ?`,
      )
      .bind(limit)
      .all<LinearEventRow>();
    return (results ?? []).map(toActionable);
  }

  async markProcessed(
    deliveryId: string,
    sessionId: string,
    processedAtMs: number,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE linear_events
           SET processed_at = ?, processed_session_id = ?
         WHERE delivery_id = ?`,
      )
      .bind(processedAtMs, sessionId, deliveryId)
      .run();
  }

  async markFailed(
    deliveryId: string,
    errorMessage: string,
    processedAtMs: number,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE linear_events
           SET processed_at = ?, error = ?
         WHERE delivery_id = ?`,
      )
      .bind(processedAtMs, errorMessage.slice(0, 2000), deliveryId)
      .run();
  }

  async listByPublication(
    publicationId: string,
    limit: number,
  ): Promise<readonly LinearActionableEvent[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM linear_events
         WHERE publication_id = ? AND payload_json IS NOT NULL
         ORDER BY received_at DESC
         LIMIT ?`,
      )
      .bind(publicationId, limit)
      .all<LinearEventRow>();
    return (results ?? []).map(toActionable);
  }
}

function toActionable(row: LinearEventRow): LinearActionableEvent {
  return {
    deliveryId: row.delivery_id,
    tenantId: row.tenant_id,
    publicationId: row.publication_id ?? "",
    eventKind: row.event_kind ?? "unknown",
    payload: row.payload_json ?? "",
    receivedAt: row.received_at,
    processedAt: row.processed_at,
    processedSessionId: row.processed_session_id,
    errorMessage: row.error,
  };
}
