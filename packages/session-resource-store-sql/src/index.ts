import type { Session } from "@open-managed-agents/domain/sessions";
import type {
  FindCurrentSessionResources,
  ReplaceCurrentSessionResources,
  ReplaceCurrentSessionResourcesResult,
  SessionResourceSecretChange,
  SessionResourceSecretSource,
  SessionResourceStore,
  StoredSessionResources,
} from "@open-managed-agents/session-resource-store";
import type { SqlClient, SqlStatement } from "@open-managed-agents/sql-client";

export interface SessionResourceSecretSealer {
  seal(value: string): Promise<string>;
}

export interface SessionResourceSecretOpener {
  open(value: string): Promise<string>;
}

interface SessionResourceSecretRow {
  sealed_value: string;
}

export class SqlSessionResourceSecretSource
  implements SessionResourceSecretSource
{
  constructor(
    private readonly client: SqlClient,
    private readonly opener: SessionResourceSecretOpener,
  ) {}

  async findGithubToken(input: {
    workspaceId: string;
    sessionId: string;
    resourceId: string;
  }): Promise<string | null> {
    const row = await this.client
      .prepare(
        `SELECT sealed_value
           FROM managed_session_resource_secrets
          WHERE workspace_id = ? AND session_id = ? AND resource_id = ?
            AND secret_type = 'github_token'`,
      )
      .bind(input.workspaceId, input.sessionId, input.resourceId)
      .first<SessionResourceSecretRow>();
    return row === null ? null : this.opener.open(row.sealed_value);
  }
}

interface SessionResourceRow {
  document: string;
  revision: number;
}

function timestamp(value: string): number {
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) {
    throw new Error(`Invalid Session Resource timestamp: ${value}`);
  }
  return milliseconds;
}

function toStoredResources(row: SessionResourceRow): StoredSessionResources {
  const session = JSON.parse(row.document) as Session;
  return {
    resources: session.resources,
    revision: Number(row.revision),
  };
}

interface SealedSecretChange {
  change: SessionResourceSecretChange;
  sealedValue?: string;
}

export class SqlSessionResourceStore implements SessionResourceStore {
  constructor(
    private readonly client: SqlClient,
    private readonly sealer: SessionResourceSecretSealer,
  ) {}

  async findCurrent(
    input: FindCurrentSessionResources,
  ): Promise<StoredSessionResources | null> {
    const row = await this.client
      .prepare(
        `SELECT document, revision
           FROM managed_sessions
          WHERE workspace_id = ? AND id = ?`,
      )
      .bind(input.workspaceId, input.sessionId)
      .first<SessionResourceRow>();
    return row === null ? null : toStoredResources(row);
  }

  async replaceCurrent(
    input: ReplaceCurrentSessionResources,
  ): Promise<ReplaceCurrentSessionResourcesResult> {
    const row = await this.client
      .prepare(
        `SELECT document, revision
           FROM managed_sessions
          WHERE workspace_id = ? AND id = ?`,
      )
      .bind(input.workspaceId, input.sessionId)
      .first<SessionResourceRow>();
    if (row === null) return { type: "not_found" };
    if (Number(row.revision) !== input.expectedRevision) {
      return {
        type: "revision_conflict",
        actualRevision: Number(row.revision),
      };
    }

    const current = JSON.parse(row.document) as Session;
    const next: Session = {
      ...current,
      resources: input.resources,
      updatedAt: input.updatedAt,
    };
    const sealedChanges: SealedSecretChange[] = await Promise.all(
      input.secretChanges.map(async (change) =>
        change.type === "store_github_token"
          ? { change, sealedValue: await this.sealer.seal(change.authorizationToken) }
          : { change }),
    );
    const statements: SqlStatement[] = [
      this.client
        .prepare(
          `DELETE FROM managed_session_memory_stores
            WHERE workspace_id = ? AND session_id = ?
              AND EXISTS (
                SELECT 1 FROM managed_sessions
                 WHERE workspace_id = ? AND id = ? AND revision = ?
              )`,
        )
        .bind(
          input.workspaceId,
          input.sessionId,
          input.workspaceId,
          input.sessionId,
          input.expectedRevision,
        ),
      ...input.resources
        .filter((resource) => resource.type === "memory_store")
        .map((resource) =>
          this.client
            .prepare(
              `INSERT INTO managed_session_memory_stores
                (session_id, workspace_id, memory_store_id)
               SELECT ?, ?, ?
                WHERE EXISTS (
                  SELECT 1 FROM managed_sessions
                   WHERE workspace_id = ? AND id = ? AND revision = ?
                )`,
            )
            .bind(
              input.sessionId,
              input.workspaceId,
              resource.memoryStoreId,
              input.workspaceId,
              input.sessionId,
              input.expectedRevision,
            )),
    ];
    for (const sealed of sealedChanges) {
      const change = sealed.change;
      if (change.type === "store_github_token") {
        statements.push(
          this.client
            .prepare(
              `INSERT INTO managed_session_resource_secrets
                (workspace_id, session_id, resource_id, secret_type, sealed_value, updated_at)
               SELECT ?, ?, ?, 'github_token', ?, ?
                WHERE EXISTS (
                  SELECT 1 FROM managed_sessions
                   WHERE workspace_id = ? AND id = ? AND revision = ?
                )
               ON CONFLICT (workspace_id, session_id, resource_id)
               DO UPDATE SET secret_type = excluded.secret_type,
                             sealed_value = excluded.sealed_value,
                             updated_at = excluded.updated_at`,
            )
            .bind(
              input.workspaceId,
              input.sessionId,
              change.resourceId,
              sealed.sealedValue,
              timestamp(input.updatedAt),
              input.workspaceId,
              input.sessionId,
              input.expectedRevision,
            ),
        );
      } else {
        statements.push(
          this.client
            .prepare(
              `DELETE FROM managed_session_resource_secrets
                WHERE workspace_id = ? AND session_id = ? AND resource_id = ?
                  AND EXISTS (
                    SELECT 1 FROM managed_sessions
                     WHERE workspace_id = ? AND id = ? AND revision = ?
                  )`,
            )
            .bind(
              input.workspaceId,
              input.sessionId,
              change.resourceId,
              input.workspaceId,
              input.sessionId,
              input.expectedRevision,
            ),
        );
      }
    }
    statements.push(
      this.client
        .prepare(
          `UPDATE managed_sessions
              SET document = ?, revision = revision + 1, updated_at = ?
            WHERE workspace_id = ? AND id = ? AND revision = ?`,
        )
        .bind(
          JSON.stringify(next),
          timestamp(input.updatedAt),
          input.workspaceId,
          input.sessionId,
          input.expectedRevision,
        ),
    );

    const results = await this.client.batch(statements);
    const sessionChanges = results[results.length - 1]?.meta.changes;
    if (sessionChanges === 0) {
      const currentRecord = await this.findCurrent({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
      });
      return currentRecord === null
        ? { type: "not_found" }
        : {
            type: "revision_conflict",
            actualRevision: currentRecord.revision,
          };
    }
    if (sessionChanges !== 1) {
      throw new Error(
        `Session Resource replacement affected ${sessionChanges ?? "missing"} Session rows`,
      );
    }
    return {
      type: "replaced",
      record: {
        resources: structuredClone(input.resources),
        revision: input.expectedRevision + 1,
      },
    };
  }
}
