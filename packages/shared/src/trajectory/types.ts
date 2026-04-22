// OMA Trajectory v1 — schema spec at docs/trajectory-v1-spec.md
//
// A Trajectory wraps a session's event stream with the metadata needed to
// replay, evaluate, train on, or audit it. Stable, versioned, with documented
// projections to popular shapes (Anthropic Messages first; OTel/Inspect/RL later).

import type { AgentConfig, EnvironmentConfig, StoredEvent } from "../types.js";

// --- Identity & lifecycle ---

export type TrajectoryOutcome =
  | "success" // session.status_idle reached without errors
  | "failure" // session.error or supervisor failed
  | "timeout" // wall-clock or turn limit hit
  | "interrupted" // user.interrupt
  | "running"; // not yet ended

export interface TrajectorySummary {
  num_events: number;
  num_turns: number; // count of agent.message events
  num_tool_calls: number;
  num_tool_errors: number;
  num_threads: number; // multi-agent sub-thread count
  duration_ms: number;
  token_usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
}

// --- RL extension (optional, populated only by RL workstream) ---

export interface Completion {
  completion_id: string;
  span_id?: string; // links to span.model_request_start.id
  turn_index: number; // 0-based, matches Nth agent.message
  prompt_ids: number[];
  response_ids: number[];
  logprobs: number[]; // per response token
  ref_logprobs?: number[]; // reference-model logprobs (KL term)
  finish_reason: "stop" | "length" | "tool_calls" | "error";
  model_id: string;
  // For PPO/GRPO with token-level rewards:
  token_advantages?: number[];
  token_rewards?: number[];
}

export interface RewardResult {
  raw_rewards: Record<string, number>; // named components
  final_reward: number; // aggregated scalar [0, 1]
  verifier_id?: string;
  computed_at?: string;
}

export interface GroupStats {
  group_id: string;
  reward_mean: number;
  reward_std: number; // clamped to ≥1e-8
  finished_num: number;
  pass_rate: number;
}

// --- Trajectory envelope ---

export interface Trajectory {
  schema_version: "oma.trajectory.v1";
  trajectory_id: string;
  session_id: string;
  group_id?: string; // RL: same task sampled N times shares group_id
  task_id?: string; // RL/eval: which task this trajectory ran

  // Configuration snapshots (frozen at session start)
  agent_config: AgentConfig;
  environment_config: EnvironmentConfig;
  model: { id: string; provider: string; base_url?: string };

  // Lifecycle
  started_at: string; // ISO-8601
  ended_at?: string; // null while running
  outcome: TrajectoryOutcome;

  // Events (raw stream, source of truth)
  events: StoredEvent[];

  // RL extension (omitted for non-RL trajectories)
  completions?: Completion[];
  reward?: RewardResult;
  group_stats?: GroupStats;

  // Aggregates (computed once at end, cached for fast eval)
  summary: TrajectorySummary;
}
