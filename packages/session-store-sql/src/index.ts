import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  FindCurrentSessionRecord,
  ArchiveSessionRecord,
  ArchiveSessionRecordResult,
  DeleteSessionRecordResult,
  InsertSessionRecord,
  ListSessionRecords,
  ReplaceSessionRecord,
  ReplaceSessionRecordResult,
  StoredSession,
  SessionStore,
} from "@open-managed-agents/session-store";
import type { SessionResourceSecretSealer } from "./secret-sealer";
import { sessionBootstrapExecutionEvents, sessionExecutionEventBatches } from "@open-managed-agents/session-runtime-contract/coordination";

export type { SessionResourceSecretSealer } from "./secret-sealer";

export interface SqlSessionStoreOptions {
  /** Commit bootstrap execution work atomically with the new Session. */
  executionOutbox?: boolean;
  executionPolicy?: { maxAttempts: number; timeoutMs: number };
}

interface SessionRow {
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
    throw new Error(`Invalid session timestamp: ${value}`);
  }
  return milliseconds;
}

function toStoredSession(row: SessionRow): StoredSession {
  const session = JSON.parse(row.document) as StoredSession["session"];
  return {
    revision: Number(row.revision),
    session: {
      ...session,
      id: row.id,
      createdAt: new Date(Number(row.created_at)).toISOString(),
      updatedAt: new Date(Number(row.updated_at)).toISOString(),
      archivedAt:
        row.archived_at === null
          ? null
          : new Date(Number(row.archived_at)).toISOString(),
    },
  };
}

export class SqlSessionStore implements SessionStore {
  constructor(
    private readonly client: SqlClient,
    private readonly sealer: SessionResourceSecretSealer,
    private readonly options: SqlSessionStoreOptions = {},
  ) {}

  async insert(input: InsertSessionRecord): Promise<StoredSession> {
    const session = input.session;
    const sealedResourceSecrets = await Promise.all(
      input.resourceSecrets.map(async (secret) => ({
        ...secret,
        sealedValue: await this.sealer.seal(secret.authorizationToken),
      })),
    );
    const bootstrapBatches = this.options.executionOutbox === true
      ? sessionExecutionEventBatches(sessionBootstrapExecutionEvents({
          sessionId: session.id, createdAt: session.createdAt, initialEvents: input.initialEvents,
        }))
      : [];
    const policy = this.options.executionPolicy ?? { maxAttempts: 10, timeoutMs: 60 * 60 * 1_000 };
    const statements = [
      this.client
        .prepare(
          `INSERT INTO managed_sessions
            (id, workspace_id, document, revision, agent_id, agent_version,
             environment_id, deployment_id, status, created_at, updated_at, archived_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          session.id,
          input.workspaceId,
          JSON.stringify(session),
          1,
          session.agent.id,
          session.agent.version,
          session.environmentId,
          session.deploymentId ?? null,
          session.status,
          timestamp(session.createdAt),
          timestamp(session.updatedAt),
          session.archivedAt === null ? null : timestamp(session.archivedAt),
        ),
      ...session.resources
        .filter((resource) => resource.type === "memory_store")
        .map((resource) =>
          this.client
            .prepare(
              `INSERT INTO managed_session_memory_stores
                (session_id, workspace_id, memory_store_id)
               VALUES (?, ?, ?)`,
            )
            .bind(session.id, input.workspaceId, resource.memoryStoreId),
        ),
      ...input.initialEvents.map((event, sequence) =>
        this.client
          .prepare(
            `INSERT INTO managed_session_initial_events
              (session_id, workspace_id, sequence, document)
             VALUES (?, ?, ?, ?)`,
          )
          .bind(session.id, input.workspaceId, sequence, JSON.stringify(event)),
      ),
      ...sealedResourceSecrets.map((secret) =>
        this.client
          .prepare(
            `INSERT INTO managed_session_resource_secrets
              (workspace_id, session_id, resource_id, secret_type, sealed_value, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            input.workspaceId,
            session.id,
            secret.resourceId,
            secret.type,
            secret.sealedValue,
            timestamp(session.createdAt),
          ),
      ),
      ...bootstrapBatches.map((batch) => {
        const eventsJson = JSON.stringify(batch.events);
        return this.client.prepare(
          `INSERT INTO managed_session_executions (
             workspace_id, session_id, lane_id, id, admitted_at_ms, events_json,
             events_fingerprint, state, generation, attempt_count, max_attempts,
             deadline_at_ms, revision
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, 0, ?, ?, 1)`,
        ).bind(input.workspaceId, session.id, batch.laneId, batch.id,
          timestamp(session.createdAt), eventsJson, eventsJson, policy.maxAttempts,
          timestamp(session.createdAt) + policy.timeoutMs);
      }),
    ];
    const results = await this.client.batch(statements);
    if (results.some((result) => result.meta.changes !== 1)) {
      throw new Error("Session insertion violated atomic write invariants");
    }
    const inserted = await this.findCurrent({
      workspaceId: input.workspaceId,
      sessionId: session.id,
    });
    if (inserted === null) throw new Error("Session vanished after insert");
    return inserted;
  }

  async findCurrent(
    input: FindCurrentSessionRecord,
  ): Promise<StoredSession | null> {
    const row = await this.client
      .prepare(
        `SELECT id, document, revision, created_at, updated_at, archived_at
           FROM managed_sessions
          WHERE workspace_id = ? AND id = ?`,
      )
      .bind(input.workspaceId, input.sessionId)
      .first<SessionRow>();
    return row === null ? null : toStoredSession(row);
  }

  async replaceCurrent(
    input: ReplaceSessionRecord,
  ): Promise<ReplaceSessionRecordResult> {
    if (input.next.id !== input.sessionId) {
      throw new Error("Replacement session ID does not match the target session");
    }
    const result = await this.client
      .prepare(
        `UPDATE managed_sessions
            SET document = ?, revision = revision + 1, agent_id = ?,
                agent_version = ?, environment_id = ?, deployment_id = ?,
                status = ?, updated_at = ?, archived_at = ?
          WHERE workspace_id = ? AND id = ? AND revision = ?`,
      )
      .bind(
        JSON.stringify(input.next),
        input.next.agent.id,
        input.next.agent.version,
        input.next.environmentId,
        input.next.deploymentId ?? null,
        input.next.status,
        timestamp(input.next.updatedAt),
        input.next.archivedAt === null
          ? null
          : timestamp(input.next.archivedAt),
        input.workspaceId,
        input.sessionId,
        input.expectedRevision,
      )
      .run();
    if (result.meta.changes === 0) {
      const current = await this.findCurrent({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
      });
      return current === null
        ? { type: "not_found" }
        : { type: "revision_conflict", actualRevision: current.revision };
    }
    if (result.meta.changes !== 1) {
      throw new Error(`Session replacement affected ${result.meta.changes} rows`);
    }
    const record = await this.findCurrent({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
    });
    if (record === null) throw new Error("Session vanished after replacement");
    return { type: "replaced", record };
  }

  async archiveCurrent(
    input: ArchiveSessionRecord,
  ): Promise<ArchiveSessionRecordResult> {
    const archivedAt = timestamp(input.archivedAt);
    const result = await this.client
      .prepare(
        `UPDATE managed_sessions
            SET archived_at = ?, updated_at = ?, revision = revision + 1
          WHERE workspace_id = ? AND id = ?`,
      )
      .bind(archivedAt, archivedAt, input.workspaceId, input.sessionId)
      .run();
    if (result.meta.changes === 0) return { type: "not_found" };
    if (result.meta.changes !== 1) {
      throw new Error(`Session archive affected ${result.meta.changes} rows`);
    }
    const record = await this.findCurrent({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
    });
    if (record === null) throw new Error("Session vanished after archive");
    return { type: "archived", record };
  }

  async deleteCurrent(
    input: FindCurrentSessionRecord,
  ): Promise<DeleteSessionRecordResult> {
    const results = await this.client.batch([
      this.client
        .prepare(
          `DELETE FROM managed_session_events
            WHERE workspace_id = ? AND session_id = ?`,
        )
        .bind(input.workspaceId, input.sessionId),
      this.client
        .prepare(
          `DELETE FROM managed_session_threads
            WHERE workspace_id = ? AND session_id = ?`,
        )
        .bind(input.workspaceId, input.sessionId),
      this.client
        .prepare(
          `DELETE FROM managed_session_resource_secrets
            WHERE workspace_id = ? AND session_id = ?`,
        )
        .bind(input.workspaceId, input.sessionId),
      this.client
        .prepare(
          `DELETE FROM managed_session_initial_events
            WHERE workspace_id = ? AND session_id = ?`,
        )
        .bind(input.workspaceId, input.sessionId),
      this.client
        .prepare(
          `DELETE FROM managed_session_memory_stores
            WHERE workspace_id = ? AND session_id = ?`,
        )
        .bind(input.workspaceId, input.sessionId),
      this.client
        .prepare(
          `DELETE FROM managed_sessions
            WHERE workspace_id = ? AND id = ?`,
        )
        .bind(input.workspaceId, input.sessionId),
    ]);
    const sessionChanges = results[5]?.meta.changes;
    if (sessionChanges === 0) return { type: "not_found" };
    if (sessionChanges !== 1) {
      throw new Error(
        `Session deletion affected ${sessionChanges ?? "missing"} rows`,
      );
    }
    return { type: "deleted" };
  }

  async listCurrent(input: ListSessionRecords): Promise<StoredSession[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Session list limit must be a positive integer");
    }
    if (input.statuses !== undefined && input.statuses.length === 0) return [];
    const conditions = ["workspace_id = ?"];
    const parameters: Array<string | number> = [input.workspaceId];
    if (!input.includeArchived) conditions.push("archived_at IS NULL");
    if (input.agentId !== undefined) {
      conditions.push("agent_id = ?");
      parameters.push(input.agentId);
    }
    if (input.agentVersion !== undefined) {
      conditions.push("agent_version = ?");
      parameters.push(input.agentVersion);
    }
    if (input.createdAfter !== undefined) {
      conditions.push("created_at > ?");
      parameters.push(timestamp(input.createdAfter));
    }
    if (input.createdAtOrAfter !== undefined) {
      conditions.push("created_at >= ?");
      parameters.push(timestamp(input.createdAtOrAfter));
    }
    if (input.createdBefore !== undefined) {
      conditions.push("created_at < ?");
      parameters.push(timestamp(input.createdBefore));
    }
    if (input.createdAtOrBefore !== undefined) {
      conditions.push("created_at <= ?");
      parameters.push(timestamp(input.createdAtOrBefore));
    }
    if (input.deploymentId !== undefined) {
      conditions.push("deployment_id = ?");
      parameters.push(input.deploymentId);
    }
    if (input.statuses !== undefined) {
      conditions.push(`status IN (${input.statuses.map(() => "?").join(", ")})`);
      parameters.push(...input.statuses);
    }
    if (input.memoryStoreId !== undefined) {
      conditions.push(
        `EXISTS (
          SELECT 1 FROM managed_session_memory_stores AS memory_link
           WHERE memory_link.workspace_id = managed_sessions.workspace_id
             AND memory_link.session_id = managed_sessions.id
             AND memory_link.memory_store_id = ?
        )`,
      );
      parameters.push(input.memoryStoreId);
    }
    if (input.position !== undefined) {
      const nextOperator = input.order === "asc" ? ">" : "<";
      const previousOperator = input.order === "asc" ? "<" : ">";
      const operator =
        input.position.direction === "next" ? nextOperator : previousOperator;
      const positionTime = timestamp(input.position.createdAt);
      conditions.push(
        `(created_at ${operator} ? OR (created_at = ? AND id ${operator} ?))`,
      );
      parameters.push(
        positionTime,
        positionTime,
        input.position.sessionId,
      );
    }
    const requestedDirection = input.order === "asc" ? "ASC" : "DESC";
    const queryDirection =
      input.position?.direction === "previous"
        ? requestedDirection === "ASC"
          ? "DESC"
          : "ASC"
        : requestedDirection;
    parameters.push(input.limit);
    const rows = await this.client
      .prepare(
        `SELECT id, document, revision, created_at, updated_at, archived_at
           FROM managed_sessions
          WHERE ${conditions.join(" AND ")}
          ORDER BY created_at ${queryDirection}, id ${queryDirection}
          LIMIT ?`,
      )
      .bind(...parameters)
      .all<SessionRow>();
    return (rows.results ?? []).map(toStoredSession);
  }
}
