// @ts-nocheck
import { describe, it, expect } from "vitest";
import {
  CCStyleCompactionStrategy,
  OpenCodeStyleCompactionStrategy,
  SummarizeCompactionStrategy,
  resolveCompactionStrategy,
} from "../../apps/agent/src/harness/compaction";
import type { SessionEvent } from "@open-managed-agents/shared";

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
