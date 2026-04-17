/**
 * Verifier Registry — how users define custom verifiers.
 *
 * Three levels:
 *
 * 1. Declarative (JSON config, zero code):
 *    Task JSON → checks[] array with built-in types
 *    Good for: file checks, output matching, exit codes
 *
 * 2. Script (shell command, run in sandbox):
 *    Task JSON → reward.verify_script: "python /workspace/check.py"
 *    The script receives the trajectory as stdin JSON, exits 0 for pass
 *    Good for: test suites, custom validation, schema checks
 *
 * 3. Programmatic (TypeScript/Python function, register by name):
 *    User writes a VerifyFn, registers it with a domain name
 *    Good for: complex multi-step verification, external API checks
 *
 * Usage:
 *
 *   // Register a custom verifier
 *   registerVerifier("coding", async (traj, task) => {
 *     const lastBashOutput = getLastToolOutput(traj, "bash");
 *     const testsPass = !lastBashOutput.includes("FAILED");
 *     return { raw_rewards: { tests: testsPass ? 1 : 0 }, final_reward: testsPass ? 1 : 0 };
 *   });
 *
 *   // Task JSON references it by domain
 *   { "reward": { "type": "custom", "domain": "coding" } }
 *
 *   // Or use a verify script (runs in sandbox)
 *   { "reward": { "type": "script", "verify_script": "cd /workspace && python -m pytest --tb=no -q" } }
 */

import type { Trajectory, RLTask, RewardResult } from "./types.js";
import { verify as builtinVerify } from "./verifier.js";

// --- Types ---

export type VerifyFn = (
  trajectory: Trajectory,
  task: RLTask,
) => RewardResult | Promise<RewardResult>;

// --- Registry ---

const registry = new Map<string, VerifyFn>();

export function registerVerifier(domain: string, fn: VerifyFn): void {
  registry.set(domain, fn);
}

export function getVerifier(domain: string): VerifyFn | undefined {
  return registry.get(domain);
}

export function listVerifiers(): string[] {
  return [...registry.keys()];
}

// --- Dispatch ---

export async function resolveAndVerify(
  trajectory: Trajectory,
  task: RLTask,
): Promise<RewardResult> {
  const spec = task.reward;

  // 1. Custom domain verifier
  if (spec.type === "custom" && (spec as any).domain) {
    const fn = registry.get((spec as any).domain);
    if (!fn) {
      throw new Error(`No verifier registered for domain: ${(spec as any).domain}`);
    }
    return fn(trajectory, task);
  }

  // 2. Script verifier (needs sandbox access — returns placeholder here)
  if (spec.type === "script" as any) {
    // Script execution is handled at the rollout level where sandbox access is available.
    // The rollout sends the verify_script to the sandbox, captures exit code.
    // Here we just return the pre-computed result if available.
    return trajectory.reward;
  }

  // 3. Built-in verifiable checks
  return builtinVerify(trajectory, task);
}

// --- Built-in verifier helpers for custom verifier authors ---

export function getLastToolOutput(trajectory: Trajectory, toolName: string): string {
  const toolTurns = trajectory.turns
    .filter((t) => t.role === "tool")
    .filter((t) => {
      const prevAssistant = trajectory.turns
        .filter((p) => p.role === "assistant")
        .flatMap((p) => p.tool_calls || [])
        .find((tc) => t.tool_results?.some((r) => r.tool_use_id === tc.id));
      return prevAssistant?.name === toolName;
    });

  if (toolTurns.length === 0) return "";
  const last = toolTurns[toolTurns.length - 1];
  return last.tool_results?.map((r) => r.content).join("\n") || last.content;
}

export function getAllToolOutputs(trajectory: Trajectory, toolName?: string): string[] {
  return trajectory.turns
    .filter((t) => t.role === "tool")
    .flatMap((t) => t.tool_results || [])
    .map((r) => r.content);
}

export function getAgentFinalMessage(trajectory: Trajectory): string {
  const assistantTurns = trajectory.turns.filter((t) => t.role === "assistant");
  return assistantTurns.length > 0 ? assistantTurns[assistantTurns.length - 1].content : "";
}

export function extractCodeBlocks(text: string): string[] {
  const pattern = /```(?:\w+)?\n([\s\S]*?)```/g;
  const blocks: string[] = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    blocks.push(match[1].trim());
  }
  return blocks;
}

// --- Pre-built domain verifiers ---

registerVerifier("exact_match", (traj, task) => {
  const gt = task.reward.ground_truth;
  if (!gt) return { raw_rewards: { no_ground_truth: 0 }, final_reward: 0 };
  const output = getAgentFinalMessage(traj) + "\n" + getAllToolOutputs(traj).join("\n");
  const match = output.includes(gt.trim()) ? 1.0 : 0.0;
  return { raw_rewards: { exact_match: match }, final_reward: match };
});

registerVerifier("test_pass", (traj, _task) => {
  const outputs = getAllToolOutputs(traj);
  const allOutput = outputs.join("\n");
  const hasFail = /FAIL|ERROR|AssertionError|assert.*failed/i.test(allOutput);
  const hasPass = /PASS|OK|passed|tests? passed/i.test(allOutput);
  const score = hasPass && !hasFail ? 1.0 : 0.0;
  return { raw_rewards: { test_pass: score }, final_reward: score };
});
