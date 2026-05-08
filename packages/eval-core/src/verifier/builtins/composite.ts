// Composite Verifier — wraps N sub-Verifiers and aggregates their
// `score.value` by weighted average. Each sub-score becomes a key in
// the composite's `criteria`.
//
// Use case: a task that wants both "tests pass" (script) and "code is
// idiomatic" (reward_model judge) signals combined into a single
// reward scalar. The sub-Verifiers run in parallel — one slow LLM
// judge doesn't stall the script verifier.

import type { Trajectory } from "../../trajectory/types.js";
import type { Score } from "../../scorers/types.js";
import type { Verifier, VerifierContext, CompositeRewardSpec } from "../types.js";
import { verifierForSpec } from "../registry.js";

export class CompositeVerifier implements Verifier {
  readonly id = "composite.v1";

  constructor(
    private readonly spec: CompositeRewardSpec,
    private readonly ctx: VerifierContext,
  ) {}

  async check(traj: Trajectory): Promise<Score> {
    const components = this.spec.components;
    if (!components || components.length === 0) {
      return {
        pass: false,
        value: 0,
        reason: "composite verifier has no components",
        metadata: { criteria: {} },
      };
    }

    // Parallel execution — composite latency is max(child), not sum.
    const settled = await Promise.allSettled(
      components.map(async (c) => ({
        name: c.name,
        weight: c.weight,
        score: await verifierForSpec(c.verifier, this.ctx).check(traj),
      })),
    );

    const criteria: Record<string, number> = {};
    const reasons: string[] = [];
    let weightedSum = 0;
    let totalWeight = 0;
    let allPass = true;

    for (const s of settled) {
      if (s.status === "rejected") {
        allPass = false;
        reasons.push(`unknown_child_failed: ${String(s.reason).slice(0, 100)}`);
        continue;
      }
      const { name, weight, score } = s.value;
      criteria[name] = score.value;
      weightedSum += score.value * weight;
      totalWeight += weight;
      reasons.push(`${name}=${score.value.toFixed(3)} (${score.reason.slice(0, 80)})`);
      if (!score.pass) allPass = false;
    }

    const value = totalWeight > 0 ? weightedSum / totalWeight : 0;
    return {
      pass: allPass,
      value,
      reason: `composite: ${reasons.join("; ")}`,
      metadata: { criteria },
    };
  }
}
