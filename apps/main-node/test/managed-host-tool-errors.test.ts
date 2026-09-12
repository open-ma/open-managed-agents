import { jsonSchema, tool } from "ai";
import { describe, expect, it } from "vitest";
import type { HarnessContext } from "@open-managed-agents/agent/harness/interface";
import { ManagedNodeDefaultHarness } from "../src/lib/node-managed-default-harness";
import { ManagedNodeHarnessRuntime } from "../src/lib/node-managed-harness-runtime";
import { createNoEnvironmentSandbox } from "../src/openai-no-environment";
import { createProjectionState, applyManagedEvents } from "@open-managed-agents/openai-agents-compat";
import { createScriptedLanguageModel, finishChunk, streamStep, textChunks, toolCallChunks } from "../../../test/fakes/scripted-language-model";

describe("registered host tool failures", () => {
  it("persists a rejected subagent operation as failed rather than a successful coordination item", async () => {
    const model = createScriptedLanguageModel([
      streamStep([...toolCallChunks({ id: "call-interrupt", toolName: "interrupt_subagent", inputDeltas: ['{"id":"foreign-child"}'] }), finishChunk("tool-calls")]),
      streamStep([...textChunks("message-done", ["The child was not found."]), finishChunk("stop")]),
    ]);
    const input = { id: "input", type: "user.message" as const, content: [{ type: "text" as const, text: "Interrupt the child" }], processedAt: "2026-09-11T00:00:00Z" };
    let sequence = 0;
    const runtime = new ManagedNodeHarnessRuntime({ initialEvents: [], events: [input], sandbox: createNoEnvironmentSandbox(), output: async () => {}, clock: { now: () => new Date("2026-09-11T00:00:01Z") }, ids: { nextEventId: () => `event-${++sequence}` } });
    await new ManagedNodeDefaultHarness().run({
      agent: { id: "agent", model: { id: "test" }, tools: [] }, userMessage: { type: "user.message", content: input.content }, session_id: "session", model: model.model,
      tools: { interrupt_subagent: tool({ metadata: { openmaBuiltin: true }, inputSchema: jsonSchema<{ id: string }>({ type: "object", properties: { id: { type: "string" } }, required: ["id"] }), execute: async () => { throw new Error("Subagent foreign-child was not found under the current parent"); } }) },
      systemPrompt: "Use the provided tools", env: {}, runtime,
    } as unknown as HarnessContext);
    await runtime.drain();
    const events = runtime.getApplicationHistoryEvents();
    expect(events).toContainEqual(expect.objectContaining({ type: "agent.tool_result", toolUseId: "call-interrupt", isError: true }));
    const projected = applyManagedEvents(createProjectionState({ sessionId: "session", agentId: "agent", createdAt: 0 }), events, { observedAt: 1789084801 });
    expect(projected.state.items["call-interrupt"]).toMatchObject({ type: "interrupt_subagent_call", status: "failed", recipient_agent_id: "foreign-child" });
  });
});
