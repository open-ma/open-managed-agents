import type {
  AcquireRuntimeFenceInput,
  AcquireRuntimeFenceResult,
  PublishRuntimeResourcesResult,
  RenewRuntimeFenceResult,
  RuntimeResourceFence,
  RuntimeResourceFencePort,
  RuntimeResourcePublication,
  RuntimeResourceScope,
  RuntimeOrphanPort,
  RuntimeOrphanRecord,
  RuntimeOrphanReason,
} from "@open-managed-agents/runtime-resource-contract";
import { runtimeOrphanId } from "@open-managed-agents/runtime-resource-contract";
import type { SqlClient } from "@open-managed-agents/sql-client";

const runtimeResourceFenceSqlStatements = [
  "CREATE TABLE IF NOT EXISTS runtime_resource_fences (scope_key TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, environment_id TEXT NOT NULL, session_id TEXT NOT NULL, work_id TEXT NOT NULL, generation BIGINT NOT NULL, owner_id TEXT NOT NULL, fence_token TEXT NOT NULL, expires_at_ms BIGINT NOT NULL, publication_json TEXT, publication_generation BIGINT, revision BIGINT NOT NULL DEFAULT 0)",
  "CREATE INDEX IF NOT EXISTS runtime_resource_fences_expiry_idx ON runtime_resource_fences(expires_at_ms)",
  "CREATE TABLE IF NOT EXISTS runtime_resource_orphans (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, environment_id TEXT NOT NULL, session_id TEXT NOT NULL, work_id TEXT NOT NULL, generation BIGINT NOT NULL, owner_id TEXT NOT NULL, sandbox_json TEXT NOT NULL, reason TEXT NOT NULL, attempts BIGINT NOT NULL DEFAULT 0, last_error TEXT NOT NULL)",
] as const;

export const runtimeResourceFenceSqlSchema =
  `${runtimeResourceFenceSqlStatements.join(";\n")};`;

export async function ensureRuntimeResourceFenceSchema(sql: SqlClient): Promise<void> {
  for (const statement of runtimeResourceFenceSqlStatements) {
    await sql.exec(statement);
  }
}

export interface SqlRuntimeResourceFenceOptions {
  now?: () => Date;
  nextToken?: (generationHint: number) => string;
}

interface FenceRow {
  generation: number | string;
  owner_id: string;
  fence_token: string;
  expires_at_ms: number | string;
  publication_json: string | null;
  publication_generation: number | string | null;
  revision: number | string;
}

interface RevisionRow {
  revision: number | string;
}

function scopeKey(scope: RuntimeResourceScope): string {
  return JSON.stringify([
    scope.workspaceId,
    scope.environmentId,
    scope.sessionId,
    scope.workId,
  ]);
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

function asSafeInteger(value: number | string, name: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`SQL runtime fence returned an invalid ${name}`);
  }
  return parsed;
}

function validRuntimeCheckpoint(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object") return false;
  const checkpoint = value as Record<string, unknown>;
  return typeof checkpoint.provider === "string"
    && checkpoint.provider.length > 0
    && typeof checkpoint.checkpointId === "string"
    && checkpoint.checkpointId.length > 0
    && (checkpoint.kind === "filesystem" || checkpoint.kind === "process")
    && typeof checkpoint.sourceRuntimeId === "string"
    && checkpoint.sourceRuntimeId.length > 0
    && typeof checkpoint.sessionId === "string"
    && Number.isSafeInteger(checkpoint.workGeneration)
    && Number.isSafeInteger(checkpoint.workspaceRevision)
    && typeof checkpoint.harnessVersion === "string"
    && typeof checkpoint.runtimeIdentity === "string";
}

function validateTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error("Runtime resource fence ttlMs must be a positive integer");
  }
}

function parsePublication(
  value: string | null,
  generation: number | string | null,
  revision: number | string,
): RuntimeResourcePublication | null {
  if (value === null) return null;
  if (generation === null) {
    throw new Error("SQL runtime fence publication is missing its generation");
  }
  const candidates = JSON.parse(value) as Pick<
    RuntimeResourcePublication,
    "workspaceCandidate" | "outputCandidate" | "runtimeCheckpoint"
  >;
  const parsed: RuntimeResourcePublication = {
    generation: asSafeInteger(generation, "publication generation"),
    revision: asSafeInteger(revision, "revision"),
    workspaceCandidate: candidates.workspaceCandidate,
    outputCandidate: candidates.outputCandidate,
    ...(candidates.runtimeCheckpoint === undefined
      ? {}
      : { runtimeCheckpoint: candidates.runtimeCheckpoint }),
  };
  if (
    typeof parsed !== "object"
    || parsed === null
    || !Number.isSafeInteger(parsed.generation)
    || !Number.isSafeInteger(parsed.revision)
    || typeof parsed.workspaceCandidate?.id !== "string"
    || typeof parsed.workspaceCandidate?.contentHash !== "string"
    || !validRuntimeCheckpoint(parsed.runtimeCheckpoint)
  ) {
    throw new Error("SQL runtime fence contains an invalid publication");
  }
  return parsed;
}

function rowFence(
  scope: RuntimeResourceScope,
  row: FenceRow,
): RuntimeResourceFence {
  const expiresAtMs = asSafeInteger(row.expires_at_ms, "expiry");
  return {
    ...scope,
    ownerId: row.owner_id,
    generation: asSafeInteger(row.generation, "generation"),
    token: row.fence_token,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

/**
 * Cross-runtime SQL fence. Every ownership transition, renewal and publication
 * is one conditional mutation; no correctness decision depends on a prior
 * SELECT. This makes the same Port usable with D1, SQLite and Postgres.
 */
export class SqlRuntimeResourceFencePort implements RuntimeResourceFencePort {
  readonly #now: () => Date;
  readonly #nextToken: (generationHint: number) => string;

  constructor(
    private readonly sql: SqlClient,
    options: SqlRuntimeResourceFenceOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#nextToken = options.nextToken ?? (() => crypto.randomUUID());
  }

  async acquire(input: AcquireRuntimeFenceInput): Promise<AcquireRuntimeFenceResult> {
    validateTtl(input.ttlMs);
    const key = scopeKey(input.scope);
    const now = this.#now().getTime();
    const expiry = now + input.ttlMs;
    const token = this.#nextToken(1);
    const row = await this.sql.prepare(`
      INSERT INTO runtime_resource_fences (
        scope_key, workspace_id, environment_id, session_id, work_id,
        generation, owner_id, fence_token, expires_at_ms,
        publication_json, publication_generation, revision
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, NULL, 0)
      ON CONFLICT(scope_key) DO UPDATE SET
        generation = CASE
          WHEN runtime_resource_fences.expires_at_ms <= ?
            THEN runtime_resource_fences.generation + 1
            ELSE runtime_resource_fences.generation END,
        owner_id = CASE
          WHEN runtime_resource_fences.expires_at_ms <= ?
            THEN excluded.owner_id ELSE runtime_resource_fences.owner_id END,
        fence_token = CASE
          WHEN runtime_resource_fences.expires_at_ms <= ?
            THEN excluded.fence_token ELSE runtime_resource_fences.fence_token END,
        expires_at_ms = CASE
          WHEN runtime_resource_fences.expires_at_ms <= ?
            THEN excluded.expires_at_ms ELSE runtime_resource_fences.expires_at_ms END
      WHERE runtime_resource_fences.expires_at_ms <= ?
        OR runtime_resource_fences.owner_id = excluded.owner_id
      RETURNING generation, owner_id, fence_token, expires_at_ms,
                publication_json, publication_generation, revision
    `).bind(
      key,
      input.scope.workspaceId,
      input.scope.environmentId,
      input.scope.sessionId,
      input.scope.workId,
      input.ownerId,
      token,
      expiry,
      now,
      now,
      now,
      now,
      now,
    ).first<FenceRow>();

    if (row === null) {
      const conflict = await this.sql.prepare(`
        SELECT expires_at_ms
        FROM runtime_resource_fences
        WHERE scope_key = ?
      `).bind(key).first<{ expires_at_ms: number | string }>();
      return {
        type: "conflict",
        expiresAt:
          conflict === null
            ? null
            : new Date(asSafeInteger(conflict.expires_at_ms, "expiry")).toISOString(),
      };
    }
    return {
      type: "acquired",
      fence: rowFence(input.scope, row),
      publication: parsePublication(
        row.publication_json,
        row.publication_generation,
        row.revision,
      ),
    };
  }

  async renew(input: {
    fence: RuntimeResourceFence;
    ttlMs: number;
  }): Promise<RenewRuntimeFenceResult> {
    validateTtl(input.ttlMs);
    const now = this.#now().getTime();
    const row = await this.sql.prepare(`
      UPDATE runtime_resource_fences
      SET expires_at_ms = ?
      WHERE scope_key = ? AND generation = ? AND owner_id = ?
        AND fence_token = ? AND expires_at_ms > ?
      RETURNING generation, owner_id, fence_token, expires_at_ms,
                publication_json, publication_generation, revision
    `).bind(
      now + input.ttlMs,
      scopeKey(input.fence),
      input.fence.generation,
      input.fence.ownerId,
      input.fence.token,
      now,
    ).first<FenceRow>();
    return row === null
      ? { type: "lost" }
      : { type: "renewed", fence: rowFence(input.fence, row) };
  }

  /** Read-only authorization check for side-effect gates such as credential
   * egress. Publication still uses its own atomic compare-and-mutate path. */
  async isCurrent(fence: RuntimeResourceFence): Promise<boolean> {
    const row = await this.sql.prepare(`
      SELECT 1 AS present
      FROM runtime_resource_fences
      WHERE scope_key = ? AND generation = ? AND owner_id = ?
        AND fence_token = ? AND expires_at_ms > ?
    `).bind(
      scopeKey(fence),
      fence.generation,
      fence.ownerId,
      fence.token,
      this.#now().getTime(),
    ).first<{ present: number | string }>();
    return row !== null;
  }

  async publish(input: {
    fence: RuntimeResourceFence;
    workspaceCandidate: RuntimeResourcePublication["workspaceCandidate"];
    outputCandidate: RuntimeResourcePublication["outputCandidate"];
    runtimeCheckpoint?: RuntimeResourcePublication["runtimeCheckpoint"];
  }): Promise<PublishRuntimeResourcesResult> {
    const now = this.#now().getTime();
    const candidates = {
      workspaceCandidate: input.workspaceCandidate,
      outputCandidate: input.outputCandidate,
      ...(input.runtimeCheckpoint === undefined
        ? {}
        : { runtimeCheckpoint: input.runtimeCheckpoint }),
    };
    const candidateJson = stableJson(candidates);

    const row = await this.sql.prepare(`
      UPDATE runtime_resource_fences
      SET revision = CASE
            WHEN publication_generation = ? AND publication_json = ?
              THEN revision ELSE revision + 1 END,
          publication_generation = ?,
          publication_json = ?
      WHERE scope_key = ? AND generation = ? AND owner_id = ?
        AND fence_token = ? AND expires_at_ms > ?
      RETURNING revision
    `).bind(
      input.fence.generation,
      candidateJson,
      input.fence.generation,
      candidateJson,
      scopeKey(input.fence),
      input.fence.generation,
      input.fence.ownerId,
      input.fence.token,
      now,
    ).first<RevisionRow>();
    if (row === null) return { type: "lost" };
    const revision = asSafeInteger(row.revision, "revision");
    return { type: "published", revision };
  }

  async release(input: {
    fence: RuntimeResourceFence;
    reason: "completed" | "failed" | "lease_lost";
  }): Promise<void> {
    await this.sql.prepare(`
      UPDATE runtime_resource_fences
      SET expires_at_ms = 0
      WHERE scope_key = ? AND generation = ? AND owner_id = ?
        AND fence_token = ?
    `).bind(
      scopeKey(input.fence),
      input.fence.generation,
      input.fence.ownerId,
      input.fence.token,
    ).run();
  }
}

interface OrphanRow {
  id: string;
  workspace_id: string;
  environment_id: string;
  session_id: string;
  work_id: string;
  generation: number | string;
  owner_id: string;
  sandbox_json: string;
  reason: string;
  attempts: number | string;
  last_error: string;
}

function orphanErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
}

function parseOrphanRow(row: OrphanRow): RuntimeOrphanRecord {
  const sandbox = JSON.parse(row.sandbox_json) as RuntimeOrphanRecord["sandbox"];
  if (
    typeof sandbox !== "object"
    || sandbox === null
    || typeof sandbox.provider !== "string"
    || sandbox.provider.length === 0
    || typeof sandbox.runtimeId !== "string"
    || sandbox.runtimeId.length === 0
  ) {
    throw new Error("SQL runtime orphan contains an invalid sandbox lease");
  }
  if (row.reason !== "completed" && row.reason !== "failed" && row.reason !== "lease_lost") {
    throw new Error("SQL runtime orphan contains an invalid cleanup reason");
  }
  return {
    id: row.id,
    scope: {
      workspaceId: row.workspace_id,
      environmentId: row.environment_id,
      sessionId: row.session_id,
      workId: row.work_id,
    },
    generation: asSafeInteger(row.generation, "orphan generation"),
    ownerId: row.owner_id,
    sandbox,
    reason: row.reason as RuntimeOrphanReason,
    attempts: asSafeInteger(row.attempts, "orphan attempts"),
    lastError: row.last_error,
  };
}

/** Durable retry queue for provider resources that survived hard termination. */
export class SqlRuntimeOrphanPort implements RuntimeOrphanPort {
  constructor(private readonly sql: SqlClient) {}

  async enqueue(input: Parameters<RuntimeOrphanPort["enqueue"]>[0]): Promise<void> {
    const id = runtimeOrphanId(input);
    await this.sql.prepare(`
      INSERT INTO runtime_resource_orphans (
        id, workspace_id, environment_id, session_id, work_id,
        generation, owner_id, sandbox_json, reason, attempts, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT(id) DO UPDATE SET last_error = excluded.last_error
    `).bind(
      id,
      input.scope.workspaceId,
      input.scope.environmentId,
      input.scope.sessionId,
      input.scope.workId,
      input.generation,
      input.ownerId,
      stableJson(input.sandbox),
      input.reason,
      orphanErrorMessage(input.error),
    ).run();
  }

  async list(input: { limit: number }): Promise<readonly RuntimeOrphanRecord[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
      throw new Error("Runtime orphan list limit must be a positive integer");
    }
    const result = await this.sql.prepare(`
      SELECT id, workspace_id, environment_id, session_id, work_id,
             generation, owner_id, sandbox_json, reason, attempts, last_error
      FROM runtime_resource_orphans
      ORDER BY id
      LIMIT ?
    `).bind(input.limit).all<OrphanRow>();
    return (result.results ?? []).map(parseOrphanRow);
  }

  async failed(input: { id: string; error: unknown }): Promise<void> {
    await this.sql.prepare(`
      UPDATE runtime_resource_orphans
      SET attempts = attempts + 1, last_error = ?
      WHERE id = ?
    `).bind(orphanErrorMessage(input.error), input.id).run();
  }

  async resolve(input: { id: string }): Promise<void> {
    await this.sql.prepare("DELETE FROM runtime_resource_orphans WHERE id = ?")
      .bind(input.id)
      .run();
  }
}
