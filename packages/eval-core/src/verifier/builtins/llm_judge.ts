// LLM-Judge Verifier — in-process LLM evaluation against a rubric.
//
// This is the AMA-default outcome path: the supervisor passes the agent's
// configured aux model and the resolved rubric markdown, and the verifier
// returns a Score driven by the model's "satisfied | needs_revision"
// verdict.
//
// Why a separate verifier (not an extension of RewardModelVerifier)?
//   - RewardModelVerifier POSTs to an HTTP endpoint. The supervisor
//     already holds an in-process `LanguageModel` handle (via the AI
//     SDK's `generateText`); routing through HTTP back to ourselves
//     would double-cost and double-fail.
//   - Outcome judging needs token-usage propagation back to
//     `span.outcome_evaluation_end.usage` (AMA spec). The HTTP path
//     loses that.
//
// Why not a JSON RewardSpec branch?
//   - RewardSpec is the JSON wire format that lives on persisted tasks.
//     A `LanguageModel` handle is not serializable, so it has no place
//     in RewardSpec. Instead the supervisor calls
//     `createLlmJudgeVerifier(...)` with the runtime-resolved model.
//
// Decoupling from the AI SDK:
//   The verifier doesn't import `ai`; it accepts a `JudgeFn` callback
//   the caller wraps around `generateText`. Keeps @oma/eval-core a
//   leaf package.

import type { Score } from "../../scorers/types.js";
import type { Trajectory } from "../../trajectory/types.js";
import type { Verifier } from "../types.js";
import { extractTextFromContent } from "../../scorers/scorers.js";

/** Token-usage shape mirroring AMA's `span.outcome_evaluation_end.usage`. */
export interface JudgeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Caller-supplied wrapper around an in-process LLM. The supervisor
 * loop in apps/agent passes a closure over the AI SDK's `generateText`;
 * tests pass a fake. Letting this be a function (rather than a typed
 * `LanguageModel`) keeps eval-core dep-free of `ai`.
 */
export type JudgeFn = (
  prompt: { system: string; user: string },
  signal?: AbortSignal,
) => Promise<{ text: string; usage?: JudgeUsage }>;

export interface LlmJudgeOpts {
  /**
   * Already-resolved rubric markdown. File rubrics are fetched at the
   * supervisor layer (see apps/agent/src/runtime/resolve-rubric.ts);
   * this verifier never touches the Files API.
   */
  rubric: string;
  judge: JudgeFn;
  /** Free-form id appended to the verifier id (for logs / Score.metadata). */
  modelId?: string;
  /**
   * The agent's task description, surfaced to the judge alongside the
   * rubric so the verdict reflects "did the agent do the requested task
   * by the rubric's standards" rather than rubric-only matching.
   */
  description?: string;
  /** Max retries on parse failure / transient JudgeFn errors. */
  maxRetries?: number;
  /** Optional cancellation; passed through to JudgeFn. */
  abortSignal?: AbortSignal;
}

const MAX_RETRIES_DEFAULT = 3;
const BASE_DELAY_MS = 1000;
const TRANSCRIPT_CHAR_BUDGET = 50_000;

export class LlmJudgeVerifier implements Verifier {
  readonly id: string;

  constructor(private readonly opts: LlmJudgeOpts) {
    this.id = `llm_judge${opts.modelId ? `.${opts.modelId}` : ""}.v1`;
  }

  async check(traj: Trajectory): Promise<Score> {
    return this.runJudge(traj, this.opts.rubric);
  }

  /**
   * Judge with a runtime-supplied rubric. Useful when a single verifier
   * instance grades many trajectories with task-specific rubrics (e.g.
   * eval-runner re-grading historical sessions).
   */
  async judge(traj: Trajectory, rubric: string): Promise<Score> {
    return this.runJudge(traj, rubric);
  }

  private async runJudge(traj: Trajectory, rubric: string): Promise<Score> {
    const transcript = buildAgentTranscript(traj);
    const description = this.opts.description ?? "";
    const maxRetries = this.opts.maxRetries ?? MAX_RETRIES_DEFAULT;

    const system =
      `You are an outcome evaluator. Read the rubric, the task description, and the agent's transcript. ` +
      `Reply with EXACTLY one JSON object: {"result": "satisfied" | "needs_revision", "explanation": "..."}. ` +
      `Use "satisfied" only when every rubric criterion is clearly met by the transcript. ` +
      `Use "needs_revision" otherwise, and use the explanation field to describe the specific gaps.`;
    const user =
      (description ? `## Task\n${description}\n\n` : "") +
      `## Rubric\n${rubric}\n\n` +
      `## Agent transcript\n${transcript || "(empty — the agent produced no messages)"}\n\n` +
      `Respond with the JSON object only.`;

    let lastErr = "";
    let lastUsage: JudgeUsage | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const { text, usage } = await this.opts.judge(
          { system, user },
          this.opts.abortSignal,
        );
        if (usage) lastUsage = mergeUsage(lastUsage, usage);
        const candidate = text || "";
        const parsed = parseRubricVerdict(candidate);
        if (parsed) {
          const pass = parsed.result === "satisfied";
          return {
            pass,
            value: pass ? 1 : 0,
            reason:
              parsed.explanation ||
              (pass ? "rubric satisfied" : "rubric not yet satisfied"),
            metadata: {
              criteria: { satisfied: pass ? 1 : 0 },
              explanation: parsed.explanation,
              ...(lastUsage ? { usage: lastUsage } : {}),
            },
          };
        }
        lastErr = `parse failure (text=${candidate.slice(0, 200)})`;
      } catch (err: unknown) {
        if ((err as { name?: string }).name === "AbortError") {
          // Bubble — supervisor turns this into a "interrupted" verdict
          // before persisting.
          throw err;
        }
        lastErr = err instanceof Error ? err.message : String(err);
      }

      if (attempt >= maxRetries) break;
      const delay = Math.min(
        8000,
        BASE_DELAY_MS * Math.pow(2, attempt) * (0.75 + Math.random() * 0.5),
      );
      await new Promise((r) => setTimeout(r, delay));
    }

    // Out of retries — return needs_revision with the failure reason in
    // `reason`. The supervisor turns a non-pass score into either
    // `needs_revision` or `max_iterations_reached`, never `failed` (which
    // is reserved for verifier throws). If the operator wants a hard
    // failure on judge failure they can switch to a deterministic
    // verifier or raise.
    return {
      pass: false,
      value: 0,
      reason: `llm judge exhausted retries: ${lastErr.slice(0, 200)}`,
      metadata: {
        criteria: { satisfied: 0 },
        ...(lastUsage ? { usage: lastUsage } : {}),
      },
    };
  }
}

/** Convenience factory — mirrors the eval-core export style. */
export function createLlmJudgeVerifier(opts: LlmJudgeOpts): LlmJudgeVerifier {
  return new LlmJudgeVerifier(opts);
}

/**
 * Build a compact agent-only transcript. Mirrors what the old
 * evaluateOutcome inlined: concat all `agent.message` text content.
 * Keeps the verdict comparable across the migration so an existing
 * outcome that satisfied under the old judge keeps satisfying under the
 * new one (modulo prompt wording).
 */
function buildAgentTranscript(traj: Trajectory): string {
  const out: string[] = [];
  let used = 0;
  for (const e of traj.events) {
    if (e.type !== "agent.message") continue;
    const parsed = parseEventData(e);
    const content = (parsed as { content?: unknown })?.content;
    const text = extractTextFromContent(content);
    if (!text) continue;
    if (used + text.length > TRANSCRIPT_CHAR_BUDGET) {
      out.push(text.slice(0, TRANSCRIPT_CHAR_BUDGET - used));
      out.push("\n…(truncated)");
      break;
    }
    out.push(text);
    used += text.length;
  }
  return out.join("\n\n");
}

function parseEventData(e: { data: string | object }): unknown {
  if (typeof e.data === "string") {
    try {
      return JSON.parse(e.data);
    } catch {
      return null;
    }
  }
  return e.data;
}

interface RubricVerdict {
  result: "satisfied" | "needs_revision";
  explanation: string;
}

/**
 * Tolerant parser: scans for the first JSON object in the model's reply,
 * tries to read either `explanation` (AMA spelling) or `feedback`
 * (legacy spelling) for the rationale. Returns null if no usable object
 * was found — caller retries.
 */
function parseRubricVerdict(text: string): RubricVerdict | null {
  if (!text.trim()) return null;
  const m = text.match(/\{[\s\S]*?\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]) as {
      result?: string;
      explanation?: string;
      feedback?: string;
    };
    const result =
      parsed.result === "satisfied" ? "satisfied" : "needs_revision";
    return {
      result,
      explanation: parsed.explanation || parsed.feedback || "",
    };
  } catch {
    return null;
  }
}

function mergeUsage(prev: JudgeUsage | undefined, next: JudgeUsage): JudgeUsage {
  if (!prev) return { ...next };
  return {
    input_tokens: prev.input_tokens + next.input_tokens,
    output_tokens: prev.output_tokens + next.output_tokens,
    cache_creation_input_tokens:
      (prev.cache_creation_input_tokens ?? 0) +
      (next.cache_creation_input_tokens ?? 0) || undefined,
    cache_read_input_tokens:
      (prev.cache_read_input_tokens ?? 0) + (next.cache_read_input_tokens ?? 0) ||
      undefined,
  };
}
