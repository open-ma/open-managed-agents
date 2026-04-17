import type { SessionEvent, ContentBlock } from "../packages/shared/src/types.js";

// --- RL Task Definition ---

export interface SetupFile {
  path: string;
  content: string;
}

export interface RuleReward {
  check: "file_exists" | "file_contains" | "exit_code" | "bash_output_contains";
  path?: string;
  expected?: string;
  score: number; // 0.0 - 1.0
}

export interface RewardSpec {
  type: "rule" | "llm" | "composite";
  rules?: RuleReward[];
  rubric?: { description: string; criteria: string[] };
  weights?: { rules?: number; llm?: number; efficiency?: number };
}

export interface RLTask {
  id: string;
  description: string;
  message: string; // what to send to the agent
  setup_files?: SetupFile[];
  reward: RewardSpec;
  max_turns?: number; // default: 5
  timeout_ms?: number; // default: 300_000
}

export interface RLTaskSet {
  name: string;
  version: string;
  tasks: RLTask[];
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

export interface RewardBreakdown {
  total: number;
  rules?: number;
  llm?: number;
  efficiency?: number;
}

export interface Trajectory {
  task_id: string;
  session_id: string;
  turns: TurnRecord[];
  reward: RewardBreakdown;
  token_usage: TokenUsage;
  num_turns: number;
  duration_ms: number;
  outcome: "success" | "failure" | "error" | "timeout";
  metadata: {
    model_id: string;
    policy_version?: string;
    collected_at: string;
  };
}

// --- Rollout Config ---

export interface RolloutConfig {
  api_url: string;
  api_key: string;
  model: string;
  model_base_url?: string; // vLLM endpoint
  model_compat?: "ant" | "ant-compatible" | "oai" | "oai-compatible";
  concurrency: number;
  timeout_ms: number;
  max_turns: number;
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
