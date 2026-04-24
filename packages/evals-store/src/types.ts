// Public types for the evals store service. Mirrors the D1 schema in
// apps/main/migrations/0012_eval_runs_table.sql.
//
// Design choices:
//   - EvalRunRow holds the full run record. The progressive `tasks[]` state
//     (with embedded per-trial details: session_id, trajectory_id, current
//     message index, error) is round-tripped via the opaque `results` JSON
//     column — the store doesn't interpret it, so route + eval-runner can
//     evolve their task/trial shape without schema migrations.
//   - status / score / completed_at are first-class columns so the cron tick
//     replacement (listActive: WHERE status IN ('pending','running')) and
//     score-based reporting (future) stay indexable.
//   - Soft FK to `agents` and `environments` (still KV-only as of OPE-9 scope)
//     — both *_id columns are plain TEXT, cascade lives in app layer.
//   - Per-resource event log / trajectory blobs are NOT stored here — they
//     continue to live in CONFIG_KV under `t:{tenant}:trajectory:{id}` keys
//     (eval-runner.ts:169), referenced by id from inside the `results` blob.

export type EvalRunStatus = "pending" | "running" | "completed" | "failed";

export interface EvalRunRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  environment_id: string;
  /** Optional named suite the run belongs to (e.g. "smoke", "regression"). */
  suite: string | null;
  status: EvalRunStatus;
  /** Frozen at create time — represents when the run started. ISO timestamp. */
  started_at: string;
  /** ISO timestamp; null while pending or running. */
  completed_at: string | null;
  /**
   * Opaque JSON blob — the run's progressive task/trial state. Adapters
   * JSON.parse the `results` column. Route + eval-runner own its shape.
   */
  results: unknown;
  /** Aggregate numeric score, e.g. completed/total. Nullable while running. */
  score: number | null;
  /** Run-level error message, populated only on terminal failure. */
  error: string | null;
}
