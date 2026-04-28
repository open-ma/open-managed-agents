import type {
  IdGenerator,
  NewPendingEvent,
  PendingEvent,
  PendingEventRepo,
} from "@open-managed-agents/integrations-core";

interface Row {
  id: string;
  tenant_id: string;
  publication_id: string;
  event_kind: string;
  issue_id: string | null;
  issue_identifier: string | null;
  workspace_id: string | null;
  payload_json: string;
  received_at: number;
  processed_at: number | null;
  processed_session_id: string | null;
  error_message: string | null;
}

export class D1PendingEventRepo implements PendingEventRepo {
  constructor(
    private readonly db: D1Database,
    private readonly ids: IdGenerator,
  ) {}

  async insert(input: NewPendingEvent, nowMs: number): Promise<PendingEvent> {
    const id = this.ids.generate();
    await this.db
      .prepare(
        `INSERT INTO linear_pending_events
           (id, tenant_id, publication_id, event_kind, issue_id, issue_identifier,
            workspace_id, payload_json, received_at, processed_at,
            processed_session_id, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      )
      .bind(
        id,
        input.tenantId,
        input.publicationId,
        input.eventKind,
        input.issueId,
        input.issueIdentifier,
        input.workspaceId,
        input.payload,
        nowMs,
      )
      .run();
    return {
      id,
      tenantId: input.tenantId,
      publicationId: input.publicationId,
      eventKind: input.eventKind,
      issueId: input.issueId,
      issueIdentifier: input.issueIdentifier,
      workspaceId: input.workspaceId,
      payload: input.payload,
      receivedAt: nowMs,
      processedAt: null,
      processedSessionId: null,
      errorMessage: null,
    };
  }

  /**
   * Drain hot path. The partial index `idx_linear_pending_events_unprocessed`
   * keeps this cheap regardless of how many processed rows accumulate.
   */
  async listUnprocessed(limit: number): Promise<readonly PendingEvent[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM linear_pending_events
         WHERE processed_at IS NULL
         ORDER BY received_at ASC
         LIMIT ?`,
      )
      .bind(limit)
      .all<Row>();
    return (results ?? []).map((r) => this.toDomain(r));
  }

  async delete(id: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM linear_pending_events WHERE id = ?`)
      .bind(id)
      .run();
  }

  async markFailed(
    id: string,
    errorMessage: string,
    processedAtMs: number,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE linear_pending_events
           SET processed_at = ?, error_message = ?
         WHERE id = ?`,
      )
      // Truncate to keep one bad row from blowing up the column.
      .bind(processedAtMs, errorMessage.slice(0, 2000), id)
      .run();
  }

  async listByPublication(
    publicationId: string,
    limit: number,
  ): Promise<readonly PendingEvent[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM linear_pending_events
         WHERE publication_id = ?
         ORDER BY received_at DESC
         LIMIT ?`,
      )
      .bind(publicationId, limit)
      .all<Row>();
    return (results ?? []).map((r) => this.toDomain(r));
  }

  private toDomain(row: Row): PendingEvent {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      publicationId: row.publication_id,
      eventKind: row.event_kind,
      issueId: row.issue_id,
      issueIdentifier: row.issue_identifier,
      workspaceId: row.workspace_id,
      payload: row.payload_json,
      receivedAt: row.received_at,
      processedAt: row.processed_at,
      processedSessionId: row.processed_session_id,
      errorMessage: row.error_message,
    };
  }
}
