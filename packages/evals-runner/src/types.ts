// EvalRunRecord / EvalTaskSpec / EvalTrialResult — the wire shape returned
// by /v1/evals/runs. Stored opaquely inside EvalRunRow.results JSON.

import type { RewardSpec } from "@open-managed-agents/shared";
import type { EvalRunStatus } from "@open-managed-agents/evals-store";

export interface EvalTaskSpec {
  id: string;
  setup_files?: { path: string; content: string }[];
  /** Bash run in the sandbox via /exec before the first message. */
  setup_script?: string;
  messages: string[];
  timeout_ms?: number;
  trials?: number;
  reward?: RewardSpec;
}

export type { EvalRunStatus };

export interface EvalTrialResult {
  trial_index: number;
  status: EvalRunStatus;
  session_id?: string;
  trajectory_id?: string;
  current_message_index?: number;
  error?: string;
  started_at?: string;
  ended_at?: string;
  finalize_retry_count?: number;
  reward?: number;
}

export interface EvalTaskResult {
  id: string;
  spec: EvalTaskSpec;
  status: EvalRunStatus;
  trials: EvalTrialResult[];
  trial_pass_count?: number;
  trial_total?: number;
  error?: string;
}

export interface EvalRunRecord {
  id: string;
  tenant_id: string;
  agent_id: string;
  environment_id: string;
  status: EvalRunStatus;
  created_at: string;
  started_at?: string;
  ended_at?: string;
  task_count: number;
  completed_count: number;
  failed_count: number;
  tasks: EvalTaskResult[];
  error?: string;
}

/**
 * Translate an EvalRunRow (storage shape) to the legacy EvalRunRecord
 * (route + advanceRun consumer shape). The mutable per-tick state lives
 * in the opaque `results` JSON column.
 */
export function rowToRecord(row: import("@open-managed-agents/evals-store").EvalRunRow): EvalRunRecord {
  const partial = (row.results ?? {}) as Partial<EvalRunRecord>;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    agent_id: row.agent_id,
    environment_id: row.environment_id,
    status: row.status as EvalRunStatus,
    created_at: row.started_at,
    started_at: row.started_at,
    ended_at: row.completed_at ?? undefined,
    error: row.error ?? undefined,
    task_count: partial.task_count ?? 0,
    completed_count: partial.completed_count ?? 0,
    failed_count: partial.failed_count ?? 0,
    tasks: partial.tasks ?? [],
  };
}

export function extractResults(run: EvalRunRecord): unknown {
  return {
    task_count: run.task_count,
    completed_count: run.completed_count,
    failed_count: run.failed_count,
    tasks: run.tasks,
  };
}

export function kvKey(tenantId: string, ...parts: string[]): string {
  return `t:${tenantId}:${parts.join(":")}`;
}
