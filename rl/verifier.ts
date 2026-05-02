/**
 * RL Reward Verifier
 *
 * NOT the same as outcome-evaluator.ts:
 * - outcome-evaluator: production quality check, LLM-as-judge, "is the work good enough?"
 * - verifier: training signal, deterministic where possible, "how well did the policy do?"
 *
 * Design principles:
 * 1. Deterministic rewards first (verifiable checks) — fast, zero cost, no noise
 * 2. Execution-based verification (sandbox_exec) — run code, check output
 * 3. Reward model only as fallback for tasks that can't be rule-verified
 * 4. Aligned with Forge's RewardResult structure
 */

import type {
  Trajectory,
  RLTask,
  VerifyCheck,
  RewardResult,
  RewardBreakdown,
  GroupStats,
} from "./types.js";

// --- Individual check evaluators ---

function checkFileExists(trajectory: Trajectory, check: VerifyCheck): number {
  const allOutput = collectAllOutput(trajectory);
  const writeTools = collectToolCalls(trajectory, "write");
  const bashTools = collectToolCalls(trajectory, "bash");

  const mentioned =
    writeTools.some((tc) => JSON.stringify(tc.input).includes(check.path || "")) ||
    bashTools.some((tc) => JSON.stringify(tc.input).includes(check.path || "")) ||
    allOutput.includes(check.path || "");

  return mentioned ? check.score : 0;
}

function checkFileContains(trajectory: Trajectory, check: VerifyCheck): number {
  const allOutput = collectAllOutput(trajectory);
  return allOutput.includes(check.expected || "") ? check.score : 0;
}

function checkExitCode(trajectory: Trajectory, check: VerifyCheck): number {
  const toolResults = trajectory.turns
    .filter((t) => t.role === "tool")
    .flatMap((t) => t.tool_results || []);

  if (toolResults.length === 0) return 0;

  const lastResult = toolResults[toolResults.length - 1];
  const hasError = lastResult.is_error || lastResult.content.includes("exit code");

  if (check.expected === "0") return hasError ? 0 : check.score;
  return check.score;
}

function checkBashOutputContains(trajectory: Trajectory, check: VerifyCheck): number {
  const allOutput = collectAllOutput(trajectory);
  return allOutput.includes(check.expected || "") ? check.score : 0;
}

function checkSandboxExec(_trajectory: Trajectory, _check: VerifyCheck): number {
  // sandbox_exec requires calling back into the OMA session to run a verification command
  // this is handled at the rollout level, not here
  return 0;
}

// --- Script verifier (run a verify_script in the sandbox via a follow-up turn) ---

/**
 * Run a verify_script in the agent's sandbox by sending a follow-up message,
 * then parse the agent's reply for `EXIT_CODE=<n>`. Used for `RewardSpec.type
 * === "script"` tasks (e.g. terminal-bench pytest tests).
 *
 * Returns -1 if the agent's reply doesn't contain a parseable EXIT_CODE.
 */
export async function runScriptVerifier(
  sendAndWait: (sessionId: string, message: string, timeoutMs?: number) => Promise<unknown[]>,
  sessionId: string,
  verifyScript: string,
  timeoutMs?: number,
): Promise<{ exit_code: number; output: string }> {
  const prompt =
    "Run this exact bash script in the sandbox, then reply with EXACTLY one line at the end: " +
    "`EXIT_CODE=<n>` where <n> is the numeric exit status of the script. " +
    "Do not run anything else. Do not modify the script.\n\n" +
    "```bash\n" +
    verifyScript +
    "\n```";

  const events = await sendAndWait(sessionId, prompt, timeoutMs ?? 600_000);
  let allText = "";
  for (const e of events as Array<Record<string, unknown>>) {
    if (e.type === "agent.message" && Array.isArray(e.content)) {
      for (const block of e.content as Array<Record<string, unknown>>) {
        if (block.type === "text" && typeof block.text === "string") {
          allText += block.text + "\n";
        }
      }
    } else if (e.type === "agent.tool_result" && typeof e.content === "string") {
      allText += e.content + "\n";
    }
  }
  const matches = [...allText.matchAll(/EXIT_CODE=(-?\d+)/g)];
  const last = matches.length > 0 ? matches[matches.length - 1] : null;
  return {
    exit_code: last ? parseInt(last[1], 10) : -1,
    output: allText.slice(-2000),
  };
}

// --- Helpers ---

function collectAllOutput(trajectory: Trajectory): string {
  return trajectory.turns
    .filter((t) => t.role === "tool" || t.role === "assistant")
    .map((t) => {
      if (t.tool_results) {
        return t.tool_results.map((r) => r.content).join("\n");
      }
      return t.content;
    })
    .join("\n");
}

function collectToolCalls(trajectory: Trajectory, toolName: string) {
  return trajectory.turns
    .filter((t) => t.role === "assistant")
    .flatMap((t) => t.tool_calls || [])
    .filter((tc) => tc.name === toolName);
}

// --- Main verifier ---

const CHECK_EVALUATORS: Record<string, (t: Trajectory, c: VerifyCheck) => number> = {
  file_exists: checkFileExists,
  file_contains: checkFileContains,
  exit_code: checkExitCode,
  bash_output_contains: checkBashOutputContains,
  sandbox_exec: checkSandboxExec,
};

function evaluateChecks(trajectory: Trajectory, checks: VerifyCheck[]): Record<string, number> {
  const raw: Record<string, number> = {};
  for (const check of checks) {
    const evaluator = CHECK_EVALUATORS[check.type];
    if (!evaluator) continue;
    const score = evaluator(trajectory, check);
    const key = `${check.type}:${check.path || check.expected || check.command || ""}`.slice(0, 50);
    raw[key] = score;
  }
  return raw;
}

function evaluateGroundTruth(trajectory: Trajectory, groundTruth: string): Record<string, number> {
  const allOutput = collectAllOutput(trajectory);
  const normalized = allOutput.replace(/\s+/g, " ").trim();
  const target = groundTruth.trim();
  const match = normalized.includes(target) ? 1.0 : 0.0;
  return { ground_truth_match: match };
}

function computeEfficiency(trajectory: Trajectory, task: RLTask): number {
  const maxTurns = task.max_turns || 5;
  return Math.max(0, 1.0 - (trajectory.num_turns / maxTurns) * 0.3);
}

// --- Public API ---

export function verify(trajectory: Trajectory, task: RLTask): RewardResult {
  if (trajectory.outcome === "error" || trajectory.outcome === "timeout") {
    return { raw_rewards: { outcome: 0 }, final_reward: 0 };
  }

  const spec = task.reward;
  const raw: Record<string, number> = {};

  // 1. Verifiable checks (deterministic, fast)
  if (spec.checks && spec.checks.length > 0) {
    Object.assign(raw, evaluateChecks(trajectory, spec.checks));
  }

  // 2. Ground truth exact match (deterministic)
  if (spec.ground_truth) {
    Object.assign(raw, evaluateGroundTruth(trajectory, spec.ground_truth));
  }

  // 3. Script verifier — populated by rollout via metadata.verifier_result
  if (spec.type === "script") {
    const vr = trajectory.metadata.verifier_result;
    raw.script_pass = vr && vr.exit_code === 0 ? 1.0 : 0.0;
  }

  // 4. Efficiency bonus
  raw.efficiency = computeEfficiency(trajectory, task);

  // Aggregate
  const weights = spec.weights || { verifiable: 0.8, efficiency: 0.2 };
  const checkScores = Object.entries(raw)
    .filter(([k]) => k !== "efficiency")
    .map(([, v]) => v);
  const checkTotal = checkScores.length > 0
    ? Math.min(checkScores.reduce((a, b) => a + b, 0), 1.0)
    : 0;

  const finalReward =
    checkTotal * (weights.verifiable || 0.8) +
    raw.efficiency * (weights.efficiency || 0.2);

  return { raw_rewards: raw, final_reward: Math.max(0, Math.min(1, finalReward)) };
}

export function verifyBatch(
  trajectories: Trajectory[],
  tasks: Map<string, RLTask>,
): RewardResult[] {
  return trajectories.map((traj) => {
    const task = tasks.get(traj.task_id);
    if (!task) return { raw_rewards: { missing_task: 0 }, final_reward: 0 };
    return verify(traj, task);
  });
}

// --- GRPO Advantage Estimation ---

export function computeGroupAdvantages(
  trajectories: Trajectory[],
): Map<string, GroupStats> {
  const groups = new Map<string, Trajectory[]>();
  for (const traj of trajectories) {
    const existing = groups.get(traj.group_uuid) || [];
    existing.push(traj);
    groups.set(traj.group_uuid, existing);
  }

  const stats = new Map<string, GroupStats>();
  for (const [groupUuid, trajs] of groups) {
    const rewards = trajs.map((t) => t.reward.final_reward);
    const mean = rewards.reduce((a, b) => a + b, 0) / rewards.length;
    const std = Math.sqrt(rewards.reduce((s, r) => s + (r - mean) ** 2, 0) / rewards.length);
    const passRate = rewards.filter((r) => r > 0.5).length / rewards.length;

    const groupStat: GroupStats = {
      group_uuid: groupUuid,
      reward_mean: mean,
      reward_std: Math.max(std, 1e-8),
      finished_num: trajs.length,
      pass_rate: passRate,
    };

    stats.set(groupUuid, groupStat);

    // Write back to trajectories
    for (const traj of trajs) {
      traj.group_stats = groupStat;
    }
  }

  return stats;
}

export function computeAdvantage(reward: number, groupStats: GroupStats): number {
  return (reward - groupStats.reward_mean) / groupStats.reward_std;
}
