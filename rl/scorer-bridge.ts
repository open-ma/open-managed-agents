/**
 * RL ↔ Scorer bridge.
 *
 * Lets RL tasks reuse the Phase 2 scorer library (in packages/shared/src/scorers)
 * as reward functions, without forcing the RL surface to switch to the platform's
 * Trajectory type or scorer API.
 *
 * Two utilities:
 *  - rlTrajectoryToPlatform(traj): RL TurnRecord[] → platform Trajectory shape
 *    (synthesizes a StoredEvent stream from RL turns).
 *  - scoreToReward(score, weights?): platform Score → RL RewardResult.
 *  - asReward(scorer): wraps a Phase 2 Scorer into an RL VerifyFn for use with
 *    rl/verifier-registry.ts registerVerifier(...).
 *
 * Additive only — does not modify rl/verifier.ts or rl/types.ts.
 */

import type { Trajectory as PlatformTrajectory, Score, Scorer, StoredEvent } from "../packages/shared/src/index.js";
import type { Trajectory as RLTrajectory, RewardResult, RLTask } from "./types.js";
import type { VerifyFn } from "./verifier-registry.js";

// ---------- Trajectory conversion ----------

export function rlTrajectoryToPlatform(traj: RLTrajectory): PlatformTrajectory {
  const events: StoredEvent[] = [];
  let seq = 1;
  const baseTs = new Date().toISOString();

  for (const turn of traj.turns) {
    const ts = new Date(turn.timestamp_ms || Date.now()).toISOString();
    if (turn.role === "user") {
      events.push({
        seq: seq++,
        type: "user.message",
        data: JSON.stringify({
          type: "user.message",
          content: [{ type: "text", text: turn.content || "" }],
        }),
        ts,
      });
    } else if (turn.role === "assistant") {
      // Emit any tool_calls first, then the assistant message text
      for (const tc of turn.tool_calls || []) {
        events.push({
          seq: seq++,
          type: "agent.tool_use",
          data: JSON.stringify({
            type: "agent.tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.input,
          }),
          ts,
        });
      }
      if (turn.content) {
        events.push({
          seq: seq++,
          type: "agent.message",
          data: JSON.stringify({
            type: "agent.message",
            content: [{ type: "text", text: turn.content }],
          }),
          ts,
        });
      }
    } else if (turn.role === "tool") {
      for (const tr of turn.tool_results || []) {
        events.push({
          seq: seq++,
          type: "agent.tool_result",
          data: JSON.stringify({
            type: "agent.tool_result",
            tool_use_id: tr.tool_use_id,
            content: tr.content,
            is_error: tr.is_error,
          }),
          ts,
        });
      }
    }
  }

  // Cap with a synthetic idle event so idleNoError-style scorers work
  if (traj.outcome === "success") {
    events.push({
      seq: seq++,
      type: "session.status_idle",
      data: JSON.stringify({ type: "session.status_idle" }),
      ts: baseTs,
    });
  } else if (traj.outcome === "error" || traj.outcome === "failure") {
    events.push({
      seq: seq++,
      type: "session.error",
      data: JSON.stringify({ type: "session.error", error: "rl trajectory marked failure" }),
      ts: baseTs,
    });
  }

  return {
    schema_version: "oma.trajectory.v1",
    trajectory_id: `tr-rl-${traj.traj_uuid}`,
    session_id: traj.session_id,
    group_id: traj.group_uuid,
    task_id: traj.task_id,
    agent_config: {} as never,
    environment_config: {} as never,
    model: { id: traj.metadata?.model_id || "unknown", provider: "" },
    started_at: baseTs,
    outcome: traj.outcome === "success" ? "success" : traj.outcome === "timeout" ? "timeout" : "failure",
    events,
    summary: {
      num_events: events.length,
      num_turns: traj.turns.filter((t) => t.role === "assistant").length,
      num_tool_calls: traj.turns.flatMap((t) => t.tool_calls || []).length,
      num_tool_errors: traj.turns.flatMap((t) => t.tool_results || []).filter((r) => r.is_error).length,
      num_threads: 0,
      duration_ms: traj.duration_ms,
      token_usage: {
        input_tokens: traj.token_usage?.input_tokens || 0,
        output_tokens: traj.token_usage?.output_tokens || 0,
        cache_read_input_tokens: traj.token_usage?.cache_read_input_tokens || 0,
      },
    },
  };
}

// ---------- Score → RewardResult ----------

export function scoreToReward(score: Score, name = "scorer"): RewardResult {
  return {
    raw_rewards: { [name]: score.value },
    final_reward: score.value,
  };
}

// ---------- Scorer → VerifyFn (for registerVerifier) ----------

/**
 * Wrap a platform Scorer into an RL VerifyFn for use with verifier-registry.
 *
 * Usage:
 *   import { registerVerifier } from "./verifier-registry";
 *   import { asReward } from "./scorer-bridge";
 *   import { bashOutputMarker } from "@open-managed-agents/shared";
 *
 *   registerVerifier("scorer:test_pass", asReward(bashOutputMarker("ALL_TESTS_PASSED")));
 */
export function asReward(scorer: Scorer, rewardName = "scorer"): VerifyFn {
  return async (rlTraj: RLTrajectory, _task: RLTask): Promise<RewardResult> => {
    const platformTraj = rlTrajectoryToPlatform(rlTraj);
    const score = await Promise.resolve(scorer(platformTraj));
    return scoreToReward(score, rewardName);
  };
}
