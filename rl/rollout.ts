import type { RLTask, RLTaskSet, RolloutConfig, RolloutResult, Trajectory, TokenUsage } from "./types.js";
import { eventsToTrajectory } from "./trajectory.js";
import { computeReward, batchRewardStats } from "./reward.js";
import { verifierForSpec, type VerifierContext } from "../packages/eval-core/src/index.js";
import {
  createAgent,
  createSession,
  deleteAgent,
  deleteSession,
  execInSandbox,
  sendAndWait,
  setupFiles,
  getOrCreateEnvironment,
} from "../test/eval/client.js";

const DEFAULT_TOOLS = [
  { type: "agent_toolset_20260401", default_config: { enabled: true } },
];

const DEFAULT_SYSTEM = "You are a helpful assistant. Complete tasks precisely and efficiently.";

/**
 * Build a VerifierContext for the given session that runs verify_scripts
 * directly in the sandbox via /exec. Replaces the prior runScriptVerifier
 * approach (which sent a follow-up message asking the model to run the
 * script and emit `EXIT_CODE=N`) — that flow consumed model tokens, was
 * non-deterministic (model could refuse / paraphrase), and had no
 * timeout discipline. The Verifier framework's ScriptVerifier uses this
 * ctx.runExec to talk to the sandbox directly.
 */
function buildVerifierContext(sessionId: string): VerifierContext {
  return {
    sessionId,
    runExec: (cmd, opts) => execInSandbox(sessionId, cmd, opts?.timeoutMs ?? 600_000),
  };
}

class SessionPool {
  private available: Array<{ sessionId: string; agentId: string }> = [];
  private envId: string | null = null;
  private config: RolloutConfig;

  constructor(config: RolloutConfig) {
    this.config = config;
  }

  async warmup(count: number): Promise<void> {
    this.envId = await getOrCreateEnvironment();
    const promises = Array.from({ length: count }, () => this.createOne());
    this.available = await Promise.all(promises);
    console.log(`[pool] Warmed up ${count} sessions`);
  }

  private async createOne(): Promise<{ sessionId: string; agentId: string }> {
    const agentId = await createAgent({
      name: `rl-rollout-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      system: DEFAULT_SYSTEM,
      model: this.config.model,
      tools: DEFAULT_TOOLS,
    });
    const sessionId = await createSession(agentId, this.envId!);
    return { sessionId, agentId };
  }

  async acquire(): Promise<{ sessionId: string; agentId: string }> {
    if (this.available.length > 0) {
      return this.available.pop()!;
    }
    if (!this.envId) this.envId = await getOrCreateEnvironment();
    return this.createOne();
  }

  async release(handle: { sessionId: string; agentId: string }): Promise<void> {
    await deleteSession(handle.sessionId).catch(() => {});
    await deleteAgent(handle.agentId).catch(() => {});
  }

  async destroyAll(): Promise<void> {
    await Promise.all(this.available.map((h) => this.release(h)));
    this.available = [];
  }
}

async function executeTask(
  task: RLTask,
  pool: SessionPool,
  config: RolloutConfig,
): Promise<Trajectory> {
  const startTime = Date.now();
  const handle = await pool.acquire();

  try {
    if (task.setup_files && task.setup_files.length > 0) {
      await setupFiles(handle.sessionId, task.setup_files);
    }

    const events = await sendAndWait(
      handle.sessionId,
      task.message,
      task.timeout_ms || config.timeout_ms,
    );

    const trajectory = eventsToTrajectory(
      events,
      task,
      handle.sessionId,
      config.model,
      startTime,
    );

    if (task.reward.type === "script" && task.reward.verify_script) {
      try {
        // Phase 2 unification: route through ScriptVerifier (single
        // verify_script implementation across eval-runner + RL rollout).
        // Pass an empty Trajectory placeholder — ScriptVerifier doesn't
        // inspect it, only runs the script and grades by exit code.
        const ctx = buildVerifierContext(handle.sessionId);
        const verifier = verifierForSpec(
          { type: "script", verify_script: task.reward.verify_script },
          ctx,
        );
        const score = await verifier.check({} as never);
        const meta = score.metadata as { exit_code?: number; output?: string } | undefined;
        trajectory.metadata.verifier_result = {
          exit_code: typeof meta?.exit_code === "number" ? meta.exit_code : score.pass ? 0 : -1,
          output: typeof meta?.output === "string" ? meta.output : "",
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        trajectory.metadata.verifier_result = { exit_code: -1, output: `verifier_error: ${msg}` };
      }
    }

    const reward = await computeReward(trajectory, task);
    trajectory.reward = reward;

    return trajectory;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      task_id: task.id,
      session_id: handle.sessionId,
      turns: [],
      reward: { total: 0 },
      token_usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      num_turns: 0,
      duration_ms: Date.now() - startTime,
      outcome: msg.includes("timeout") ? "timeout" : "error",
      metadata: {
        model_id: config.model,
        collected_at: new Date().toISOString(),
      },
    };
  } finally {
    await pool.release(handle);
  }
}

export async function batchRollout(
  tasks: RLTask[],
  config: RolloutConfig,
): Promise<RolloutResult> {
  const pool = new SessionPool(config);
  const warmupCount = Math.min(config.concurrency, tasks.length);

  console.log(`[rollout] Starting batch: ${tasks.length} tasks, concurrency=${config.concurrency}`);
  console.log(`[rollout] Model: ${config.model}${config.model_base_url ? ` @ ${config.model_base_url}` : ""}`);

  await pool.warmup(warmupCount);

  const trajectories: Trajectory[] = [];
  const pending: Promise<void>[] = [];
  let active = 0;

  for (const task of tasks) {
    while (active >= config.concurrency) {
      await Promise.race(pending);
    }

    active++;
    const p = executeTask(task, pool, config).then((trajectory) => {
      trajectories.push(trajectory);
      active--;
      const icon = trajectory.outcome === "success" ? "OK" : "ERR";
      console.log(
        `[rollout] ${icon} ${task.id} reward=${trajectory.reward.total.toFixed(3)} ` +
          `turns=${trajectory.num_turns} ${(trajectory.duration_ms / 1000).toFixed(1)}s`,
      );
    });
    pending.push(p);
  }

  await Promise.all(pending);
  await pool.destroyAll();

  const totalTokens: TokenUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  for (const t of trajectories) {
    totalTokens.input_tokens += t.token_usage.input_tokens;
    totalTokens.output_tokens += t.token_usage.output_tokens;
    totalTokens.cache_read_input_tokens += t.token_usage.cache_read_input_tokens;
    totalTokens.cache_creation_input_tokens += t.token_usage.cache_creation_input_tokens;
  }

  const rewardStats = batchRewardStats(trajectories.map((t) => t.reward));

  const stats = {
    total: trajectories.length,
    success: trajectories.filter((t) => t.outcome === "success").length,
    failure: trajectories.filter((t) => t.outcome === "failure").length,
    error: trajectories.filter((t) => t.outcome === "error").length,
    timeout: trajectories.filter((t) => t.outcome === "timeout").length,
    mean_reward: rewardStats.mean,
    mean_turns: trajectories.reduce((s, t) => s + t.num_turns, 0) / trajectories.length,
    mean_duration_ms: trajectories.reduce((s, t) => s + t.duration_ms, 0) / trajectories.length,
    total_tokens: totalTokens,
  };

  console.log(`[rollout] Done: ${stats.success}/${stats.total} success, mean_reward=${stats.mean_reward.toFixed(3)}`);

  return { trajectories, stats };
}

export function loadTaskSet(path: string): RLTask[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const data = require(path) as RLTaskSet;
  return data.tasks;
}
