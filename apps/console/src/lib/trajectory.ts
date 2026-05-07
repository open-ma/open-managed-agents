// Console-side Trajectory v1 types (subset).
//
// The canonical types live in `packages/eval-core/src/trajectory/types.ts`.
// We keep a minimal mirror here so the console doesn't pull in the eval-core
// workspace package (and its transitive deps) just to read four fields off a
// JSON response. If the spec ever lands stable types in @open-managed-agents/
// api-types, swap this import.
//
// See docs/trajectory-v1-spec.md for the authoritative shape.

export type TrajectoryOutcome =
  | "success"
  | "failure"
  | "timeout"
  | "interrupted"
  | "running";

export interface RewardResult {
  raw_rewards: Record<string, number>;
  final_reward: number;
  verifier_id?: string;
  computed_at?: string;
}

export interface TrajectorySummary {
  num_events: number;
  num_turns: number;
  num_tool_calls: number;
  num_tool_errors: number;
  num_threads: number;
  duration_ms: number;
  token_usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens?: number;
  };
}

/** Minimal Trajectory envelope as the console consumes it. The wire payload
 *  carries more (events, agent_config, environment_config, completions); we
 *  type those as `unknown` so we don't have to mirror the full schema. */
export interface Trajectory {
  schema_version: "oma.trajectory.v1";
  trajectory_id: string;
  session_id: string;
  group_id?: string;
  task_id?: string;

  agent_config: unknown;
  environment_config: unknown;
  model: { id: string; provider: string; base_url?: string };

  started_at: string;
  ended_at?: string;
  outcome: TrajectoryOutcome;

  events: unknown[];

  reward?: RewardResult;
  completions?: unknown[];
  group_stats?: unknown;

  summary: TrajectorySummary;
}

/** Render the headline for a reward: "PASS" / "FAIL" / "0.42". */
export function rewardHeadline(reward: RewardResult): string {
  const v = reward.final_reward;
  if (!Number.isFinite(v)) return "—";
  if (v >= 0.99) return "PASS";
  if (v <= 0) return "FAIL";
  return v.toFixed(2);
}

/** Map TrajectoryOutcome → StatusPill `status` token (Badge.tsx) so the
 *  pill picks up the right color tone. */
export function outcomeToStatusTone(outcome: TrajectoryOutcome): string {
  switch (outcome) {
    case "success":     return "completed";
    case "failure":     return "errored";
    case "timeout":     return "errored";
    case "interrupted": return "terminated";
    case "running":     return "running";
  }
}
