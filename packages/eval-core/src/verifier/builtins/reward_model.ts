// Reward-Model Verifier — POSTs the trajectory + rubric to an external
// HTTP endpoint and parses the response as a Score.
//
// Standard wire format the endpoint must produce:
//   {
//     "value": number,        // 0..1
//     "pass": boolean,
//     "reasoning"?: string,
//     "criteria"?: Record<string, number>
//   }
//
// Failure modes (network error, non-2xx, malformed body, timeout) are
// converted to a deterministic 0-score so the trial doesn't hang. The
// underlying error is surfaced in `reasoning` so the trajectory still
// records why scoring failed.
//
// `judge(traj, rubric)` overrides whatever rubric was configured at
// construction time — eval-core consumers should wire it from the
// task's runtime rubric (e.g. `state.outcome.rubric` for the supervisor
// loop).

import type { Trajectory } from "../../trajectory/types.js";
import type { Score } from "../../scorers/types.js";
import type { Verifier, VerifierContext, RewardModelRewardSpec } from "../types.js";

const DEFAULT_TIMEOUT_MS = 30_000;

interface RewardModelResponse {
  value?: number;
  pass?: boolean;
  reasoning?: string;
  criteria?: Record<string, number>;
}

export class RewardModelVerifier implements Verifier {
  readonly id = "reward_model.v1";

  constructor(
    private readonly spec: RewardModelRewardSpec,
    private readonly _ctx: VerifierContext,
  ) {}

  async check(traj: Trajectory): Promise<Score> {
    return this.callRewardModel(traj, this.spec.prompt_template);
  }

  async judge(traj: Trajectory, rubric: string): Promise<Score> {
    return this.callRewardModel(traj, rubric);
  }

  private async callRewardModel(traj: Trajectory, rubric?: string): Promise<Score> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(this.spec.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trajectory: traj, rubric: rubric ?? "" }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return zero(`reward_model HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      const parsed = (await res.json().catch(() => null)) as RewardModelResponse | null;
      if (!parsed || typeof parsed.value !== "number") {
        return zero(`reward_model malformed response (no numeric value)`);
      }
      const value = clamp01(parsed.value);
      const pass = typeof parsed.pass === "boolean" ? parsed.pass : value >= 0.5;
      return {
        pass,
        value,
        reason: parsed.reasoning || `reward_model value=${value.toFixed(3)}`,
        metadata: { criteria: parsed.criteria ?? { value } },
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return zero(`reward_model error: ${msg.slice(0, 200)}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function zero(reason: string): Score {
  return { pass: false, value: 0, reason, metadata: { criteria: { value: 0 } } };
}
