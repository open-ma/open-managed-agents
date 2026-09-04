import type {
  SentSessionEvent,
  SessionEventView,
} from "../domain/session-event";
import type { Session } from "../domain/session";
import type { SessionBootstrapEvent } from "../domain/session-bootstrap";

/**
 * Application-owned projection proof. It is deliberately structural so the
 * execution coordinator can provide its fence without making this inbound
 * port depend on a runtime/storage package.
 */
export interface SessionExecutionFence {
  executionId: string;
  workspaceId: string;
  sessionId: string;
  attemptId: string;
  ownerId: string;
  generation: number;
  expiresAt: string;
}

export type RuntimeProducedSessionEvent = Exclude<
  SessionEventView,
  SentSessionEvent
>;

export interface RecordSessionRuntimeEventsCommand {
  sessionId: string;
  events: RuntimeProducedSessionEvent[];
  executionFence?: SessionExecutionFence;
}

export type RecordSessionRuntimeEventsResult =
  | { type: "recorded"; session: Session }
  | { type: "not_found" }
  | { type: "execution_fence_lost" }
  | { type: "version_conflict"; message: string };

export interface SessionRuntimeProjectionApplicationPort {
  recordSessionRuntimeEvents(
    command: RecordSessionRuntimeEventsCommand,
  ): Promise<RecordSessionRuntimeEventsResult>;
}

export interface LoadSessionRuntimeHistoryQuery {
  sessionId: string;
}

export type LoadSessionRuntimeHistoryResult =
  | {
      type: "found";
      initialEvents: SessionBootstrapEvent[];
      events: SessionEventView[];
    }
  | { type: "not_found" };

export interface SessionRuntimeHistoryApplicationPort {
  loadSessionRuntimeHistory(
    query: LoadSessionRuntimeHistoryQuery,
  ): Promise<LoadSessionRuntimeHistoryResult>;
}
