// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  CCStyleCompactionStrategy,
  OpenCodeStyleCompactionStrategy,
  SummarizeCompactionStrategy,
  resolveCompactionStrategy,
  stripImagesFromMessages,
} from "../../apps/agent/src/harness/compaction";
import type { SessionEvent } from "@open-managed-agents/shared";

// Mock ai-sdk's generateText so iterative-compaction tests can drive the
// strategy's full code path without hitting a real LLM. Spread original
// exports so tools(), z, etc. still work.
vi.mock("ai", async (importOriginal) => {
  const orig = await importOriginal<typeof import("ai")>();
  return {
    ...orig,
    generateText: vi.fn(),
  };
});

import { generateText } from "ai";

// ============================================================
// resolveCompactionStrategy — name → class registry
// ============================================================

describe("resolveCompactionStrategy", () => {
  it("returns SummarizeCompactionStrategy for undefined", () => {
    expect(resolveCompactionStrategy(undefined).name).toBe("summarize");
  });

  it("returns SummarizeCompactionStrategy for 'summarize'", () => {
    const s = resolveCompactionStrategy("summarize");
    expect(s).toBeInstanceOf(SummarizeCompactionStrategy);
    expect(s.name).toBe("summarize");
  });

  it("returns CCStyleCompactionStrategy for 'cc-style'", () => {
    const s = resolveCompactionStrategy("cc-style");
    expect(s).toBeInstanceOf(CCStyleCompactionStrategy);
    expect(s.name).toBe("cc-style");
  });

  it("returns OpenCodeStyleCompactionStrategy for 'opencode-style'", () => {
    const s = resolveCompactionStrategy("opencode-style");
    expect(s).toBeInstanceOf(OpenCodeStyleCompactionStrategy);
    expect(s.name).toBe("opencode-style");
  });

  it("falls back to summarize on unknown name (no throw)", () => {
    // Should warn but not throw — agent metadata is user-controlled and a
    // typo shouldn't crash the harness.
    const s = resolveCompactionStrategy("typo-style");
    expect(s).toBeInstanceOf(SummarizeCompactionStrategy);
  });

  it("propagates options to the resolved strategy", () => {
    // shouldCompact uses triggerFraction → cheapest way to verify the
    // option threaded through.
    const events: SessionEvent[] = Array.from({ length: 8 }, (_, i) =>
      i % 2 === 0
        ? { type: "user.message", content: [{ type: "text", text: "x".repeat(2000) }] }
        : { type: "agent.message", content: [{ type: "text", text: "y".repeat(2000) }] },
    );
    const tight = resolveCompactionStrategy("cc-style", { triggerFraction: 0.001 });
    const loose = resolveCompactionStrategy("cc-style", { triggerFraction: 0.99 });
    expect(tight.shouldCompact(events, { contextWindowTokens: 1_000_000 })).toBe(true);
    expect(loose.shouldCompact(events, { contextWindowTokens: 1_000_000 })).toBe(false);
  });
});

// ============================================================
// shouldCompact — trigger fraction threshold
// ============================================================
//
// All three strategies share the same shouldCompact logic. Verify each
// fires above its threshold and stays quiet below.

describe("shouldCompact (all strategies)", () => {
  // Build a conversation big enough that estimateMessagesTokens crosses
  // typical thresholds. ~50KB of text ≈ ~12K tokens at 4 chars/token.
  const bigEvents: SessionEvent[] = Array.from({ length: 12 }, (_, i) =>
    i % 2 === 0
      ? { type: "user.message", content: [{ type: "text", text: "x".repeat(4000) }] }
      : { type: "agent.message", content: [{ type: "text", text: "y".repeat(4000) }] },
  );

  for (const [name, Strategy] of [
    ["summarize", SummarizeCompactionStrategy],
    ["cc-style", CCStyleCompactionStrategy],
    ["opencode-style", OpenCodeStyleCompactionStrategy],
  ] as const) {
    it(`${name}: fires when estimated tokens exceed contextWindow * triggerFraction`, () => {
      const tight = new Strategy({ triggerFraction: 0.005 });
      expect(tight.shouldCompact(bigEvents, { contextWindowTokens: 1_000_000 })).toBe(true);
    });

    it(`${name}: stays quiet when below threshold`, () => {
      const loose = new Strategy({ triggerFraction: 0.99 });
      expect(loose.shouldCompact(bigEvents, { contextWindowTokens: 1_000_000 })).toBe(false);
    });
  }
});

// ============================================================
// compact() early-return: too few messages
// ============================================================
//
// All isolated strategies (cc-style, opencode-style) return null when
// the derived message list is shorter than 4. Below that threshold there's
// nothing meaningful to summarize and we'd just lose information. Verify
// without making any API calls.

describe("compact() — early return for short conversations", () => {
  const tinyEvents: SessionEvent[] = [
    { type: "user.message", content: [{ type: "text", text: "hi" }] },
    { type: "agent.message", content: [{ type: "text", text: "hello" }] },
  ];

  // Stub LanguageModel — never invoked because the early return triggers
  // before generateText is called. Cast to any to satisfy the type.
  const stubModel = { modelId: "stub" } as any;

  const stubArgs = {
    model: stubModel,
    contextWindowTokens: 1_000_000,
    systemPrompt: "stub-system",
    tools: {},
    applyCacheStrategy: (sys: string, tools: any, msgs: any[]) => ({
      system: sys,
      tools,
      messages: msgs,
    }),
  };

  it("CCStyleCompactionStrategy: returns null for < 4 messages", async () => {
    const s = new CCStyleCompactionStrategy();
    const result = await s.compact(tinyEvents, stubArgs);
    expect(result).toBeNull();
  });

  it("OpenCodeStyleCompactionStrategy: returns null for < 4 messages", async () => {
    const s = new OpenCodeStyleCompactionStrategy();
    const result = await s.compact(tinyEvents, stubArgs);
    expect(result).toBeNull();
  });
});

// ============================================================
// stripImagesFromMessages helper (via compact() integration)
// ============================================================
//
// stripImagesFromMessages is private to compaction.ts. Test it indirectly
// by having the strategy operate on events that contain images, then
// reading the messages it would emit via eventsToMessages and asserting
// the strip behavior on equivalent fixtures via the ToolResult roundtrip.
//
// Direct shape tests live in bijection-invariants.test.ts (image base64
// roundtrip). Here we focus on the strip semantics: image bytes go away
// AND get replaced by the placeholder text, AND the surrounding text
// blocks survive.

import { eventsToMessages } from "../../apps/agent/src/runtime/history";

describe("stripImagesFromMessages semantics (via eventsToMessages fixture)", () => {
  const PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";

  const events: SessionEvent[] = [
    { type: "user.message", content: [{ type: "text", text: "render it" }] },
    {
      type: "agent.tool_use",
      id: "tc_chart",
      name: "render_chart",
      input: { caption: "p99" },
    } as any,
    {
      type: "agent.tool_result",
      tool_use_id: "tc_chart",
      content: [
        { type: "text", text: "Chart caption: p99." },
        { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
      ],
    } as any,
  ];

  it("derived messages contain the raw image data BEFORE strip", () => {
    const messages = eventsToMessages(events);
    const tool = messages.find((m) => m.role === "tool")!;
    const trPart = (tool.content as any[])[0];
    const imageBlock = trPart.output.value.find((b: any) => b.type === "image-data");
    expect(imageBlock).toBeDefined();
    expect(imageBlock.data).toBe(PNG);
  });

  // The actual strip happens inside compact() before sending to generateText.
  // We can't easily snapshot that without mocking generateText, but we can
  // assert the helper's behavior via the resolver + a manual integration
  // probe: call compact on a tiny conversation, expect early-return (so no
  // model call is made even with images present).
  it("strategies don't crash on image-bearing fixtures (early return path)", async () => {
    const cc = new CCStyleCompactionStrategy();
    const oc = new OpenCodeStyleCompactionStrategy();
    const stubArgs = {
      model: { modelId: "stub" } as any,
      contextWindowTokens: 1_000_000,
      systemPrompt: "stub",
      tools: {},
      applyCacheStrategy: (sys: string, tools: any, msgs: any[]) => ({ system: sys, tools, messages: msgs }),
    };
    // 3 messages → below the 4-message threshold → early return null
    expect(await cc.compact(events, stubArgs)).toBeNull();
    expect(await oc.compact(events, stubArgs)).toBeNull();
  });
});

// ============================================================
// Strategy distinctness
// ============================================================
//
// The two new strategies are intentionally separate classes (not just
// different prompt strings) so future divergence is cheap. Pin that they
// are NOT the same class.

describe("strategy classes are distinct", () => {
  it("CCStyleCompactionStrategy and OpenCodeStyleCompactionStrategy are different classes", () => {
    const cc = new CCStyleCompactionStrategy();
    const oc = new OpenCodeStyleCompactionStrategy();
    expect(cc).not.toBeInstanceOf(OpenCodeStyleCompactionStrategy);
    expect(oc).not.toBeInstanceOf(CCStyleCompactionStrategy);
    expect(cc.name).not.toBe(oc.name);
  });

  it("neither extends SummarizeCompactionStrategy (they are not cache-prefix-sharing)", () => {
    const cc = new CCStyleCompactionStrategy();
    const oc = new OpenCodeStyleCompactionStrategy();
    expect(cc).not.toBeInstanceOf(SummarizeCompactionStrategy);
    expect(oc).not.toBeInstanceOf(SummarizeCompactionStrategy);
  });
});

// ============================================================
// Upstream empty-summary defense in DefaultHarness.compact()
// ============================================================
//
// The downstream layer (eventsToMessages skipping empty boundaries) has
// its own tests in bijection-invariants.test.ts. This file pins the
// upstream layer: even if a (legacy) strategy returns a result whose
// summary text is empty, DefaultHarness.compact must NOT broadcast a
// boundary event.
//
// We use a fake CompactionStrategy that returns a hand-crafted result
// instead of mocking generateText.

import { DefaultHarness } from "../../apps/agent/src/harness/default-loop";
import type { CompactionStrategy, CompactionResult } from "../../apps/agent/src/harness/compaction";
import type { HarnessRuntime } from "../../apps/agent/src/harness/interface";

class FakeStrategy implements CompactionStrategy {
  readonly name = "fake";
  constructor(private result: CompactionResult | null) {}
  shouldCompact() {
    return true;
  }
  async compact() {
    return this.result;
  }
}

function buildHarnessWithStrategy(strategy: CompactionStrategy): {
  harness: DefaultHarness;
  broadcasts: SessionEvent[];
} {
  const harness = new DefaultHarness();
  // Inject our fake strategy via the private field. compactionStrategy is
  // re-set inside run() based on agent.metadata, but compact() (the method
  // we're testing here) reads from the field directly.
  (harness as any).compactionStrategy = strategy;
  const broadcasts: SessionEvent[] = [];
  const runtime = {
    history: { append() {}, getEvents: () => [], getMessages: () => [] } as any,
    sandbox: {} as any,
    broadcast: (e: SessionEvent) => broadcasts.push(e),
    reportUsage: async () => {},
    pendingConfirmations: [],
  } as HarnessRuntime;
  return { harness, broadcasts, runtime } as any;
}

describe("DefaultHarness.compact() — empty-summary defense (upstream)", () => {
  const ctx = {
    model: { modelId: "stub" } as any,
    systemPrompt: "stub",
    tools: {},
  };

  it("does NOT broadcast boundary when strategy returns empty-text summary", async () => {
    const fake = new FakeStrategy({
      summary: [{ type: "text", text: "" }],
      pre_tokens: 1000,
      original_message_count: 10,
      compacted_message_count: 1,
    });
    const { harness, broadcasts, runtime } = buildHarnessWithStrategy(fake) as any;
    await harness.compact([], runtime, ctx);
    const boundaries = broadcasts.filter((e) => e.type === "agent.thread_context_compacted");
    expect(boundaries).toHaveLength(0);
  });

  it("does NOT broadcast boundary when summary is whitespace-only", async () => {
    const fake = new FakeStrategy({
      summary: [{ type: "text", text: "   \n\t  " }],
      pre_tokens: 1000,
      original_message_count: 10,
      compacted_message_count: 1,
    });
    const { harness, broadcasts, runtime } = buildHarnessWithStrategy(fake) as any;
    await harness.compact([], runtime, ctx);
    expect(broadcasts.filter((e) => e.type === "agent.thread_context_compacted")).toHaveLength(0);
  });

  it("DOES broadcast boundary when summary has real text", async () => {
    const fake = new FakeStrategy({
      summary: [{ type: "text", text: "real summary content" }],
      pre_tokens: 1000,
      original_message_count: 10,
      compacted_message_count: 1,
    });
    const { harness, broadcasts, runtime } = buildHarnessWithStrategy(fake) as any;
    await harness.compact([], runtime, ctx);
    const boundaries = broadcasts.filter((e) => e.type === "agent.thread_context_compacted");
    expect(boundaries).toHaveLength(1);
    expect((boundaries[0] as any).summary[0].text).toBe("real summary content");
  });

  it("does NOT broadcast when strategy returns null (e.g. too few messages)", async () => {
    const fake = new FakeStrategy(null);
    const { harness, broadcasts, runtime } = buildHarnessWithStrategy(fake) as any;
    await harness.compact([], runtime, ctx);
    expect(broadcasts).toHaveLength(0);
  });
});

// ============================================================
// Iterative compaction (with mocked generateText)
// ============================================================
//
// When events already contain a prior boundary with a real summary, the
// next compaction call should:
//   1. See that prior summary as the leading user message in its derived
//      messages (eventsToMessages handles this — it injects the
//      <conversation-summary> block).
//   2. Send those messages to the model alongside its own summarize prompt.
//   3. Produce a new summary that supersedes (or extends) the prior one.
//
// We verify (1) and (2) by inspecting the actual messages handed to
// generateText. (3) is purely up to the model and can't be tested without
// a real LLM, but the input shape being correct guarantees the prior-
// summary content is in the model's view.

describe("iterative compaction (mocked generateText)", () => {
  beforeEach(() => {
    (generateText as any).mockReset();
  });

  const eventsWithPriorBoundary: SessionEvent[] = [
    { type: "user.message", content: [{ type: "text", text: "early question" }] },
    { type: "agent.message", content: [{ type: "text", text: "early answer" }] },
    {
      type: "agent.thread_context_compacted",
      original_message_count: 2,
      compacted_message_count: 1,
      summary: [{ type: "text", text: "Earlier: user asked about X, agent did Y." }],
    } as any,
    { type: "user.message", content: [{ type: "text", text: "follow-up question" }] },
    { type: "agent.message", content: [{ type: "text", text: "follow-up answer" }] },
    { type: "user.message", content: [{ type: "text", text: "another question" }] },
    { type: "agent.message", content: [{ type: "text", text: "another answer" }] },
  ];

  const stubArgs = {
    model: { modelId: "stub" } as any,
    contextWindowTokens: 1_000_000,
    systemPrompt: "main-agent-system",
    tools: { bash: {} },
    applyCacheStrategy: (sys: string, tools: any, msgs: any[]) => ({ system: sys, tools, messages: msgs }),
  };

  for (const [name, Strategy] of [
    ["cc-style", CCStyleCompactionStrategy],
    ["opencode-style", OpenCodeStyleCompactionStrategy],
  ] as const) {
    it(`${name}: includes prior summary as leading user message in the summarize call`, async () => {
      (generateText as any).mockResolvedValue({
        text: "v2: covers earlier work + follow-up + another exchange.",
        usage: { inputTokens: 100, outputTokens: 50 },
        finishReason: "stop",
      });

      const s = new Strategy();
      const result = await s.compact(eventsWithPriorBoundary, stubArgs);

      // Strategy returned a non-null result with the new summary text.
      expect(result).not.toBeNull();
      expect(result!.summary[0].text).toContain("v2");

      // generateText was called once. Its messages payload starts with the
      // <conversation-summary> block (the prior summary, surfaced by
      // eventsToMessages as a synthesized user message).
      expect((generateText as any)).toHaveBeenCalledTimes(1);
      const call = (generateText as any).mock.calls[0][0];
      const firstMsg = call.messages[0];
      expect(firstMsg.role).toBe("user");
      const firstText = Array.isArray(firstMsg.content)
        ? firstMsg.content[0].text
        : firstMsg.content;
      expect(firstText).toContain("<conversation-summary>");
      expect(firstText).toContain("Earlier: user asked about X");

      // Last message is the strategy's own "please summarize" prompt.
      const lastMsg = call.messages[call.messages.length - 1];
      expect(lastMsg.role).toBe("user");
      const lastText = typeof lastMsg.content === "string"
        ? lastMsg.content
        : lastMsg.content[0].text;
      // CC style talks about "older conversation history"; OpenCode style
      // talks about "## Goal". Both are unambiguous summarize-ish prompts.
      expect(
        lastText.includes("summary") || lastText.includes("summarize") || lastText.includes("Goal"),
      ).toBe(true);
    });

    it(`${name}: returns null on empty model output (defense)`, async () => {
      (generateText as any).mockResolvedValue({
        text: "",
        usage: { inputTokens: 100, outputTokens: 0 },
        finishReason: "stop",
      });

      const s = new Strategy();
      const result = await s.compact(eventsWithPriorBoundary, stubArgs);
      expect(result).toBeNull();
    });

    it(`${name}: returns null on whitespace-only model output`, async () => {
      (generateText as any).mockResolvedValue({
        text: "   \n\t   ",
        usage: { inputTokens: 100, outputTokens: 5 },
        finishReason: "stop",
      });

      const s = new Strategy();
      const result = await s.compact(eventsWithPriorBoundary, stubArgs);
      expect(result).toBeNull();
    });

    it(`${name}: does NOT pass main agent's system prompt or tools`, async () => {
      (generateText as any).mockResolvedValue({
        text: "summary",
        usage: { inputTokens: 100, outputTokens: 5 },
        finishReason: "stop",
      });

      const s = new Strategy();
      await s.compact(eventsWithPriorBoundary, stubArgs);
      const call = (generateText as any).mock.calls[0][0];
      // The strategies use their own short system prompt, NOT the caller's.
      expect(call.system).not.toBe("main-agent-system");
      expect(typeof call.system).toBe("string");
      expect(call.system.length).toBeLessThan(1000);
      // No tools field passed → ai-sdk treats as undefined.
      expect(call.tools).toBeUndefined();
      // No toolChoice passed.
      expect(call.toolChoice).toBeUndefined();
    });
  }
});

// ============================================================
// stripImagesFromMessages — direct edge-case tests
// ============================================================
//
// Replaces every image / file content block with a short text placeholder,
// across all the shapes the codebase currently produces. Pure function;
// must not mutate input.

describe("stripImagesFromMessages", () => {
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";

  it("passes through messages with string content unchanged", () => {
    const input = [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi" },
    ];
    const result = stripImagesFromMessages(input);
    expect(result).toEqual(input);
  });

  it("passes through messages with no images unchanged", () => {
    const input = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "no images here" }],
      },
    ];
    const result = stripImagesFromMessages(input);
    // Same shape, same text.
    expect((result[0].content as any)[0].text).toBe("no images here");
  });

  it("strips top-level image part on user message", () => {
    const input = [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "look at this:" },
          { type: "image" as const, image: PNG, mediaType: "image/png" },
        ],
      },
    ];
    const result = stripImagesFromMessages(input);
    const parts = result[0].content as any[];
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "text", text: "look at this:" });
    expect(parts[1].type).toBe("text");
    expect(parts[1].text).toContain("image");
    expect(parts[1].text).not.toContain(PNG);
  });

  it("strips top-level file part (e.g. PDF) on user message", () => {
    const input = [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "see attached:" },
          { type: "file" as const, data: "BASE64DATA", mediaType: "application/pdf" },
        ],
      },
    ];
    const result = stripImagesFromMessages(input);
    const parts = result[0].content as any[];
    expect(parts[1].type).toBe("text");
    expect(parts[1].text).not.toContain("BASE64DATA");
  });

  it("strips image-data inside tool_result content", () => {
    const input = [
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: "tc1",
            toolName: "render_chart",
            output: {
              type: "content",
              value: [
                { type: "text", text: "Chart text:" },
                { type: "image-data", data: PNG, mediaType: "image/png" },
              ],
            },
          },
        ],
      },
    ];
    const result = stripImagesFromMessages(input);
    const trPart = (result[0].content as any[])[0];
    const innerParts = trPart.output.value;
    expect(innerParts).toHaveLength(2);
    expect(innerParts[0]).toEqual({ type: "text", text: "Chart text:" });
    expect(innerParts[1].type).toBe("text");
    expect(innerParts[1].text).not.toContain(PNG);
    // Surrounding tool-result envelope preserved
    expect(trPart.toolCallId).toBe("tc1");
    expect(trPart.toolName).toBe("render_chart");
    expect(trPart.output.type).toBe("content");
  });

  it("strips image-url, file-data, file-url inside tool_result content", () => {
    const input = [
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: "tc1",
            toolName: "fetch",
            output: {
              type: "content",
              value: [
                { type: "image-url", url: "https://example.com/x.png", mediaType: "image/png" },
                { type: "file-data", data: "PDFBYTES", mediaType: "application/pdf" },
                { type: "file-url", url: "https://example.com/x.pdf", mediaType: "application/pdf" },
              ],
            },
          },
        ],
      },
    ];
    const result = stripImagesFromMessages(input);
    const innerParts = (result[0].content as any[])[0].output.value;
    expect(innerParts).toHaveLength(3);
    for (const p of innerParts) {
      expect(p.type).toBe("text");
      expect(p.text).not.toContain("example.com");
      expect(p.text).not.toContain("PDFBYTES");
    }
  });

  it("does NOT touch tool_result with text-only output", () => {
    const input = [
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: "tc1",
            toolName: "bash",
            output: { type: "text", value: "command output" },
          },
        ],
      },
    ];
    const result = stripImagesFromMessages(input);
    expect(result[0]).toEqual(input[0]);
  });

  it("preserves system messages with string content", () => {
    const input = [
      { role: "system" as const, content: "you are helpful" },
      {
        role: "user" as const,
        content: [{ type: "image" as const, image: PNG, mediaType: "image/png" }],
      },
    ];
    const result = stripImagesFromMessages(input);
    expect(result[0]).toEqual({ role: "system", content: "you are helpful" });
    expect((result[1].content as any[])[0].type).toBe("text");
  });

  it("does not mutate input array or nested objects", () => {
    const original = [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "look:" },
          { type: "image" as const, image: PNG, mediaType: "image/png" },
        ],
      },
    ];
    const beforeJson = JSON.stringify(original);
    stripImagesFromMessages(original);
    expect(JSON.stringify(original)).toBe(beforeJson);
  });

  it("handles empty messages array", () => {
    expect(stripImagesFromMessages([])).toEqual([]);
  });

  it("handles message with empty content array", () => {
    const input = [{ role: "user" as const, content: [] }];
    const result = stripImagesFromMessages(input);
    expect((result[0].content as any[]).length).toBe(0);
  });
});
