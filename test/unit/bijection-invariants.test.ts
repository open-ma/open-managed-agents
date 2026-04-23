// @ts-nocheck
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { eventsToMessages } from "../../apps/agent/src/runtime/history";
import type {
  SessionEvent,
  AgentToolUseEvent,
  AgentToolResultEvent,
} from "@open-managed-agents/shared";

// ============================================================
// Bijection / determinism — write/read invariants for prompt cache
// ============================================================
//
// These guard the contract default-loop.ts onStepFinish + history.ts
// eventsToMessages must satisfy: same input events → same output bytes,
// every turn, forever. Anthropic's prompt cache breaks the moment any
// prefix byte drifts — these tests catch the drift before deploy.

describe("eventsToMessages — bijection invariants", () => {
  // Mixed event stream covering namespaces that should drop vs keep
  const mixedEvents: SessionEvent[] = [
    { type: "user.message", content: [{ type: "text", text: "find todos" }] },
    // span / lifecycle events MUST be filtered out (not in model context)
    { type: "span.model_request_start", model: "claude-sonnet-4-6" } as any,
    { type: "lifecycle.status_running" } as any,
    {
      type: "agent.thinking",
      text: "let me grep first",
      providerOptions: { anthropic: { signature: "abc123" } },
    },
    { type: "agent.message", content: [{ type: "text", text: "I'll search." }] },
    {
      type: "agent.tool_use",
      id: "tc_grep",
      name: "grep",
      input: { pattern: "TODO" },
    } as AgentToolUseEvent,
    {
      type: "agent.tool_result",
      tool_use_id: "tc_grep",
      content: "found 3",
    } as AgentToolResultEvent,
    { type: "span.model_request_end", model: "claude-sonnet-4-6" } as any,
    { type: "agent.message", content: [{ type: "text", text: "Found 3." }] },
  ];

  it("byte-stable: two derive calls produce identical bytes", () => {
    const out1 = eventsToMessages(mixedEvents);
    const out2 = eventsToMessages(mixedEvents);
    // If JSON.stringify ordering is non-deterministic (Set iteration, key
    // reordering, Date.now() injection), this assert fails.
    expect(JSON.stringify(out1)).toBe(JSON.stringify(out2));
  });

  it("ignores lifecycle/span/notification events entirely", () => {
    const noNoise = mixedEvents.filter(
      (e) =>
        !e.type.startsWith("span.") &&
        !e.type.startsWith("lifecycle.") &&
        !e.type.startsWith("notification."),
    );
    // Adding noise (span/lifecycle) MUST NOT change the projected bytes.
    expect(JSON.stringify(eventsToMessages(mixedEvents))).toBe(
      JSON.stringify(eventsToMessages(noNoise)),
    );
  });

  it("preserves reasoning providerOptions verbatim (Anthropic signature)", () => {
    const sig = { anthropic: { signature: "sig_xyz", redactedData: "..." } };
    const events: SessionEvent[] = [
      { type: "user.message", content: [{ type: "text", text: "hi" }] },
      { type: "agent.thinking", text: "thought", providerOptions: sig },
      { type: "agent.message", content: [{ type: "text", text: "response" }] },
    ];
    const messages = eventsToMessages(events);
    const assistantContent = messages[1].content as any[];
    const reasoning = assistantContent.find((p) => p.type === "reasoning");
    expect(reasoning).toBeDefined();
    // Bytes of providerOptions MUST round-trip — Anthropic verifies the
    // signature on subsequent calls; any byte drift means signature reject.
    expect(reasoning.providerOptions).toEqual(sig);
  });

  it("resolves tool_use → tool_result names across flush boundaries", () => {
    // Scenario the OLD pendingToolCalls.find logic broke on: tool_use lives
    // in one flush window, tool_result lands after a separator. The new
    // pre-pass toolNameById map must still resolve.
    const events: SessionEvent[] = [
      { type: "user.message", content: [{ type: "text", text: "a" }] },
      {
        type: "agent.tool_use",
        id: "tc1",
        name: "bash",
        input: { cmd: "ls" },
      } as AgentToolUseEvent,
      // separator that flushed assistant before tool_result lands
      { type: "agent.message", content: [{ type: "text", text: "running" }] },
      {
        type: "agent.tool_result",
        tool_use_id: "tc1",
        content: "file1\nfile2",
      } as AgentToolResultEvent,
    ];
    const messages = eventsToMessages(events);
    const tool = messages.find((m) => m.role === "tool");
    expect(tool).toBeDefined();
    const trPart = (tool!.content as any[])[0];
    expect(trPart.toolName).toBe("bash"); // NOT "unknown"
  });

  it("tool_result content roundtrip: string survives", () => {
    const events: SessionEvent[] = [
      { type: "user.message", content: [{ type: "text", text: "a" }] },
      {
        type: "agent.tool_use",
        id: "tc1",
        name: "read",
        input: {},
      } as AgentToolUseEvent,
      {
        type: "agent.tool_result",
        tool_use_id: "tc1",
        content: "plain text result",
      } as AgentToolResultEvent,
    ];
    const tool = eventsToMessages(events).find((m) => m.role === "tool")!;
    const trPart = (tool.content as any[])[0];
    expect(trPart.output).toEqual({ type: "text", value: "plain text result" });
  });

  it("tool_result content roundtrip: ContentBlock[] survives", () => {
    const events: SessionEvent[] = [
      { type: "user.message", content: [{ type: "text", text: "a" }] },
      {
        type: "agent.tool_use",
        id: "tc1",
        name: "read",
        input: {},
      } as AgentToolUseEvent,
      {
        type: "agent.tool_result",
        tool_use_id: "tc1",
        content: [
          { type: "text", text: "hello" },
          {
            type: "image",
            source: { type: "base64", data: "AAA=", media_type: "image/png" },
          },
        ],
      } as AgentToolResultEvent,
    ];
    const tool = eventsToMessages(events).find((m) => m.role === "tool")!;
    const trPart = (tool.content as any[])[0];
    expect(trPart.output.type).toBe("content");
    expect(trPart.output.value[0]).toEqual({ type: "text", text: "hello" });
    expect(trPart.output.value[1].type).toBe("image-data");
    expect(trPart.output.value[1].mediaType).toBe("image/png");
  });

  it("MCP tool name reconstructs as mcp_<server>_call", () => {
    const events: SessionEvent[] = [
      { type: "user.message", content: [{ type: "text", text: "a" }] },
      {
        type: "agent.mcp_tool_use",
        id: "tc_mcp",
        mcp_server_name: "github",
        name: "mcp_github_call",
        input: { method: "list_issues" },
      } as any,
      {
        type: "agent.mcp_tool_result",
        mcp_tool_use_id: "tc_mcp",
        content: "ok",
      } as any,
    ];
    const messages = eventsToMessages(events);
    const assistant = messages.find((m) => m.role === "assistant")!;
    const callPart = (assistant.content as any[]).find((p) => p.type === "tool-call");
    expect(callPart.toolName).toBe("mcp_github_call");
    const tool = messages.find((m) => m.role === "tool")!;
    const trPart = (tool.content as any[])[0];
    expect(trPart.toolName).toBe("mcp_github_call");
  });
});

describe("eventsToMessages — context_boundary handling", () => {
  const summary = [
    { type: "text" as const, text: "Earlier the user asked X and we did Y." },
  ];
  const eventsBefore: SessionEvent[] = [
    { type: "user.message", content: [{ type: "text", text: "first question" }] },
    { type: "agent.message", content: [{ type: "text", text: "first answer" }] },
    { type: "user.message", content: [{ type: "text", text: "second question" }] },
    { type: "agent.message", content: [{ type: "text", text: "second answer" }] },
  ];

  it("boundary without summary is a no-op (UI signal only)", () => {
    const events: SessionEvent[] = [
      ...eventsBefore,
      {
        type: "agent.thread_context_compacted",
        original_message_count: 4,
        compacted_message_count: 4,
      } as any,
      { type: "user.message", content: [{ type: "text", text: "third" }] },
    ];
    const messages = eventsToMessages(events);
    // All 4 pre-boundary messages + 1 post-boundary user message survive
    expect(messages).toHaveLength(5);
  });

  it("boundary WITH summary injects summary and preserves a tail of pre-boundary messages", () => {
    const events: SessionEvent[] = [
      ...eventsBefore,
      {
        type: "agent.thread_context_compacted",
        original_message_count: 4,
        compacted_message_count: 2,
        summary,
      } as any,
      { type: "user.message", content: [{ type: "text", text: "third" }] },
      { type: "agent.message", content: [{ type: "text", text: "third answer" }] },
    ];
    const messages = eventsToMessages(events);
    // [synthesized summary user] + [tail of pre-boundary] + [user "third"] +
    // [assistant "third answer"]. Tail-preservation (CC-style) keeps the
    // last K messages of the pre-boundary range alongside the summary so the
    // model has recent context. With only 4 short pre-boundary messages, the
    // picker keeps all of them (minimums not met for trimming).
    expect(messages.length).toBeGreaterThanOrEqual(3);
    expect(messages[0].role).toBe("user");
    const sumContent = messages[0].content as any[];
    expect(sumContent[0].type).toBe("text");
    expect(sumContent[0].text).toContain("<conversation-summary>");
    expect(sumContent[0].text).toContain("Earlier the user asked X");
    // Last two messages are the post-boundary user "third" + agent reply.
    expect(messages[messages.length - 2].role).toBe("user");
    expect(messages[messages.length - 1].role).toBe("assistant");
  });

  it("only the LAST boundary with summary is honored (iterative compaction)", () => {
    const summary1 = [{ type: "text" as const, text: "summary v1" }];
    const summary2 = [
      { type: "text" as const, text: "summary v2 (supersedes v1)" },
    ];
    const events: SessionEvent[] = [
      { type: "user.message", content: [{ type: "text", text: "q1" }] },
      { type: "agent.message", content: [{ type: "text", text: "a1" }] },
      {
        type: "agent.thread_context_compacted",
        original_message_count: 2,
        compacted_message_count: 1,
        summary: summary1,
      } as any,
      { type: "user.message", content: [{ type: "text", text: "q2" }] },
      { type: "agent.message", content: [{ type: "text", text: "a2" }] },
      {
        type: "agent.thread_context_compacted",
        original_message_count: 4,
        compacted_message_count: 1,
        summary: summary2,
      } as any,
      { type: "user.message", content: [{ type: "text", text: "q3" }] },
    ];
    const messages = eventsToMessages(events);
    // First message is the v2 summary user message; v1 was superseded.
    // Tail preservation may include some pre-v2-boundary messages; the
    // post-boundary q3 is always at the end.
    expect(messages.length).toBeGreaterThanOrEqual(2);
    const sumText = (messages[0].content as any[])[0].text;
    expect(sumText).toContain("summary v2");
    expect(sumText).not.toContain("summary v1");
    expect(messages[messages.length - 1].role).toBe("user");
    expect((messages[messages.length - 1].content as any[])[0].text).toBe("q3");
  });

  it("boundary handling stays byte-stable", () => {
    const events: SessionEvent[] = [
      ...eventsBefore,
      {
        type: "agent.thread_context_compacted",
        original_message_count: 4,
        compacted_message_count: 1,
        summary,
      } as any,
      { type: "user.message", content: [{ type: "text", text: "next" }] },
    ];
    expect(JSON.stringify(eventsToMessages(events))).toBe(
      JSON.stringify(eventsToMessages(events)),
    );
  });
});

// ============================================================
// Empty-summary defense (downstream layer)
// ============================================================
//
// A boundary event with an array summary that contains only empty / whitespace
// text MUST be ignored. Otherwise a strategy that returned `[{type:"text", text:""}]`
// would silently drop the entire pre-boundary history.
//
// Symptom in the wild: MiniMax sometimes returns finish_reason="tool-calls"
// with empty text on summarize; SummarizeCompactionStrategy passes that
// through verbatim into the boundary event. This test pins down that
// eventsToMessages no longer trusts such boundaries.

describe("eventsToMessages — empty-summary defense", () => {
  const baseHistory: SessionEvent[] = [
    { type: "user.message", content: [{ type: "text", text: "q1" }] },
    { type: "agent.message", content: [{ type: "text", text: "a1" }] },
    { type: "user.message", content: [{ type: "text", text: "q2" }] },
    { type: "agent.message", content: [{ type: "text", text: "a2" }] },
  ];

  it("boundary with empty-text summary is ignored (history NOT dropped)", () => {
    const events: SessionEvent[] = [
      ...baseHistory,
      {
        type: "agent.thread_context_compacted",
        original_message_count: 4,
        compacted_message_count: 1,
        summary: [{ type: "text", text: "" }],
      } as any,
      { type: "user.message", content: [{ type: "text", text: "q3" }] },
    ];
    const messages = eventsToMessages(events);
    // Pre-boundary 4 messages + post-boundary q3 — boundary is treated as
    // a no-op because its summary text is empty.
    expect(messages).toHaveLength(5);
    expect(messages[0].role).toBe("user");
    expect((messages[0].content as any[])[0].text).toBe("q1");
    expect(messages[messages.length - 1].role).toBe("user");
    expect((messages[messages.length - 1].content as any[])[0].text).toBe("q3");
  });

  it("boundary with whitespace-only summary is ignored", () => {
    const events: SessionEvent[] = [
      ...baseHistory,
      {
        type: "agent.thread_context_compacted",
        original_message_count: 4,
        compacted_message_count: 1,
        summary: [{ type: "text", text: "   \n\t  " }],
      } as any,
      { type: "user.message", content: [{ type: "text", text: "q3" }] },
    ];
    const messages = eventsToMessages(events);
    expect(messages).toHaveLength(5);
  });

  it("boundary with image-only summary IS honored (multimodal escape)", () => {
    // Edge case: a strategy that produces a summary consisting only of an
    // image block (no text). Rare but legal — it counts as "carries content"
    // so the boundary takes effect.
    const events: SessionEvent[] = [
      ...baseHistory,
      {
        type: "agent.thread_context_compacted",
        original_message_count: 4,
        compacted_message_count: 1,
        summary: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AAA=" },
          },
        ],
      } as any,
      { type: "user.message", content: [{ type: "text", text: "q3" }] },
    ];
    const messages = eventsToMessages(events);
    // Honored: synthesized summary at index 0, post-boundary q3 at end.
    // Tail preservation may add some pre-boundary messages between them.
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages[0].role).toBe("user");
    expect((messages[0].content as any[])[0].text).toContain("[image elided]");
  });

  it("when latest boundary is empty but earlier boundary has real summary, fall through to earlier", () => {
    // Two boundaries; the most recent is empty (defense rejects it). The
    // earlier one has a real summary and should be the one honored.
    const events: SessionEvent[] = [
      { type: "user.message", content: [{ type: "text", text: "q1" }] },
      { type: "agent.message", content: [{ type: "text", text: "a1" }] },
      {
        type: "agent.thread_context_compacted",
        original_message_count: 2,
        compacted_message_count: 1,
        summary: [{ type: "text", text: "real summary v1" }],
      } as any,
      { type: "user.message", content: [{ type: "text", text: "q2" }] },
      { type: "agent.message", content: [{ type: "text", text: "a2" }] },
      {
        type: "agent.thread_context_compacted",
        original_message_count: 4,
        compacted_message_count: 1,
        summary: [{ type: "text", text: "" }], // empty — skipped
      } as any,
      { type: "user.message", content: [{ type: "text", text: "q3" }] },
    ];
    const messages = eventsToMessages(events);
    const sumText = (messages[0].content as any[])[0].text;
    expect(sumText).toContain("real summary v1");
  });
});


// ============================================================
// Sub-agent / thread-tagged events
// ============================================================
//
// SessionDO.runSubAgent broadcasts each sub-session event into the parent
// history with an extra `session_thread_id` field but the same `type`.
// These tests pin down whether the parent's eventsToMessages walks those
// tagged events or filters them — in either case, the contract MUST be
// byte-stable so the prompt cache survives.
//
// If the spec changes to filter tagged events, only the assertion changes;
// the byte-stability invariant stays.

describe("eventsToMessages — sub-agent thread tagging", () => {
  const buildParentWithSubThread = (): SessionEvent[] => [
    { type: "user.message", content: [{ type: "text", text: "delegate it" }] },
    {
      type: "agent.tool_use",
      id: "tc_call_agent",
      name: "call_agent_researcher",
      input: { message: "investigate X" },
    } as AgentToolUseEvent,
    // --- sub-session events tagged into the parent log ---
    {
      type: "session.thread_created",
      session_thread_id: "thread_1",
      agent_id: "researcher",
      agent_name: "researcher",
    } as any,
    {
      type: "agent.message",
      session_thread_id: "thread_1",
      content: [{ type: "text", text: "[sub] working" }],
    } as any,
    {
      type: "agent.tool_use",
      session_thread_id: "thread_1",
      id: "thread_1_grep",
      name: "grep",
      input: { pattern: "TODO" },
    } as any,
    {
      type: "agent.tool_result",
      session_thread_id: "thread_1",
      tool_use_id: "thread_1_grep",
      content: "matches: 80",
    } as any,
    {
      type: "agent.message",
      session_thread_id: "thread_1",
      content: [{ type: "text", text: "[sub] done" }],
    } as any,
    {
      type: "session.thread_idle",
      session_thread_id: "thread_1",
    } as any,
    // --- back to the parent: tool_result for the call_agent_* call ---
    {
      type: "agent.tool_result",
      tool_use_id: "tc_call_agent",
      content: "Researcher returned: 80 matches.",
    } as AgentToolResultEvent,
  ];

  it("byte-stable across repeated derives (with tagged events present)", () => {
    const events = buildParentWithSubThread();
    expect(JSON.stringify(eventsToMessages(events))).toBe(
      JSON.stringify(eventsToMessages(events)),
    );
  });

  it("documents current shape: tagged events flow through (every type is walked)", () => {
    // Pin the current behavior: tagged events are NOT filtered by type, so
    // sub-session agent.tool_use / agent.tool_result events appear in the
    // parent's projected messages alongside the parent's own tool round-trip.
    //
    // If a future change adds a "skip events with session_thread_id" branch
    // to eventsToMessages, this test should be flipped (or the polluting
    // events removed from the expected message stream). Either way it
    // serves as a pin-down for the chosen contract.
    const events = buildParentWithSubThread();
    const messages = eventsToMessages(events);

    // Find the assistant message holding the call_agent_* tool-call.
    const assistantWithCall = messages.find((m) =>
      m.role === "assistant" &&
      Array.isArray(m.content) &&
      (m.content as any[]).some(
        (p) => p.type === "tool-call" && p.toolName === "call_agent_researcher",
      ),
    );
    expect(assistantWithCall).toBeDefined();

    // Tagged sub-session tool_use is currently surfaced as a normal tool-call.
    const allToolCalls = messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => (Array.isArray(m.content) ? (m.content as any[]) : []))
      .filter((p) => p.type === "tool-call");
    const toolNames = allToolCalls.map((p) => p.toolName).sort();
    expect(toolNames).toContain("call_agent_researcher");
    // The sub-session's grep call is currently in there too — pin it down so
    // a regression that "accidentally fixes" this without updating tests
    // gets noticed and forces an explicit decision.
    expect(toolNames).toContain("grep");
  });

  it("tagged events do not duplicate parent's own tool_result", () => {
    // The parent's own agent.tool_result for tc_call_agent should still be
    // exactly one tool message, regardless of how many sub-session events
    // sit between the call and the result.
    const events = buildParentWithSubThread();
    const messages = eventsToMessages(events);
    const toolMsgs = messages.filter((m) => m.role === "tool");
    const callAgentResults = toolMsgs.flatMap((m) =>
      (m.content as any[]).filter(
        (p) => p.toolCallId === "tc_call_agent",
      ),
    );
    expect(callAgentResults).toHaveLength(1);
    expect(callAgentResults[0].toolName).toBe("call_agent_researcher");
  });
});

// ============================================================
// Multimodal — image bytes in tool_result content
// ============================================================
//
// Anthropic's prompt cache hashes the wire bytes of every block. For
// images that means the base64 payload must round-trip through
// normalizeToolOutputForWire (write side) ↔ wireContentToToolOutput
// (read side) without re-encoding, key reordering, or padding drift.
// These tests pin down byte-perfect equality for the image path that the
// multimodal probe exercises end-to-end.

describe("eventsToMessages — multimodal image roundtrip", () => {
  // 1×1 transparent PNG. Constant bytes — same fixture as the probe.
  const PNG_1X1_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";

  const buildEventsWithImage = (data: string = PNG_1X1_BASE64): SessionEvent[] => [
    { type: "user.message", content: [{ type: "text", text: "render it" }] },
    {
      type: "agent.tool_use",
      id: "tc_chart",
      name: "render_chart",
      input: { caption: "p99" },
    } as AgentToolUseEvent,
    {
      type: "agent.tool_result",
      tool_use_id: "tc_chart",
      content: [
        { type: "text", text: "Chart caption: p99." },
        { type: "image", source: { type: "base64", media_type: "image/png", data } },
      ],
    } as AgentToolResultEvent,
  ];

  it("base64 bytes survive verbatim through the wire shape", () => {
    const events = buildEventsWithImage();
    const messages = eventsToMessages(events);
    const tool = messages.find((m) => m.role === "tool")!;
    const trPart = (tool.content as any[])[0];
    expect(trPart.output.type).toBe("content");
    const parts = trPart.output.value as any[];
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "text", text: "Chart caption: p99." });
    expect(parts[1].type).toBe("image-data");
    expect(parts[1].mediaType).toBe("image/png");
    // Byte-perfect: any whitespace/padding drift here busts cache.
    expect(parts[1].data).toBe(PNG_1X1_BASE64);
    expect(parts[1].data.length).toBe(PNG_1X1_BASE64.length);
  });

  it("two derives produce identical bytes for image-bearing tool_results", () => {
    const events = buildEventsWithImage();
    expect(JSON.stringify(eventsToMessages(events))).toBe(
      JSON.stringify(eventsToMessages(events)),
    );
  });

  it("two distinct image payloads project to distinct bytes (no cross-contamination)", () => {
    const altPng =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAQAAcngHTwAAAAASUVORK5CYII=";
    const a = JSON.stringify(eventsToMessages(buildEventsWithImage(PNG_1X1_BASE64)));
    const b = JSON.stringify(eventsToMessages(buildEventsWithImage(altPng)));
    expect(a).not.toBe(b);
  });

  it("two image-bearing tool_results in sequence each preserve their own bytes", () => {
    const altPng =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAQAAcngHTwAAAAASUVORK5CYII=";
    const events: SessionEvent[] = [
      { type: "user.message", content: [{ type: "text", text: "render two" }] },
      {
        type: "agent.tool_use",
        id: "tc_chart_a",
        name: "render_chart",
        input: { caption: "a" },
      } as AgentToolUseEvent,
      {
        type: "agent.tool_result",
        tool_use_id: "tc_chart_a",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1X1_BASE64 } },
        ],
      } as AgentToolResultEvent,
      {
        type: "agent.tool_use",
        id: "tc_chart_b",
        name: "render_chart",
        input: { caption: "b" },
      } as AgentToolUseEvent,
      {
        type: "agent.tool_result",
        tool_use_id: "tc_chart_b",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: altPng } },
        ],
      } as AgentToolResultEvent,
    ];
    const messages = eventsToMessages(events);
    const toolMsgs = messages.filter((m) => m.role === "tool");
    const allImageBytes = toolMsgs
      .flatMap((m) => (m.content as any[]).flatMap((p) =>
        Array.isArray(p.output?.value) ? (p.output.value as any[]) : [],
      ))
      .filter((b) => b.type === "image-data")
      .map((b) => b.data);
    expect(allImageBytes).toEqual([PNG_1X1_BASE64, altPng]);
  });

  it("compaction summary elides images stably (no per-derive churn)", () => {
    // Boundary summary contains an image block; serializeSummaryAsText
    // collapses it to "[image elided]". Output bytes must be stable.
    const events: SessionEvent[] = [
      { type: "user.message", content: [{ type: "text", text: "q1" }] },
      { type: "agent.message", content: [{ type: "text", text: "a1" }] },
      {
        type: "agent.thread_context_compacted",
        original_message_count: 2,
        compacted_message_count: 1,
        summary: [
          { type: "text", text: "earlier we generated a chart" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1X1_BASE64 } },
        ],
      } as any,
      { type: "user.message", content: [{ type: "text", text: "q2" }] },
    ];
    const a = eventsToMessages(events);
    const b = eventsToMessages(events);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const summaryText = (a[0].content as any[])[0].text as string;
    expect(summaryText).toContain("<conversation-summary>");
    expect(summaryText).toContain("earlier we generated a chart");
    expect(summaryText).toContain("[image elided]");
    // Image base64 must NOT leak into the summary text — compaction's whole
    // point is shrinking the prefix, and serializing 50KB of base64 here
    // would defeat that.
    expect(summaryText).not.toContain(PNG_1X1_BASE64);
  });
});
