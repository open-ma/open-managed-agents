// ---- Eval Framework Types ----

export type Difficulty = "easy" | "medium" | "hard";
export type Category = "tool-use" | "coding" | "multi-step" | "error-recovery" | "multi-agent";
export type VerifyStatus = "pass" | "fail" | "skip";

// Mirrors the relevant subset of SessionEvent types from packages/shared
export interface SSEEvent {
  type: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  tool_use_id?: string;
  stop_reason?: { type: string };
  reason?: string;
  result?: string;
  // catch-all for fields we don't enumerate
  [key: string]: unknown;
}

export interface VerifyResult {
  status: VerifyStatus;
  message: string;
  details?: string[];
}

export interface SetupFile {
  path: string;
  content: string;
}

export interface EvalTurn {
  message: string;
  verify: (events: SSEEvent[]) => VerifyResult;
}

export interface SubAgentConfig {
  name: string;
  system: string;
  model?: string;
  tools: unknown[];
}

export interface EvalTask {
  id: string;
  category: Category;
  difficulty: Difficulty;
  description: string;

  agentConfig: {
    system: string;
    model?: string;
    tools: unknown[];
    callable_agents?: Array<{ type: "agent"; id: string }>;
  };

  // Sub-agents created before the eval (multi-agent tasks)
  subAgents?: SubAgentConfig[];

  // Files written to sandbox in a setup turn before the eval starts
  setupFiles?: SetupFile[];

  // One or more turns; each is sent sequentially and verified independently
  turns: EvalTurn[];

  // Overall verification after all turns complete
  finalVerify?: (allEvents: SSEEvent[]) => VerifyResult;

  // Per-turn timeout (default 300_000 ms = 5 min)
  timeoutMs?: number;
}

export interface EvalTaskResult {
  taskId: string;
  category: Category;
  difficulty: Difficulty;
  status: VerifyStatus;
  message: string;
  durationMs: number;
  turnResults: VerifyResult[];
  error?: string;
}

export interface EvalSuiteResult {
  suite: string;
  tasks: EvalTaskResult[];
  pass: number;
  fail: number;
  skip: number;
}

export interface EvalReport {
  timestamp: string;
  suites: EvalSuiteResult[];
  totalPass: number;
  totalFail: number;
  totalSkip: number;
  totalTasks: number;
  durationMs: number;
}

// Default toolset config used by most eval agents
export const DEFAULT_TOOLS = [
  { type: "agent_toolset_20260401", default_config: { enabled: true } },
];

export const DEFAULT_SYSTEM = "You are a helpful coding assistant. Complete tasks precisely and verify your work.";
export const DEFAULT_MODEL = process.env.OMA_MODEL || "MiniMax-M2.7";
export const DEFAULT_TIMEOUT = 600_000; // 10 min for production tasks
