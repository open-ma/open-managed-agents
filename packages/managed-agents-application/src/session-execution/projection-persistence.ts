import type { Session } from "../domain/session";
import type { StoredSession } from "@open-managed-agents/session-store";
import type {
  RuntimeProducedSessionEvent,
  SessionExecutionFence,
} from "./port";

export interface FindRuntimeProjectionSession {
  workspaceId: string;
  sessionId: string;
}

export interface ProjectSessionRuntimeState extends FindRuntimeProjectionSession {
  expectedRevision: number;
  events: RuntimeProducedSessionEvent[];
  next: Session;
  executionFence?: SessionExecutionFence;
}

export type ProjectSessionRuntimeStateResult =
  | { type: "projected"; record: StoredSession }
  | { type: "not_found" }
  | { type: "execution_fence_lost" }
  | { type: "revision_conflict"; actualRevision: number };

export interface SessionRuntimeProjectionPersistencePort {
  findCurrent(
    input: FindRuntimeProjectionSession,
  ): Promise<StoredSession | null>;
  project(
    input: ProjectSessionRuntimeState,
  ): Promise<ProjectSessionRuntimeStateResult>;
}
