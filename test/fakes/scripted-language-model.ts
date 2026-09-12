import { MockLanguageModelV3 } from "ai/test";

export type LanguageModelStreamChunk = Record<string, unknown> & { type: string };

export interface StreamStepOptions {
  /** Emit the provider protocol's error chunk after exactly this many chunks. */
  errorAfterChunks?: number;
  error?: Error;
}

export interface ScriptedStreamStep {
  type: "stream";
  chunks: LanguageModelStreamChunk[];
  errorAfterChunks?: number;
  error?: Error;
}

export interface ScriptedRequestErrorStep {
  type: "request-error";
  error: Error;
}

export type ScriptedLanguageModelStep = ScriptedStreamStep | ScriptedRequestErrorStep;

export function streamStep(
  chunks: LanguageModelStreamChunk[],
  options: StreamStepOptions = {},
): ScriptedStreamStep {
  return { type: "stream", chunks, ...options };
}

export function requestErrorStep(error: Error): ScriptedRequestErrorStep {
  return { type: "request-error", error };
}

export function textChunks(id: string, deltas: string[]): LanguageModelStreamChunk[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id },
    ...deltas.map((delta) => ({ type: "text-delta", id, delta })),
    { type: "text-end", id },
  ];
}

export function toolCallChunks(options: {
  id: string;
  toolName: string;
  inputDeltas: string[];
}): LanguageModelStreamChunk[] {
  const input = options.inputDeltas.join("");
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id: options.id, toolName: options.toolName },
    ...options.inputDeltas.map((delta) => ({
      type: "tool-input-delta",
      id: options.id,
      delta,
    })),
    { type: "tool-input-end", id: options.id },
    {
      type: "tool-call",
      toolCallId: options.id,
      toolName: options.toolName,
      input,
    },
  ];
}

export function finishChunk(
  reason: "stop" | "tool-calls" | "length" | "content-filter" | "error" | "other",
  usage = {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  },
): LanguageModelStreamChunk {
  return {
    type: "finish",
    finishReason: { unified: reason, raw: reason },
    usage,
  };
}

function scriptedStream(step: ScriptedStreamStep): ReadableStream<LanguageModelStreamChunk> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      const failAfter = step.errorAfterChunks;
      if (failAfter !== undefined && index === failAfter) {
        controller.enqueue({
          type: "error",
          error: step.error ?? new Error("scripted LLM stream disconnected"),
        });
        controller.close();
        return;
      }
      if (index >= step.chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(step.chunks[index]!);
      index += 1;
      if (index === step.chunks.length && failAfter === undefined) controller.close();
    },
  });
}

export function createScriptedLanguageModel(
  steps: ScriptedLanguageModelStep[],
  options: { provider?: string; modelId?: string } = {},
) {
  const script = [...steps];
  const calls: unknown[] = [];
  const totalSteps = script.length;
  let callIndex = 0;
  const model = new MockLanguageModelV3({
    provider: options.provider ?? "openma-scripted-fake",
    modelId: options.modelId ?? "scripted-language-model",
    doStream: async (options) => {
      calls.push(options);
      const step = script.shift();
      callIndex += 1;
      if (!step) {
        throw new Error(`Scripted LLM exhausted after ${totalSteps} calls`);
      }
      if (step.type === "request-error") throw step.error;
      return { stream: scriptedStream(step) } as never;
    },
  });

  return {
    model,
    get calls() {
      return calls;
    },
    get callCount() {
      return callIndex;
    },
    get remainingSteps() {
      return script.length;
    },
    assertExhausted() {
      if (script.length > 0) {
        throw new Error(
          `Scripted LLM has ${script.length} unconsumed step${script.length === 1 ? "" : "s"}`,
        );
      }
    },
  };
}
