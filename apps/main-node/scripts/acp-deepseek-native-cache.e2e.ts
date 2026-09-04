import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerCoreHarnesses } from "@open-managed-agents/agent/harness/builtins";
import type {
  HarnessContext,
  HarnessRuntime,
} from "@open-managed-agents/agent/harness/interface";
import { resolveHarness } from "@open-managed-agents/agent/harness/registry";
import { LocalSubprocessSandbox } from "@open-managed-agents/sandbox/adapters/local-subprocess";
import type { SandboxPort } from "@open-managed-agents/sandbox";
import type {
  AgentConfig,
  SessionEvent,
  UserMessageEvent,
} from "@open-managed-agents/shared";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  throw new Error("DEEPSEEK_API_KEY is required (the script never reads or prints its value)");
}

const sessionId = `session_deepseek_cache_${Date.now().toString(36)}`;
const firstRoot = await mkdtemp(join(tmpdir(), "oma-dsh-cache-first-"));
const checkpointRoot = await mkdtemp(join(tmpdir(), "oma-dsh-cache-restored-"));
const restoredRoot = join(checkpointRoot, "workspace");
let firstSandbox: LocalSubprocessSandbox | undefined;
let restoredSandbox: LocalSubprocessSandbox | undefined;
let firstHarness: ReturnType<typeof resolveHarness> | undefined;
let restoredHarness: ReturnType<typeof resolveHarness> | undefined;

const events: SessionEvent[] = [];
const reportedUsage: Array<{ input: number; output: number }> = [];
const agent = {
  id: "agent_deepseek_native_cache_e2e",
  name: "DeepSeek native restore cache E2E",
  model: "deepseek-v4-flash",
  system: "Answer concisely. Do not use tools for this test.",
  tools: [],
  harness: "acp-sandbox",
  acp: {
    agent: {
      id: "dsh-acp",
      command: process.env.DSH_ACP_BIN ?? "dsh-acp",
      args: [
        "--provider", "deepseek-official",
        "--model", "deepseek-v4-flash",
        "--no-thinking",
        "--permission-mode", "read-only",
      ],
      env: { DEEPSEEK_API_KEY: apiKey },
      cwd: "/workspace",
    },
  },
  version: 1,
  created_at: new Date().toISOString(),
} as unknown as AgentConfig;

try {
  registerCoreHarnesses();
  firstSandbox = new LocalSubprocessSandbox({ workdir: firstRoot });
  const firstRuntime = createRuntime(firstSandbox, events, reportedUsage);
  firstHarness = resolveHarness("acp-sandbox");

  // A fresh nonce avoids accidentally measuring cache from an earlier run.
  // The repeated body is long enough to cross provider cache thresholds and
  // becomes the stable prefix reconstructed from DSH's native JSONL session.
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const stablePrefix = Array.from(
    { length: 1_600 },
    (_, index) => `cache-line-${index.toString().padStart(4, "0")}-${nonce}`,
  ).join("\n");
  await firstHarness.run(createContext(
    agent,
    firstRuntime,
    `${stablePrefix}\nReply with exactly: CACHE-PRIMED`,
    sessionId,
  ));

  const firstEnd = lastModelEnd(events);
  const firstUsage = requiredUsage(firstEnd);
  assertAssistantReply(events, "first DeepSeek turn");
  await firstHarness.dispose?.("shutdown");
  firstHarness = undefined;

  const nativeSessionRoot =
    `.openma/harness-state/acp/${sessionId}/dsh/v1/native/sessions`;
  const nativeFileCount = Number(await firstSandbox.exec(
    `find '${nativeSessionRoot}' -type f | wc -l`,
  ));
  if (!Number.isFinite(nativeFileCount) || nativeFileCount < 1) {
    const stateTree = await firstSandbox.exec("find .openma -maxdepth 10 -print");
    throw new Error(`DSH did not persist a native session artifact\n${stateTree}`);
  }

  await cp(firstRoot, restoredRoot, { recursive: true });
  await firstSandbox.destroy();
  firstSandbox = undefined;

  // Fresh sandbox + fresh harness ensures neither process memory nor the old
  // ACP connection can satisfy the second turn.
  restoredSandbox = new LocalSubprocessSandbox({ workdir: restoredRoot });
  const restoredRuntime = createRuntime(restoredSandbox, events, reportedUsage);
  restoredHarness = resolveHarness("acp-sandbox");
  await restoredHarness.run(createContext(
    agent,
    restoredRuntime,
    "Reply with exactly: CACHE-RESTORED",
    sessionId,
  ));

  const ends = events.filter(isModelEnd);
  if (ends.length !== 2) {
    throw new Error(`expected two model spans, received ${ends.length}`);
  }
  const secondEnd = ends[1]!;
  const secondUsage = requiredUsage(secondEnd);
  if (secondUsage.cache_read_input_tokens <= 0) {
    throw new Error(
      `native resume succeeded but DeepSeek reported no cache hit: ${JSON.stringify(secondUsage)}`,
    );
  }
  if (events.some((event) =>
    event.type === "session.warning"
    && (event as { source?: string }).source === "acp_semantic_recovery"
  )) {
    throw new Error("native session was not resumed; semantic recovery was used instead");
  }
  assertAssistantReply(events, "restored DeepSeek turn", 2);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    model: "deepseek-v4-flash",
    thinking: false,
    native_resume: true,
    native_session_files: nativeFileCount,
    first: firstUsage,
    restored: secondUsage,
    restored_cache_hit_ratio:
      secondUsage.cache_read_input_tokens
      / Math.max(1, secondUsage.input_tokens + secondUsage.cache_read_input_tokens),
    reported_usage_calls: reportedUsage.length,
  }, null, 2)}\n`);
} finally {
  await firstHarness?.dispose?.("destroy").catch(() => undefined);
  await restoredHarness?.dispose?.("destroy").catch(() => undefined);
  await firstSandbox?.destroy().catch(() => undefined);
  await restoredSandbox?.destroy().catch(() => undefined);
  await rm(firstRoot, { recursive: true, force: true });
  await rm(checkpointRoot, { recursive: true, force: true });
}

function createContext(
  configuredAgent: AgentConfig,
  runtime: HarnessRuntime,
  text: string,
  currentSessionId: string,
): HarnessContext {
  return {
    agent: configuredAgent,
    userMessage: {
      type: "user.message",
      content: [{ type: "text", text }],
    } as UserMessageEvent,
    session_id: currentSessionId,
    tools: {},
    model: {} as HarnessContext["model"],
    systemPrompt: configuredAgent.system,
    env: {},
    runtime,
  } as HarnessContext;
}

function createRuntime(
  sandbox: SandboxPort,
  target: SessionEvent[],
  usage: Array<{ input: number; output: number }>,
): HarnessRuntime {
  return {
    history: {
      getEvents: () => target,
      getMessages: () => [],
      append: (event: SessionEvent) => target.push(event),
    },
    sandbox,
    broadcast: (event: SessionEvent) => target.push(event),
    broadcastStreamStart: async () => {},
    broadcastChunk: async () => {},
    broadcastStreamEnd: async () => {},
    broadcastThinkingStart: async () => {},
    broadcastThinkingChunk: async () => {},
    broadcastThinkingEnd: async () => {},
    broadcastToolInputStart: async () => {},
    broadcastToolInputChunk: async () => {},
    broadcastToolInputEnd: async () => {},
    reportUsage: async (input, output) => { usage.push({ input, output }); },
    pendingConfirmations: [],
  } as HarnessRuntime;
}

type ModelEnd = Extract<SessionEvent, { type: "span.model_request_end" }>;
type ModelUsage = NonNullable<ModelEnd["model_usage"]> & {
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

function isModelEnd(event: SessionEvent): event is ModelEnd {
  return event.type === "span.model_request_end";
}

function lastModelEnd(target: SessionEvent[]): ModelEnd {
  const event = target.filter(isModelEnd).at(-1);
  if (!event) throw new Error("DeepSeek turn did not emit span.model_request_end");
  return event;
}

function requiredUsage(event: ModelEnd): ModelUsage {
  if (!event.model_usage) throw new Error("ACP PromptResponse did not include usage");
  return {
    input_tokens: event.model_usage.input_tokens,
    output_tokens: event.model_usage.output_tokens,
    cache_read_input_tokens: event.model_usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: event.model_usage.cache_creation_input_tokens ?? 0,
  };
}

function assertAssistantReply(
  target: SessionEvent[],
  label: string,
  expectedCount = 1,
): void {
  const count = target.filter((event) => event.type === "agent.message").length;
  if (count < expectedCount) throw new Error(`${label} produced no assistant message`);
}
