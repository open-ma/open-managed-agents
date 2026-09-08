import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  ClaimAvailableEnvironmentWork,
  ClaimAvailableEnvironmentWorkResult,
  EnvironmentWorkLocation,
  EnvironmentWorkStore,
  EnvironmentWorkQueueStats,
  GetEnvironmentWorkQueueStatsRecord,
  FindActiveEnvironmentSessionWork,
  InsertEnvironmentWorkRecord,
  ListEnvironmentWorkRecords,
  ReplaceEnvironmentWorkRecord,
  ReplaceEnvironmentWorkRecordResult,
  StoredEnvironmentWork,
} from "@open-managed-agents/environment-work-store";
export interface EnvironmentWorkSecretCipher {
  seal(input: { plaintext: string }): Promise<{ ciphertext: string }>;
  open(input: { ciphertext: string }): Promise<{ plaintext: string }>;
}

interface EnvironmentWorkRow {
  id: string;
  document: string;
  sealed_secret: string;
  claim_at: number | null;
  claim_worker_id: string | null;
  claim_generation: number;
  heartbeat_ttl_seconds: number;
  revision: number;
  state: StoredEnvironmentWork["work"]["state"];
  created_at: number;
}

interface EnvironmentWorkStatsRow {
  depth: number;
  pending: number;
  oldest_queued_at: number | null;
}

interface EnvironmentWorkWorkerStatsRow {
  active: number;
  total: number;
}

function timestamp(value: string): number {
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) {
    throw new Error(`Invalid Environment Work timestamp: ${value}`);
  }
  return milliseconds;
}

export class SqlEnvironmentWorkStore
  implements EnvironmentWorkStore
{
  constructor(
    private readonly client: SqlClient,
    private readonly cipher: EnvironmentWorkSecretCipher,
  ) {}

  private async toStored(row: EnvironmentWorkRow): Promise<StoredEnvironmentWork> {
    const document = JSON.parse(row.document) as StoredEnvironmentWork["work"];
    const work = row.state === "queued"
      ? {
          ...document,
          acknowledgedAt: null,
          latestHeartbeatAt: null,
          startedAt: null,
          state: "queued" as const,
        }
      : { ...document, state: row.state };
    const opened = await this.cipher.open({ ciphertext: row.sealed_secret });
    const secret = JSON.parse(opened.plaintext) as StoredEnvironmentWork["secret"];
    return {
      work: {
        ...work,
        id: row.id,
        createdAt: new Date(Number(row.created_at)).toISOString(),
      },
      secret,
      claim:
        row.claim_at === null
          ? null
          : {
              claimedAt: new Date(Number(row.claim_at)).toISOString(),
              workerId: row.claim_worker_id,
              generation: Number(row.claim_generation),
            },
      heartbeatTtlSeconds: Number(row.heartbeat_ttl_seconds),
      revision: Number(row.revision),
    };
  }

  private columns(): string {
    return `id, document, sealed_secret, claim_at, claim_worker_id, claim_generation,
            heartbeat_ttl_seconds, revision, state, created_at`;
  }

  async insert(
    input: InsertEnvironmentWorkRecord,
  ): Promise<StoredEnvironmentWork> {
    const record = input.record;
    const sealed = await this.cipher.seal({
      plaintext: JSON.stringify(record.secret),
    });
    const result = await this.client
      .prepare(
        `INSERT INTO managed_environment_work
          (workspace_id, environment_id, id, session_id, document, sealed_secret,
           claim_at, claim_worker_id, claim_generation, heartbeat_ttl_seconds,
           revision, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.workspaceId,
        record.work.environmentId,
        record.work.id,
        record.work.data.type === "session" ? record.work.data.id : null,
        JSON.stringify(record.work),
        sealed.ciphertext,
        record.claim === null ? null : timestamp(record.claim.claimedAt),
        record.claim?.workerId ?? null,
        record.claim?.generation ?? 0,
        record.heartbeatTtlSeconds,
        1,
        record.work.state,
        timestamp(record.work.createdAt),
      )
      .run();
    if (result.meta.changes !== 1) {
      throw new Error(
        `Environment Work insertion affected ${result.meta.changes} rows`,
      );
    }
    const inserted = await this.find({
      workspaceId: input.workspaceId,
      environmentId: record.work.environmentId,
      workId: record.work.id,
    });
    if (inserted === null) throw new Error("Environment Work vanished after insert");
    return inserted;
  }

  async find(
    input: EnvironmentWorkLocation,
  ): Promise<StoredEnvironmentWork | null> {
    const row = await this.client
      .prepare(
        `SELECT ${this.columns()}
           FROM managed_environment_work
          WHERE workspace_id = ? AND environment_id = ? AND id = ?`,
      )
      .bind(input.workspaceId, input.environmentId, input.workId)
      .first<EnvironmentWorkRow>();
    return row === null ? null : this.toStored(row);
  }

  async findActiveSession(
    input: FindActiveEnvironmentSessionWork,
  ): Promise<StoredEnvironmentWork | null> {
    const row = await this.client
      .prepare(
        `SELECT ${this.columns()}
           FROM managed_environment_work
          WHERE workspace_id = ? AND session_id = ? AND state <> 'stopped'
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
      )
      .bind(input.workspaceId, input.sessionId)
      .first<EnvironmentWorkRow>();
    return row === null ? null : this.toStored(row);
  }

  async list(
    input: ListEnvironmentWorkRecords,
  ): Promise<StoredEnvironmentWork[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Environment Work list limit must be a positive integer");
    }
    const conditions = ["workspace_id = ?", "environment_id = ?"];
    const parameters: Array<string | number> = [
      input.workspaceId,
      input.environmentId,
    ];
    if (input.position !== undefined) {
      const createdAt = timestamp(input.position.createdAt);
      conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
      parameters.push(createdAt, createdAt, input.position.workId);
    }
    parameters.push(input.limit);
    const rows = await this.client
      .prepare(
        `SELECT ${this.columns()}
           FROM managed_environment_work
          WHERE ${conditions.join(" AND ")}
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      )
      .bind(...parameters)
      .all<EnvironmentWorkRow>();
    return Promise.all((rows.results ?? []).map((row) => this.toStored(row)));
  }

  async replace(
    input: ReplaceEnvironmentWorkRecord,
  ): Promise<ReplaceEnvironmentWorkRecordResult> {
    if (
      input.next.work.id !== input.workId ||
      input.next.work.environmentId !== input.environmentId
    ) {
      throw new Error("Replacement Environment Work identity does not match its target");
    }
    const sealed = await this.cipher.seal({
      plaintext: JSON.stringify(input.next.secret),
    });
    const result = await this.client
      .prepare(
        `UPDATE managed_environment_work
            SET document = ?, session_id = ?, sealed_secret = ?, claim_at = ?,
                claim_worker_id = ?, claim_generation = ?, heartbeat_ttl_seconds = ?,
                revision = revision + 1, state = ?
          WHERE workspace_id = ? AND environment_id = ? AND id = ?
            AND revision = ?`,
      )
      .bind(
        JSON.stringify(input.next.work),
        input.next.work.data.type === "session"
          ? input.next.work.data.id
          : null,
        sealed.ciphertext,
        input.next.claim === null
          ? null
          : timestamp(input.next.claim.claimedAt),
        input.next.claim?.workerId ?? null,
        input.next.claim?.generation ?? 0,
        input.next.heartbeatTtlSeconds,
        input.next.work.state,
        input.workspaceId,
        input.environmentId,
        input.workId,
        input.expectedRevision,
      )
      .run();
    if (result.meta.changes === 0) {
      const current = await this.find(input);
      return current === null
        ? { type: "not_found" }
        : { type: "revision_conflict", actualRevision: current.revision };
    }
    if (result.meta.changes !== 1) {
      throw new Error(
        `Environment Work replacement affected ${result.meta.changes} rows`,
      );
    }
    const record = await this.find(input);
    if (record === null) throw new Error("Environment Work vanished after replace");
    return { type: "replaced", record };
  }

  async claimAvailable(
    input: ClaimAvailableEnvironmentWork,
  ): Promise<ClaimAvailableEnvironmentWorkResult> {
    const claimedAt = timestamp(input.claimedAt);
    if (input.workerId !== null) {
      await this.client
        .prepare(
          `INSERT INTO managed_environment_work_workers
            (workspace_id, environment_id, worker_id, last_polled_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (workspace_id, environment_id, worker_id)
           DO UPDATE SET last_polled_at = excluded.last_polled_at`,
        )
        .bind(
          input.workspaceId,
          input.environmentId,
          input.workerId,
          claimedAt,
        )
        .run();
    }
    const rows = await this.client
      .prepare(
        `UPDATE managed_environment_work
            SET claim_at = ?, claim_worker_id = ?,
                claim_generation = claim_generation + 1,
                heartbeat_ttl_seconds = ?,
                state = 'queued',
                revision = revision + 1
          WHERE workspace_id = ? AND environment_id = ?
            AND id = (
              SELECT id
                FROM managed_environment_work
               WHERE workspace_id = ? AND environment_id = ?
                 AND (
                   (state = 'queued' AND (claim_at IS NULL OR claim_at <= ?))
                   OR (
                     state IN ('starting', 'active')
                     AND claim_at IS NOT NULL
                     AND claim_at + heartbeat_ttl_seconds * 1000 <= ?
                   )
                 )
               ORDER BY created_at ASC, id ASC
               LIMIT 1
            )
            AND (
              (state = 'queued' AND (claim_at IS NULL OR claim_at <= ?))
              OR (
                state IN ('starting', 'active')
                AND claim_at IS NOT NULL
                AND claim_at + heartbeat_ttl_seconds * 1000 <= ?
              )
            )
          RETURNING ${this.columns()}`,
      )
      .bind(
        claimedAt,
        input.workerId,
        input.heartbeatTtlSeconds,
        input.workspaceId,
        input.environmentId,
        input.workspaceId,
        input.environmentId,
        timestamp(input.reclaimBefore),
        claimedAt,
        timestamp(input.reclaimBefore),
        claimedAt,
      )
      .all<EnvironmentWorkRow>();
    const row = rows.results?.[0];
    return row === undefined
      ? { type: "empty" }
      : { type: "claimed", record: await this.toStored(row) };
  }

  async queueStats(
    input: GetEnvironmentWorkQueueStatsRecord,
  ): Promise<EnvironmentWorkQueueStats> {
    const stats = await this.client
      .prepare(
        `SELECT
           SUM(CASE WHEN state = 'queued' AND claim_at IS NULL THEN 1 ELSE 0 END) AS depth,
           SUM(CASE WHEN state = 'queued' AND claim_at IS NOT NULL THEN 1 ELSE 0 END) AS pending,
           MIN(CASE WHEN state = 'queued' THEN created_at ELSE NULL END) AS oldest_queued_at
         FROM managed_environment_work
         WHERE workspace_id = ? AND environment_id = ?`,
      )
      .bind(input.workspaceId, input.environmentId)
      .first<EnvironmentWorkStatsRow>();
    const workers = await this.client
      .prepare(
        `SELECT
           SUM(CASE WHEN last_polled_at >= ? THEN 1 ELSE 0 END) AS active,
           COUNT(*) AS total
         FROM managed_environment_work_workers
         WHERE workspace_id = ? AND environment_id = ?`,
      )
      .bind(
        timestamp(input.workerActiveSince),
        input.workspaceId,
        input.environmentId,
      )
      .first<EnvironmentWorkWorkerStatsRow>();
    const totalWorkers = Number(workers?.total ?? 0);
    return {
      depth: Number(stats?.depth ?? 0),
      oldestQueuedAt:
        stats?.oldest_queued_at == null
          ? null
          : new Date(Number(stats.oldest_queued_at)).toISOString(),
      pending: Number(stats?.pending ?? 0),
      workersPolling:
        totalWorkers === 0 ? null : Number(workers?.active ?? 0),
    };
  }
}
