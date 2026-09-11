import type {
  Api,
  AssistantMessage,
  Message,
  Model,
  Models,
  SimpleStreamOptions,
  TextContent,
  Tool,
} from "@earendil-works/pi-ai";
import type { ContentBlock, SessionEvent } from "@open-managed-agents/shared";
import type { HarnessRuntime } from "./interface";

export interface PiCompactionResult {
  summary: ContentBlock[];
  pre_tokens: number;
  original_message_count: number;
  compacted_message_count: number;
}

export interface PiCompactionCheckContext {
  messages: Message[];
  contextWindowTokens: number;
}

export interface PiCompactionRunContext extends PiCompactionCheckContext {
  models: Models;
  model: Model<Api>;
  systemPrompt: string;
  tools: Tool[];
  runtime: HarnessRuntime;
  sessionId?: string;
  abortSignal?: AbortSignal;
  /** Resolved provider controls and transport; summary bounds remain local. */
  requestOptions?: SimpleStreamOptions;
}

/**
 * Harness-owned context compaction policy for Pi.
 *
 * The policy decides when/how to summarize. PiHarness remains the sole owner
 * of persistence: successful results are written as the canonical
 * `agent.thread_context_compacted` event before the main Agent is created.
 * Custom policies can use another model or a deterministic reducer without
 * changing the Pi tool loop. The capability itself remains mandatory.
 */
export interface PiCompactionPolicy {
  readonly name: string;
  shouldCompact(events: SessionEvent[], ctx: PiCompactionCheckContext): boolean;
  compact(
    events: SessionEvent[],
    ctx: PiCompactionRunContext,
  ): Promise<PiCompactionResult | null>;
}

export interface PiSummaryCompactionOptions {
  triggerFraction?: number;
  maxSummaryTokens?: number;
  summaryPrompt?: string;
}

/**
 * Pi-native implementation of the three established OpenMA compaction shapes.
 *
 * `cc-style` and `opencode-style` intentionally isolate summarization from
 * the main agent payload. `summarize` is the opt-in cache-aware shape that
 * appends one instruction to the exact main request prefix.
 */
export class PiSummaryCompactionPolicy implements PiCompactionPolicy {
  readonly name: string;

  constructor(
    name: string = "cc-style",
    private readonly options: PiSummaryCompactionOptions = {},
  ) {
    this.name = name;
  }

  shouldCompact(
    _events: SessionEvent[],
    { messages, contextWindowTokens }: PiCompactionCheckContext,
  ): boolean {
    return estimatePiMessagesTokens(messages)
      > contextWindowTokens * normalizeTriggerFraction(this.options.triggerFraction);
  }

  async compact(
    _events: SessionEvent[],
    { messages, models, model, systemPrompt, tools, runtime, sessionId, abortSignal, requestOptions }: PiCompactionRunContext,
  ): Promise<PiCompactionResult | null> {
    if (messages.length < 4) return null;

    const preTokens = estimatePiMessagesTokens(messages);
    const cacheAware = this.name === "summarize";
    const request: Message = {
      role: "user",
      content: this.options.summaryPrompt ?? promptFor(this.name),
      // Timestamp is required by Pi's in-memory message shape. It is not a
      // provider payload field, and zero keeps deterministic tests/replays.
      timestamp: 0,
    };
    const modelId = model.id;
    runtime.broadcast({ type: "span.compaction_summarize_start", model: modelId });

    const requestContext = cacheAware
      ? {
          systemPrompt,
          messages: [...messages, request],
          tools,
        }
      : {
          systemPrompt: isolatedSystemPromptFor(this.name),
          messages: [...stripImagesFromPiMessages(messages), request],
          tools: [],
        };

    let response: AssistantMessage;
    try {
      response = await models.completeSimple(
        model,
        requestContext,
        {
          ...requestOptions,
          maxTokens: Math.min(
            this.options.maxSummaryTokens ?? 2_000,
            model.maxTokens || 2_000,
          ),
          signal: abortSignal ?? requestOptions?.signal,
          ...(sessionId
            ? { sessionId: cacheAware ? sessionId : `${sessionId}:compaction` }
            : {}),
        },
      );
    } catch (error) {
      runtime.broadcast({
        type: "span.compaction_summarize_end",
        model: modelId,
        finish_reason: "error",
        final_text_length: 0,
      });
      throw error;
    }

    const text = response.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    runtime.broadcast({
      type: "span.compaction_summarize_end",
      model: modelId,
      model_usage: {
        input_tokens: response.usage.input,
        output_tokens: response.usage.output,
        cache_read_input_tokens: response.usage.cacheRead,
        cache_creation_input_tokens: response.usage.cacheWrite,
      },
      finish_reason: response.stopReason,
      final_text_length: text.length,
    });

    if (response.stopReason === "error") {
      throw new Error(response.errorMessage ?? "Pi compaction model failed");
    }
    if (cacheAware && response.stopReason === "toolUse") {
      throw new Error("Pi cache-aware compaction attempted to call a tool");
    }
    if (!text) return null;

    return {
      summary: [{ type: "text", text }],
      pre_tokens: preTokens,
      original_message_count: messages.length,
      compacted_message_count: 1,
    };
  }
}

export function resolvePiCompactionPolicy(
  metadata: Record<string, unknown> | undefined,
): PiCompactionPolicy {
  const name = typeof metadata?.compaction_strategy === "string"
    ? metadata.compaction_strategy
    : "cc-style";

  const supportedName = name === "summarize" || name === "opencode-style" || name === "cc-style"
    ? name
    : "cc-style";
  return new PiSummaryCompactionPolicy(supportedName, {
    triggerFraction: finiteNumber(metadata?.compaction_trigger_fraction),
    maxSummaryTokens: finiteNumber(metadata?.compaction_max_summary_tokens),
    summaryPrompt: typeof metadata?.compaction_summary_prompt === "string"
      ? metadata.compaction_summary_prompt
      : undefined,
  });
}

export function estimatePiMessagesTokens(messages: Message[]): number {
  let chars = 0;
  let fixedTokens = 0;
  for (const message of messages) {
    if (typeof message.content === "string") {
      chars += message.content.length;
      continue;
    }
    for (const block of message.content) {
      if (block.type === "text") chars += block.text.length;
      else if (block.type === "image") fixedTokens += 2_000;
      else if (block.type === "thinking") chars += block.thinking.length;
      else if (block.type === "toolCall") {
        chars += block.name.length + JSON.stringify(block.arguments).length;
      }
    }
  }
  return Math.ceil(chars / 4) + fixedTokens;
}

const IMAGE_PLACEHOLDER = "[image stripped for compaction]";

export function stripImagesFromPiMessages(messages: Message[]): Message[] {
  return messages.map((message): Message => {
    if (message.role === "assistant" || typeof message.content === "string") return message;
    const content = message.content.map((block) =>
      block.type === "image"
        ? { type: "text" as const, text: IMAGE_PLACEHOLDER }
        : block
    );
    return { ...message, content };
  });
}

function normalizeTriggerFraction(value: number | undefined): number {
  if (value === undefined) return 0.75;
  return Math.min(0.95, Math.max(0.01, value));
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function promptFor(name: string): string {
  if (name === "opencode-style") return OPENCODE_PROMPT;
  if (name === "summarize") return CACHE_AWARE_PROMPT;
  return CC_STYLE_PROMPT;
}

function isolatedSystemPromptFor(name: string): string {
  return name === "opencode-style" ? OPENCODE_SYSTEM_PROMPT : CC_STYLE_SYSTEM_PROMPT;
}

const CC_STYLE_SYSTEM_PROMPT =
  "You are a helpful AI assistant tasked with summarizing conversations.";

const OPENCODE_SYSTEM_PROMPT =
  "You are a helpful AI assistant tasked with summarizing conversations. Output only the summary text, no preamble.";

const CC_STYLE_PROMPT =
  "Provide a detailed but concise summary of the older conversation history. The most recent turns may be preserved verbatim outside your summary, so focus on information that would still be needed to continue the work with that recent context available. Cover what was done, current work, modified files, next steps, persistent user constraints, and important technical decisions. Do not answer questions in the conversation; output only the summary.";

const CACHE_AWARE_PROMPT =
  "Act only as a compaction engine for the conversation above. Provide a detailed but concise summary. Preserve key decisions, user constraints, file paths, commands and tool results, current work, and explicit next steps. Do not call tools and do not answer questions from the conversation; output only the summary.";

const OPENCODE_PROMPT = `Summarize the conversation using these sections:
## Goal
## Instructions
## Discoveries
## Accomplished
## Relevant files / directories
Preserve concrete decisions, tool results, current work, and next steps. Output only the summary.`;
