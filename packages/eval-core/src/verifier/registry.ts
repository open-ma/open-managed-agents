// verifierForSpec: maps a RewardSpec to a concrete Verifier instance.
//
// One factory function so all consumers (eval-runner, rl-rollout, the
// supervisor outcome loop, future Console "Re-grade" button) reach the
// same implementations from a single dispatch point. Adding a new
// RewardSpec branch lands here only.

import type { Verifier, VerifierContext, RewardSpec } from "./types.js";
import { ScriptVerifier } from "./builtins/script.js";
import { CompositeVerifier } from "./builtins/composite.js";
import { VerifiableVerifier } from "./builtins/verifiable.js";
import { RewardModelVerifier } from "./builtins/reward_model.js";

export function verifierForSpec(spec: RewardSpec, ctx: VerifierContext): Verifier {
  switch (spec.type) {
    case "script":
      return new ScriptVerifier(spec, ctx);
    case "composite":
      return new CompositeVerifier(spec, ctx);
    case "verifiable":
      return new VerifiableVerifier(spec, ctx);
    case "reward_model":
      return new RewardModelVerifier(spec, ctx);
    default: {
      // exhaustiveness check — every RewardSpec branch must be handled
      const _exhaustive: never = spec;
      throw new Error(`unknown RewardSpec type: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
