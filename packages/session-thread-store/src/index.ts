import type { SessionThread } from "@open-managed-agents/domain/sessions";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";

export interface InsertSessionThread {
  workspaceId: string;
  thread: SessionThread;
  executionFence?: SessionExecutionFence;
}

export interface SessionThreadLocation {
  workspaceId: string;
  sessionId: string;
  threadId: string;
}

export interface SessionThreadListPosition {
  createdAt: string;
  threadId: string;
}

export interface ListSessionThreads {
  workspaceId: string;
  sessionId: string;
  limit: number;
  position?: SessionThreadListPosition;
}

export interface ArchiveSessionThread extends SessionThreadLocation {
  archivedAt: string;
}

export type ArchiveSessionThreadResult =
  | {
      type: "archived";
      thread: SessionThread;
      /** True only for the call that performed the state transition. */
      transitioned: boolean;
    }
  | { type: "not_found" };

export interface SessionThreadStore {
  insert(input: InsertSessionThread): Promise<SessionThread>;
  list(input: ListSessionThreads): Promise<SessionThread[]>;
  find(input: SessionThreadLocation): Promise<SessionThread | null>;
  archive(input: ArchiveSessionThread): Promise<ArchiveSessionThreadResult>;
}
