import { describe, expect, it, vi } from "vitest";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { z } from "zod";
import type { SessionEvent } from "@open-managed-agents/shared";
import type { HarnessContext, HarnessRuntime } from "../src/harness/interface";
import type { PiCompactionPolicy } from "../src/harness/pi-compaction";
import { PiHarness } from "../src/harness/pi-loop";

function makeContext(responses: ReturnType<typeof fauxAssistantMessage>[]) {
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);

  const events: SessionEvent[] = [
    { type: "user.message", content: [{ type: "text", text: "echo hello" }] },
  ];
  const streamCalls = {
    messageStarts: [] as string[],
    messageChunks: [] as Array<[string, string]>,
    messageEnds: [] as string[],
    thinkingStarts: [] as string[],
    thinkingEnds: [] as string[],
    toolStarts: [] as string[],
    toolEnds: [] as string[],
  };

  const runtime = {
    history: {
      getEvents: () => events,
      getMessages: () => [],
      append: (event: SessionEvent) => events.push(event),
    },
    sandbox: {},
    broadcast: (event: SessionEvent) => events.push(event),
    broadcastStreamStart: vi.fn(async (id: string) => void streamCalls.messageStarts.push(id)),
    broadcastChunk: vi.fn(async (id: string, delta: string) => void streamCalls.messageChunks.push([id, delta])),
    broadcastStreamEnd: vi.fn(async (id: string) => void streamCalls.messageEnds.push(id)),
    broadcastThinkingStart: vi.fn(async (id: string) => void streamCalls.thinkingStarts.push(id)),
    broadcastThinkingChunk: vi.fn(async () => undefined),
    broadcastThinkingEnd: vi.fn(async (id: string) => void streamCalls.thinkingEnds.push(id)),
    broadcastToolInputStart: vi.fn(async (id: string) => void streamCalls.toolStarts.push(id)),
    broadcastToolInputChunk: vi.fn(async () => undefined),
    broadcastToolInputEnd: vi.fn(async (id: string) => void streamCalls.toolEnds.push(id)),
    reportUsage: vi.fn(async () => undefined),
    pendingConfirmations: [],
  } as unknown as HarnessRuntime;

  const echo = vi.fn(async ({ value }: { value: string }) => ({ echoed: value }));
  const ctx = {
    agent: { id: "agent-test", model: faux.getModel().id },
    userMessage: events[0],
    session_id: "session-test",
    tools: {
      echo: {
        description: "Echo a value",
        inputSchema: z.object({ value: z.string() }),
        execute: echo,
      },
    },
    model: {} as HarnessContext["model"],
    pi: { models, model: faux.getModel() },
    systemPrompt: "You are concise.",
    env: { ANTHROPIC_API_KEY: "unused" },
    runtime,
  } as unknown as HarnessContext;

  return { ctx, events, streamCalls, echo, faux };
}

describe("PiHarness", () => {
  it("keeps thinking off by default even when the model supports reasoning", async () => {
    const { ctx, faux } = makeContext([]);
    ctx.pi!.model = { ...ctx.pi!.model, reasoning: true };
    let reasoning: unknown = "not-called";
    faux.setResponses([
      (_context, options) => {
        reasoning = options?.reasoning;
        return fauxAssistantMessage("thinking stayed off");
      },
    ]);

    await new PiHarness().run(ctx);

    // Pi encodes the portable "off" level by omitting provider reasoning.
    expect(reasoning).toBeUndefined();
  });

  it("projects an explicit Managed Agents effort into Pi's thinking level", async () => {
    const { ctx, faux } = makeContext([]);
    ctx.pi!.model = { ...ctx.pi!.model, reasoning: true };
    ctx.agent.model = { id: ctx.pi!.model.id, effort: "high" };
    let reasoning: unknown;
    faux.setResponses([
      (_context, options) => {
        reasoning = options?.reasoning;
        return fauxAssistantMessage("explicit effort applied");
      },
    ]);

    await new PiHarness().run(ctx);

    expect(reasoning).toBe("high");
  });

  it("runs an injected compaction policy and persists its canonical boundary before the turn", async () => {
    const { ctx, events, faux } = makeContext([fauxAssistantMessage("after compact")]);
    events.unshift(
      { type: "user.message", content: [{ type: "text", text: "older question" }] },
      { type: "agent.message", message_id: "older-answer", content: [{ type: "text", text: "older answer" }] },
      { type: "user.message", content: [{ type: "text", text: "follow-up" }] },
      { type: "agent.message", message_id: "follow-up-answer", content: [{ type: "text", text: "follow-up answer" }] },
    );

    const policy: PiCompactionPolicy = {
      name: "test-policy",
      shouldCompact: vi.fn(() => true),
      compact: vi.fn(async () => ({
        summary: [{ type: "text", text: "custom compacted summary" }],
        pre_tokens: 123,
        original_message_count: 5,
        compacted_message_count: 1,
      })),
    };
    let requestText = "";
    faux.setResponses([
      (context) => {
        requestText = JSON.stringify(context.messages);
        return fauxAssistantMessage("after compact");
      },
    ]);

    await new PiHarness({ compaction: policy }).run(ctx);

    expect(policy.shouldCompact).toHaveBeenCalledOnce();
    expect(policy.compact).toHaveBeenCalledOnce();
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent.thread_context_compacted",
      summary: [{ type: "text", text: "custom compacted summary" }],
      trigger: "auto",
      pre_tokens: 123,
    }));
    expect(requestText).toContain("<conversation-summary>");
    expect(requestText).toContain("custom compacted summary");
  });

  it("uses Pi itself for the built-in summary and keeps compaction best-effort", async () => {
    const { ctx, events, faux } = makeContext([]);
    events.unshift(
      { type: "user.message", content: [{ type: "text", text: "a".repeat(200) }] },
      { type: "agent.message", message_id: "a1", content: [{ type: "text", text: "b".repeat(200) }] },
      { type: "user.message", content: [{ type: "text", text: "c".repeat(200) }] },
      { type: "agent.message", message_id: "a2", content: [{ type: "text", text: "d".repeat(200) }] },
    );
    ctx.agent.metadata = { compaction_trigger_fraction: 0.01 };
    ctx.pi!.model = { ...ctx.pi!.model, contextWindow: 100 };

    let summaryTools: unknown;
    let summaryReasoning: unknown;
    let finalRequestText = "";
    faux.setResponses([
      (context, options) => {
        summaryTools = context.tools;
        summaryReasoning = options?.reasoning;
        return fauxAssistantMessage("built-in Pi summary");
      },
      (context) => {
        finalRequestText = JSON.stringify(context.messages);
        return fauxAssistantMessage("done after summary");
      },
    ]);

    await new PiHarness().run(ctx);

    expect(summaryTools).toEqual([]);
    expect(summaryReasoning).toBeUndefined();
    expect(finalRequestText).toContain("<conversation-summary>");
    expect(finalRequestText).toContain("built-in Pi summary");
    expect(events.filter((event) => event.type === "agent.thread_context_compacted")).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent.message",
      content: [{ type: "text", text: "done after summary" }],
    }));
  });

  it("continues the turn when a compaction policy fails", async () => {
    const { ctx, events } = makeContext([fauxAssistantMessage("still answered")]);
    const policy: PiCompactionPolicy = {
      name: "broken-policy",
      shouldCompact: () => true,
      compact: async () => {
        throw new Error("summarizer unavailable");
      },
    };

    await new PiHarness({ compaction: policy }).run(ctx);

    expect(events.some((event) => event.type === "agent.thread_context_compacted")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent.message",
      content: [{ type: "text", text: "still answered" }],
    }));
  });

  it("does one forced compact-and-retry when Pi classifies a context overflow", async () => {
    const { ctx, events, faux } = makeContext([]);
    events.unshift(
      { type: "user.message", content: [{ type: "text", text: "old question 1" }] },
      { type: "agent.message", message_id: "old-answer-1", content: [{ type: "text", text: "old answer 1" }] },
      { type: "user.message", content: [{ type: "text", text: "old question 2" }] },
      { type: "agent.message", message_id: "old-answer-2", content: [{ type: "text", text: "old answer 2" }] },
    );
    ctx.pi!.model = { ...ctx.pi!.model, contextWindow: 10_000 };
    faux.setResponses([
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "prompt is too long: 12000 tokens > 10000 maximum",
      }),
      fauxAssistantMessage("overflow recovery summary"),
      fauxAssistantMessage("recovered answer"),
    ]);

    await new PiHarness().run(ctx);

    expect(faux.state.callCount).toBe(3);
    expect(events.filter((event) => event.type === "agent.thread_context_compacted")).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent.message",
      content: [{ type: "text", text: "recovered answer" }],
    }));
  });

  it("drives Pi's tool loop and emits canonical OpenMA events", async () => {
    const first = fauxAssistantMessage(
      [
        fauxThinking("I should call echo"),
        fauxToolCall("echo", { value: "hello" }, { id: "tool-echo" }),
      ],
      { stopReason: "toolUse", responseId: "response-1" },
    );
    const second = fauxAssistantMessage("done", { responseId: "response-2" });
    const { ctx, events, streamCalls, echo } = makeContext([first, second]);

    await new PiHarness().run(ctx);

    expect(echo).toHaveBeenCalled();
    expect(echo.mock.calls[0]?.[0]).toEqual({ value: "hello" });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "span.model_request_start",
        "agent.thinking",
        "agent.tool_use",
        "agent.tool_result",
        "agent.message",
        "span.model_request_end",
      ]),
    );
    expect(events.filter((event) => event.type === "span.model_request_start")).toHaveLength(2);
    expect(events.find((event) => event.type === "agent.tool_use")).toMatchObject({
      id: "tool-echo",
      name: "echo",
      input: { value: "hello" },
    });
    expect(events.find((event) => event.type === "agent.tool_result")).toMatchObject({
      tool_use_id: "tool-echo",
      content: [{ type: "text", text: '{"echoed":"hello"}' }],
    });
    expect(events.find((event) => event.type === "agent.message")).toMatchObject({
      content: [{ type: "text", text: "done" }],
    });
    expect(streamCalls.messageStarts).toEqual(streamCalls.messageEnds);
    expect(streamCalls.thinkingStarts).toEqual(streamCalls.thinkingEnds);
    expect(streamCalls.toolStarts).toEqual(streamCalls.toolEnds);
  });

  it("projects canonical history back into Pi on the next turn", async () => {
    const { ctx, events, faux } = makeContext([
      fauxAssistantMessage("first answer"),
    ]);
    await new PiHarness().run(ctx);
    events.push({
      type: "user.message",
      content: [{ type: "text", text: "second question" }],
    });

    let roles: string[] = [];
    faux.setResponses([
      (context) => {
        roles = context.messages.map((message) => message.role);
        return fauxAssistantMessage("second answer");
      },
    ]);
    await new PiHarness().run(ctx);

    expect(roles).toEqual(["user", "assistant", "user"]);
    expect(
      events.filter((event) => event.type === "agent.message"),
    ).toHaveLength(2);
  });

  it("pauses non-executable tools for OpenMA confirmation", async () => {
    const call = fauxAssistantMessage(
      fauxToolCall("echo", { value: "confirm me" }, { id: "tool-confirm" }),
      { stopReason: "toolUse" },
    );
    const { ctx, events } = makeContext([call]);
    delete (ctx.tools.echo as { execute?: unknown }).execute;

    await new PiHarness().run(ctx);

    expect(ctx.runtime.pendingConfirmations).toEqual(["tool-confirm"]);
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent.tool_use",
      id: "tool-confirm",
    }));
    expect(events.some((event) => event.type === "agent.tool_result")).toBe(false);
  });
});
