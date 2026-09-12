import type {
  SendableSessionEvent,
  SentSessionEvent,
  SessionEventDeltaType,
  SessionEventView,
  StreamSessionEvent,
} from "../domain/session-event";

export type * from "../domain/session-event";

export interface SendSessionEventsCommand {
  sessionId: string;
  events: SendableSessionEvent[];
  /** Retries of the same logical input return its original accepted events. */
  idempotencyKey?: string;
  /** Bind state-dependent validation to the existing native Session CAS. */
  expectedRevision?: number;
}

export interface ListSessionEventsQuery {
  sessionId: string;
  pageSize?: number;
  cursor?: string;
  createdAfter?: string;
  createdAtOrAfter?: string;
  createdBefore?: string;
  createdAtOrBefore?: string;
  order?: "asc" | "desc";
  types?: string[];
}

export interface SessionEventsPage {
  events: SessionEventView[];
  nextCursor: string | null;
}

export interface StreamSessionEventsQuery {
  sessionId: string;
  deltaEventTypes?: SessionEventDeltaType[];
}

export type SendSessionEventsResult =
  | { type: "accepted"; events?: SentSessionEvent[] }
  | { type: "idempotency_conflict"; message: string }
  | { type: "version_conflict"; message: string }
  | { type: "invalid_request"; message: string }
  | { type: "not_found" };

export type ListSessionEventsResult =
  | { type: "page"; page: SessionEventsPage }
  | { type: "invalid_request"; message: string }
  | { type: "not_found" };

export type StreamSessionEventsResult =
  | { type: "stream"; events: AsyncIterable<StreamSessionEvent> }
  | { type: "not_found" };

export interface SessionEventsApplicationPort {
  sendSessionEvents(
    command: SendSessionEventsCommand,
  ): Promise<SendSessionEventsResult>;
  listSessionEvents(
    query: ListSessionEventsQuery,
  ): Promise<ListSessionEventsResult>;
  streamSessionEvents(
    query: StreamSessionEventsQuery,
  ): Promise<StreamSessionEventsResult>;
}
