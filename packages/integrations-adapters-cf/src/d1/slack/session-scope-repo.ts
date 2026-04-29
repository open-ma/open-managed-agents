import type {
  SessionScope,
  SessionScopeStatus,
} from "@open-managed-agents/integrations-core";
import type { SlackSessionScopeRepo } from "@open-managed-agents/slack";

interface Row {
  tenant_id: string;
  publication_id: string;
  scope_key: string;
  session_id: string;
  status: string;
  created_at: number;
  pending_scan_until: number | null;
  last_scan_at: number | null;
  channel_name: string | null;
}

/**
 * D1 session-scope repo for Slack. Table `slack_thread_sessions`. The
 * scope_key column stores `${channel_id}:${thread_ts ?? event_ts}` for
 * `per_thread` granularity, or `channel:${channel_id}` for `per_channel`.
 *
 * The three nullable columns `pending_scan_until` / `last_scan_at` /
 * `channel_name` are only meaningful for per_channel rows; per_thread rows
 * leave them NULL.
 */
export class D1SlackSessionScopeRepo implements SlackSessionScopeRepo {
  constructor(private readonly db: D1Database) {}

  async getByScope(publicationId: string, scopeKey: string): Promise<SessionScope | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM slack_thread_sessions
         WHERE publication_id = ? AND scope_key = ?`,
      )
      .bind(publicationId, scopeKey)
      .first<Row>();
    return row ? this.toDomain(row) : null;
  }

  async insert(row: SessionScope): Promise<boolean> {
    // INSERT OR IGNORE so concurrent dispatchers racing on the same
    // (publication_id, scope_key) don't 500. Returns true when this call
    // wrote the row; false when the row was already present (race loser).
    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO slack_thread_sessions
           (tenant_id, publication_id, scope_key, session_id, status, created_at,
            pending_scan_until, last_scan_at, channel_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.tenantId,
        row.publicationId,
        row.scopeKey,
        row.sessionId,
        row.status,
        row.createdAt,
        row.pendingScanUntil ?? null,
        row.lastScanAt ?? null,
        row.channelName ?? null,
      )
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async updateStatus(
    publicationId: string,
    scopeKey: string,
    status: SessionScopeStatus,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE slack_thread_sessions SET status = ?
         WHERE publication_id = ? AND scope_key = ?`,
      )
      .bind(status, publicationId, scopeKey)
      .run();
  }

  async listActive(publicationId: string): Promise<readonly SessionScope[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM slack_thread_sessions
         WHERE publication_id = ? AND status = 'active'`,
      )
      .bind(publicationId)
      .all<Row>();
    return (results ?? []).map((r) => this.toDomain(r));
  }

  async armPendingScan(
    publicationId: string,
    scopeKey: string,
    until: number,
    now: number,
  ): Promise<{ armed: boolean; currentUntil: number | null }> {
    // Conditional UPDATE: only set pending_scan_until if the row is not
    // currently armed (or its armed window has lapsed). Returning .meta.changes
    // tells us whether we actually claimed the slot. Two concurrent dispatchers
    // are serialized by D1's row lock; at most one observes `changes > 0`.
    const result = await this.db
      .prepare(
        `UPDATE slack_thread_sessions
         SET pending_scan_until = ?
         WHERE publication_id = ? AND scope_key = ?
           AND (pending_scan_until IS NULL OR pending_scan_until <= ?)`,
      )
      .bind(until, publicationId, scopeKey, now)
      .run();

    if ((result.meta?.changes ?? 0) > 0) {
      return { armed: true, currentUntil: null };
    }

    // Either the row didn't exist, or someone else has it armed. Read back to
    // distinguish — and so the caller knows when the existing window expires.
    const row = await this.db
      .prepare(
        `SELECT pending_scan_until FROM slack_thread_sessions
         WHERE publication_id = ? AND scope_key = ?`,
      )
      .bind(publicationId, scopeKey)
      .first<{ pending_scan_until: number | null }>();
    return { armed: false, currentUntil: row?.pending_scan_until ?? null };
  }

  async clearPendingScan(publicationId: string, scopeKey: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE slack_thread_sessions SET pending_scan_until = NULL
         WHERE publication_id = ? AND scope_key = ?`,
      )
      .bind(publicationId, scopeKey)
      .run();
  }

  async updateChannelName(
    publicationId: string,
    scopeKey: string,
    channelName: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE slack_thread_sessions SET channel_name = ?
         WHERE publication_id = ? AND scope_key = ?`,
      )
      .bind(channelName, publicationId, scopeKey)
      .run();
  }

  private toDomain(row: Row): SessionScope {
    return {
      tenantId: row.tenant_id,
      publicationId: row.publication_id,
      scopeKey: row.scope_key,
      sessionId: row.session_id,
      status: row.status as SessionScopeStatus,
      createdAt: row.created_at,
      pendingScanUntil: row.pending_scan_until,
      lastScanAt: row.last_scan_at,
      channelName: row.channel_name,
    };
  }
}
