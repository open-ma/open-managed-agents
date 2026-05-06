// No-Run Verifier — synthetic Verifier emitted for trials that died
// before the agent ever produced a useful execution (setup error,
// postUserMessage failure, per-trial wall-clock timeout). There's
// nothing meaningful to score, so we record `value=0, pass=false`
// with a stable verifier_id so consumers can distinguish "scored as
// failure" from "no scoring attempted".
//
// Phase 2 use: eval-runner uses this for the failure-trial trajectory
// gap fix (Phase 1 left it on purpose: failure trials had no
// trajectory built; Phase 2 builds the trajectory and tags it
// no-run.v1 so the failure timeline is still queryable).

import type { Trajectory } from "../../trajectory/types.js";
import type { Score } from "../../scorers/types.js";
import type { Verifier } from "../types.js";

export class NoRunVerifier implements Verifier {
  readonly id = "no-run.v1";

  constructor(private readonly reasonHint?: string) {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async check(_traj: Trajectory): Promise<Score> {
    return {
      pass: false,
      value: 0,
      reason: this.reasonHint ? `no-run: ${this.reasonHint}` : "no-run",
      metadata: { criteria: { failure: 0 } },
    };
  }
}
