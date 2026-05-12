// OMA Verifier framework — Phase 2 of the Trajectory v1 unification plan.
//
// Replaces the three parallel verification paths that grew up independently:
//   - eval-runner: ad-hoc /exec verify_script + exit_code
//   - outcome-evaluator: standalone LLM judge
//   - rl/verifier: turn-based heuristic checks
//
// Now: one Verifier interface, three consumers (eval / outcome / RL), one
// canonical RewardSpec wire format. Trajectory.reward.verifier_id records
// which Verifier produced a given reward, so a session can be re-graded
// with a different one without re-executing.
//
// Design rule (per docs/archive/handoff-verifier-framework.md):
//   Task + Agent execution + Verifier → Score
//     Outcome: score → needs_revision/satisfied (supervisor loop)
//     Eval:    score → pass/fail (quality report)
//     RL:      score → reward signal (training)

import type { Trajectory } from "../trajectory/types.js";
import type { Score } from "../scorers/types.js";

/** Sandbox + session handle the script Verifier needs to run a verify
 *  command. Ignored by Verifiers that don't touch the sandbox. */
export interface VerifierContext {
  /** Session whose sandbox the verifier should use. */
  sessionId: string;
  /**
   * Run a shell command in the session's sandbox via /exec. Returns the
   * exit code and combined stdout+stderr. Wall-clock timeout is the
   * caller's responsibility — implementations should pass through
   * `timeoutMs` when supplied.
   */
  runExec(cmd: string, opts?: { timeoutMs?: number }): Promise<{ exit_code: number; output: string }>;
}

/**
 * One verifier — produces a Score from a Trajectory.
 *
 * Two modes:
 *   - check(traj): deterministic inspection (script exit, file existence,
 *     tool-use pattern match, …). Always available.
 *   - judge(traj, rubric): LLM-based qualitative assessment. Optional;
 *     consumers must fall back to check() when undefined.
 */
export interface Verifier {
  /** Stable id used as `RewardResult.verifier_id` and for logging. */
  readonly id: string;
  /** Deterministic check — pure inspection of the trajectory. */
  check(traj: Trajectory): Promise<Score>;
  /**
   * Optional LLM-judge variant when the task ships a rubric. Verifiers
   * that don't have a judge mode should leave this undefined; consumers
   * fall back to `check`.
   */
  judge?(traj: Trajectory, rubric: string): Promise<Score>;
}

/**
 * Reward spec shapes that ship today. Verifier registry maps each to
 * a concrete implementation. Keeps the existing JSON wire format
 * (`type: "verifiable" | "script" | "reward_model" | "composite"`)
 * intact so old task JSONs keep working.
 *
 * `weights` is consumer-defined metadata — composite uses per-component
 * weight (see ScriptRewardSpec); leaf shapes carry it for forward-compat
 * with future aggregators (e.g. multi-criterion scorers).
 */
export type RewardSpec =
  | ScriptRewardSpec
  | RewardModelRewardSpec
  | CompositeRewardSpec
  | VerifiableRewardSpec;

export interface ScriptRewardSpec {
  type: "script";
  /** Bash script to run in the agent's sandbox. exit 0 = pass. */
  verify_script: string;
  /** Optional: per-component weights (currently informational). */
  weights?: Record<string, number>;
  /** Optional per-script wall-clock timeout in ms. Default at the runner. */
  timeout_ms?: number;
}

export interface RewardModelRewardSpec {
  type: "reward_model";
  /** External HTTP endpoint the trajectory + rubric are POSTed to. */
  endpoint: string;
  /** Optional rubric / prompt template the endpoint will use. */
  prompt_template?: string;
  weights?: Record<string, number>;
}

export interface CompositeRewardSpec {
  type: "composite";
  components: Array<{
    /** Sub-Verifier RewardSpec. */
    verifier: RewardSpec;
    /** Weight applied to this sub-Verifier's `score.value` during aggregation. */
    weight: number;
    /** Human-readable name used as the criteria key. */
    name: string;
  }>;
}

export interface VerifiableRewardSpec {
  type: "verifiable";
  /**
   * Name of a registered Scorer (eval-core/src/scorers/scorers.ts —
   * `bashExit`, `fileWritten`, `idleNoError`, `regex`, …). Resolved by
   * the verifiable builtin's mapping table.
   */
  scorer: string;
  /** Constructor opts forwarded to the named scorer factory. */
  opts?: Record<string, unknown>;
  weights?: Record<string, number>;
}
