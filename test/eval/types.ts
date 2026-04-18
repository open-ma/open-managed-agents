// ---- Eval Framework Types ----
import type { Scorer, ContentBlock } from "../../packages/shared/src/index.js";

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

/**
 * Files uploaded via POST /v1/files BEFORE the turns run.
 * The resulting file_ids (in upload order) are passed to turn.message when
 * message is a function — used by T6.3 to test the file_id resolver path.
 */
export interface SetupUpload {
  filename: string;
  /** Either base64 (for binary) or raw text (for text/*). */
  content: string;
  encoding?: "base64" | "utf8";
  media_type: string;
}

export interface EvalTurnContext {
  fileIds: string[];
}

export interface EvalTurn {
  /**
   * Either a string (legacy) or a function that receives the uploaded
   * file_ids and returns a string OR ContentBlock[]. ContentBlock[] lets a
   * test send {type:"document", source:{type:"file", file_id}} blocks.
   */
  message: string | ((ctx: EvalTurnContext) => string | ContentBlock[]);
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

  // Files uploaded via POST /v1/files before the turns. Their file_ids are
  // passed to turn.message when it's a function. Use this to test the
  // file_id → inline base64 + sandbox auto-mount path.
  setupUploads?: SetupUpload[];

  // Free-form metadata attached to the task. Surfaces in reports + lets
  // downstream graders pick task-specific dimensions (e.g. GAIA level).
  metadata?: Record<string, unknown>;

  // One or more turns; each is sent sequentially and verified independently
  turns: EvalTurn[];

  // Overall verification after all turns complete
  finalVerify?: (allEvents: SSEEvent[]) => VerifyResult;

  // NEW (Phase 2): Scorer runs against a synthesized Trajectory after all turns.
  // If provided, replaces per-turn verify + outcome judge. Other fields stay for
  // backward compat with existing tests.
  scorer?: Scorer;

  // NEW (P0a, blog-aligned): how many independent trials of this task to run.
  // Default 1. When > 1, the report computes pass@1, pass@k, pass^k.
  // pass@k = at least one trial passed (creativity benchmark).
  // pass^k = all trials passed (consistency / determinism benchmark).
  trials?: number;

  // NEW (P0b): bash commands sent as the final turn AFTER the agent's last
  // user message, asking the agent to run end-state verification commands.
  // Their outputs land in the trajectory and can be checked by the scorer
  // (typically via bashOutputMarker or includes). Inspired by Anthropic's
  // "state_check" pattern in their evals blog.
  verifyCommands?: string[];

  // Per-turn timeout (default 300_000 ms = 5 min)
  timeoutMs?: number;

  // Layer 2: outcome evaluation (optional, runs after all turns pass)
  outcome?: {
    description: string;
    rubric: string;
  };
}

export interface EvalTrialResult {
  trialIndex: number;
  status: VerifyStatus;
  message: string;
  durationMs: number;
  turnResults: VerifyResult[];
  error?: string;
}

export interface EvalTaskResult {
  taskId: string;
  category: Category;
  difficulty: Difficulty;
  status: VerifyStatus;       // pass if pass^k, fail if any failed (legacy aggregation)
  message: string;
  durationMs: number;
  turnResults: VerifyResult[]; // first trial's per-turn results (legacy)
  error?: string;
  // NEW (P0a): per-trial breakdown when trials > 1
  trials?: EvalTrialResult[];
  // Computed metrics (only populated when trials > 1)
  passAt1?: boolean;     // first trial passed
  passAtK?: boolean;     // any trial passed
  passPowK?: boolean;    // all trials passed
  trialPassCount?: number;
  trialTotal?: number;
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
