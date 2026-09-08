import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  Type,
  type Api,
  type AssistantMessage,
  type ImageContent,
  type Message,
  type Model,
  type TextContent,
  type ToolResultMessage,
  type Usage,
  isContextOverflow,
} from "@earendil-works/pi-ai";
import type { ModelMessage } from "ai";
import { z } from "zod";
import type { ContentBlock, SessionEvent } from "@open-managed-agents/shared";
import {
  classifyExternalError,
  generateEventId,
  ModelError,
} from "@open-managed-agents/shared";
import { eventsToMessagesAsync } from "../runtime/history";
import type { HarnessContext, HarnessInterface } from "./interface";
import {
  resolvePiCompactionPolicy,
  type PiCompactionPolicy,
  type PiCompactionResult,
} from "./pi-compaction";

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface LiveMessageState {
  spanId: string | null;
  firstTokenSeen: boolean;
  textIds: Map<number, string>;
  thinkingIds: Map<number, string>;
  toolIds: Map<number, string>;
}

interface PiRunOutcome {
  producedOutput: boolean;
  providerFailure?: AssistantMessage;
}

export interface PiHarnessOptions {
  /** Replace the required default policy; the compaction capability remains active. */
  compaction?: PiCompactionPolicy;
}

/**
 * Pi-backed implementation of the OpenMA Harness Port.
 *
 * Pi owns provider auth, request/response protocols, streaming and the tool
 * loop. This class is intentionally only a boundary translator: canonical
 * OpenMA history in, canonical OpenMA events out.
 */
export class PiHarness implements HarnessInterface {
  constructor(private readonly options: PiHarnessOptions = {}) {}

  async run(ctx: HarnessContext): Promise<void> {
    if (!ctx.pi) {
      throw new ModelError("Pi harness requires a tenant-scoped Pi model runtime");
    }

    const proactivelyCompacted = await this.compactBeforeTurn(ctx);
    let outcome = await this.runAgentOnce(ctx);
    if (
      outcome.providerFailure
      && !outcome.producedOutput
      && !proactivelyCompacted
      && !ctx.runtime.abortSignal?.aborted
      && isContextOverflow(outcome.providerFailure, ctx.pi.model.contextWindow)
    ) {
      const recovered = await this.compactBeforeTurn(ctx, true);
      if (recovered) outcome = await this.runAgentOnce(ctx);
    }

    if (outcome.providerFailure && !ctx.runtime.abortSignal?.aborted) {
      const message = outcome.providerFailure.errorMessage ?? "Pi provider request failed";
      const external = classifyExternalError(new Error(message));
      throw external instanceof Error ? external : new ModelError(message);
    }
    if (!outcome.producedOutput && !ctx.runtime.abortSignal?.aborted) {
      throw new ModelError("No output generated. Check the Pi stream for errors.");
    }
  }

  private async runAgentOnce(ctx: HarnessContext): Promise<PiRunOutcome> {
    const modelMessages = await eventsToMessagesAsync(ctx.runtime.history.getEvents(), ctx.fileFetcher);
    const messages = modelMessagesToPi(modelMessages, ctx.pi!.model);
    if (messages.length === 0) {
      throw new ModelError("Pi harness cannot continue without a user message");
    }
    const state: LiveMessageState = {
      spanId: null,
      firstTokenSeen: false,
      textIds: new Map(),
      thinkingIds: new Map(),
      toolIds: new Map(),
    };
    let providerFailure: AssistantMessage | undefined;
    let producedOutput = false;

    const agent = new Agent({
      initialState: {
        systemPrompt: ctx.systemPrompt,
        model: ctx.pi!.model,
        messages,
        tools: toolsToPi(ctx),
        // `model.reasoning` describes capability, not user intent. Managed
        // Agents effort is opt-in; an omitted effort must remain non-thinking.
        // Pi owns provider-specific validation and maps the portable effort to
        // the concrete request payload.
        thinkingLevel:
          typeof ctx.agent.model === "object"
            ? (ctx.agent.model.effort ?? "off")
            : "off",
      },
      sessionId: ctx.session_id,
      streamFn: (model, context, options) =>
        ctx.pi!.models.streamSimple(model, context, options),
      toolExecution: "parallel",
    });

    const unsubscribe = agent.subscribe(async (event) => {
      const result = await translatePiEvent(event, ctx, state);
      producedOutput ||= result.producedOutput;
      if (result.providerFailure) providerFailure = result.providerFailure;
    });

    const abort = () => agent.abort();
    ctx.runtime.abortSignal?.addEventListener("abort", abort, { once: true });

    try {
      const run = () => agent.continue();
      if (ctx.runtime.keepAliveWhile) await ctx.runtime.keepAliveWhile(run);
      else await run();
    } finally {
      unsubscribe();
      ctx.runtime.abortSignal?.removeEventListener("abort", abort);
      await closeLiveStreams(ctx, state, ctx.runtime.abortSignal?.aborted ? "aborted" : "completed");
    }

    return { producedOutput, ...(providerFailure ? { providerFailure } : {}) };
  }

  private async compactBeforeTurn(ctx: HarnessContext, force: boolean = false): Promise<boolean> {
    const policy = this.options.compaction === undefined
      ? resolvePiCompactionPolicy((ctx.agent.metadata ?? {}) as Record<string, unknown>)
      : this.options.compaction;
    if (!ctx.pi) return false;

    const events = ctx.runtime.history.getEvents();
    const modelMessages = await eventsToMessagesAsync(events, ctx.fileFetcher);
    const messages = modelMessagesToPi(modelMessages, ctx.pi.model);
    const contextWindowTokens = ctx.pi.model.contextWindow || 128_000;
    if (!force && !policy.shouldCompact(events, { messages, contextWindowTokens })) return false;

    try {
      const result = await policy.compact(events, {
        messages,
        contextWindowTokens,
        models: ctx.pi.models,
        model: ctx.pi.model,
        systemPrompt: ctx.systemPrompt,
        tools: toolsToPi(ctx),
        runtime: ctx.runtime,
        sessionId: ctx.session_id,
        abortSignal: ctx.runtime.abortSignal,
      });
      return this.persistCompaction(result, ctx);
    } catch (error) {
      // Context compaction is a best-effort optimization. The canonical
      // history remains untouched when a policy/model fails, so the main
      // turn can still run and a later turn can retry.
      console.warn(`[pi-compact] ${policy.name} failed: ${(error as Error).message}`);
      return false;
    }
  }

  private persistCompaction(
    result: PiCompactionResult | null,
    ctx: HarnessContext,
  ): boolean {
    if (!result) return false;
    const hasContent = result.summary.some(
      (block) => (block.type === "text" && block.text.trim().length > 0)
        || block.type === "image"
        || block.type === "document",
    );
    if (!hasContent) return false;
    ctx.runtime.broadcast({
      type: "agent.thread_context_compacted",
      original_message_count: result.original_message_count,
      compacted_message_count: result.compacted_message_count,
      summary: result.summary,
      trigger: "auto",
      pre_tokens: result.pre_tokens,
    });
    return true;
  }
}

async function translatePiEvent(
  event: AgentEvent,
  ctx: HarnessContext,
  state: LiveMessageState,
): Promise<{ producedOutput: boolean; providerFailure?: AssistantMessage }> {
  const runtime = ctx.runtime;
  const modelId = ctx.pi!.model.id;
  let producedOutput = false;

  if (event.type === "turn_start") {
    state.spanId = generateEventId();
    state.firstTokenSeen = false;
    runtime.broadcast({
      type: "span.model_request_start",
      id: state.spanId,
      model: modelId,
    });
    return { producedOutput };
  }

  if (event.type === "message_update" && event.message.role === "assistant") {
    const update = event.assistantMessageEvent;
    if (update.type !== "start" && update.type !== "done" && update.type !== "error") {
      markFirstToken(runtime, state, modelId);
    }
    switch (update.type) {
      case "text_start": {
        const id = generateEventId();
        state.textIds.set(update.contentIndex, id);
        await runtime.broadcastStreamStart(id);
        break;
      }
      case "text_delta": {
        const id = await ensureTextStream(runtime, state, update.contentIndex);
        await runtime.broadcastChunk(id, update.delta);
        break;
      }
      case "thinking_start": {
        const id = generateEventId();
        state.thinkingIds.set(update.contentIndex, id);
        await runtime.broadcastThinkingStart(id);
        break;
      }
      case "thinking_delta": {
        const id = await ensureThinkingStream(runtime, state, update.contentIndex);
        await runtime.broadcastThinkingChunk(id, update.delta);
        break;
      }
      case "toolcall_start": {
        const block = update.partial.content[update.contentIndex];
        const id = block?.type === "toolCall" ? block.id : generateEventId();
        const name = block?.type === "toolCall" ? block.name : undefined;
        state.toolIds.set(update.contentIndex, id);
        await runtime.broadcastToolInputStart(id, name);
        break;
      }
      case "toolcall_delta": {
        const id = await ensureToolStream(runtime, state, update.contentIndex);
        await runtime.broadcastToolInputChunk(id, update.delta);
        break;
      }
      case "toolcall_end": {
        const prior = state.toolIds.get(update.contentIndex);
        if (prior && prior !== update.toolCall.id) {
          await runtime.broadcastToolInputEnd(prior, "aborted");
          await runtime.broadcastToolInputStart(update.toolCall.id, update.toolCall.name);
        } else if (!prior) {
          await runtime.broadcastToolInputStart(update.toolCall.id, update.toolCall.name);
        }
        state.toolIds.set(update.contentIndex, update.toolCall.id);
        break;
      }
    }
    return { producedOutput };
  }

  if (event.type === "message_end" && event.message.role === "assistant") {
    const message = event.message;
    for (let index = 0; index < message.content.length; index++) {
      const block = message.content[index];
      if (block.type === "thinking") {
        const id = state.thinkingIds.get(index) ?? generateEventId();
        if (state.thinkingIds.has(index)) {
          await runtime.broadcastThinkingEnd(id, "completed");
        }
        runtime.broadcast({
          type: "agent.thinking",
          thinking_id: id,
          text: block.thinking,
          ...(block.thinkingSignature
            ? { providerOptions: { pi: { thinkingSignature: block.thinkingSignature } } }
            : {}),
        });
        producedOutput ||= block.thinking.length > 0;
      } else if (block.type === "text") {
        const id = state.textIds.get(index) ?? generateEventId();
        if (state.textIds.has(index)) {
          await runtime.broadcastStreamEnd(id, "completed");
        }
        runtime.broadcast({
          type: "agent.message",
          message_id: id,
          content: [{ type: "text", text: block.text.replace(/\s+$/, "") }],
        });
        producedOutput ||= block.text.trim().length > 0;
      } else if (block.type === "toolCall") {
        const streamId = state.toolIds.get(index);
        if (streamId) await runtime.broadcastToolInputEnd(streamId, "completed");
        runtime.broadcast({
          type: "agent.tool_use",
          id: block.id,
          name: block.name,
          input: block.arguments,
        });
        producedOutput = true;
      }
    }

    const usage = message.usage;
    runtime.broadcast({
      type: "span.model_request_end",
      model: modelId,
      model_request_start_id: state.spanId ?? undefined,
      provider_response_id: message.responseId,
      model_usage: {
        input_tokens: usage.input,
        output_tokens: usage.output,
        cache_read_input_tokens: usage.cacheRead,
        cache_creation_input_tokens: usage.cacheWrite,
      },
      finish_reason: message.stopReason,
      final_text_length: message.content
        .filter((block) => block.type === "text")
        .reduce((sum, block) => sum + block.text.length, 0),
      is_error: message.stopReason === "error",
      ...(message.errorMessage ? { error_message: message.errorMessage.slice(0, 500) } : {}),
    });
    await runtime.reportUsage?.(usage.input, usage.output);
    clearMessageState(state);
    return {
      producedOutput,
      ...(message.stopReason === "error"
        ? { providerFailure: message }
        : {}),
    };
  }

  if (event.type === "tool_execution_end") {
    const details = event.result?.details as { openmaPendingConfirmation?: boolean } | undefined;
    if (!details?.openmaPendingConfirmation) {
      runtime.broadcast({
        type: "agent.tool_result",
        tool_use_id: event.toolCallId,
        content: piContentToWire(event.result?.content ?? []),
        is_error: event.isError,
      } as SessionEvent);
    }
  }

  return { producedOutput };
}

function markFirstToken(
  runtime: HarnessContext["runtime"],
  state: LiveMessageState,
  model: string,
): void {
  if (state.firstTokenSeen || !state.spanId) return;
  state.firstTokenSeen = true;
  runtime.broadcast({
    type: "span.model_first_token",
    model,
    model_request_start_id: state.spanId,
  });
}

async function ensureTextStream(
  runtime: HarnessContext["runtime"],
  state: LiveMessageState,
  index: number,
): Promise<string> {
  let id = state.textIds.get(index);
  if (!id) {
    id = generateEventId();
    state.textIds.set(index, id);
    await runtime.broadcastStreamStart(id);
  }
  return id;
}

async function ensureThinkingStream(
  runtime: HarnessContext["runtime"],
  state: LiveMessageState,
  index: number,
): Promise<string> {
  let id = state.thinkingIds.get(index);
  if (!id) {
    id = generateEventId();
    state.thinkingIds.set(index, id);
    await runtime.broadcastThinkingStart(id);
  }
  return id;
}

async function ensureToolStream(
  runtime: HarnessContext["runtime"],
  state: LiveMessageState,
  index: number,
): Promise<string> {
  let id = state.toolIds.get(index);
  if (!id) {
    id = generateEventId();
    state.toolIds.set(index, id);
    await runtime.broadcastToolInputStart(id);
  }
  return id;
}

async function closeLiveStreams(
  ctx: HarnessContext,
  state: LiveMessageState,
  status: "completed" | "aborted",
): Promise<void> {
  for (const id of state.textIds.values()) {
    await ctx.runtime.broadcastStreamEnd(id, status);
  }
  for (const id of state.thinkingIds.values()) {
    await ctx.runtime.broadcastThinkingEnd(id, status);
  }
  for (const id of state.toolIds.values()) {
    await ctx.runtime.broadcastToolInputEnd(id, status);
  }
  clearMessageState(state);
}

function clearMessageState(state: LiveMessageState): void {
  state.spanId = null;
  state.firstTokenSeen = false;
  state.textIds.clear();
  state.thinkingIds.clear();
  state.toolIds.clear();
}

function toolsToPi(ctx: HarnessContext): AgentTool[] {
  return Object.entries(ctx.tools).map(([name, raw]) => {
    const tool = raw as {
      description?: string;
      inputSchema?: unknown;
      parameters?: unknown;
      execute?: (input: unknown, options?: unknown) => Promise<unknown>;
    };
    const schema = toJsonSchema(tool.inputSchema ?? tool.parameters);
    return {
      name,
      label: name,
      description: tool.description ?? name,
      parameters: Type.Unsafe<Record<string, unknown>>(schema),
      execute: async (toolCallId, params, signal) => {
        if (!tool.execute) {
          ctx.runtime.pendingConfirmations ??= [];
          ctx.runtime.pendingConfirmations.push(toolCallId);
          return {
            content: [{ type: "text", text: "Tool confirmation required" }],
            details: { openmaPendingConfirmation: true },
            terminate: true,
          };
        }
        const value = await tool.execute(params, {
          toolCallId,
          messages: [],
          abortSignal: signal,
        });
        return { content: valueToPiContent(value), details: value };
      },
    };
  });
}

function toJsonSchema(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") {
    return { type: "object", additionalProperties: true };
  }
  const candidate = input as { jsonSchema?: unknown; _zod?: unknown };
  if (candidate.jsonSchema && typeof candidate.jsonSchema === "object") {
    return candidate.jsonSchema as Record<string, unknown>;
  }
  try {
    return z.toJSONSchema(input as z.ZodType) as Record<string, unknown>;
  } catch {
    return input as Record<string, unknown>;
  }
}

function valueToPiContent(value: unknown): Array<TextContent | ImageContent> {
  if (typeof value === "string") return [{ type: "text", text: value }];
  return [{ type: "text", text: JSON.stringify(value) ?? String(value) }];
}

function piContentToWire(content: Array<TextContent | ImageContent>): ContentBlock[] {
  return content.map((block) =>
    block.type === "text"
      ? { type: "text", text: block.text }
      : {
          type: "image",
          source: { type: "base64", media_type: block.mimeType, data: block.data },
        },
  );
}

function modelMessagesToPi(
  messages: ModelMessage[],
  model: Model<Api>,
): Message[] {
  const now = Date.now();
  return messages.flatMap((message, index): Message[] => {
    const timestamp = now + index;
    if (message.role === "user") {
      const content = typeof message.content === "string"
        ? message.content
        : message.content.flatMap((part): Array<TextContent | ImageContent> => {
            if (part.type === "text") return [{ type: "text", text: part.text }];
            if (part.type === "image") {
              const image = part.image;
              if (image instanceof Uint8Array) {
                return [{
                  type: "image",
                  data: bytesToBase64(image),
                  mimeType: part.mediaType ?? "application/octet-stream",
                }];
              }
              if (typeof image === "string") {
                return [{ type: "image", data: image, mimeType: part.mediaType ?? "image/png" }];
              }
            }
            return [{ type: "text", text: `[${part.type} attachment]` }];
          });
      return [{ role: "user", content, timestamp }];
    }
    if (message.role === "assistant") {
      const content: AssistantMessage["content"] = [];
      if (typeof message.content === "string") {
        content.push({ type: "text", text: message.content });
      } else {
        for (const part of message.content) {
          if (part.type === "text") {
            content.push({ type: "text", text: part.text });
          } else if (part.type === "reasoning") {
            const options = part.providerOptions as Record<string, unknown> | undefined;
            const thinkingSignature = extractThinkingSignature(options);
            content.push({
              type: "thinking",
              thinking: part.text,
              ...(thinkingSignature ? { thinkingSignature } : {}),
            });
          } else if (part.type === "tool-call") {
            content.push({
              type: "toolCall",
              id: part.toolCallId,
              name: part.toolName,
              arguments: (part.input ?? {}) as Record<string, unknown>,
            });
          }
        }
      }
      const assistant: AssistantMessage = {
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { ...EMPTY_USAGE, cost: { ...EMPTY_USAGE.cost } },
        stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
        timestamp,
      };
      return [assistant];
    }
    if (message.role === "tool") {
      return message.content.flatMap((part): ToolResultMessage[] =>
        part.type === "tool-result"
          ? [{
              role: "toolResult",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              content: toolOutputToPi(part.output),
              isError: false,
              timestamp,
            }]
          : [],
      );
    }
    return [];
  });
}

function toolOutputToPi(output: unknown): Array<TextContent | ImageContent> {
  if (!output || typeof output !== "object") return valueToPiContent(output);
  const value = output as { type?: string; value?: unknown };
  if (value.type === "text") return [{ type: "text", text: String(value.value ?? "") }];
  if (value.type === "json") return valueToPiContent(value.value);
  if (value.type === "content" && Array.isArray(value.value)) {
    return value.value.flatMap((part): Array<TextContent | ImageContent> => {
      if (!part || typeof part !== "object") return valueToPiContent(part);
      const item = part as Record<string, unknown>;
      if (item.type === "text") return [{ type: "text", text: String(item.text ?? "") }];
      if (item.type === "image-data") {
        return [{
          type: "image",
          data: String(item.data ?? ""),
          mimeType: String(item.mediaType ?? "image/png"),
        }];
      }
      return valueToPiContent(item);
    });
  }
  return valueToPiContent(output);
}

function extractThinkingSignature(options: Record<string, unknown> | undefined): string | undefined {
  if (!options) return undefined;
  const pi = options.pi as { thinkingSignature?: unknown } | undefined;
  if (typeof pi?.thinkingSignature === "string") return pi.thinkingSignature;
  const anthropic = options.anthropic as { signature?: unknown; redactedData?: unknown } | undefined;
  if (typeof anthropic?.signature === "string") return anthropic.signature;
  if (typeof anthropic?.redactedData === "string") return anthropic.redactedData;
  return undefined;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
