import { generateText } from "ai";
import type { LanguageModel } from "ai";

export interface EvaluationResult {
  result: "satisfied" | "needs_revision";
  feedback: string;
}

export async function evaluateOutcome(
  model: LanguageModel,
  rubric: { description: string; criteria?: string[] },
  agentOutput: string
): Promise<EvaluationResult> {
  const criteriaText = rubric.criteria?.map((c, i) => `${i + 1}. ${c}`).join("\n") || "No specific criteria.";

  const result = await generateText({
    model,
    system: `You are an evaluator. Assess whether the agent's output satisfies the requirements.
Reply with JSON: {"result": "satisfied" | "needs_revision", "feedback": "..."}
Be strict but fair. If all criteria are met, return "satisfied". Otherwise return "needs_revision" with specific feedback on what needs improvement.`,
    messages: [{
      role: "user",
      content: `## Requirements
${rubric.description}

## Criteria
${criteriaText}

## Agent Output
${agentOutput}

Evaluate and respond with JSON only.`
    }],
    maxOutputTokens: 500,
  });

  try {
    const parsed = JSON.parse(result.text);
    return { result: parsed.result, feedback: parsed.feedback || "" };
  } catch {
    return { result: "needs_revision", feedback: "Failed to parse evaluation. Retrying." };
  }
}
