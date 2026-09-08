import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  SessionEventStreamPort,
  SessionThreadEventStreamPort,
  StreamSessionEvent,
  SubscribeSessionEvents,
  SubscribeSessionThreadEvents,
} from "@open-managed-agents/managed-agents-application";

interface EventRow {
  document: string;
}

interface Position {
  processedAt: string;
  eventId: string;
}

export interface SqlPersistedSessionEventStreamOptions {
  pollIntervalMs?: number;
  sleep?(milliseconds: number): Promise<void>;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function positionOf(event: StreamSessionEvent): Position {
  if (
    event.type === "event_start"
    || event.type === "event_delta"
    || !("processedAt" in event)
    || typeof event.processedAt !== "string"
  ) {
    throw new Error("Persisted Session stream received a non-canonical event");
  }
  return { processedAt: event.processedAt, eventId: event.id };
}

function isTerminal(event: StreamSessionEvent, thread: boolean): boolean {
  if (event.type === "event_start" || event.type === "event_delta") return false;
  return thread
    ? event.type === "session.thread_status_idle"
      || event.type === "session.thread_status_terminated"
    : event.type === "session.status_idle"
      || event.type === "session.status_terminated"
      || event.type === "session.deleted";
}

/** Cross-process live stream for self-hosted Environment Work outputs. */
export class SqlPersistedSessionEventStream
  implements SessionEventStreamPort, SessionThreadEventStreamPort
{
  readonly #pollIntervalMs: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly client: SqlClient,
    options: SqlPersistedSessionEventStreamOptions = {},
  ) {
    this.#pollIntervalMs = options.pollIntervalMs ?? 250;
    if (!Number.isSafeInteger(this.#pollIntervalMs) || this.#pollIntervalMs < 1) {
      throw new Error("Session event poll interval must be a positive integer");
    }
    this.#sleep = options.sleep ?? defaultSleep;
  }

  subscribe(
    input: SubscribeSessionEvents | SubscribeSessionThreadEvents,
  ): AsyncIterable<StreamSessionEvent> {
    return this.stream(input);
  }

  private async *stream(
    input: SubscribeSessionEvents | SubscribeSessionThreadEvents,
  ): AsyncIterable<StreamSessionEvent> {
    const threadId = "threadId" in input ? input.threadId : undefined;
    let position = await this.latestPosition(
      input.workspaceId,
      input.sessionId,
      threadId,
    );
    for (;;) {
      await this.#sleep(this.#pollIntervalMs);
      const events = await this.readAfter(
        input.workspaceId,
        input.sessionId,
        threadId,
        position,
      );
      for (const event of events) {
        position = positionOf(event);
        yield event;
        if (isTerminal(event, threadId !== undefined)) return;
      }
    }
  }

  private async latestPosition(
    workspaceId: string,
    sessionId: string,
    threadId?: string,
  ): Promise<Position | undefined> {
    const row = await this.client.prepare(
      `SELECT document FROM managed_session_events
        WHERE workspace_id = ? AND session_id = ?
          ${threadId === undefined ? "" : "AND thread_id = ?"}
        ORDER BY processed_at DESC, id DESC
        LIMIT 1`,
    ).bind(
      workspaceId,
      sessionId,
      ...(threadId === undefined ? [] : [threadId]),
    ).first<EventRow>();
    if (row === null) return undefined;
    return positionOf(JSON.parse(row.document) as StreamSessionEvent);
  }

  private async readAfter(
    workspaceId: string,
    sessionId: string,
    threadId: string | undefined,
    position: Position | undefined,
  ): Promise<StreamSessionEvent[]> {
    const rows = await this.client.prepare(
      `SELECT document FROM managed_session_events
        WHERE workspace_id = ? AND session_id = ?
          ${threadId === undefined ? "" : "AND thread_id = ?"}
          ${position === undefined
            ? ""
            : "AND (processed_at > ? OR (processed_at = ? AND id > ?))"}
        ORDER BY processed_at ASC, id ASC
        LIMIT 100`,
    ).bind(
      workspaceId,
      sessionId,
      ...(threadId === undefined ? [] : [threadId]),
      ...(position === undefined
        ? []
        : [
            Date.parse(position.processedAt),
            Date.parse(position.processedAt),
            position.eventId,
          ]),
    ).all<EventRow>();
    return (rows.results ?? []).map(
      (row) => JSON.parse(row.document) as StreamSessionEvent,
    );
  }
}
