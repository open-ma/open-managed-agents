import type {
  SendableSessionEvent,
  SendSessionEventsCommand,
  SendSessionEventsResult,
  SentSessionEvent,
  ListSessionEventsQuery,
  ListSessionEventsResult,
  StreamSessionEventsQuery,
  StreamSessionEventsResult,
  SessionEventsApplicationPort,
} from "../ports/session-events";
import type { SessionEventLogStore } from "@open-managed-agents/session-event-store";
import type { SessionSourcePort } from "./session-source";
import type { SessionEventStreamPort } from "./stream";
import type { SessionEventDispatchPort } from "../session-execution/events";
import type {
  SessionExecutionContextSourcePort,
} from "@open-managed-agents/session-runtime-contract/context";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export async function sessionInputIdentityPrefix(workspaceId: string, sessionId: string, key: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([workspaceId, sessionId, key])));
  return `sevt_req_${Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("")}_`;
}
function inputPayload(event: SentSessionEvent): string {
  const { id: _id, processedAt: _time, ...body } = event;
  if ("outcomeId" in body) delete (body as {outcomeId?: string}).outcomeId;
  const normalize = (value: unknown): unknown => Array.isArray(value) ? value.map(normalize)
    : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, normalize(child)])) : value;
  return JSON.stringify(normalize(body));
}

function encodeCursorPart(value: string): string {
  return btoa(encodeURIComponent(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeCursorPart(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  try {
    const decoded = decodeURIComponent(atob(padded));
    return encodeCursorPart(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

interface EventCursor {
  order: "asc" | "desc";
  processedAt: string;
  eventId: string;
}

function encodeEventCursor(
  event: { id: string; processedAt?: string | null },
  order: EventCursor["order"],
): string | null {
  if (event.processedAt == null) return null;
  return `session-events.${order}.${encodeCursorPart(event.processedAt)}.${encodeCursorPart(event.id)}`;
}

function decodeEventCursor(value: string): EventCursor | null {
  const [scope, order, processedAt, eventId, extra] = value.split(".");
  if (
    scope !== "session-events" ||
    (order !== "asc" && order !== "desc") ||
    processedAt === undefined ||
    eventId === undefined ||
    extra !== undefined
  ) return null;
  const decodedProcessedAt = decodeCursorPart(processedAt);
  const decodedEventId = decodeCursorPart(eventId);
  if (
    decodedProcessedAt === null ||
    decodedEventId === null ||
    decodedEventId.length === 0 ||
    Number.isNaN(Date.parse(decodedProcessedAt)) ||
    new Date(decodedProcessedAt).toISOString() !== decodedProcessedAt
  ) return null;
  return { order, processedAt: decodedProcessedAt, eventId: decodedEventId };
}

export interface SessionEventsApplicationServiceDependencies {
  workspaceId: string;
  store: SessionEventLogStore;
  sessions: SessionSourcePort;
  execution: SessionExecutionContextSourcePort;
  stream: SessionEventStreamPort;
  dispatch: SessionEventDispatchPort;
  clock: { now(): Date };
  ids: { nextEventId(): string; nextOutcomeId(): string };
}

function toSentEvent(
  event: SendableSessionEvent,
  id: string,
  processedAt: string,
  nextOutcomeId: () => string,
): SentSessionEvent {
  switch (event.type) {
    case "user.message":
      return { ...event, id, processedAt };
    case "user.interrupt":
      return { ...event, id, processedAt };
    case "user.tool_confirmation":
      return { ...event, id, processedAt };
    case "user.custom_tool_result":
      return { ...event, id, processedAt };
    case "user.define_outcome":
      return {
        ...event,
        id,
        maxIterations: event.maxIterations ?? null,
        outcomeId: nextOutcomeId(),
        processedAt,
      };
    case "user.tool_result":
      return { ...event, id, processedAt };
    case "system.message":
      return { ...event, id, processedAt };
  }
}

function applyAcceptedEvents(
  current: import("../domain/session").Session,
  events: SentSessionEvent[],
): import("../domain/session").Session {
  const next = structuredClone(current);
  for (const event of events) {
    if (
      event.type === "user.define_outcome" &&
      !next.outcomeEvaluations.some(
        (evaluation) => evaluation.outcomeId === event.outcomeId,
      )
    ) {
      next.outcomeEvaluations.push({
        type: "outcome_evaluation",
        completedAt: null,
        description: event.description,
        explanation: null,
        iteration: 0,
        outcomeId: event.outcomeId,
        result: "pending",
      });
    }
    if (event.processedAt != null && event.processedAt > next.updatedAt) {
      next.updatedAt = event.processedAt;
    }
  }
  return next;
}

export class SessionEventsApplicationService
  implements SessionEventsApplicationPort
{
  constructor(
    private readonly dependencies: SessionEventsApplicationServiceDependencies,
  ) {}

  async sendSessionEvents(
    command: SendSessionEventsCommand,
  ): Promise<SendSessionEventsResult> {
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1)) {
      return { type: "invalid_request", message: "Expected Session revision must be a positive integer" };
    }
    if (command.idempotencyKey !== undefined && (command.idempotencyKey.length === 0 || command.events.length === 0)) {
      return { type: "invalid_request", message: "Idempotent input requires a nonempty key and event batch" };
    }
    const prefix = command.idempotencyKey === undefined ? null : await sessionInputIdentityPrefix(this.dependencies.workspaceId, command.sessionId, command.idempotencyKey);
    const processedAt = this.dependencies.clock.now().toISOString();
    const events = command.events.map((event, index) =>
      toSentEvent(
        event,
        prefix === null ? this.dependencies.ids.nextEventId() : `${prefix}${index}`,
        processedAt,
        () => this.dependencies.ids.nextOutcomeId(),
      ),
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const execution = await this.dependencies.execution.find({
        workspaceId: this.dependencies.workspaceId,
        sessionId: command.sessionId,
      });
      if (execution === null) return { type: "not_found" };
      if (prefix !== null) {
        const previous = await this.dependencies.store.list({ workspaceId: this.dependencies.workspaceId, sessionId: command.sessionId, idPrefix: prefix, limit: events.length + 1, order: "asc" });
        if (previous.length > 0) {
          const byId = new Map(previous.map(event => [event.id, event]));
          if (previous.length !== events.length || events.some(event => !byId.has(event.id) || inputPayload(byId.get(event.id)! as SentSessionEvent) !== inputPayload(event))) {
            return { type: "idempotency_conflict", message: "Idempotency key was already used with different input" };
          }
          return { type: "accepted", events: events.map(event => byId.get(event.id)! as SentSessionEvent) };
        }
      }
      if (command.expectedRevision !== undefined && command.expectedRevision !== execution.revision) {
        return { type: "version_conflict", message: "Session changed after input validation; retrieve the session before retrying" };
      }
      const appended = await this.dependencies.store.append({
        workspaceId: this.dependencies.workspaceId,
        sessionId: command.sessionId,
        expectedRevision: execution.revision,
        events,
        nextSession: applyAcceptedEvents(execution.session, events),
      });
      if (appended.type === "not_found") return { type: "not_found" };
      if (appended.type === "revision_conflict") continue;
      await this.dependencies.dispatch.sessionEventsAccepted({
        workspaceId: this.dependencies.workspaceId,
        sessionId: command.sessionId,
        session: appended.session,
        environment: execution.environment,
        events: appended.events,
      });
      return { type: "accepted", events: appended.events };
    }
    throw new Error("Session changed concurrently while accepting events");
  }

  async listSessionEvents(
    query: ListSessionEventsQuery,
  ): Promise<ListSessionEventsResult> {
    const session = await this.dependencies.sessions.find({
      workspaceId: this.dependencies.workspaceId,
      sessionId: query.sessionId,
    });
    if (session === null) return { type: "not_found" };
    const order = query.order ?? "asc";
    const cursor =
      query.cursor === undefined ? undefined : decodeEventCursor(query.cursor);
    if (cursor === null || (cursor !== undefined && cursor.order !== order)) {
      return {
        type: "invalid_request",
        message: "Invalid session events page cursor",
      };
    }
    const pageSize = Math.min(
      Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const records = await this.dependencies.store.list({
      workspaceId: this.dependencies.workspaceId,
      sessionId: query.sessionId,
      limit: pageSize + 1,
      order,
      ...(query.createdAfter !== undefined && {
        createdAfter: query.createdAfter,
      }),
      ...(query.createdAtOrAfter !== undefined && {
        createdAtOrAfter: query.createdAtOrAfter,
      }),
      ...(query.createdBefore !== undefined && {
        createdBefore: query.createdBefore,
      }),
      ...(query.createdAtOrBefore !== undefined && {
        createdAtOrBefore: query.createdAtOrBefore,
      }),
      ...(query.types !== undefined && { types: query.types }),
      ...(cursor !== undefined && {
        position: {
          processedAt: cursor.processedAt,
          eventId: cursor.eventId,
        },
      }),
    });
    const hasMore = records.length > pageSize;
    const events = hasMore ? records.slice(0, pageSize) : records;
    const last = events[events.length - 1];
    return {
      type: "page",
      page: {
        events,
        nextCursor:
          hasMore && last !== undefined ? encodeEventCursor(last, order) : null,
      },
    };
  }

  async streamSessionEvents(
    query: StreamSessionEventsQuery,
  ): Promise<StreamSessionEventsResult> {
    const session = await this.dependencies.sessions.find({
      workspaceId: this.dependencies.workspaceId,
      sessionId: query.sessionId,
    });
    if (session === null) return { type: "not_found" };
    return {
      type: "stream",
      events: this.dependencies.stream.subscribe({
        workspaceId: this.dependencies.workspaceId,
        sessionId: query.sessionId,
        session,
        ...(query.deltaEventTypes !== undefined && {
          deltaEventTypes: query.deltaEventTypes,
        }),
      }),
    };
  }
}
