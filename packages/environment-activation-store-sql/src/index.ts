import type {
  ManagedEnvironmentActivationClaim,
  ManagedEnvironmentActivationIntent,
  ManagedEnvironmentActivationIntentStorePort,
} from "@open-managed-agents/managed-runtime-host";
import type { SqlClient } from "@open-managed-agents/sql-client";

const statements = [
  `CREATE TABLE IF NOT EXISTS managed_environment_activation_intents (
    event_id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    state TEXT NOT NULL,
    attempt_count BIGINT NOT NULL,
    max_attempts BIGINT NOT NULL,
    deadline_at_ms BIGINT NOT NULL,
    next_attempt_at_ms BIGINT NOT NULL,
    lease_owner_id TEXT,
    lease_generation BIGINT NOT NULL,
    lease_token TEXT,
    lease_expires_at_ms BIGINT,
    runtime_id TEXT,
    last_error TEXT,
    created_at_ms BIGINT NOT NULL,
    updated_at_ms BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS managed_environment_activation_ready_idx
    ON managed_environment_activation_intents (
      environment_id, workspace_id, state, next_attempt_at_ms,
      lease_expires_at_ms, created_at_ms
    )`,
] as const;

export const managedEnvironmentActivationSqlSchema = `${statements.join(";\n")};`;

export async function ensureManagedEnvironmentActivationSchema(
  sql: SqlClient,
): Promise<void> {
  for (const statement of statements) await sql.exec(statement);
}

export interface SqlManagedEnvironmentActivationIntentStoreOptions {
  now?: () => number;
  nextToken?: (generation: number) => string;
}

interface IntentRow {
  event_id: string;
  environment_id: string;
  workspace_id: string;
  session_id: string;
  attempt_count: number | string;
  max_attempts: number | string;
  deadline_at_ms: number | string;
  next_attempt_at_ms: number | string;
  lease_owner_id: string;
  lease_generation: number | string;
  lease_token: string;
  lease_expires_at_ms: number | string;
}

interface IdentityRow {
  environment_id: string;
  workspace_id: string;
  session_id: string;
}

function integer(value: number | string, name: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`SQL activation store returned invalid ${name}`);
  }
  return parsed;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function claimFromRow(row: IntentRow): ManagedEnvironmentActivationClaim {
  const intent: ManagedEnvironmentActivationIntent = {
    eventId: row.event_id,
    environmentId: row.environment_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    attemptCount: integer(row.attempt_count, "attempt count"),
    maxAttempts: integer(row.max_attempts, "max attempts"),
    deadlineAtMs: integer(row.deadline_at_ms, "activation deadline"),
    nextAttemptAtMs: integer(row.next_attempt_at_ms, "retry timestamp"),
  };
  return {
    intent,
    ownerId: row.lease_owner_id,
    generation: integer(row.lease_generation, "lease generation"),
    token: row.lease_token,
    expiresAtMs: integer(row.lease_expires_at_ms, "lease expiry"),
  };
}

/** SQLite/D1/Postgres-compatible activation intent queue. It uses one
 * conditional UPDATE ... RETURNING for ownership, so no correctness decision
 * depends on a prior SELECT. */
export class SqlManagedEnvironmentActivationIntentStore
implements ManagedEnvironmentActivationIntentStorePort {
  readonly #now: () => number;
  readonly #nextToken: (generation: number) => string;

  constructor(
    private readonly sql: SqlClient,
    options: SqlManagedEnvironmentActivationIntentStoreOptions = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#nextToken = options.nextToken ?? (() => crypto.randomUUID());
  }

  async enqueue(
    intent: Omit<ManagedEnvironmentActivationIntent, "attemptCount" | "nextAttemptAtMs">,
  ): Promise<{ type: "inserted" } | { type: "existing" }> {
    const now = this.#now();
    positiveInteger(intent.maxAttempts, "maxAttempts");
    if (!Number.isSafeInteger(intent.deadlineAtMs) || intent.deadlineAtMs <= now) {
      throw new RangeError("deadlineAtMs must be a future safe integer");
    }
    const inserted = await this.sql.prepare(`
      INSERT INTO managed_environment_activation_intents (
        event_id, environment_id, workspace_id, session_id, state,
        attempt_count, max_attempts, deadline_at_ms, next_attempt_at_ms,
        lease_owner_id, lease_generation,
        lease_token, lease_expires_at_ms, runtime_id, last_error,
        created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, NULL, 0, NULL, NULL, NULL, NULL, ?, ?)
      ON CONFLICT(event_id) DO NOTHING
      RETURNING event_id
    `).bind(
      intent.eventId,
      intent.environmentId,
      intent.workspaceId,
      intent.sessionId,
      intent.maxAttempts,
      intent.deadlineAtMs,
      now,
      now,
      now,
    ).first<{ event_id: string }>();
    if (inserted !== null) return { type: "inserted" };

    const existing = await this.sql.prepare(`
      SELECT environment_id, workspace_id, session_id
      FROM managed_environment_activation_intents
      WHERE event_id = ?
    `).bind(intent.eventId).first<IdentityRow>();
    if (
      existing === null
      || existing.environment_id !== intent.environmentId
      || existing.workspace_id !== intent.workspaceId
      || existing.session_id !== intent.sessionId
    ) {
      throw new Error(
        `Webhook event ${intent.eventId} already identifies a different activation`,
      );
    }
    return { type: "existing" };
  }

  async claim(input: {
    environmentId: string;
    workspaceId: string;
    ownerId: string;
    leaseTtlMs: number;
    eventId?: string;
  }): Promise<
    | { type: "claimed"; claim: ManagedEnvironmentActivationClaim }
    | { type: "empty" }
  > {
    positiveInteger(input.leaseTtlMs, "leaseTtlMs");
    const now = this.#now();
    const exhaustionEventPredicate = input.eventId === undefined ? "" : "AND event_id = ?";
    await this.sql.prepare(`
      UPDATE managed_environment_activation_intents
      SET state = 'exhausted',
          last_error = CASE
            WHEN deadline_at_ms <= ? THEN 'activation deadline exceeded'
            ELSE 'activation attempt budget exhausted'
          END,
          lease_owner_id = NULL, lease_token = NULL,
          lease_expires_at_ms = NULL, updated_at_ms = ?
      WHERE environment_id = ? AND workspace_id = ? AND state = 'pending'
        AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms <= ?)
        AND (deadline_at_ms <= ? OR attempt_count >= max_attempts)
        ${exhaustionEventPredicate}
    `).bind(
      now,
      now,
      input.environmentId,
      input.workspaceId,
      now,
      now,
      ...(input.eventId === undefined ? [] : [input.eventId]),
    ).run();
    // The next generation is deterministic enough for injected token
    // factories; the SQL mutation remains the source of truth under races.
    const generationHint = await this.sql.prepare(`
      SELECT COALESCE(MAX(lease_generation), 0) + 1 AS generation
      FROM managed_environment_activation_intents
      WHERE environment_id = ? AND workspace_id = ?
    `).bind(input.environmentId, input.workspaceId)
      .first<{ generation: number | string }>();
    const token = this.#nextToken(integer(generationHint?.generation ?? 1, "generation hint"));
    const eventPredicate = input.eventId === undefined ? "" : "AND event_id = ?";
    const bindings = [
      input.ownerId,
      token,
      now + input.leaseTtlMs,
      now,
      input.environmentId,
      input.workspaceId,
      now,
      now,
      now,
      ...(input.eventId === undefined ? [] : [input.eventId]),
      now,
    ];
    const row = await this.sql.prepare(`
      UPDATE managed_environment_activation_intents
      SET attempt_count = attempt_count + 1,
          lease_owner_id = ?,
          lease_generation = lease_generation + 1,
          lease_token = ?,
          lease_expires_at_ms = ?,
          updated_at_ms = ?
      WHERE event_id = (
        SELECT event_id
        FROM managed_environment_activation_intents
        WHERE environment_id = ?
          AND workspace_id = ?
          AND state = 'pending'
          AND next_attempt_at_ms <= ?
          AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms <= ?)
          AND deadline_at_ms > ?
          AND attempt_count < max_attempts
          ${eventPredicate}
        ORDER BY next_attempt_at_ms, created_at_ms, event_id
        LIMIT 1
      )
        AND state = 'pending'
        AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms <= ?)
      RETURNING event_id, environment_id, workspace_id, session_id,
                attempt_count, max_attempts, deadline_at_ms,
                next_attempt_at_ms, lease_owner_id,
                lease_generation, lease_token, lease_expires_at_ms
    `).bind(...bindings).first<IntentRow>();
    return row === null
      ? { type: "empty" }
      : { type: "claimed", claim: claimFromRow(row) };
  }

  async complete(input: {
    claim: ManagedEnvironmentActivationClaim;
    runtimeId: string;
  }): Promise<{ type: "completed" } | { type: "lost" }> {
    const now = this.#now();
    const result = await this.sql.prepare(`
      UPDATE managed_environment_activation_intents
      SET state = 'completed', runtime_id = ?, lease_owner_id = NULL,
          lease_token = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?
      WHERE event_id = ? AND state = 'pending'
        AND lease_owner_id = ? AND lease_generation = ? AND lease_token = ?
        AND lease_expires_at_ms > ? AND deadline_at_ms > ?
      RETURNING event_id
    `).bind(
      input.runtimeId,
      now,
      input.claim.intent.eventId,
      input.claim.ownerId,
      input.claim.generation,
      input.claim.token,
      now,
      now,
    ).first<{ event_id: string }>();
    return result === null ? { type: "lost" } : { type: "completed" };
  }

  async renew(input: {
    claim: ManagedEnvironmentActivationClaim;
    leaseTtlMs: number;
  }): Promise<
    | { type: "renewed"; claim: ManagedEnvironmentActivationClaim }
    | { type: "lost" }
  > {
    positiveInteger(input.leaseTtlMs, "leaseTtlMs");
    const now = this.#now();
    const row = await this.sql.prepare(`
      UPDATE managed_environment_activation_intents
      SET lease_expires_at_ms = ?, updated_at_ms = ?
      WHERE event_id = ? AND state = 'pending'
        AND lease_owner_id = ? AND lease_generation = ? AND lease_token = ?
        AND lease_expires_at_ms > ? AND deadline_at_ms > ?
      RETURNING event_id, environment_id, workspace_id, session_id,
                attempt_count, max_attempts, deadline_at_ms,
                next_attempt_at_ms, lease_owner_id,
                lease_generation, lease_token, lease_expires_at_ms
    `).bind(
      Math.min(now + input.leaseTtlMs, input.claim.intent.deadlineAtMs),
      now,
      input.claim.intent.eventId,
      input.claim.ownerId,
      input.claim.generation,
      input.claim.token,
      now,
      now,
    ).first<IntentRow>();
    return row === null
      ? { type: "lost" }
      : { type: "renewed", claim: claimFromRow(row) };
  }

  async retry(input: {
    claim: ManagedEnvironmentActivationClaim;
    nextAttemptAtMs: number;
    error: string;
  }): Promise<{ type: "released" | "exhausted" } | { type: "lost" }> {
    if (!Number.isSafeInteger(input.nextAttemptAtMs)) {
      throw new RangeError("nextAttemptAtMs must be a safe integer");
    }
    const now = this.#now();
    const result = await this.sql.prepare(`
      UPDATE managed_environment_activation_intents
      SET next_attempt_at_ms = ?,
          state = CASE
            WHEN attempt_count >= max_attempts OR ? >= deadline_at_ms
              THEN 'exhausted'
            ELSE 'pending'
          END,
          last_error = ?, lease_owner_id = NULL,
          lease_token = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?
      WHERE event_id = ? AND state = 'pending'
        AND lease_owner_id = ? AND lease_generation = ? AND lease_token = ?
        AND lease_expires_at_ms > ?
      RETURNING state
    `).bind(
      input.nextAttemptAtMs,
      input.nextAttemptAtMs,
      input.error,
      now,
      input.claim.intent.eventId,
      input.claim.ownerId,
      input.claim.generation,
      input.claim.token,
      now,
    ).first<{ state: string }>();
    if (result === null) return { type: "lost" };
    return { type: result.state === "exhausted" ? "exhausted" : "released" };
  }
}
