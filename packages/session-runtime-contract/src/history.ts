import type {
  SessionBootstrapEvent,
  SessionEventView,
} from "@open-managed-agents/domain/sessions";

export interface LoadSessionRuntimeHistoryRecord {
  workspaceId: string;
  sessionId: string;
}

export interface SessionRuntimeHistoryRecord {
  /** Native Session revision read in the same snapshot as this history. */
  revision?: number;
  initialEvents: SessionBootstrapEvent[];
  events: SessionEventView[];
  /** Present only when every persisted event has a unique, trusted source position. */
  orderedEvents?: OrderedSessionEvent[];
}

export interface SessionRuntimeHistorySourcePort {
  load(
    input: LoadSessionRuntimeHistoryRecord,
  ): Promise<SessionRuntimeHistoryRecord | null>;
}

/** Position assigned atomically by the existing Session revision CAS. */
export interface SessionEventSourcePosition {
  revision: number;
  index: number;
}

export interface OrderedSessionEvent {
  event: SessionEventView;
  position: SessionEventSourcePosition;
  executionId?: string;
}

/** Storage metadata is internal and must never become a public Managed event field. */
export function encodeSessionEventDocument(
  event: SessionEventView,
  position: SessionEventSourcePosition,
  executionId?: string,
): string {
  if (!Number.isSafeInteger(position.revision) || position.revision < 1 || !Number.isSafeInteger(position.index) || position.index < 0) {
    throw new Error('Invalid session event source position');
  }
  return JSON.stringify({
    ...event,
    source_position: { ...position, ...(executionId === undefined ? {} : { execution_id: executionId }) },
  });
}

export function decodeSessionEventDocument(document: string): {
  event: SessionEventView;
  position?: SessionEventSourcePosition;
  executionId?: string;
} {
  const { source_position: source, ...event } = JSON.parse(document) as SessionEventView & {
    source_position?: { revision?: unknown; index?: unknown; execution_id?: unknown };
  };
  const valid = source !== null && typeof source === 'object' &&
    typeof source.revision === 'number' && Number.isSafeInteger(source.revision) && source.revision >= 1 &&
    typeof source.index === 'number' && Number.isSafeInteger(source.index) && source.index >= 0;
  if (!valid) return { event: event as SessionEventView };
  return {
    event: event as SessionEventView,
    position: { revision: source.revision as number, index: source.index as number },
    ...(typeof source.execution_id === 'string' && source.execution_id.length > 0 ? { executionId: source.execution_id } : {}),
  };
}
