import { generateText } from "ai";
import type { LanguageModel } from "ai";
import { extractTextFromContent, parseJudgeJson } from "@open-managed-agents/shared";

export interface EvaluationResult {
  result: "satisfied" | "needs_revision";
  feedback: string;
}

const MAX_RETRIES = 3;
const BASE_DELAY = 1000;

/**
 * Evaluate whether the agent's output satisfies the rubric.
 *
 * Robustness fixes inherited from the Phase 2 scorer library:
 *   - Defends against thinking-mode models by filtering response content blocks
 *     to text only (extractTextFromContent). The bug that bit T2.1 in the
 *     prior eval run was extracting `content[0].text` blindly, which is
 *     undefined when content[0] is a `{type:"thinking"}` block.
 *   - Retries on parse failure with exponential backoff (was: single attempt,
 *     fail-soft to "needs_revision" on first hiccup).
 *   - Uses the shared parseJudgeJson helper so the parsing rules stay
 *     consistent across outcome-evaluator and the judge() scorer.
 */
export async function evaluateOutcome(
  model: LanguageModel,
  rubric: { description: string; criteria?: string[] },
  agentOutput: string
): Promise<EvaluationResult> {
  const criteriaText =
    rubric.criteria?.map((c, i) => `${i + 1}. ${c}`).join("\n") || "No specific criteria.";

  const system = `You are an evaluator. Assess whether the agent's output satisfies the requirements.
Reply with JSON: {"result": "satisfied" | "needs_revision", "feedback": "..."}
Be strict but fair. If all criteria are met, return "satisfied". Otherwise return "needs_revision" with specific feedback on what needs improvement.`;

  const userPrompt = `## Requirements
${rubric.description}

## Criteria
${criteriaText}

## Agent Output
${agentOutput}

Evaluate and respond with JSON only.`;

  let lastErr = "";
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await generateText({
        model,
        system,
        messages: [{ role: "user", content: userPrompt }],
        maxOutputTokens: 500,
      });

      // result.text from `ai` SDK should already be text-only, but defend
      // against future SDK changes / thinking-block leakage by filtering content.
      const candidate = result.text || extractTextFromContent((result as unknown as { content?: unknown }).content);

      // Map "satisfied"/"needs_revision" verdict via the shared parser, then
      // translate to outcome semantics.
      const parsed = parseRubricVerdict(candidate);
      if (parsed) return parsed;

      lastErr = `Failed to parse evaluator response: ${candidate.slice(0, 200)}`;
    } catch (err: unknown) {
      lastErr = err instanceof Error ? err.message : String(err);
    }

    if (attempt >= MAX_RETRIES) break;
    const delay = Math.min(8000, BASE_DELAY * Math.pow(2, attempt) * (0.75 + Math.random() * 0.5));
    await new Promise((r) => setTimeout(r, delay));
  }

  return { result: "needs_revision", feedback: `Evaluator failed after retries: ${lastErr.slice(0, 200)}` };
}

/**
 * Parse outcome-flavored verdict ("satisfied" / "needs_revision") from JSON-ish
 * text. Reuses parseJudgeJson's tolerance for prose-wrapped JSON, then maps
 * to the outcome-evaluator's verdict shape.
 */
function parseRubricVerdict(text: string): EvaluationResult | null {
  if (!text.trim()) return null;
  const m = text.match(/\{[\s\S]*?\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]) as { result?: string; feedback?: string };
    const verdict = parsed.result === "satisfied" ? "satisfied" : "needs_revision";
    return { result: verdict, feedback: parsed.feedback || "" };
  } catch {
    return null;
  }
}

// Re-export the shared helpers for tests / other consumers
export { extractTextFromContent, parseJudgeJson };
