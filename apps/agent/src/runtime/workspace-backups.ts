// Workspace backup/restore registry — wraps the @cloudflare/sandbox
// createBackup/restoreBackup pattern with persistence in D1.
//
// CF SDK lets the sandbox container snapshot a directory (squashfs → R2)
// and restore it later. The handle is a small serializable object the SDK
// gives us; we store it in D1 keyed by (tenant_id, environment_id) so a
// fresh session in the same scope picks up where the previous session left
// off. Cloudflare's official "persist across sessions" pattern per the
// 2026-02-23 changelog post.
//
// Why per-(tenant, environment)?
//   - environment_id is the natural unit of "this is my project's workspace
//     state" (deps installed, repo cloned, build cache, etc.)
//   - tenant_id keeps tenants strictly isolated even if they share env templates
//   - Per-agent or per-session-thread are finer-grained but for v1 we want
//     simple semantics; per-(tenant, env) maps cleanly to "log back in,
//     workspace is where you left it"
//
// Refinements deferred to follow-up:
//   - Per-(tenant, env, agent) for multi-agent orgs needing per-agent state
//   - Periodic snapshots during long sessions (currently snapshot only at
//     session destroy — browser close without DELETE → state lost)
//   - Branching/forking backups
//   - Manual backup/restore via REST API for operator workflows

import { logWarn } from "@open-managed-agents/shared";

/**
 * Mirror of @cloudflare/sandbox `DirectoryBackup`. Kept local to avoid
 * importing the SDK type into a module that needs to run in environments
 * without it. Shape MUST stay byte-compatible with the SDK type.
 */
export interface WorkspaceBackupHandle {
  id: string;
  dir: string;
  localBucket?: boolean;
}

/**
 * Default TTL for a workspace backup. Matches the typical "I might come
 * back next week" expectation; tunable without schema change.
 */
export const DEFAULT_WORKSPACE_BACKUP_TTL_SEC = 7 * 24 * 60 * 60;

/**
 * Look up the most recent UN-expired workspace backup for a scope. Returns
 * null if none, or if D1 errors (best-effort path — restore failure on
 * warmup falls back to empty workspace, not a crash).
 */
export async function findLatestBackup(
  db: D1Database,
  tenantId: string,
  environmentId: string,
  nowMs: number,
): Promise<WorkspaceBackupHandle | null> {
  try {
    const row = await db
      .prepare(
        `SELECT backup_handle FROM workspace_backups
         WHERE tenant_id = ? AND environment_id = ? AND expires_at > ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(tenantId, environmentId, nowMs)
      .first<{ backup_handle: string }>();
    if (!row) return null;
    return JSON.parse(row.backup_handle) as WorkspaceBackupHandle;
  } catch (err) {
    logWarn(
      { op: "workspace_backups.find", tenant_id: tenantId, environment_id: environmentId, err },
      "workspace backup lookup failed",
    );
    return null;
  }
}

/**
 * Persist a freshly-minted backup handle. Idempotent in the sense that
 * a duplicate insert just creates an additional row; cleanup cron handles
 * the redundancy.
 */
export async function recordBackup(
  db: D1Database,
  opts: {
    tenantId: string;
    environmentId: string;
    handle: WorkspaceBackupHandle;
    nowMs: number;
    ttlSec: number;
    sessionId?: string;
  },
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO workspace_backups
         (tenant_id, environment_id, backup_handle, created_at, expires_at, source_session_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        opts.tenantId,
        opts.environmentId,
        JSON.stringify(opts.handle),
        opts.nowMs,
        opts.nowMs + opts.ttlSec * 1000,
        opts.sessionId ?? null,
      )
      .run();
  } catch (err) {
    logWarn(
      { op: "workspace_backups.record", tenant_id: opts.tenantId, environment_id: opts.environmentId, err },
      "workspace backup record failed; squashfs is in R2 but we lost the handle (will GC via TTL)",
    );
  }
}

/**
 * Daily cleanup: delete workspace_backups rows older than their expires_at.
 * Cron-friendly (idempotent, safe to run repeatedly).
 *
 * Note: this only cleans the D1 row. The squashfs in R2 is GC'd by the
 * R2 lifecycle rule the operator configures on managed-agents-backups
 * (matching the same TTL).
 */
export async function pruneExpired(db: D1Database, nowMs: number): Promise<number> {
  try {
    const result = await db
      .prepare(`DELETE FROM workspace_backups WHERE expires_at < ?`)
      .bind(nowMs)
      .run();
    const changes = (result.meta as { changes?: number } | undefined)?.changes;
    return typeof changes === "number" ? changes : -1;
  } catch (err) {
    logWarn({ op: "workspace_backups.prune", err }, "workspace backup prune failed");
    return -1;
  }
}

// ============================================================
// Coordination helper (extracted for unit testing)
// ============================================================

/**
 * State the coordinator carries between calls. Lives on the SessionDO as
 * mutable instance fields; passed in to keep this function pure.
 */
export interface BackupCoordinatorState {
  /** Last successful backup timestamp (ms). 0 if no backup yet. */
  lastBackupAt: number;
  /** Single in-flight backup promise to coalesce concurrent calls. null when idle. */
  inFlight: Promise<void> | null;
}

export interface BackupCoordinatorDeps {
  /** Minimum interval (ms) between non-force backups. */
  debounceMs: number;
  /** Async work the coordinator runs (the actual createBackup + recordBackup). */
  doBackup: () => Promise<void>;
  /** "Now" — injected for testability. */
  now: () => number;
}

/**
 * Coalesce + debounce a workspace backup. Pure function over an explicit
 * state object so unit tests can drive it deterministically with a mock
 * clock + a stubbed doBackup.
 *
 * Behavior:
 *   - If a backup is in flight: force callers await it; non-force callers skip.
 *   - Otherwise: non-force callers debounced by debounceMs since lastBackupAt;
 *     force callers always proceed.
 *   - Sentinel `lastBackupAt === 0` means "no backup has ever succeeded" — the
 *     debounce never applies in that case (otherwise a small mock-clock value
 *     would suppress the very first backup; production Date.now() is large
 *     enough that this never triggered, but the semantic gap was real).
 *   - On success: lastBackupAt is updated.
 *   - On failure: lastBackupAt is NOT updated (next call may retry).
 *
 * Mutates `state` in place — that mirrors the SessionDO's instance-field
 * model and keeps the caller side cheap (no return-value to thread).
 */
export async function coordinateBackup(
  state: BackupCoordinatorState,
  deps: BackupCoordinatorDeps,
  opts?: { force?: boolean },
): Promise<void> {
  if (state.inFlight) {
    return opts?.force ? state.inFlight : undefined;
  }
  const now = deps.now();
  const debounced =
    !opts?.force &&
    state.lastBackupAt > 0 &&
    now - state.lastBackupAt < deps.debounceMs;
  if (debounced) {
    return;
  }
  state.inFlight = (async () => {
    try {
      await deps.doBackup();
      state.lastBackupAt = deps.now();
    } catch {
      // doBackup is responsible for its own logging; we just don't bump
      // lastBackupAt on failure so the next call may retry sooner.
    }
  })();
  try {
    await state.inFlight;
  } finally {
    state.inFlight = null;
  }
}
