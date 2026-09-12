import type {
  SentSessionEvent,
  SessionEventView,
} from "@open-managed-agents/domain/sessions";
import type {
  AppendSessionEvents,
  AppendSessionEventsResult,
  ListPersistedSessionEvents,
  ListPersistedSessionThreadEvents,
  SessionEventStore,
} from "@open-managed-agents/session-event-store";
import type { SessionStore } from "@open-managed-agents/session-store";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function processedAt(event: SessionEventView): string {
  if (event.processedAt == null) {
    throw new Error(`Session event ${event.id} has no processing time`);
  }
  return event.processedAt;
}

function compareEvents(
  left: SessionEventView,
  right: SessionEventView,
): number {
  return processedAt(left).localeCompare(processedAt(right))
    || left.id.localeCompare(right.id);
}

export class MemorySessionEventStore implements SessionEventStore {
  private readonly workspaces = new Map<
    string,
    Map<string, Map<string, SessionEventView>>
  >();
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly sessions: SessionStore) {}

  append(input: AppendSessionEvents): Promise<AppendSessionEventsResult> {
    return this.exclusive(async () => {
      if (input.nextSession.id !== input.sessionId) {
        throw new Error("Next Session ID does not match the event target");
      }
      for (const event of input.events) processedAt(event);

      const current = await this.sessions.findCurrent({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
      });
      if (current === null) return { type: "not_found" };
      if (current.revision !== input.expectedRevision) {
        return {
          type: "revision_conflict",
          actualRevision: current.revision,
        };
      }
      const replaced = await this.sessions.replaceCurrent({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        expectedRevision: input.expectedRevision,
        next: input.nextSession,
      });
      if (replaced.type !== "replaced") return replaced;

      const records = this.events(input.workspaceId, input.sessionId, true);
      for (const event of input.events) {
        if (!records.has(event.id)) records.set(event.id, clone(event));
      }
      return {
        type: "appended",
        events: clone(input.events),
        session: clone(replaced.record.session),
      };
    });
  }

  async list(input: ListPersistedSessionEvents): Promise<SessionEventView[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Session event list limit must be a positive integer");
    }
    if (input.types !== undefined && input.types.length === 0) return [];
    const direction = input.order === "asc" ? 1 : -1;
    const position: SessionEventView | undefined = input.position === undefined
      ? undefined
      : {
          id: input.position.eventId,
          type: "agent.thinking",
          processedAt: input.position.processedAt,
        };
    return [...(this.events(input.workspaceId, input.sessionId)?.values() ?? [])]
      .filter((event) => input.createdAfter === undefined || processedAt(event) > input.createdAfter)
      .filter((event) => input.createdAtOrAfter === undefined || processedAt(event) >= input.createdAtOrAfter)
      .filter((event) => input.createdBefore === undefined || processedAt(event) < input.createdBefore)
      .filter((event) => input.createdAtOrBefore === undefined || processedAt(event) <= input.createdAtOrBefore)
      .filter((event) => input.types === undefined || input.types.includes(event.type))
      .filter((event) => input.idPrefix === undefined || event.id.startsWith(input.idPrefix))
      .filter((event) => position === undefined || direction * compareEvents(event, position) > 0)
      .sort((left, right) => direction * compareEvents(left, right))
      .slice(0, input.limit)
      .map(clone);
  }

  async listThread(
    input: ListPersistedSessionThreadEvents,
  ): Promise<SessionEventView[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error(
        "Session Thread event list limit must be a positive integer",
      );
    }
    const position: SessionEventView | undefined = input.position === undefined
      ? undefined
      : {
          id: input.position.eventId,
          type: "agent.thinking",
          processedAt: input.position.processedAt,
        };
    return [...(this.events(input.workspaceId, input.sessionId)?.values() ?? [])]
      .filter((event) =>
        "sessionThreadId" in event && event.sessionThreadId === input.threadId
      )
      .filter((event) =>
        position === undefined || compareEvents(event, position) > 0
      )
      .sort(compareEvents)
      .slice(0, input.limit)
      .map(clone);
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private events(
    workspaceId: string,
    sessionId: string,
    create: true,
  ): Map<string, SessionEventView>;
  private events(
    workspaceId: string,
    sessionId: string,
    create?: false,
  ): Map<string, SessionEventView> | undefined;
  private events(
    workspaceId: string,
    sessionId: string,
    create = false,
  ): Map<string, SessionEventView> | undefined {
    let sessions = this.workspaces.get(workspaceId);
    if (sessions === undefined) {
      if (!create) return undefined;
      sessions = new Map();
      this.workspaces.set(workspaceId, sessions);
    }
    const current = sessions.get(sessionId);
    if (current !== undefined || !create) return current;
    const events = new Map<string, SessionEventView>();
    sessions.set(sessionId, events);
    return events;
  }
}

export type { SentSessionEvent };
