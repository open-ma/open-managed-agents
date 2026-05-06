import type { SessionEvent, ContentBlock } from "../packages/shared/src/types.js";

// --- RL Task Definition ---

export interface SetupFile {
  path: string;
  content: string;
}

export interface VerifyCheck {
  type: "file_exists" | "file_contains" | "exit_code" | "bash_output_contains" | "sandbox_exec";
  path?: string;
  expected?: string;
  command?: string; // for sandbox_exec: run this command, check exit code
  score: number; // 0.0 - 1.0
}

export interface RewardSpec {
  type: "verifiable" | "custom" | "script" | "reward_model" | "composite";
  // verifiable: built-in declarative checks
  checks?: VerifyCheck[];
  ground_truth?: string;
  // custom: user-registered VerifyFn by domain name
  domain?: string;
  // script: run a command in sandbox, exit 0 = pass
  verify_script?: string;
  // reward_model: external endpoint
  reward_model?: { endpoint?: string; prompt_template?: string };
  // composite: weighted combination
  weights?: { verifiable?: number; reward_model?: number; efficiency?: number };
}

export interface RLTask {
  id: string;
  description: string;
  message: string;
  setup_files?: SetupFile[];
  /**
   * Bash script run in the sandbox via /exec BEFORE the first user.message
   * is sent. Use for env preparation that can't be expressed as static
   * file writes — git clone at a specific commit, system package install,
   * dataset download, etc. Runs after `setup_files` writes complete.
   *
   * The eval-runner aborts the trial if the script's exit code is nonzero,
   * so the agent never sees a half-staged environment. Output is
   * truncated to 4 KB and surfaced in the error trail for debugging.
   */
  setup_script?: string;
  reward: RewardSpec;
  max_turns?: number; // default: 5
  timeout_ms?: number; // default: 300_000
  group_size?: number; // GRPO: how many trajectories to sample per task (default: 4)
}

export interface RLTaskSet {
  name: string;
  version: string;
  tasks: RLTask[];
}

// --- Completion (token-level data, aligned with Forge) ---

export interface Completion {
  completion_uuid: string;
  prompt_ids?: number[];
  response_ids?: number[];
  logprobs?: number[]; // per response token log probability
  finish_reason: "stop" | "length" | "tool_calls" | "error";
  content: string; // decoded text
  turn_index: number;
}

// --- Trajectory ---

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface TurnRecord {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_results?: ToolResult[];
  timestamp_ms: number;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
}

// --- Reward (aligned with Forge's RewardResult) ---

export interface RewardResult {
  raw_rewards: Record<string, number>; // named reward components
  final_reward: number; // aggregated scalar
}

export interface RewardBreakdown {
  total: number;
  rules?: number;
  llm?: number;
  efficiency?: number;
}

// --- Group (for GRPO advantage estimation) ---

export interface GroupStats {
  group_uuid: string;
  reward_mean: number;
  reward_std: number;
  finished_num: number;
  pass_rate: number;
}

export interface Trajectory {
  task_id: string;
  session_id: string;
  traj_uuid: string;
  group_uuid: string; // same task sampled multiple times shares group_uuid
  turns: TurnRecord[];
  completions: Completion[];
  reward: RewardResult;
  reward_breakdown: RewardBreakdown; // backward compat
  group_stats?: GroupStats;
  token_usage: TokenUsage;
  num_turns: number;
  duration_ms: number;
  outcome: "success" | "failure" | "error" | "timeout";
  metadata: {
    model_id: string;
    policy_version?: string;
    domain_name?: string;
    data_source?: string;
    collected_at: string;
    verifier_result?: { exit_code: number; output: string };
  };
}

// --- Rollout Config ---

export interface RolloutConfig {
  api_url: string;
  api_key: string;
  model: string;
  model_base_url?: string;
  model_compat?: "ant" | "ant-compatible" | "oai" | "oai-compatible";
  concurrency: number;
  timeout_ms: number;
  max_turns: number;
  group_size: number; // GRPO: trajectories per task (default: 4)
}

// --- Rollout Result ---

export interface RolloutResult {
  trajectories: Trajectory[];
  stats: {
    total: number;
    success: number;
    failure: number;
    error: number;
    timeout: number;
    mean_reward: number;
    mean_turns: number;
    mean_duration_ms: number;
    total_tokens: TokenUsage;
  };
}
