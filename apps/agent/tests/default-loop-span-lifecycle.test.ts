import { describe, expect, it, vi } from "vitest";
import type { SessionEvent } from "@open-managed-agents/shared";
import type { HarnessContext, HarnessRuntime } from "../src/harness/interface";
import { DefaultHarness } from "../src/harness/default-loop";
import {
  createScriptedLanguageModel,
  streamStep,
} from "../../../test/fakes/scripted-language-model";

describe("DefaultHarness model span lifecycle", () => {
  it("closes a failed model call exactly once when AI SDK invokes error and step-finish callbacks", async () => {
    const scripted = createScriptedLanguageModel([
      streamStep(
        [{ type: "stream-start", warnings: [] }],
        { errorAfterChunks: 1, error: new Error("provider stream failed") },
      ),
    ]);
    const events: SessionEvent[] = [
      { type: "user.message", content: [{ type: "text", text: "hello" }] },
    ];
    const runtime = {
      history: {
        getEvents: () => events,
        getMessages: () => [],
        append: (event: SessionEvent) => events.push(event),
      },
      sandbox: {},
      broadcast: (event: SessionEvent) => events.push(event),
      broadcastStreamStart: vi.fn(async () => undefined),
      broadcastChunk: vi.fn(async () => undefined),
      broadcastStreamEnd: vi.fn(async () => undefined),
      broadcastThinkingStart: vi.fn(async () => undefined),
      broadcastThinkingChunk: vi.fn(async () => undefined),
      broadcastThinkingEnd: vi.fn(async () => undefined),
      broadcastToolInputStart: vi.fn(async () => undefined),
      broadcastToolInputChunk: vi.fn(async () => undefined),
      broadcastToolInputEnd: vi.fn(async () => undefined),
      reportUsage: vi.fn(async () => undefined),
      pendingConfirmations: [],
    } as unknown as HarnessRuntime;
    const context = {
      agent: {
        id: "agent-test",
        model: {
          id: scripted.model.modelId,
          provider_options: {
            pi: { reasoning: "off", sampling: { temperature: 0 } },
          },
        },
      },
      userMessage: events[0],
      session_id: "session-test",
      tools: {},
      model: scripted.model,
      systemPrompt: "Reply concisely.",
      env: { ANTHROPIC_API_KEY: "unused" },
      runtime,
    } as unknown as HarnessContext;

    await new DefaultHarness().run(context);

    const starts = events.filter(
      (event) => event.type === "span.model_request_start",
    );
    const ends = events.filter(
      (event) => event.type === "span.model_request_end",
    );
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({
      is_error: true,
      model_request_start_id: starts[0]?.id,
    });
    expect(scripted.calls[0]).toMatchObject({
      providerOptions: {
        pi: { reasoning: "off", sampling: { temperature: 0 } },
      },
    });
  });
});
