import type {
  AdmitSessionExecution,
  AdmitSessionExecutionResult,
  ClaimSessionExecution,
  ClaimSessionExecutionResult,
  RenewSessionExecutionResult,
  SessionExecution,
  SessionExecutionStorePort,
  SessionExecutionFence,
  SettleSessionExecutionResult,
} from "@open-managed-agents/session-runtime-contract/coordination";
import type { SqlClient } from "@open-managed-agents/sql-client";

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS managed_session_executions (
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    lane_id TEXT NOT NULL,
    id TEXT NOT NULL,
    admitted_at_ms BIGINT NOT NULL,
    events_json TEXT NOT NULL,
    events_fingerprint TEXT NOT NULL,
    state TEXT NOT NULL,
    attempt_id TEXT,
    owner_id TEXT,
    generation BIGINT NOT NULL DEFAULT 0,
    attempt_count BIGINT NOT NULL DEFAULT 0,
    max_attempts BIGINT NOT NULL DEFAULT 10,
    deadline_at_ms BIGINT NOT NULL,
    claimed_at_ms BIGINT,
    lease_expires_at_ms BIGINT,
    interrupt_requested_at_ms BIGINT,
    settled_at_ms BIGINT,
    failure TEXT,
    revision BIGINT NOT NULL DEFAULT 1,
    PRIMARY KEY (workspace_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS managed_session_executions_claim_idx
    ON managed_session_executions
      (state, lease_expires_at_ms, admitted_at_ms, id)`,
  `CREATE INDEX IF NOT EXISTS managed_session_executions_session_idx
    ON managed_session_executions
      (workspace_id, session_id, lane_id, admitted_at_ms, id)`,
] as const;

export const sessionExecutionCoordinatorSqlSchema =
  `${schemaStatements.join(";\n")};`;

export async function ensureSessionExecutionCoordinatorSchema(
  sql: SqlClient,
): Promise<void> {
  // Create the table first.  Index DDL is deferred until after the additive
  // upgrade below so an old SQLite table without `lane_id` can be upgraded
  // without failing on the new session index.
  await sql.exec(schemaStatements[0]);

  // A few self-host installations created the execution table from an
  // earlier preview of this contract.  `CREATE TABLE IF NOT EXISTS` quite
  // correctly leaves those tables untouched, but a subsequent INSERT would
  // then fail on the newly required lease columns.  SQLite/D1 expose
  // `PRAGMA table_info`; PostgreSQL does not, so the probe is intentionally
  // best-effort and the real PG migrations remain the source of truth there.
  let existing: Set<string> | null = null;
  try {
    const result = await sql
      .prepare("PRAGMA table_info(managed_session_executions)")
      .all<{ name?: string }>();
    existing = new Set(
      (result.results ?? [])
        .map((column) => column.name)
        .filter((name): name is string => typeof name === "string"),
    );
  } catch {
    // PostgreSQL (and non-SQLite adapters) use their own migration runner.
  }
  if (existing !== null && existing.size > 0) {
    const additions: Array<[string, string]> = [
      ["lane_id", "TEXT NOT NULL DEFAULT 'sthr_primary'"],
      ["events_fingerprint", "TEXT NOT NULL DEFAULT ''"],
      ["generation", "BIGINT NOT NULL DEFAULT 0"],
      ["attempt_count", "BIGINT NOT NULL DEFAULT 0"],
      ["max_attempts", "BIGINT NOT NULL DEFAULT 10"],
      ["deadline_at_ms", "BIGINT NOT NULL DEFAULT 253402300799999"],
      ["claimed_at_ms", "BIGINT"],
      ["lease_expires_at_ms", "BIGINT"],
      ["interrupt_requested_at_ms", "BIGINT"],
      ["settled_at_ms", "BIGINT"],
      ["failure", "TEXT"],
      ["revision", "BIGINT NOT NULL DEFAULT 1"],
    ];
    for (const [name, definition] of additions) {
      if (!existing.has(name)) {
        await sql.exec(
          `ALTER TABLE managed_session_executions ADD COLUMN ${name} ${definition}`,
        );
      }
    }
  }
  for (const statement of schemaStatements.slice(1)) await sql.exec(statement);
}

interface ExecutionRow {
  workspace_id: string;
  session_id: string;
  lane_id: string;
  id: string;
  admitted_at_ms: number | string;
  events_json: string;
  events_fingerprint: string;
  state: SessionExecution["state"];
  attempt_id: string | null;
  owner_id: string | null;
  generation: number | string;
  attempt_count: number | string;
  max_attempts: number | string;
  deadline_at_ms: number | string;
  claimed_at_ms: number | string | null;
  lease_expires_at_ms: number | string | null;
  interrupt_requested_at_ms: number | string | null;
  settled_at_ms: number | string | null;
  failure: string | null;
  revision: number | string;
}

function timestamp(value: string, name: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error(`Invalid ${name} timestamp`);
  }
  return milliseconds;
}

function safeInteger(value: number | string, name: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid ${name}`);
  return parsed;
}

function optionalDate(value: number | string | null, name: string): string | null {
  return value === null
    ? null
    : new Date(safeInteger(value, name)).toISOString();
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function columns(): string {
  return `workspace_id, session_id, lane_id, id, admitted_at_ms, events_json,
    events_fingerprint, state, attempt_id, owner_id, generation,
    attempt_count, max_attempts, deadline_at_ms,
    claimed_at_ms, lease_expires_at_ms, interrupt_requested_at_ms,
    settled_at_ms, failure, revision`;
}

function toExecution(row: ExecutionRow): SessionExecution {
  const generation = safeInteger(row.generation, "execution generation");
  const claimedAt = optionalDate(row.claimed_at_ms, "claim time");
  const leaseExpiresAt = optionalDate(row.lease_expires_at_ms, "lease expiry");
  const attempt = row.attempt_id === null || row.owner_id === null ||
      claimedAt === null || leaseExpiresAt === null
    ? null
    : {
        id: row.attempt_id,
        ownerId: row.owner_id,
        generation,
        claimedAt,
        leaseExpiresAt,
      };
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    laneId: row.lane_id,
    admittedAt: new Date(
      safeInteger(row.admitted_at_ms, "admission time"),
    ).toISOString(),
    events: JSON.parse(row.events_json) as SessionExecution["events"],
    state: row.state,
    attempt,
    attemptCount: safeInteger(row.attempt_count, "execution attempt count"),
    maxAttempts: safeInteger(row.max_attempts, "execution max attempts"),
    deadlineAt: new Date(
      safeInteger(row.deadline_at_ms, "execution deadline"),
    ).toISOString(),
    interruptRequestedAt: optionalDate(
      row.interrupt_requested_at_ms,
      "interrupt time",
    ),
    settledAt: optionalDate(row.settled_at_ms, "settlement time"),
    failure: row.failure,
    revision: safeInteger(row.revision, "execution revision"),
  };
}

function toFence(row: ExecutionRow): SessionExecutionFence {
  const execution = toExecution(row);
  if (execution.attempt === null) {
    throw new Error("Claimed Session Execution has no attempt");
  }
  return {
    executionId: execution.id,
    workspaceId: execution.workspaceId,
    sessionId: execution.sessionId,
    attemptId: execution.attempt.id,
    ownerId: execution.attempt.ownerId,
    generation: execution.attempt.generation,
    expiresAt: execution.attempt.leaseExpiresAt,
  };
}

function validateTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error("Session Execution leaseTtlMs must be a positive integer");
  }
}

export class SqlSessionExecutionStore
  implements SessionExecutionStorePort
{
  constructor(private readonly sql: SqlClient) {}

  async admit(
    input: AdmitSessionExecution,
  ): Promise<AdmitSessionExecutionResult> {
    if (input.execution.events.length === 0) {
      throw new Error("A Session Execution requires at least one event");
    }
    const maxAttempts = input.policy?.maxAttempts ?? 10;
    const timeoutMs = input.policy?.timeoutMs ?? 60 * 60 * 1_000;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
      throw new Error("Session Execution maxAttempts must be a positive integer");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Session Execution timeoutMs must be a positive integer");
    }
    const admittedAt = timestamp(input.execution.admittedAt, "admission");
    const deadlineAt = admittedAt + timeoutMs;
    if (!Number.isSafeInteger(deadlineAt)) {
      throw new Error("Session Execution deadline exceeds safe timestamp range");
    }
    const eventsJson = stableJson(input.execution.events);
    const inserted = await this.sql.prepare(`
      INSERT INTO managed_session_executions (
        workspace_id, session_id, lane_id, id, admitted_at_ms, events_json,
        events_fingerprint, state, generation, attempt_count, max_attempts,
        deadline_at_ms, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, 0, ?, ?, 1)
      ON CONFLICT (workspace_id, id) DO NOTHING
    `).bind(
      input.execution.workspaceId,
      input.execution.sessionId,
      input.execution.laneId ?? "sthr_primary",
      input.execution.id,
      admittedAt,
      eventsJson,
      eventsJson,
      maxAttempts,
      deadlineAt,
    ).run();
    const execution = await this.find({
      workspaceId: input.execution.workspaceId,
      executionId: input.execution.id,
    });
    if (execution === null) {
      throw new Error("Session Execution vanished after admission");
    }
    if (inserted.meta.changes === 1) return { type: "admitted", execution };
    const sameIdentity = execution.sessionId === input.execution.sessionId &&
      execution.laneId === (input.execution.laneId ?? "sthr_primary") &&
      execution.admittedAt === input.execution.admittedAt &&
      stableJson(execution.events) === eventsJson;
    return sameIdentity
      ? { type: "replayed", execution }
      : { type: "conflict", execution };
  }

  async claim(
    input: ClaimSessionExecution,
  ): Promise<ClaimSessionExecutionResult> {
    validateTtl(input.leaseTtlMs);
    const claimedAt = timestamp(input.claimedAt, "claim");
    await this.terminalizeExpired(claimedAt);
    const row = await this.sql.prepare(`
      UPDATE managed_session_executions
       SET state = 'running', attempt_id = ?, owner_id = ?,
             generation = generation + 1, attempt_count = attempt_count + 1,
             claimed_at_ms = ?,
             lease_expires_at_ms = CASE
               WHEN ? < deadline_at_ms THEN ? ELSE deadline_at_ms END,
             settled_at_ms = NULL, failure = NULL, revision = revision + 1
       WHERE (workspace_id, id) = (
         SELECT candidate.workspace_id, candidate.id
          FROM managed_session_executions AS candidate
          WHERE (? IS NULL OR candidate.workspace_id = ?)
            AND (? IS NULL OR candidate.session_id = ?)
            AND (? IS NULL OR candidate.lane_id = ?)
            AND (
            candidate.state = 'queued'
            OR (
              candidate.state = 'running'
              AND candidate.lease_expires_at_ms <= ?
              AND candidate.owner_id <> ?
            )
          )
            AND candidate.attempt_count < candidate.max_attempts
            AND candidate.deadline_at_ms > ?
            AND NOT EXISTS (
              SELECT 1
                FROM managed_session_executions AS earlier
               WHERE earlier.workspace_id = candidate.workspace_id
                 AND earlier.session_id = candidate.session_id
                 AND earlier.lane_id = candidate.lane_id
                 AND earlier.state IN ('queued', 'running')
                 AND (
                   earlier.admitted_at_ms < candidate.admitted_at_ms
                   OR (
                     earlier.admitted_at_ms = candidate.admitted_at_ms
                     AND earlier.id < candidate.id
                   )
                 )
            )
          ORDER BY candidate.admitted_at_ms ASC, candidate.id ASC
          LIMIT 1
       )
         AND (? IS NULL OR workspace_id = ?)
         AND (? IS NULL OR session_id = ?)
         AND (? IS NULL OR lane_id = ?)
         AND (
           state = 'queued'
           OR (
             state = 'running' AND lease_expires_at_ms <= ?
             AND owner_id <> ?
           )
         )
         AND attempt_count < max_attempts
         AND deadline_at_ms > ?
      RETURNING ${columns()}
    `).bind(
      input.attemptId,
      input.ownerId,
      claimedAt,
      claimedAt + input.leaseTtlMs,
      claimedAt + input.leaseTtlMs,
      input.workspaceId ?? null,
      input.workspaceId ?? null,
      input.sessionId ?? null,
      input.sessionId ?? null,
      input.laneId ?? null,
      input.laneId ?? null,
      claimedAt,
      input.ownerId,
      claimedAt,
      input.workspaceId ?? null,
      input.workspaceId ?? null,
      input.sessionId ?? null,
      input.sessionId ?? null,
      input.laneId ?? null,
      input.laneId ?? null,
      claimedAt,
      input.ownerId,
      claimedAt,
    ).first<ExecutionRow>();
    if (row === null) return { type: "empty" };
    return {
      type: "claimed",
      execution: toExecution(row),
      fence: toFence(row),
    };
  }

  async renew(input: {
    fence: SessionExecutionFence;
    renewedAt: string;
    leaseTtlMs: number;
  }): Promise<RenewSessionExecutionResult> {
    validateTtl(input.leaseTtlMs);
    const renewedAt = timestamp(input.renewedAt, "renewal");
    await this.terminalizeExpired(renewedAt);
    const row = await this.sql.prepare(`
      UPDATE managed_session_executions
         SET lease_expires_at_ms = CASE
               WHEN ? < deadline_at_ms THEN ? ELSE deadline_at_ms END,
             revision = revision + 1
       WHERE workspace_id = ? AND id = ? AND session_id = ?
         AND state = 'running' AND attempt_id = ? AND owner_id = ?
         AND generation = ? AND lease_expires_at_ms > ?
         AND deadline_at_ms > ?
      RETURNING ${columns()}
    `).bind(
      renewedAt + input.leaseTtlMs,
      renewedAt + input.leaseTtlMs,
      input.fence.workspaceId,
      input.fence.executionId,
      input.fence.sessionId,
      input.fence.attemptId,
      input.fence.ownerId,
      input.fence.generation,
      renewedAt,
      renewedAt,
    ).first<ExecutionRow>();
    return row === null
      ? { type: "lost" }
      : {
          type: "renewed",
          fence: toFence(row),
          interruptRequestedAt: toExecution(row).interruptRequestedAt,
        };
  }

  async settle(input: {
    fence: SessionExecutionFence;
    settledAt: string;
    outcome: "completed" | "failed" | "cancelled";
    failure?: string;
  }): Promise<SettleSessionExecutionResult> {
    const settledAt = timestamp(input.settledAt, "settlement");
    const row = await this.sql.prepare(`
      UPDATE managed_session_executions
         SET state = CASE
               WHEN interrupt_requested_at_ms IS NOT NULL THEN 'cancelled'
               ELSE ?
             END,
             settled_at_ms = ?,
             failure = CASE
               WHEN interrupt_requested_at_ms IS NOT NULL
                 THEN COALESCE(failure, 'interrupted during execution')
               ELSE ?
             END,
             revision = revision + 1
       WHERE workspace_id = ? AND id = ? AND session_id = ?
         AND state = 'running' AND attempt_id = ? AND owner_id = ?
         AND generation = ? AND lease_expires_at_ms > ?
      RETURNING ${columns()}
    `).bind(
      input.outcome,
      settledAt,
      input.failure?.slice(0, 4_096) ?? null,
      input.fence.workspaceId,
      input.fence.executionId,
      input.fence.sessionId,
      input.fence.attemptId,
      input.fence.ownerId,
      input.fence.generation,
      settledAt,
    ).first<ExecutionRow>();
    return row === null
      ? { type: "lost" }
      : { type: "settled", execution: toExecution(row) };
  }

  async requestInterrupt(input: {
    workspaceId: string;
    sessionId: string;
    laneId?: string;
    requestedAt: string;
  }): Promise<{ type: "requested" | "idle" }> {
    const requestedAt = timestamp(input.requestedAt, "interrupt request");
    const queued = this.sql.prepare(`
      UPDATE managed_session_executions
         SET state = 'cancelled', settled_at_ms = ?,
             interrupt_requested_at_ms = COALESCE(interrupt_requested_at_ms, ?),
             failure = 'interrupted before execution', revision = revision + 1
       WHERE workspace_id = ? AND session_id = ? AND state = 'queued'
         AND (? IS NULL OR lane_id = ?)
    `).bind(
      requestedAt,
      requestedAt,
      input.workspaceId,
      input.sessionId,
      input.laneId ?? null,
      input.laneId ?? null,
    );
    const expired = this.sql.prepare(`
      UPDATE managed_session_executions
         SET state = 'cancelled', settled_at_ms = ?,
             interrupt_requested_at_ms = COALESCE(interrupt_requested_at_ms, ?),
             failure = 'interrupted after owner lease expired',
             revision = revision + 1
       WHERE workspace_id = ? AND session_id = ? AND state = 'running'
         AND lease_expires_at_ms <= ?
         AND (? IS NULL OR lane_id = ?)
    `).bind(
      requestedAt,
      requestedAt,
      input.workspaceId,
      input.sessionId,
      requestedAt,
      input.laneId ?? null,
      input.laneId ?? null,
    );
    const active = this.sql.prepare(`
      UPDATE managed_session_executions
         SET interrupt_requested_at_ms = COALESCE(interrupt_requested_at_ms, ?),
             revision = revision + 1
       WHERE workspace_id = ? AND session_id = ? AND state = 'running'
         AND lease_expires_at_ms > ?
         AND (? IS NULL OR lane_id = ?)
    `).bind(
      requestedAt,
      input.workspaceId,
      input.sessionId,
      requestedAt,
      input.laneId ?? null,
      input.laneId ?? null,
    );
    const results = await this.sql.batch([queued, expired, active]);
    return results.reduce((total, result) => total + result.meta.changes, 0) === 0
      ? { type: "idle" }
      : { type: "requested" };
  }

  async cancelSession(input: {
    workspaceId: string;
    sessionId: string;
    cancelledAt: string;
    reason: string;
  }): Promise<{ queued: number; running: number }> {
    const cancelledAt = timestamp(input.cancelledAt, "session cancellation");
    const queued = this.sql.prepare(`
      UPDATE managed_session_executions
         SET state = 'cancelled', settled_at_ms = ?, failure = ?,
             revision = revision + 1
       WHERE workspace_id = ? AND session_id = ? AND state = 'queued'
    `).bind(
      cancelledAt,
      input.reason.slice(0, 4_096),
      input.workspaceId,
      input.sessionId,
    );
    const running = this.sql.prepare(`
      UPDATE managed_session_executions
         SET state = 'cancelled', settled_at_ms = ?,
             interrupt_requested_at_ms = COALESCE(interrupt_requested_at_ms, ?),
             failure = ?,
             revision = revision + 1
       WHERE workspace_id = ? AND session_id = ? AND state = 'running'
    `).bind(
      cancelledAt,
      cancelledAt,
      input.reason.slice(0, 4_096),
      input.workspaceId,
      input.sessionId,
    );
    const results = await this.sql.batch([queued, running]);
    const queuedResult = results[0];
    const runningResult = results[1];
    if (queuedResult === undefined || runningResult === undefined) {
      throw new Error("Session cancellation SQL batch must return two results");
    }
    return {
      queued: queuedResult.meta.changes,
      running: runningResult.meta.changes,
    };
  }

  async find(input: {
    workspaceId: string;
    executionId: string;
  }): Promise<SessionExecution | null> {
    const row = await this.sql.prepare(`
      SELECT ${columns()}
        FROM managed_session_executions
       WHERE workspace_id = ? AND id = ?
    `).bind(input.workspaceId, input.executionId).first<ExecutionRow>();
    return row === null ? null : toExecution(row);
  }

  private async terminalizeExpired(now: number): Promise<void> {
    await this.sql.batch([
      this.sql.prepare(`
        UPDATE managed_session_executions
           SET state = 'failed', settled_at_ms = ?,
               failure = 'execution deadline exceeded', revision = revision + 1
         WHERE state IN ('queued', 'running') AND deadline_at_ms <= ?
      `).bind(now, now),
      this.sql.prepare(`
        UPDATE managed_session_executions
           SET state = 'failed', settled_at_ms = ?,
               failure = 'execution attempt limit exhausted',
               revision = revision + 1
         WHERE state = 'running' AND lease_expires_at_ms <= ?
           AND attempt_count >= max_attempts
      `).bind(now, now),
    ]);
  }
}

/** @deprecated Use SqlSessionExecutionStore. */
export const SqlSessionExecutionCoordinator = SqlSessionExecutionStore;
