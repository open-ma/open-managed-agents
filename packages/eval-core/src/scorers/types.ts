// Scorer types — pure functions over Trajectory.
//
// Design principles (per docs/handoff-verifier-framework.md discussion):
// - Score is structured (not just float) so it composes; eval can pass/fail,
//   RL can take .value as reward, outcome can use .reason as feedback
// - case-insensitive matching by DEFAULT for natural-language scorers,
//   strict by default for tool/path scorers
// - Pure functions: no I/O except `judge` which calls an LLM
// - Composition via all/any/weighted combinators

import type { Trajectory } from "../trajectory/types.js";

export interface Score {
  pass: boolean;
  value: number; // 0..1
  reason: string; // human-readable
  metadata?: Record<string, unknown>;
}

export type Scorer = (trajectory: Trajectory) => Score | Promise<Score>;
