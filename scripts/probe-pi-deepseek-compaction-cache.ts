import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createPiModelRuntime } from "../apps/agent/src/harness/pi-provider";
import { PiSummaryCompactionPolicy } from "../apps/agent/src/harness/pi-compaction";

type AssistantMessage = any;
type Message = any;
type SimpleStreamOptions = any;
type Tool = any;
type Usage = any;

const MODEL = process.env.PROBE_MODEL ?? "deepseek-v4-flash";
const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
const MAX_OUTPUT_TOKENS = Number(process.env.PROBE_MAX_OUTPUT_TOKENS ?? 32);

interface ProbeResult {
  name: string;
  elapsed_ms: number;
  ttft_ms: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_hit_ratio: number;
  thinking: string;
  text: string;
  message: AssistantMessage;
}

async function apiKey(): Promise<string> {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const source = await readFile(join(homedir(), ".dsh", ".credentials.yaml"), "utf8");
  const match = source.match(/^\s*DEEPSEEK_API_KEY\s*:\s*["']?([^\n"'#]+)["']?\s*$/m);
  if (!match?.[1]) throw new Error("DEEPSEEK_API_KEY is missing from env and ~/.dsh/.credentials.yaml");
  return match[1].trim();
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistant(text: string, timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "deepseek",
    model: MODEL,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp,
  };
}

function cacheRatio(usage: Usage): number {
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  return prompt === 0 ? 0 : usage.cacheRead / prompt;
}

async function runRequest(
  name: string,
  runtime: ReturnType<typeof createPiModelRuntime>,
  systemPrompt: string,
  messages: Message[],
  tools: Tool[],
): Promise<ProbeResult> {
  let wireThinking = "unobserved";
  const options: SimpleStreamOptions = {
    maxTokens: MAX_OUTPUT_TOKENS,
    reasoning: "off",
    temperature: 0,
    sessionId: "openma-pi-compaction-cache-probe",
    onPayload: (payload) => {
      const thinking = (payload as { thinking?: { type?: unknown } }).thinking?.type;
      wireThinking = typeof thinking === "string" ? thinking : "omitted";
      return payload;
    },
  };
  const started = performance.now();
  let firstToken: number | null = null;
  let terminal: AssistantMessage | undefined;
  const stream = runtime.models.streamSimple(
    runtime.model,
    { systemPrompt, messages, tools },
    options,
  );
  for await (const event of stream) {
    if (
      firstToken === null
      && (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta")
    ) {
      firstToken = performance.now();
    }
    if (event.type === "done") terminal = event.message;
    if (event.type === "error") throw new Error(event.error.errorMessage ?? `${name} failed`);
  }
  if (!terminal) throw new Error(`${name} ended without a terminal message`);
  const ended = performance.now();
  const text = terminal.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  return {
    name,
    elapsed_ms: Math.round(ended - started),
    ttft_ms: firstToken === null ? null : Math.round(firstToken - started),
    input_tokens: terminal.usage.input,
    output_tokens: terminal.usage.output,
    cache_read_tokens: terminal.usage.cacheRead,
    cache_hit_ratio: cacheRatio(terminal.usage),
    thinking: wireThinking,
    text,
    message: terminal,
  };
}

function print(result: ProbeResult): void {
  console.log(JSON.stringify({
    name: result.name,
    elapsed_ms: result.elapsed_ms,
    ttft_ms: result.ttft_ms,
    input_tokens: result.input_tokens,
    output_tokens: result.output_tokens,
    cache_read_tokens: result.cache_read_tokens,
    cache_hit_ratio: Number(result.cache_hit_ratio.toFixed(4)),
    thinking: result.thinking,
    text: result.text.slice(0, 80),
  }));
}

async function runCompactionPolicy(
  name: string,
  policy: PiSummaryCompactionPolicy,
  runtime: ReturnType<typeof createPiModelRuntime>,
  messages: Message[],
  systemPrompt: string,
  tools: Tool[],
) {
  const events: Array<Record<string, unknown>> = [];
  const started = performance.now();
  const compacted = await policy.compact([], {
    messages,
    contextWindowTokens: runtime.model.contextWindow,
    models: runtime.models,
    model: runtime.model,
    systemPrompt,
    tools,
    runtime: {
      history: { getEvents: () => [], append: () => undefined },
      sandbox: {} as never,
      broadcast: (event) => events.push(event as unknown as Record<string, unknown>),
      reportUsage: async () => undefined,
      pendingConfirmations: [],
    },
    sessionId: "openma-pi-compaction-cache-probe",
  });
  const elapsed = Math.round(performance.now() - started);
  const end = events.findLast((event) => event.type === "span.compaction_summarize_end");
  const usage = end?.model_usage as Record<string, number> | undefined;
  console.log(JSON.stringify({
    name,
    elapsed_ms: elapsed,
    input_tokens: usage?.input_tokens ?? null,
    output_tokens: usage?.output_tokens ?? null,
    cache_read_tokens: usage?.cache_read_input_tokens ?? null,
    cache_hit_ratio: usage
      ? Number(((usage.cache_read_input_tokens ?? 0) /
        ((usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0))).toFixed(4))
      : null,
    summary_chars: compacted?.summary[0]?.type === "text" ? compacted.summary[0].text.length : 0,
  }));
  if (!compacted || compacted.summary[0]?.type !== "text") {
    throw new Error(`${name} returned no text`);
  }
  return compacted;
}

async function main(): Promise<void> {
  const runtime = createPiModelRuntime({
    provider: "deepseek",
    model: MODEL,
    apiKey: await apiKey(),
    baseURL: BASE_URL,
  });
  const nonce = crypto.randomUUID();
  const systemPrompt = [
    `OpenMA deterministic cache benchmark ${nonce}.`,
    "You are a coding agent. Preserve exact technical state and reply only with the requested short marker.",
    "The following policy is stable across the entire managed session. ".repeat(80),
  ].join("\n");
  const longState = Array.from({ length: 900 }, (_, index) =>
    `src/module-${String(index).padStart(4, "0")}.ts exports stableSymbol${index}; decision=${index % 7}; status=verified.`,
  ).join("\n");
  const messages: Message[] = [
    {
      role: "user",
      content: `Benchmark run ${nonce}. Record this repository state exactly:\n${longState}`,
      timestamp: 1,
    },
    assistant("Repository state recorded exactly.", 2),
    { role: "user", content: "Keep all recorded paths and decisions. Reply exactly BASELINE_OK.", timestamp: 3 },
  ];
  const tools: Tool[] = [{
    name: "read_file",
    description: "Read one repository file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  }];

  console.log(JSON.stringify({ model: MODEL, thinking: "off", prefix_chars: systemPrompt.length + longState.length }));

  const cold = await runRequest("baseline_cold", runtime, systemPrompt, messages, tools);
  print(cold);
  const warm = await runRequest("baseline_warm_exact", runtime, systemPrompt, messages, tools);
  print(warm);
  const historyMessages: Message[] = [...messages, warm.message];

  const dshStyle = await runRequest(
    "dsh_style_summary_same_prefix",
    runtime,
    systemPrompt,
    [...historyMessages, {
      role: "user",
      content: "Act as a compaction engine. Summarize the conversation above in under 120 words. Output only the checkpoint.",
      timestamp: 4,
    }],
    tools,
  );
  print(dshStyle);

  await runCompactionPolicy(
    "openma_cc_style_isolated",
    new PiSummaryCompactionPolicy("cc-style", { maxSummaryTokens: MAX_OUTPUT_TOKENS }),
    runtime,
    historyMessages,
    systemPrompt,
    tools,
  );

  const flueStyle = await runRequest(
    "flue_style_serialized_isolated_summary",
    runtime,
    "You are a context summarization assistant. Do not continue the conversation. Only output a structured summary.",
    [{
      role: "user",
      content: `<conversation>\n${JSON.stringify(historyMessages)}\n</conversation>\n\nCreate a concise structured checkpoint.`,
      timestamp: 4,
    }],
    [],
  );
  print(flueStyle);

  const compacted = await runCompactionPolicy(
    "openma_summarize_reused_prefix",
    new PiSummaryCompactionPolicy("summarize", { maxSummaryTokens: MAX_OUTPUT_TOKENS }),
    runtime,
    historyMessages,
    systemPrompt,
    tools,
  );

  const postMessages: Message[] = [
    {
      role: "user",
      content: `<conversation-summary>\n${compacted.summary[0].text}\n</conversation-summary>`,
      timestamp: 5,
    },
    historyMessages.at(-2),
    historyMessages.at(-1),
    { role: "user", content: "After compaction reply exactly POST_ONE.", timestamp: 6 },
  ];
  const postOne = await runRequest("post_compaction_first", runtime, systemPrompt, postMessages, tools);
  print(postOne);
  const postTwo = await runRequest(
    "post_compaction_second_append",
    runtime,
    systemPrompt,
    [...postMessages, postOne.message, {
      role: "user",
      content: "Continue from the unchanged compacted prefix. Reply exactly POST_TWO.",
      timestamp: 7,
    }],
    tools,
  );
  print(postTwo);

  const continued = await runRequest(
    "no_compaction_continuation",
    runtime,
    systemPrompt,
    [...historyMessages, {
      role: "user",
      content: "Continue without compaction. Reply exactly CONTINUED.",
      timestamp: 8,
    }],
    tools,
  );
  print(continued);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
