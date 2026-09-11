import { decodeSessionEventDocument, encodeSessionEventDocument } from '@open-managed-agents/session-runtime-contract/history';
import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  FindRuntimeProjectionSession,
  ProjectSessionRuntimeState,
  ProjectSessionRuntimeStateResult,
  SessionRuntimeProjectionPersistencePort,
  SessionThread,
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
    const environmentWorkFence = input.environmentWorkFence;
    if (fence !== undefined && environmentWorkFence !== undefined) {
      throw new Error("Runtime projection accepts exactly one execution fence");
    }
    if (
      fence !== undefined &&
      (fence.workspaceId !== input.workspaceId ||
        fence.sessionId !== input.sessionId)
    ) return { type: "execution_fence_lost" };
    if (
      environmentWorkFence !== undefined &&
      (environmentWorkFence.workspaceId !== input.workspaceId ||
        environmentWorkFence.sessionId !== input.sessionId ||
        !Number.isSafeInteger(environmentWorkFence.generation) ||
        environmentWorkFence.generation < 1)
    ) return { type: "execution_fence_lost" };
    const now = this.#now().getTime();
    const fenceSql = fence !== undefined
      ? `AND EXISTS (
           SELECT 1 FROM managed_session_executions
            WHERE workspace_id = ? AND id = ? AND session_id = ?
              AND state = 'running' AND attempt_id = ? AND owner_id = ?
              AND generation = ? AND lease_expires_at_ms > ?
         )`
      : environmentWorkFence !== undefined
        ? `AND EXISTS (
             SELECT 1 FROM managed_environment_work
              WHERE workspace_id = ? AND environment_id = ? AND id = ?
                AND session_id = ? AND state IN ('starting', 'active')
                AND claim_generation = ? AND claim_at IS NOT NULL
                AND claim_at + heartbeat_ttl_seconds * 1000 > ?
           )`
        : "";
    const fenceBindings: Array<string | number> = fence !== undefined
      ? [
          fence.workspaceId,
          fence.executionId,
          fence.sessionId,
          fence.attemptId,
          fence.ownerId,
          fence.generation,
          now,
        ]
      : environmentWorkFence !== undefined
        ? [
            environmentWorkFence.workspaceId,
            environmentWorkFence.environmentId,
            environmentWorkFence.workId,
            environmentWorkFence.sessionId,
            environmentWorkFence.generation,
            now,
          ]
        : [];
    const existingEvents = await Promise.all(input.events.map((event) =>
      this.client.prepare(
        `SELECT document FROM managed_session_events
          WHERE workspace_id = ? AND session_id = ? AND id = ?`,
      ).bind(input.workspaceId, input.sessionId, event.id).first<{
        document: string;
      }>()
    ));
    if (existingEvents.some((row) => row !== null)) {
      const exactReplay = existingEvents.every((row, index) =>
        row !== null && JSON.stringify(decodeSessionEventDocument(row.document).event) === JSON.stringify(input.events[index])
      );
      if (!exactReplay) {
        throw new Error(
          "Runtime projection event IDs collide with a different or partial batch",
        );
      }
      if (!await this.isFenceActive(input, now)) {
        return { type: "execution_fence_lost" };
      }
      const current = await this.findCurrent(input);
      return current === null
        ? { type: "not_found" }
        : { type: "projected", record: current };
    }
    const eventStatements = input.events.map((event, index) => {
      return this.client.prepare(
          `INSERT INTO managed_session_events
            (workspace_id, session_id, thread_id, id, type, document, processed_at)
           SELECT ?, ?, ?, ?, ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM managed_sessions
               WHERE workspace_id = ? AND id = ? AND revision = ?
            )
              ${fenceSql}
           ON CONFLICT (workspace_id, session_id, id) DO NOTHING`,
        ).bind(
          input.workspaceId,
          input.sessionId,
          "sessionThreadId" in event ? event.sessionThreadId ?? null : null,
          event.id,
          event.type,
          encodeSessionEventDocument(event, { revision: input.expectedRevision + 1, index }, fence?.executionId),
          timestamp(event.processedAt),
          input.workspaceId,
          input.sessionId,
          input.expectedRevision,
          ...fenceBindings,
        );
    });
    // Thread CRUD is a projection of the same native lifecycle facts. Update
    // the existing Thread records under this Session CAS/fence, so a stale
    // child cannot publish a status after the parent loses ownership.
    const threadUpdates = new Map<string, SessionThread>();
    for (const event of input.events) {
      if (!("sessionThreadId" in event) || typeof event.sessionThreadId !== "string") continue;
      const status = event.type === "session.thread_status_running" ? "running"
        : event.type === "session.thread_status_idle" ? "idle"
        : event.type === "session.thread_status_terminated" ? "terminated"
        : event.type === "session.thread_status_rescheduled" ? "rescheduling" : undefined;
      if (status === undefined) continue;
      let thread = threadUpdates.get(event.sessionThreadId);
      if (thread === undefined) {
        const row = await this.client.prepare(
          `SELECT document FROM managed_session_threads
            WHERE workspace_id = ? AND session_id = ? AND id = ?`,
        ).bind(input.workspaceId, input.sessionId, event.sessionThreadId).first<{ document: string }>();
        if (row === null) continue;
        thread = JSON.parse(row.document) as SessionThread;
      }
      threadUpdates.set(event.sessionThreadId, { ...thread, status,
        updatedAt: event.processedAt > thread.updatedAt ? event.processedAt : thread.updatedAt });
    }
    const threadStatements = [...threadUpdates.values()].map((thread) => this.client.prepare(
      `UPDATE managed_session_threads SET document = ?, updated_at = ?
        WHERE workspace_id = ? AND session_id = ? AND id = ?
          AND EXISTS (
            SELECT 1 FROM managed_sessions
              WHERE workspace_id = ? AND id = ? AND revision = ?
          ) ${fenceSql}`,
    ).bind(JSON.stringify(thread), timestamp(thread.updatedAt), input.workspaceId,
      input.sessionId, thread.id, input.workspaceId, input.sessionId,
      input.expectedRevision, ...fenceBindings));
    const next = input.next;
    const update = this.client.prepare(
        `UPDATE managed_sessions
            SET document = ?, revision = revision + 1, agent_id = ?,
                agent_version = ?, environment_id = ?, deployment_id = ?,
                status = ?, updated_at = ?, archived_at = ?
          WHERE workspace_id = ? AND id = ? AND revision = ?
            ${fenceSql}`,
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
        ...fenceBindings,
      );
    // Serialize event insertion with accepted inputs and other runtime batches
    // before publishing the successful Session revision as an ordering fact.
    const revisionGuard = this.client.prepare(
      `UPDATE managed_sessions SET revision = revision
        WHERE workspace_id = ? AND id = ? AND revision = ? ${fenceSql}`,
    ).bind(input.workspaceId, input.sessionId, input.expectedRevision, ...fenceBindings);
    const results = await this.client.batch([revisionGuard, ...eventStatements, ...threadStatements, update]);
    const updateResult = results[results.length - 1];
    if (updateResult === undefined) {
      throw new Error("Runtime projection batch returned no update result");
    }
    if (updateResult.meta.changes === 0) {
      if (!await this.isFenceActive(input, now)) {
        return { type: "execution_fence_lost" };
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

  private async isFenceActive(
    input: ProjectSessionRuntimeState,
    now: number,
  ): Promise<boolean> {
    const fence = input.executionFence;
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
      return active !== null;
    }
    const environmentWorkFence = input.environmentWorkFence;
    if (environmentWorkFence !== undefined) {
      const active = await this.client.prepare(
        `SELECT 1 AS active FROM managed_environment_work
          WHERE workspace_id = ? AND environment_id = ? AND id = ?
            AND session_id = ? AND state IN ('starting', 'active')
            AND claim_generation = ? AND claim_at IS NOT NULL
            AND claim_at + heartbeat_ttl_seconds * 1000 > ?`,
      ).bind(
        environmentWorkFence.workspaceId,
        environmentWorkFence.environmentId,
        environmentWorkFence.workId,
        environmentWorkFence.sessionId,
        environmentWorkFence.generation,
        now,
      ).first<{ active: number }>();
      return active !== null;
    }
    return true;
  }
}
