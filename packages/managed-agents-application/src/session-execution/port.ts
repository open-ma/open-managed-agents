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

/**
 * Ownership proof carried by a self-hosted Environment Work executor.
 * `generation` changes only when Work is claimed or reclaimed; heartbeats
 * extend the lease without changing it. Persistence validates this proof in
 * the same transaction that appends runtime events.
 */
export interface EnvironmentWorkExecutionFence {
  workspaceId: string;
  environmentId: string;
  sessionId: string;
  workId: string;
  generation: number;
}

export type RuntimeProducedSessionEvent = Exclude<
  SessionEventView,
  SentSessionEvent
>;

export interface RecordSessionRuntimeEventsCommand {
  sessionId: string;
  events: RuntimeProducedSessionEvent[];
  executionFence?: SessionExecutionFence;
  environmentWorkFence?: EnvironmentWorkExecutionFence;
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

/** Application view of an event's stable place in the Session history. */
export interface SessionRuntimeHistoryEventView {
  event: SessionEventView;
  position: {
    revision: number;
    index: number;
  };
  executionId?: string;
}

export type LoadSessionRuntimeHistoryResult =
  | {
      type: "found";
      /** Native Session revision from the same history snapshot. */
      revision?: number;
      initialEvents: SessionBootstrapEvent[];
      events: SessionEventView[];
      orderedEvents?: SessionRuntimeHistoryEventView[];
    }
  | { type: "not_found" };

export interface SessionRuntimeHistoryApplicationPort {
  loadSessionRuntimeHistory(
    query: LoadSessionRuntimeHistoryQuery,
  ): Promise<LoadSessionRuntimeHistoryResult>;
}
