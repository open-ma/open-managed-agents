import type {
  SentSessionEvent,
  SessionEventView,
  Session,
} from "@open-managed-agents/domain/sessions";

export interface AppendSessionEvents {
  workspaceId: string;
  sessionId: string;
  expectedRevision: number;
  events: SentSessionEvent[];
  nextSession: Session;
}

export type AppendSessionEventsResult =
  | { type: "appended"; events: SentSessionEvent[]; session: Session }
  | { type: "not_found" }
  | { type: "revision_conflict"; actualRevision: number };

export interface SessionEventLogStore {
  append(input: AppendSessionEvents): Promise<AppendSessionEventsResult>;
  list(input: ListPersistedSessionEvents): Promise<SessionEventView[]>;
}

export interface SessionEventListPosition {
  processedAt: string;
  eventId: string;
}

export interface ListPersistedSessionEvents {
  workspaceId: string;
  sessionId: string;
  limit: number;
  order: "asc" | "desc";
  createdAfter?: string;
  createdAtOrAfter?: string;
  createdBefore?: string;
  createdAtOrBefore?: string;
  types?: string[];
  /** Internal exact namespace lookup for deterministic event identities. */
  idPrefix?: string;
  position?: SessionEventListPosition;
}

export interface SessionThreadEventListPosition {
  processedAt: string;
  eventId: string;
}

export interface ListPersistedSessionThreadEvents {
  workspaceId: string;
  sessionId: string;
  threadId: string;
  limit: number;
  position?: SessionThreadEventListPosition;
}

export interface SessionThreadEventStore {
  listThread(
    input: ListPersistedSessionThreadEvents,
  ): Promise<SessionEventView[]>;
}

/** Full append log plus its thread-scoped read projection. */
export interface SessionEventStore
  extends SessionEventLogStore, SessionThreadEventStore {}
