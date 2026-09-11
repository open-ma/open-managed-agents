import type { SessionThread } from "@open-managed-agents/domain/sessions";
import type {
  ArchiveSessionThread,
  ArchiveSessionThreadResult,
  InsertSessionThread,
  ListSessionThreads,
  SessionThreadLocation,
  SessionThreadStore,
} from "@open-managed-agents/session-thread-store";
import type { SqlClient } from "@open-managed-agents/sql-client";

interface SessionThreadRow {
  id: string;
  document: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

function timestamp(value: string): number {
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) {
    throw new Error(`Invalid Session Thread timestamp: ${value}`);
  }
  return milliseconds;
}

function toSessionThread(row: SessionThreadRow): SessionThread {
  const thread = JSON.parse(row.document) as SessionThread;
  return {
    ...thread,
    id: row.id,
    createdAt: new Date(Number(row.created_at)).toISOString(),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
    archivedAt: row.archived_at === null
      ? null
      : new Date(Number(row.archived_at)).toISOString(),
  };
}

export class SqlSessionThreadStore implements SessionThreadStore {
  constructor(
    private readonly client: SqlClient,
    private readonly options: { now?: () => Date } = {},
  ) {}

  async insert(input: InsertSessionThread): Promise<SessionThread> {
    const value = input.thread;
    const fence = input.executionFence;
    if (fence !== undefined && (fence.workspaceId !== input.workspaceId || fence.sessionId !== value.sessionId)) {
      throw new Error("Session Thread creation fence scope does not match the parent Session");
    }
    const guard = fence === undefined ? "" : `WHERE EXISTS (
      SELECT 1 FROM managed_session_executions
        WHERE workspace_id = ? AND id = ? AND session_id = ?
          AND state = 'running' AND attempt_id = ? AND owner_id = ?
          AND generation = ? AND lease_expires_at_ms > ?
    )`;
    const fenceBindings = fence === undefined ? [] : [fence.workspaceId, fence.executionId,
      fence.sessionId, fence.attemptId, fence.ownerId, fence.generation,
      (this.options.now?.() ?? new Date()).getTime()];
    const result = await this.client
      .prepare(
        `INSERT INTO managed_session_threads
          (workspace_id, session_id, id, document, created_at, updated_at, archived_at)
         SELECT ?, ?, ?, ?, ?, ?, ? ${guard}`,
      )
      .bind(
        input.workspaceId,
        value.sessionId,
        value.id,
        JSON.stringify(value),
        timestamp(value.createdAt),
        timestamp(value.updatedAt),
        value.archivedAt === null ? null : timestamp(value.archivedAt),
        ...fenceBindings,
      )
      .run();
    if (result.meta.changes !== 1) {
      if (fence !== undefined && result.meta.changes === 0) {
        throw new Error("Session Thread creation rejected because its parent execution fence was lost");
      }
      throw new Error(
        `Session Thread insertion affected ${result.meta.changes} rows`,
      );
    }
    const inserted = await this.find({
      workspaceId: input.workspaceId,
      sessionId: value.sessionId,
      threadId: value.id,
    });
    if (inserted === null) throw new Error("Session Thread vanished after insert");
    return inserted;
  }

  async list(input: ListSessionThreads): Promise<SessionThread[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Session Thread list limit must be a positive integer");
    }
    const conditions = ["workspace_id = ?", "session_id = ?"];
    const parameters: Array<string | number> = [
      input.workspaceId,
      input.sessionId,
    ];
    if (input.position !== undefined) {
      const positionTime = timestamp(input.position.createdAt);
      conditions.push(
        "(created_at > ? OR (created_at = ? AND id > ?))",
      );
      parameters.push(
        positionTime,
        positionTime,
        input.position.threadId,
      );
    }
    parameters.push(input.limit);
    const rows = await this.client
      .prepare(
        `SELECT id, document, created_at, updated_at, archived_at
           FROM managed_session_threads
          WHERE ${conditions.join(" AND ")}
          ORDER BY created_at ASC, id ASC
          LIMIT ?`,
      )
      .bind(...parameters)
      .all<SessionThreadRow>();
    return (rows.results ?? []).map(toSessionThread);
  }

  async find(input: SessionThreadLocation): Promise<SessionThread | null> {
    const row = await this.client
      .prepare(
        `SELECT id, document, created_at, updated_at, archived_at
           FROM managed_session_threads
          WHERE workspace_id = ? AND session_id = ? AND id = ?`,
      )
      .bind(input.workspaceId, input.sessionId, input.threadId)
      .first<SessionThreadRow>();
    return row === null ? null : toSessionThread(row);
  }

  async archive(
    input: ArchiveSessionThread,
  ): Promise<ArchiveSessionThreadResult> {
    const archivedAt = timestamp(input.archivedAt);
    const result = await this.client
      .prepare(
        `UPDATE managed_session_threads
            SET archived_at = ?, updated_at = ?
          WHERE workspace_id = ? AND session_id = ? AND id = ?
            AND archived_at IS NULL`,
      )
      .bind(
        archivedAt,
        archivedAt,
        input.workspaceId,
        input.sessionId,
        input.threadId,
      )
      .run();
    if (result.meta.changes !== 0 && result.meta.changes !== 1) {
      throw new Error(
        `Session Thread archive affected ${result.meta.changes} rows`,
      );
    }
    const thread = await this.find(input);
    if (thread === null) return { type: "not_found" };
    return {
      type: "archived",
      thread,
      transitioned: result.meta.changes === 1,
    };
  }
}
