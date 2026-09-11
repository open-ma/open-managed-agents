import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
  SharedV3ProviderMetadata,
  SharedV3Warning,
} from "@ai-sdk/provider";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  ImageContent,
  Message,
  Model,
  SimpleStreamOptions,
  TextContent,
  Tool,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { Api } from "@earendil-works/pi-ai";
import {
  withPiRuntimeRequestOptions,
  type PiModelRuntime,
} from "./pi-provider";

/**
 * Present a Pi provider/model pair as the AI SDK model consumed by
 * DefaultHarness. Pi remains the provider runtime and owns auth, payloads,
 * transport and streaming; this adapter only translates the two public event
 * protocols.
 */
export function toAiSdkLanguageModel(runtime: PiModelRuntime): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: `pi.${runtime.model.provider}`,
    modelId: runtime.model.id,
    supportedUrls: {},
    doGenerate: (options) => generateWithPi(runtime, options),
    doStream: (options) => streamWithPi(runtime, options),
  };
}

async function generateWithPi(
  runtime: PiModelRuntime,
  options: LanguageModelV3CallOptions,
): Promise<LanguageModelV3GenerateResult> {
  const warnings = collectWarnings(options);
  const message = await runtime.models.completeSimple(
    runtime.model,
    toPiContext(options, runtime.model),
    toPiStreamOptions(runtime, options),
  );
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(message.errorMessage ?? `Pi model stopped with ${message.stopReason}`);
  }
  return {
    content: toAiSdkContent(message),
    finishReason: toFinishReason(message.stopReason, message.rawStopReason),
    usage: toAiSdkUsage(message.usage),
    warnings,
    response: {
      ...(message.responseId ? { id: message.responseId } : {}),
      modelId: message.responseModel ?? message.model,
      timestamp: new Date(message.timestamp),
    },
  };
}

async function streamWithPi(
  runtime: PiModelRuntime,
  options: LanguageModelV3CallOptions,
) {
  const abortController = new AbortController();
  const forwardAbort = () => abortController.abort(options.abortSignal?.reason);
  options.abortSignal?.addEventListener("abort", forwardAbort, { once: true });

  const piStream = runtime.models.streamSimple(
    runtime.model,
    toPiContext(options, runtime.model),
    toPiStreamOptions(runtime, options, abortController.signal),
  );
  const iterator = piStream[Symbol.asyncIterator]();
  const warnings = collectWarnings(options);
  let emittedStart = false;
  let terminal = false;

  const stream = new ReadableStream<LanguageModelV3StreamPart>({
    async pull(controller) {
      if (!emittedStart) {
        emittedStart = true;
        controller.enqueue({ type: "stream-start", warnings });
        return;
      }

      while (!terminal) {
        const next = await iterator.next();
        if (next.done) {
          terminal = true;
          controller.close();
          options.abortSignal?.removeEventListener("abort", forwardAbort);
          return;
        }
        const parts = toAiSdkStreamParts(next.value);
        for (const part of parts) controller.enqueue(part);
        if (next.value.type === "done" || next.value.type === "error") {
          terminal = true;
          controller.close();
          options.abortSignal?.removeEventListener("abort", forwardAbort);
          return;
        }
        if (parts.length > 0) return;
      }
    },
    async cancel(reason) {
      terminal = true;
      abortController.abort(reason);
      options.abortSignal?.removeEventListener("abort", forwardAbort);
      await iterator.return?.();
    },
  });

  return { stream };
}

function toPiContext(
  options: LanguageModelV3CallOptions,
  model: Model<Api>,
): Context {
  const systemPrompt = options.prompt
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const messages: Message[] = [];
  const timestamp = Date.now();

  for (const [index, message] of options.prompt.entries()) {
    const at = timestamp + index;
    if (message.role === "system") continue;
    if (message.role === "user") {
      messages.push({
        role: "user",
        content: message.content.flatMap(toPiUserContent),
        timestamp: at,
      });
      continue;
    }
    if (message.role === "assistant") {
      const content: AssistantMessage["content"] = [];
      for (const part of message.content) {
        if (part.type === "text") {
          content.push({ type: "text", text: part.text });
        } else if (part.type === "reasoning") {
          const signature = readPiSignature(part.providerOptions);
          content.push({
            type: "thinking",
            thinking: part.text,
            ...(signature ? { thinkingSignature: signature } : {}),
          });
        } else if (part.type === "tool-call") {
          content.push({
            type: "toolCall",
            id: part.toolCallId,
            name: part.toolName,
            arguments: asRecord(part.input),
          });
        }
      }
      messages.push({
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: emptyPiUsage(),
        stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
        timestamp: at,
      });
      continue;
    }
    for (const part of message.content) {
      if (part.type !== "tool-result") continue;
      messages.push(toPiToolResult(part, at));
    }
  }

  return {
    ...(systemPrompt ? { systemPrompt } : {}),
    messages,
    ...(options.tools ? { tools: toPiTools(options.tools) } : {}),
  };
}

function toPiUserContent(
  part: Extract<LanguageModelV3CallOptions["prompt"][number], { role: "user" }>["content"][number],
): Array<TextContent | ImageContent> {
  if (part.type === "text") return [{ type: "text", text: part.text }];
  if (!part.mediaType.startsWith("image/")) {
    return [{ type: "text", text: `[${part.filename ?? part.mediaType} attachment]` }];
  }
  if (part.data instanceof Uint8Array) {
    return [{ type: "image", data: bytesToBase64(part.data), mimeType: part.mediaType }];
  }
  if (part.data instanceof URL) {
    return [{ type: "text", text: `[image URL: ${part.data.toString()}]` }];
  }
  return [{ type: "image", data: part.data, mimeType: part.mediaType }];
}

function toPiToolResult(
  part: Extract<LanguageModelV3CallOptions["prompt"][number], { role: "tool" }>["content"][number] & { type: "tool-result" },
  timestamp: number,
): ToolResultMessage {
  const output = part.output;
  let content: Array<TextContent | ImageContent>;
  let isError = false;
  if (output.type === "text" || output.type === "error-text") {
    content = [{ type: "text", text: output.value }];
    isError = output.type === "error-text";
  } else if (output.type === "json" || output.type === "error-json") {
    content = [{ type: "text", text: JSON.stringify(output.value) }];
    isError = output.type === "error-json";
  } else if (output.type === "execution-denied") {
    content = [{ type: "text", text: output.reason ?? "Tool execution denied" }];
    isError = true;
  } else {
    content = output.value.flatMap((item): Array<TextContent | ImageContent> => {
      if (item.type === "text") return [{ type: "text", text: item.text }];
      if (item.type === "image-data") {
        return [{ type: "image", data: item.data, mimeType: item.mediaType }];
      }
      return [{ type: "text", text: `[${item.type} tool output]` }];
    });
  }
  return {
    role: "toolResult",
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    content,
    isError,
    timestamp,
  };
}

function toPiTools(
  tools: NonNullable<LanguageModelV3CallOptions["tools"]>,
): Tool[] {
  return tools.flatMap((tool): Tool[] =>
    tool.type === "function"
      ? [{
          name: tool.name,
          description: tool.description ?? tool.name,
          parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
        }]
      : [],
  );
}

function toPiStreamOptions(
  runtime: PiModelRuntime,
  options: LanguageModelV3CallOptions,
  signal = options.abortSignal,
): SimpleStreamOptions {
  const piOptions = options.providerOptions?.pi ?? {};
  const samplingParams: Record<string, unknown> = {
    ...(options.topP !== undefined ? { top_p: options.topP } : {}),
    ...(options.topK !== undefined ? { top_k: options.topK } : {}),
    ...(options.presencePenalty !== undefined ? { presence_penalty: options.presencePenalty } : {}),
    ...(options.frequencyPenalty !== undefined ? { frequency_penalty: options.frequencyPenalty } : {}),
    ...(options.stopSequences ? { stop: options.stopSequences } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
  };
  return withPiRuntimeRequestOptions(runtime, {
    ...piOptions,
    ...(piOptions.reasoning === undefined && runtime.thinkingLevel !== "off"
      ? { reasoning: runtime.thinkingLevel }
      : {}),
    ...(signal ? { signal } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxOutputTokens !== undefined ? { maxTokens: options.maxOutputTokens } : {}),
    ...(Object.keys(samplingParams).length > 0 ? { samplingParams } : {}),
    toolChoice: options.toolChoice?.type === "none" ? "none" : "auto",
  });
}

function toAiSdkStreamParts(event: AssistantMessageEvent): LanguageModelV3StreamPart[] {
  switch (event.type) {
    case "start":
      return event.partial.responseId
        ? [{ type: "response-metadata", id: event.partial.responseId }]
        : [];
    case "text_start":
      return [{ type: "text-start", id: contentId("text", event.contentIndex) }];
    case "text_delta":
      return [{ type: "text-delta", id: contentId("text", event.contentIndex), delta: event.delta }];
    case "text_end":
      return [{ type: "text-end", id: contentId("text", event.contentIndex) }];
    case "thinking_start":
      return [{ type: "reasoning-start", id: contentId("reasoning", event.contentIndex) }];
    case "thinking_delta":
      return [{ type: "reasoning-delta", id: contentId("reasoning", event.contentIndex), delta: event.delta }];
    case "thinking_end": {
      const block = event.partial.content[event.contentIndex];
      return [{
        type: "reasoning-end",
        id: contentId("reasoning", event.contentIndex),
        ...(block?.type === "thinking" ? { providerMetadata: piBlockMetadata(block) } : {}),
      }];
    }
    case "toolcall_start": {
      const block = event.partial.content[event.contentIndex];
      return block?.type === "toolCall"
        ? [{ type: "tool-input-start", id: block.id, toolName: block.name }]
        : [];
    }
    case "toolcall_delta": {
      const block = event.partial.content[event.contentIndex];
      return block?.type === "toolCall"
        ? [{ type: "tool-input-delta", id: block.id, delta: event.delta }]
        : [];
    }
    case "toolcall_end":
      return [
        { type: "tool-input-end", id: event.toolCall.id },
        {
          type: "tool-call",
          toolCallId: event.toolCall.id,
          toolName: event.toolCall.name,
          input: JSON.stringify(event.toolCall.arguments),
          ...(event.toolCall.thoughtSignature
            ? { providerMetadata: { pi: { thoughtSignature: event.toolCall.thoughtSignature } } }
            : {}),
        },
      ];
    case "done":
      return [{
        type: "finish",
        usage: toAiSdkUsage(event.message.usage),
        finishReason: toFinishReason(event.reason, event.message.rawStopReason),
        providerMetadata: piMessageMetadata(event.message),
      }];
    case "error": {
      const message = event.error.errorMessage ?? `Pi model stopped with ${event.reason}`;
      return [{
        type: "error",
        // LanguageModelV3 accepts `unknown` here. Preserve Pi's string rather
        // than wrapping it in Error: Errors serialize as `{}` in our R2/event
        // diagnostics and erase the upstream provider message.
        error: message,
      }];
    }
  }
}

function toAiSdkContent(message: AssistantMessage): LanguageModelV3Content[] {
  return message.content.map((block): LanguageModelV3Content => {
    if (block.type === "text") {
      return {
        type: "text",
        text: block.text,
        ...(block.textSignature ? { providerMetadata: piBlockMetadata(block) } : {}),
      };
    }
    if (block.type === "thinking") {
      return {
        type: "reasoning",
        text: block.thinking,
        ...(block.thinkingSignature ? { providerMetadata: piBlockMetadata(block) } : {}),
      };
    }
    return {
      type: "tool-call",
      toolCallId: block.id,
      toolName: block.name,
      input: JSON.stringify(block.arguments),
      ...(block.thoughtSignature
        ? { providerMetadata: { pi: { thoughtSignature: block.thoughtSignature } } }
        : {}),
    };
  });
}

function toAiSdkUsage(usage: Usage): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: usage.input,
      noCache: Math.max(0, usage.input - usage.cacheRead),
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
    },
    outputTokens: {
      total: usage.output,
      text: usage.reasoning === undefined ? usage.output : Math.max(0, usage.output - usage.reasoning),
      reasoning: usage.reasoning,
    },
  };
}

function toFinishReason(reason: string, raw?: string): LanguageModelV3FinishReason {
  const unified: LanguageModelV3FinishReason["unified"] =
    reason === "stop" ? "stop"
      : reason === "length" ? "length"
        : reason === "toolUse" ? "tool-calls"
          : reason === "error" || reason === "aborted" ? "error"
            : "other";
  return { unified, raw: raw ?? reason };
}

function collectWarnings(options: LanguageModelV3CallOptions): SharedV3Warning[] {
  const warnings: SharedV3Warning[] = [];
  if (options.responseFormat?.type === "json") {
    warnings.push({
      type: "unsupported",
      feature: "responseFormat",
      details: "Pi simple streams do not expose AI SDK structured response formats.",
    });
  }
  if (options.tools?.some((tool) => tool.type === "provider")) {
    warnings.push({
      type: "unsupported",
      feature: "provider-defined tools",
      details: "Only function tools cross the Pi/AI SDK adapter.",
    });
  }
  if (options.toolChoice && options.toolChoice.type !== "auto" && options.toolChoice.type !== "none") {
    warnings.push({
      type: "compatibility",
      feature: "toolChoice",
      details: `Pi maps AI SDK tool choice ${options.toolChoice.type} to auto.`,
    });
  }
  return warnings;
}

function piBlockMetadata(
  block: AssistantMessage["content"][number],
): SharedV3ProviderMetadata | undefined {
  if (block.type === "text" && block.textSignature) {
    return { pi: { textSignature: block.textSignature } };
  }
  if (block.type === "thinking" && block.thinkingSignature) {
    return {
      pi: {
        thinkingSignature: block.thinkingSignature,
        ...(block.redacted !== undefined ? { redacted: block.redacted } : {}),
      },
    };
  }
  return undefined;
}

function piMessageMetadata(message: AssistantMessage): SharedV3ProviderMetadata | undefined {
  const metadata = {
    ...(message.responseId ? { responseId: message.responseId } : {}),
    ...(message.rawStopReason ? { rawStopReason: message.rawStopReason } : {}),
  };
  return Object.keys(metadata).length > 0 ? { pi: metadata } : undefined;
}

function readPiSignature(options: Record<string, unknown> | undefined): string | undefined {
  const pi = options?.pi as { thinkingSignature?: unknown } | undefined;
  if (typeof pi?.thinkingSignature === "string") return pi.thinkingSignature;
  const anthropic = options?.anthropic as { signature?: unknown; redactedData?: unknown } | undefined;
  if (typeof anthropic?.signature === "string") return anthropic.signature;
  return typeof anthropic?.redactedData === "string" ? anthropic.redactedData : undefined;
}

function emptyPiUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function contentId(kind: "text" | "reasoning", index: number): string {
  return `pi-${kind}-${index}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
