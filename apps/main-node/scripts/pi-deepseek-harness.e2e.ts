import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPiModelRuntime } from "@open-managed-agents/agent/harness/pi-provider";
import { PiHarness } from "@open-managed-agents/agent/harness/pi-loop";
import { buildTools } from "@open-managed-agents/agent/harness/tools";
import type { HarnessRuntime } from "@open-managed-agents/agent/harness/interface";
import { LocalSubprocessSandbox } from "@open-managed-agents/sandbox/adapters/local-subprocess";
import type { AgentConfig, SessionEvent, UserMessageEvent } from "@open-managed-agents/shared";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required (its value is never logged)");

const root = await mkdtemp(join(tmpdir(), "oma-pi-deepseek-harness-"));
const sandbox = new LocalSubprocessSandbox({ workdir: root });
const events: SessionEvent[] = [];
const reportedUsage: Array<{ input: number; output: number }> = [];
const markerPath = "/workspace/openma-pi-deepseek.txt";
const marker = `PI_HARNESS_OUT_OK_${Date.now().toString(36)}`;

try {
  const agent: AgentConfig = {
    id: "agent_pi_deepseek_live",
    name: "Pi DeepSeek live certification",
    model: "deepseek-v4-flash",
    system: [
      "You are certifying a coding-agent harness.",
      "You MUST invoke the write tool exactly once with the requested absolute path and content before replying.",
      "After the tool succeeds, reply exactly PI_HARNESS_OUT_OK.",
    ].join(" "),
    tools: [{
      type: "agent_toolset_20260401",
      default_config: { enabled: false },
      configs: [{ name: "write", enabled: true }],
    }],
    harness: "pi",
    version: 1,
    created_at: new Date().toISOString(),
  };
  const userMessage = {
    type: "user.message",
    content: [{
      type: "text",
      text: `Use write to create ${markerPath} with exact content ${marker}. Then reply exactly PI_HARNESS_OUT_OK.`,
    }],
  } as UserMessageEvent;
  events.push(userMessage);

  const pi = createPiModelRuntime({
    provider: "deepseek",
    model: "deepseek-v4-flash",
    apiKey,
    baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
  });
  const runtime = {
    history: {
      getEvents: () => events,
      getMessages: () => [],
      append: (event: SessionEvent) => events.push(event),
    },
    sandbox,
    broadcast: (event: SessionEvent) => events.push(event),
    broadcastStreamStart: async () => {},
    broadcastChunk: async () => {},
    broadcastStreamEnd: async () => {},
    broadcastThinkingStart: async () => {},
    broadcastThinkingChunk: async () => {},
    broadcastThinkingEnd: async () => {},
    broadcastToolInputStart: async () => {},
    broadcastToolInputChunk: async () => {},
    broadcastToolInputEnd: async () => {},
    reportUsage: async (input: number, output: number) => { reportedUsage.push({ input, output }); },
    pendingConfirmations: [],
  } as unknown as HarnessRuntime;

  const tools = await buildTools(agent, sandbox);
  await new PiHarness().run({
    agent,
    userMessage,
    session_id: `session_pi_deepseek_${Date.now().toString(36)}`,
    tools,
    model: {} as never,
    pi,
    systemPrompt: agent.system,
    env: {},
    runtime,
  });

  const actualMarker = await sandbox.readFile(markerPath);
  if (actualMarker !== marker) {
    throw new Error(`Pi write tool produced an unexpected marker: ${JSON.stringify(actualMarker)}`);
  }
  for (const requiredType of ["agent.tool_use", "agent.tool_result", "agent.message", "span.model_request_end"]) {
    if (!events.some((event) => event.type === requiredType)) {
      throw new Error(`Pi harness did not emit ${requiredType}`);
    }
  }
  const assistantText = events
    .filter((event) => event.type === "agent.message")
    .flatMap((event) => event.content)
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("\n");
  if (!assistantText.includes("PI_HARNESS_OUT_OK")) {
    throw new Error(`Pi harness final reply was unexpected: ${assistantText}`);
  }
  const modelEnds = events.filter((event) => event.type === "span.model_request_end");
  process.stdout.write(`${JSON.stringify({
    ok: true,
    mode: "harness-out-sandbox",
    model: pi.model.id,
    thinking: false,
    sandbox_tool_round_trip: true,
    event_types: [...new Set(events.map((event) => event.type))],
    model_requests: modelEnds.length,
    model_usage: modelEnds.map((event) => event.model_usage),
    reported_usage_calls: reportedUsage.length,
  }, null, 2)}\n`);
} finally {
  await sandbox.destroy().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
