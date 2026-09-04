import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  FindRuntimeProjectionSession,
  ProjectSessionRuntimeState,
  ProjectSessionRuntimeStateResult,
  SessionRuntimeProjectionPersistencePort,
} from "@open-managed-agents/managed-agents-application";
import type { StoredSession } from "@open-managed-agents/session-store";
import { sessionFromSourceRow } from "./session-sql-source";

interface ProjectionSessionRow {
  id: string;
  document: string;
  revision: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

function timestamp(value: string): number {
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) {
    throw new Error(`Invalid runtime projection timestamp: ${value}`);
  }
  return milliseconds;
}

function storedSession(row: ProjectionSessionRow): StoredSession {
  return {
    revision: Number(row.revision),
    session: sessionFromSourceRow(row),
  };
}

export class SqlSessionRuntimeProjectionPersistence
  implements SessionRuntimeProjectionPersistencePort
{
  readonly #now: () => Date;

  constructor(
    private readonly client: SqlClient,
    options: { now?: () => Date } = {},
  ) {
    this.#now = options.now ?? (() => new Date());
  }

  async findCurrent(
    input: FindRuntimeProjectionSession,
  ): Promise<StoredSession | null> {
    const row = await this.client
      .prepare(
        `SELECT id, document, revision, created_at, updated_at, archived_at
           FROM managed_sessions
          WHERE workspace_id = ? AND id = ?`,
      )
      .bind(input.workspaceId, input.sessionId)
      .first<ProjectionSessionRow>();
    return row === null ? null : storedSession(row);
  }

  async project(
    input: ProjectSessionRuntimeState,
  ): Promise<ProjectSessionRuntimeStateResult> {
    if (input.next.id !== input.sessionId) {
      throw new Error("Projected session ID does not match the target session");
    }
    const fence = input.executionFence;
    if (
      fence !== undefined &&
      (fence.workspaceId !== input.workspaceId ||
        fence.sessionId !== input.sessionId)
    ) return { type: "execution_fence_lost" };
    const now = this.#now().getTime();
    const eventStatements = input.events.map((event) => {
      const statement = fence === undefined
        ? this.client.prepare(
            `INSERT INTO managed_session_events
            (workspace_id, session_id, thread_id, id, type, document, processed_at)
           SELECT ?, ?, ?, ?, ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM managed_sessions
               WHERE workspace_id = ? AND id = ? AND revision = ?
            )
           ON CONFLICT (workspace_id, session_id, id) DO NOTHING`,
          ).bind(
          input.workspaceId,
          input.sessionId,
          "sessionThreadId" in event ? event.sessionThreadId ?? null : null,
          event.id,
          event.type,
          JSON.stringify(event),
          timestamp(event.processedAt),
          input.workspaceId,
          input.sessionId,
          input.expectedRevision,
        )
        : this.client.prepare(
            `INSERT INTO managed_session_events
              (workspace_id, session_id, thread_id, id, type, document, processed_at)
             SELECT ?, ?, ?, ?, ?, ?, ?
              WHERE EXISTS (
                SELECT 1 FROM managed_sessions
                 WHERE workspace_id = ? AND id = ? AND revision = ?
              )
                AND EXISTS (
                  SELECT 1 FROM managed_session_executions
                   WHERE workspace_id = ? AND id = ? AND session_id = ?
                     AND state = 'running' AND attempt_id = ? AND owner_id = ?
                     AND generation = ? AND lease_expires_at_ms > ?
                )
             ON CONFLICT (workspace_id, session_id, id) DO NOTHING`,
          ).bind(
            input.workspaceId,
            input.sessionId,
            "sessionThreadId" in event ? event.sessionThreadId ?? null : null,
            event.id,
            event.type,
            JSON.stringify(event),
            timestamp(event.processedAt),
            input.workspaceId,
            input.sessionId,
            input.expectedRevision,
            fence.workspaceId,
            fence.executionId,
            fence.sessionId,
            fence.attemptId,
            fence.ownerId,
            fence.generation,
            now,
          );
      return statement;
    });
    const next = input.next;
    const update = fence === undefined
      ? this.client.prepare(
          `UPDATE managed_sessions
            SET document = ?, revision = revision + 1, agent_id = ?,
                agent_version = ?, environment_id = ?, deployment_id = ?,
                status = ?, updated_at = ?, archived_at = ?
          WHERE workspace_id = ? AND id = ? AND revision = ?`,
        ).bind(
        JSON.stringify(next),
        next.agent.id,
        next.agent.version,
        next.environmentId,
        next.deploymentId ?? null,
        next.status,
        timestamp(next.updatedAt),
        next.archivedAt === null ? null : timestamp(next.archivedAt),
        input.workspaceId,
        input.sessionId,
        input.expectedRevision,
      )
      : this.client.prepare(
          `UPDATE managed_sessions
              SET document = ?, revision = revision + 1, agent_id = ?,
                  agent_version = ?, environment_id = ?, deployment_id = ?,
                  status = ?, updated_at = ?, archived_at = ?
            WHERE workspace_id = ? AND id = ? AND revision = ?
              AND EXISTS (
                SELECT 1 FROM managed_session_executions
                 WHERE workspace_id = ? AND id = ? AND session_id = ?
                   AND state = 'running' AND attempt_id = ? AND owner_id = ?
                   AND generation = ? AND lease_expires_at_ms > ?
              )`,
        ).bind(
          JSON.stringify(next),
          next.agent.id,
          next.agent.version,
          next.environmentId,
          next.deploymentId ?? null,
          next.status,
          timestamp(next.updatedAt),
          next.archivedAt === null ? null : timestamp(next.archivedAt),
          input.workspaceId,
          input.sessionId,
          input.expectedRevision,
          fence.workspaceId,
          fence.executionId,
          fence.sessionId,
          fence.attemptId,
          fence.ownerId,
          fence.generation,
          now,
        );
    const results = await this.client.batch([...eventStatements, update]);
    const updateResult = results[results.length - 1];
    if (updateResult === undefined) {
      throw new Error("Runtime projection batch returned no update result");
    }
    if (updateResult.meta.changes === 0) {
      if (fence !== undefined) {
        const active = await this.client.prepare(
          `SELECT 1 AS active FROM managed_session_executions
            WHERE workspace_id = ? AND id = ? AND session_id = ?
              AND state = 'running' AND attempt_id = ? AND owner_id = ?
              AND generation = ? AND lease_expires_at_ms > ?`,
        ).bind(
          fence.workspaceId,
          fence.executionId,
          fence.sessionId,
          fence.attemptId,
          fence.ownerId,
          fence.generation,
          now,
        ).first<{ active: number }>();
        if (active === null) return { type: "execution_fence_lost" };
      }
      const current = await this.findCurrent(input);
      return current === null
        ? { type: "not_found" }
        : {
            type: "revision_conflict",
            actualRevision: current.revision,
          };
    }
    if (updateResult.meta.changes !== 1) {
      throw new Error(
        `Runtime projection affected ${updateResult.meta.changes} session rows`,
      );
    }
    const projected = await this.findCurrent(input);
    if (projected === null) {
      throw new Error("Session vanished after runtime projection");
    }
    return { type: "projected", record: projected };
  }
}
