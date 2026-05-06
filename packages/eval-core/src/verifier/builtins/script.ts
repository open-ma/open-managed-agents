// Script Verifier — runs a bash script in the agent's sandbox via /exec
// and translates the exit code to a Score.
//
// This is the single most common Verifier shape in production today
// (every terminal-bench task uses it: pytest the agent's output, exit 0
// = pass). Replaces the inline /exec logic that previously lived inline
// in eval-runner / rl-rollout / TB run-cloud — same wire format, single
// implementation.

import type { Trajectory } from "../../trajectory/types.js";
import type { Score } from "../../scorers/types.js";
import type { Verifier, VerifierContext, ScriptRewardSpec } from "../types.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min — matches existing TB call-sites

export class ScriptVerifier implements Verifier {
  readonly id = "script.v1";

  constructor(
    private readonly spec: ScriptRewardSpec,
    private readonly ctx: VerifierContext,
  ) {}

  async check(_traj: Trajectory): Promise<Score> {
    const timeout = this.spec.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    let exitCode = -1;
    let output = "";
    try {
      const res = await this.ctx.runExec(this.spec.verify_script, { timeoutMs: timeout });
      exitCode = res.exit_code;
      output = res.output ?? "";
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        pass: false,
        value: 0,
        reason: `script verifier failed before running: ${msg.slice(0, 200)}`,
        metadata: { exit_code: -1, output: "", error: msg },
      };
    }

    const pass = exitCode === 0;
    return {
      pass,
      value: pass ? 1 : 0,
      reason: pass
        ? `verify_script exited 0`
        : `verify_script exited ${exitCode}`,
      metadata: {
        exit_code: exitCode,
        // Truncate output — long pytest dumps would balloon the trajectory
        // envelope on KV. Keep tail (where the failure summary usually is).
        output: output.length > 4000 ? output.slice(-4000) : output,
      },
    };
  }
}
