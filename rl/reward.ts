import type { Trajectory, RLTask, RuleReward, RewardBreakdown } from "./types.js";

function checkRule(rule: RuleReward, trajectory: Trajectory): number {
  const toolResults = trajectory.turns
    .filter((t) => t.role === "tool")
    .flatMap((t) => t.tool_results || []);

  const assistantMessages = trajectory.turns
    .filter((t) => t.role === "assistant")
    .map((t) => t.content);

  const allOutput = [
    ...toolResults.map((r) => r.content),
    ...assistantMessages,
  ].join("\n");

  switch (rule.check) {
    case "file_exists": {
      const writeTools = trajectory.turns
        .filter((t) => t.role === "assistant")
        .flatMap((t) => t.tool_calls || [])
        .filter((tc) => tc.name === "write" || tc.name === "bash");
      const mentioned = writeTools.some(
        (tc) => JSON.stringify(tc.input).includes(rule.path || ""),
      );
      const resultMentioned = allOutput.includes(rule.path || "");
      return mentioned || resultMentioned ? rule.score : 0;
    }
    case "file_contains": {
      return allOutput.includes(rule.expected || "") ? rule.score : 0;
    }
    case "exit_code": {
      const bashResults = toolResults.filter((r) => {
        const matchingCall = trajectory.turns
          .filter((t) => t.role === "assistant")
          .flatMap((t) => t.tool_calls || [])
          .find((tc) => tc.id === r.tool_use_id);
        return matchingCall?.name === "bash";
      });
      if (bashResults.length === 0) return 0;
      const lastBash = bashResults[bashResults.length - 1];
      const hasError = lastBash.is_error || lastBash.content.includes("exit code");
      return rule.expected === "0" ? (hasError ? 0 : rule.score) : rule.score;
    }
    case "bash_output_contains": {
      return allOutput.includes(rule.expected || "") ? rule.score : 0;
    }
    default:
      return 0;
  }
}

function computeRuleReward(trajectory: Trajectory, rules: RuleReward[]): number {
  let total = 0;
  for (const rule of rules) {
    total += checkRule(rule, trajectory);
  }
  return Math.min(total, 1.0);
}

function computeEfficiencyReward(trajectory: Trajectory, task: RLTask): number {
  const maxTurns = task.max_turns || 5;
  const turnPenalty = (trajectory.num_turns / maxTurns) * 0.3;
  return Math.max(0, 1.0 - turnPenalty);
}

export async function computeReward(
  trajectory: Trajectory,
  task: RLTask,
): Promise<RewardBreakdown> {
  const spec = task.reward;

  if (trajectory.outcome === "error" || trajectory.outcome === "timeout") {
    return { total: 0, rules: 0, efficiency: 0 };
  }

  switch (spec.type) {
    case "rule": {
      const ruleScore = computeRuleReward(trajectory, spec.rules || []);
      const efficiency = computeEfficiencyReward(trajectory, task);
      const total = ruleScore * 0.8 + efficiency * 0.2;
      return { total, rules: ruleScore, efficiency };
    }
    case "llm": {
      // LLM-as-judge: placeholder — requires judge model instance
      // In production, call outcome-evaluator.ts with trajectory content
      return { total: 0, llm: 0, efficiency: 0 };
    }
    case "composite": {
      const weights = spec.weights || { rules: 0.6, llm: 0.2, efficiency: 0.2 };
      const ruleScore = spec.rules ? computeRuleReward(trajectory, spec.rules) : 0;
      const efficiency = computeEfficiencyReward(trajectory, task);
      const total =
        ruleScore * (weights.rules || 0.6) +
        efficiency * (weights.efficiency || 0.2);
      return { total, rules: ruleScore, efficiency };
    }
    default:
      return { total: 0 };
  }
}

export function batchRewardStats(rewards: RewardBreakdown[]): {
  mean: number;
  min: number;
  max: number;
  std: number;
} {
  const values = rewards.map((r) => r.total);
  const n = values.length;
  if (n === 0) return { mean: 0, min: 0, max: 0, std: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;
  return { mean, min, max, std: Math.sqrt(variance) };
}
