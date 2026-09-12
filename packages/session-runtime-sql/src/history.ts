import { decodeSessionEventDocument, type OrderedSessionEvent } from '@open-managed-agents/session-runtime-contract/history';
import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  SessionBootstrapEvent,
} from "@open-managed-agents/domain/sessions";
import type {
  LoadSessionRuntimeHistoryRecord,
  SessionRuntimeHistoryRecord,
  SessionRuntimeHistorySourcePort,
} from "@open-managed-agents/session-runtime-contract/history";

interface HistoryRow {
  revision: number;
  history_kind: 'initial' | 'event' | null;
  document: string | null;
}

export class SqlSessionRuntimeHistorySource
  implements SessionRuntimeHistorySourcePort
{
  constructor(private readonly client: SqlClient) {}

  async load(
    input: LoadSessionRuntimeHistoryRecord,
  ): Promise<SessionRuntimeHistoryRecord | null> {
    // One SELECT binds every event and the native revision to the same
    // database snapshot, including on READ COMMITTED SQL backends.
    const rows = await this.client
      .prepare(
        `SELECT session.revision, history.history_kind, history.document
           FROM managed_sessions AS session
           LEFT JOIN (
             SELECT workspace_id, session_id, 'initial' AS history_kind,
                    document, sequence, NULL AS processed_at, NULL AS event_id
               FROM managed_session_initial_events
              WHERE workspace_id = ? AND session_id = ?
             UNION ALL
             SELECT workspace_id, session_id, 'event' AS history_kind,
                    document, NULL AS sequence, processed_at, id AS event_id
               FROM managed_session_events
              WHERE workspace_id = ? AND session_id = ?
           ) AS history ON history.workspace_id = session.workspace_id
                       AND history.session_id = session.id
          WHERE session.workspace_id = ? AND session.id = ?
          ORDER BY history.history_kind ASC, history.sequence ASC,
                   history.processed_at ASC, history.event_id ASC`,
      )
      .bind(input.workspaceId, input.sessionId, input.workspaceId, input.sessionId, input.workspaceId, input.sessionId)
      .all<HistoryRow>();
    const session = rows.results?.[0];
    if (!session) return null;
    const initialRows = rows.results!.filter(row => row.history_kind === 'initial');
    const eventRows = rows.results!.filter(row => row.history_kind === 'event');
    const decoded = eventRows.map(row => decodeSessionEventDocument(row.document!));
    const positions = new Set<string>();
    const fullyOrdered = decoded.every(row => {
      if (row.position === undefined) return false;
      const key = `${row.position.revision}:${row.position.index}`;
      if (positions.has(key)) return false;
      positions.add(key);
      return true;
    });
    const orderedEvents = fullyOrdered
      ? (decoded as OrderedSessionEvent[]).slice().sort((left, right) =>
          left.position.revision - right.position.revision || left.position.index - right.position.index)
      : undefined;
    return {
      revision: session.revision,
      initialEvents: initialRows.map(
        (row) => JSON.parse(row.document!) as SessionBootstrapEvent,
      ),
      events: decoded.map(row => row.event),
      ...(orderedEvents === undefined ? {} : { orderedEvents }),
    };
  }
}
