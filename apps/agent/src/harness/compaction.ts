import { generateText } from "ai";
import type { ModelMessage, LanguageModel } from "ai";

export interface CompactionStrategy {
  shouldCompact(messages: ModelMessage[], maxTokens?: number): boolean;
  compact(messages: ModelMessage[], model: LanguageModel): Promise<ModelMessage[]>;
}

// Estimate tokens (rough: 4 chars per token)
function estimateTokens(messages: ModelMessage[]): number {
  return messages.reduce((sum, m) => {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return sum + Math.ceil(content.length / 4);
  }, 0);
}

export class SummarizeCompaction implements CompactionStrategy {
  shouldCompact(messages: ModelMessage[], maxTokens: number = 100000): boolean {
    return estimateTokens(messages) > maxTokens * 0.85;
  }

  async compact(messages: ModelMessage[], model: LanguageModel): Promise<ModelMessage[]> {
    if (messages.length <= 4) return messages; // Too few to compact

    // Keep first 2 messages (initial context) and last 4 messages (recent context)
    const keep_start = messages.slice(0, 2);
    const keep_end = messages.slice(-4);
    const to_summarize = messages.slice(2, -4);

    if (to_summarize.length === 0) return messages;

    // Summarize the middle section
    const summaryContent = to_summarize.map(m => {
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `[${m.role}]: ${text.slice(0, 500)}`;
    }).join("\n");

    const result = await generateText({
      model,
      system: "Summarize this conversation excerpt concisely. Preserve key decisions, tool results, and file paths. Be brief.",
      messages: [{ role: "user", content: summaryContent }],
      maxOutputTokens: 1000,
    });

    const summaryMessage: ModelMessage = {
      role: "assistant",
      content: `[Conversation summary of ${to_summarize.length} messages]: ${result.text}`,
    };

    return [...keep_start, summaryMessage, ...keep_end];
  }
}
