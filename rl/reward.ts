/**
 * Reward computation — thin wrapper over verifier.ts for backward compatibility.
 *
 * For new code, use verifier.ts directly:
 *   import { verify, computeGroupAdvantages } from "./verifier.js";
 */

import type { Trajectory, RLTask, RewardBreakdown } from "./types.js";
import { verify } from "./verifier.js";

export async function computeReward(
  trajectory: Trajectory,
  task: RLTask,
): Promise<RewardBreakdown> {
  const result = verify(trajectory, task);

  return {
    total: result.final_reward,
    rules: Object.entries(result.raw_rewards)
      .filter(([k]) => k !== "efficiency")
      .reduce((sum, [, v]) => sum + v, 0),
    efficiency: result.raw_rewards.efficiency || 0,
  };
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
