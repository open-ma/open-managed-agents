// @ts-nocheck
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { env, exports } from "cloudflare:workers";
import { describe, it, expect, beforeAll } from "vitest";
import { registerHarness } from "../../apps/agent/src/harness/registry";
import type { HarnessInterface, HarnessContext } from "../../apps/agent/src/harness/interface";

// ---------- Test Harnesses ----------
registerHarness("multi-msg", () => ({
  async run(ctx) {
    ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "msg1" }] });
    ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "msg2" }] });
    ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "msg3" }] });
  },
}));

registerHarness("thinking-harness", () => ({
  async run(ctx) {
    ctx.runtime.broadcast({ type: "agent.thinking" });
    ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "after thinking" }] });
  },
}));

registerHarness("tool-harness", () => ({
  async run(ctx) {
    ctx.runtime.broadcast({ type: "agent.tool_use", id: "tc_1", name: "bash", input: { command: "ls" } });
    ctx.runtime.broadcast({ type: "agent.tool_result", tool_use_id: "tc_1", content: "exit=0\nfile1.txt" });
    ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "found files" }] });
  },
}));

registerHarness("delayed-harness", () => ({
  async run(ctx) {
    await new Promise((r) => setTimeout(r, 200));
    ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "delayed response" }] });
  },
}));

registerHarness("partial-crash", () => ({
  async run(ctx) {
    ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "before crash" }] });
    throw new Error("partial crash");
  },
}));

registerHarness("history-reader", () => ({
  async run(ctx) {
    const count = ctx.runtime.history.getMessages().length;
    ctx.runtime.broadcast({
      type: "agent.message",
      content: [{ type: "text", text: `msgs=${count}` }],
    });
  },
}));

registerHarness("config-reader", () => ({
  async run(ctx) {
    ctx.runtime.broadcast({
      type: "agent.message",
      content: [{ type: "text", text: `system=${ctx.agent.system || "none"}` }],
    });
  },
}));

registerHarness("usage-reporter", () => ({
  async run(ctx) {
    if (ctx.runtime.reportUsage) {
      await ctx.runtime.reportUsage(100, 50);
    }
    ctx.runtime.broadcast({
      type: "agent.message",
      content: [{ type: "text", text: "usage reported" }],
    });
  },
}));

registerHarness("sh-noop", () => ({ async run() {} }));

// ---------- Helpers ----------
const H = { "x-api-key": "test-key", "Content-Type": "application/json" };
function api(path: string, init?: RequestInit) {
  return exports.default.fetch(new Request(`http://localhost${path}`, init));
}
function post(path: string, body: any) {
  return api(path, { method: "POST", headers: H, body: JSON.stringify(body) });
}
function get(path: string, extraHeaders?: Record<string, string>) {
  return api(path, { headers: { ...H, ...extraHeaders } });
}
function put(path: string, body: any) {
  return api(path, { method: "PUT", headers: H, body: JSON.stringify(body) });
}
function del(path: string) {
  return api(path, { method: "DELETE", headers: H });
}

function getDoStatus(sessionId: string) {
  const doId = env.SESSION_DO!.idFromName(sessionId);
  const stub = env.SESSION_DO!.get(doId);
  return stub.fetch(new Request("http://internal/status"));
}

async function collectReplayedEvents(sessionId: string, waitMs = 100): Promise<any[]> {
  const doId = env.SESSION_DO!.idFromName(sessionId);
  const stub = env.SESSION_DO!.get(doId);
  const wsRes = await stub.fetch(
    new Request("http://internal/ws", { headers: { Upgrade: "websocket" } }),
  );
  const ws = wsRes.webSocket!;
  ws.accept();
  const events: any[] = [];
  return new Promise((resolve) => {
    ws.addEventListener("message", (e) => events.push(JSON.parse(e.data as string)));
    setTimeout(() => {
      ws.close();
      resolve(events);
    }, waitMs);
  });
}

async function createSessionWith(harnessName: string, extra?: Record<string, unknown>) {
  const a = await post("/v1/agents", {
    name: `H-${harnessName}-${Date.now()}`,
    model: "claude-sonnet-4-6",
    harness: harnessName,
    ...extra,
  });
  const e = await post("/v1/environments", {
    name: `env-${Date.now()}`,
    config: { type: "cloud" },
  });
  const s = await post("/v1/sessions", {
    agent: ((await a.json()) as any).id,
    environment_id: ((await e.json()) as any).id,
  });
  return ((await s.json()) as any).id;
}

async function postAndWait(sessionId: string, text: string, waitMs = 400) {
  await post(`/v1/sessions/${sessionId}/events`, {
    events: [{ type: "user.message", content: [{ type: "text", text }] }],
  });
  await new Promise((r) => setTimeout(r, waitMs));
}

async function waitForIdle(sessionId: string, maxWaitMs = 5000) {
  const polls = Math.ceil(maxWaitMs / 200);
  for (let i = 0; i < polls; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const statusRes = await getDoStatus(sessionId);
    const body = (await statusRes.json()) as any;
    if (body.status === "idle") return;
  }
}

// ============================================================
// Harness execution flow
// ============================================================
describe("Harness execution flow", () => {
  it("multi-message harness produces all 3 messages in replay", async () => {
    const sessionId = await createSessionWith("multi-msg");
    await postAndWait(sessionId, "go");
    await waitForIdle(sessionId);
    const events = await collectReplayedEvents(sessionId);
    const agentMsgs = events.filter((e) => e.type === "agent.message");
    expect(agentMsgs.length).toBe(3);
    expect(agentMsgs[0].content[0].text).toBe("msg1");
    expect(agentMsgs[1].content[0].text).toBe("msg2");
    expect(agentMsgs[2].content[0].text).toBe("msg3");
  });

  it("thinking harness emits thinking event + message in replay", async () => {
    const sessionId = await createSessionWith("thinking-harness");
    await postAndWait(sessionId, "think");
    await waitForIdle(sessionId);
    const events = await collectReplayedEvents(sessionId);
    const types = events.map((e) => e.type);
    expect(types).toContain("agent.thinking");
    expect(types).toContain("agent.message");
    const thinkIdx = types.indexOf("agent.thinking");
    const msgIdx = types.indexOf("agent.message");
    expect(thinkIdx).toBeLessThan(msgIdx);
  });

  it("tool harness emits tool_use, tool_result, message in correct order", async () => {
    const sessionId = await createSessionWith("tool-harness");
    await postAndWait(sessionId, "use tool");
    await waitForIdle(sessionId);
    const events = await collectReplayedEvents(sessionId);
    const types = events.map((e) => e.type);
    expect(types).toContain("agent.tool_use");
    expect(types).toContain("agent.tool_result");
    expect(types).toContain("agent.message");
    const tuIdx = types.indexOf("agent.tool_use");
    const trIdx = types.indexOf("agent.tool_result");
    const amIdx = types.lastIndexOf("agent.message");
    expect(tuIdx).toBeLessThan(trIdx);
    expect(trIdx).toBeLessThan(amIdx);
  });

  it("delayed harness completes and session returns to idle", async () => {
    const sessionId = await createSessionWith("delayed-harness");
    await postAndWait(sessionId, "wait", 500);
    await waitForIdle(sessionId);
    const statusRes = await getDoStatus(sessionId);
    const body = (await statusRes.json()) as any;
    expect(body.status).toBe("idle");
    const events = await collectReplayedEvents(sessionId);
    const agentMsg = events.find((e) => e.type === "agent.message");
    expect(agentMsg).toBeTruthy();
    expect(agentMsg.content[0].text).toBe("delayed response");
  });

  it("events broadcast sequentially have ordering preserved", async () => {
    const sessionId = await createSessionWith("multi-msg");
    await postAndWait(sessionId, "order test");
    await waitForIdle(sessionId);
    const events = await collectReplayedEvents(sessionId);
    const agentTexts = events
      .filter((e) => e.type === "agent.message")
      .map((e) => e.content[0].text);
    expect(agentTexts).toEqual(["msg1", "msg2", "msg3"]);
  });

  it("crash harness emits error event with message", async () => {
    registerHarness("crash-sh", () => ({
      async run() {
        throw new Error("sh crash");
      },
    }));
    const sessionId = await createSessionWith("crash-sh");
    await postAndWait(sessionId, "crash", 600);
    await waitForIdle(sessionId);
    const events = await collectReplayedEvents(sessionId);
    const errorEvent = events.find((e) => e.type === "session.error");
    expect(errorEvent).toBeTruthy();
    expect(errorEvent.error).toContain("sh crash");
  });

  it("partial crash harness emits message AND error event both in replay", async () => {
    const sessionId = await createSessionWith("partial-crash");
    await postAndWait(sessionId, "partial", 600);
    await waitForIdle(sessionId);
    const events = await collectReplayedEvents(sessionId);
    const agentMsg = events.find((e) => e.type === "agent.message");
    expect(agentMsg).toBeTruthy();
    expect(agentMsg.content[0].text).toBe("before crash");
    const errorEvent = events.find((e) => e.type === "session.error");
    expect(errorEvent).toBeTruthy();
    expect(errorEvent.error).toContain("partial crash");
  });

  it("session recovers after error and new message works", async () => {
    const sessionId = await createSessionWith("partial-crash");
    await postAndWait(sessionId, "crash first", 600);
    await waitForIdle(sessionId);

    // Verify idle state
    const statusRes = await getDoStatus(sessionId);
    const body = (await statusRes.json()) as any;
    expect(body.status).toBe("idle");

    // Post another event (session should accept it)
    const res = await post(`/v1/sessions/${sessionId}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "after crash" }] }],
    });
    expect(res.status).toBe(202);
  });

  it("multiple messages grow history (history-reader harness)", async () => {
    const sessionId = await createSessionWith("history-reader");
    await postAndWait(sessionId, "first", 600);
    await waitForIdle(sessionId);
    await postAndWait(sessionId, "second", 600);
    await waitForIdle(sessionId);
    const events = await collectReplayedEvents(sessionId);
    const counts = events
      .filter((e) => e.type === "agent.message")
      .map((e) => e.content[0].text)
      .filter((t: string) => t.startsWith("msgs="))
      .map((t: string) => parseInt(t.split("=")[1], 10));
    expect(counts.length).toBe(2);
    expect(counts[1]).toBeGreaterThan(counts[0]);
  });
});

// ============================================================
// Harness context access
// ============================================================
describe("Harness context access", () => {
  it("config-reader harness reads agent.system correctly", async () => {
    const sessionId = await createSessionWith("config-reader", { system: "my-custom-system" });
    await postAndWait(sessionId, "read config", 600);
    await waitForIdle(sessionId);
    const events = await collectReplayedEvents(sessionId);
    const msg = events.find((e) => e.type === "agent.message");
    expect(msg).toBeTruthy();
    expect(msg.content[0].text).toContain("system=my-custom-system");
  });

  it("history-reader first message sees count >= 1, second message sees higher count", async () => {
    const sessionId = await createSessionWith("history-reader");
    await postAndWait(sessionId, "first msg", 600);
    await waitForIdle(sessionId);
    await postAndWait(sessionId, "second msg", 600);
    await waitForIdle(sessionId);
    const events = await collectReplayedEvents(sessionId);
    const responses = events
      .filter((e) => e.type === "agent.message")
      .map((e) => e.content[0].text);
    const counts = responses
      .filter((t: string) => t.startsWith("msgs="))
      .map((t: string) => parseInt(t.split("=")[1], 10));
    expect(counts.length).toBe(2);
    expect(counts[0]).toBeGreaterThanOrEqual(1);
    expect(counts[1]).toBeGreaterThan(counts[0]);
  });

  it("two sessions with different harnesses have independent behavior", async () => {
    const sid1 = await createSessionWith("multi-msg");
    const sid2 = await createSessionWith("thinking-harness");
    await postAndWait(sid1, "go");
    await postAndWait(sid2, "go");
    await waitForIdle(sid1);
    await waitForIdle(sid2);
    const events1 = await collectReplayedEvents(sid1);
    const events2 = await collectReplayedEvents(sid2);
    const msgs1 = events1.filter((e) => e.type === "agent.message");
    const msgs2 = events2.filter((e) => e.type === "agent.message");
    expect(msgs1.length).toBe(3);
    expect(msgs2.length).toBe(1);
    expect(msgs2[0].content[0].text).toBe("after thinking");
  });

  it("harness receives userMessage content correctly", async () => {
    registerHarness("echo-user-input", () => ({
      async run(ctx) {
        const text = ctx.userMessage.content[0].text;
        ctx.runtime.broadcast({
          type: "agent.message",
          content: [{ type: "text", text: `echo: ${text}` }],
        });
      },
    }));
    const sessionId = await createSessionWith("echo-user-input");
    await postAndWait(sessionId, "hello world", 600);
    await waitForIdle(sessionId);
    const events = await collectReplayedEvents(sessionId);
    const reply = events.find(
      (e) => e.type === "agent.message" && e.content[0].text === "echo: hello world",
    );
    expect(reply).toBeTruthy();
  });
});

// ============================================================
// Status transitions
// ============================================================
describe("Status transitions", () => {
  it("normal flow: running and idle events present", async () => {
    const sessionId = await createSessionWith("multi-msg");
    await postAndWait(sessionId, "status test", 600);
    await waitForIdle(sessionId);
    const events = await collectReplayedEvents(sessionId);
    const types = events.map((e) => e.type);
    expect(types).toContain("session.status_running");
    expect(types).toContain("session.status_idle");
  });

  it("crash flow: running and error events present, status returns to idle", async () => {
    const sessionId = await createSessionWith("partial-crash");
    await postAndWait(sessionId, "crash", 600);
    await waitForIdle(sessionId);
    const events = await collectReplayedEvents(sessionId);
    const types = events.map((e) => e.type);
    expect(types).toContain("session.status_running");
    expect(types).toContain("session.error");
    // After crash, DO status returns to idle (but session.status_idle event
    // is only emitted after successful harness completion, not after crash)
    const statusRes = await getDoStatus(sessionId);
    const status = (await statusRes.json()) as any;
    expect(status.status).toBe("idle");
  });

  it("multiple messages each have running/idle pair", async () => {
    const sessionId = await createSessionWith("sh-noop");
    await postAndWait(sessionId, "msg1", 600);
    await waitForIdle(sessionId);
    await postAndWait(sessionId, "msg2", 600);
    await waitForIdle(sessionId);
    const events = await collectReplayedEvents(sessionId);
    const runningCount = events.filter((e) => e.type === "session.status_running").length;
    const idleCount = events.filter((e) => e.type === "session.status_idle").length;
    expect(runningCount).toBeGreaterThanOrEqual(2);
    expect(idleCount).toBeGreaterThanOrEqual(2);
  });

  it("DO /status returns idle after processing", async () => {
    const sessionId = await createSessionWith("multi-msg");
    await postAndWait(sessionId, "check status", 600);
    await waitForIdle(sessionId);
    const res = await getDoStatus(sessionId);
    const body = (await res.json()) as any;
    expect(body.status).toBe("idle");
  });

  it("status includes agent_id from init", async () => {
    const a = await post("/v1/agents", { name: "StatusAgent", model: "claude-sonnet-4-6", harness: "sh-noop" });
    const agent = (await a.json()) as any;
    const e = await post("/v1/environments", { name: `status-env-${Date.now()}`, config: { type: "cloud" } });
    const envObj = (await e.json()) as any;
    const s = await post("/v1/sessions", { agent: agent.id, environment_id: envObj.id });
    const session = (await s.json()) as any;
    const res = await getDoStatus(session.id);
    const body = (await res.json()) as any;
    expect(body.agent_id).toBe(agent.id);
  });
});

// ============================================================
// Token usage tracking
// ============================================================
describe("Token usage tracking", () => {
  it("usage-reporter harness reports usage visible in /status", async () => {
    const sessionId = await createSessionWith("usage-reporter");
    await postAndWait(sessionId, "report usage", 600);
    await waitForIdle(sessionId);
    const res = await getDoStatus(sessionId);
    const body = (await res.json()) as any;
    expect(body.usage).toBeDefined();
    expect(body.usage.input_tokens).toBeGreaterThanOrEqual(100);
    expect(body.usage.output_tokens).toBeGreaterThanOrEqual(50);
  });

  it("multiple messages with usage accumulates", async () => {
    const sessionId = await createSessionWith("usage-reporter");
    await postAndWait(sessionId, "report 1", 600);
    await waitForIdle(sessionId);
    await postAndWait(sessionId, "report 2", 600);
    await waitForIdle(sessionId);
    const res = await getDoStatus(sessionId);
    const body = (await res.json()) as any;
    expect(body.usage.input_tokens).toBeGreaterThanOrEqual(200);
    expect(body.usage.output_tokens).toBeGreaterThanOrEqual(100);
  });

  it("fresh session starts with zero usage", async () => {
    const sessionId = await createSessionWith("sh-noop");
    const res = await getDoStatus(sessionId);
    const body = (await res.json()) as any;
    expect(body.usage.input_tokens).toBe(0);
    expect(body.usage.output_tokens).toBe(0);
  });

  it("/status usage structure has input_tokens and output_tokens", async () => {
    const sessionId = await createSessionWith("sh-noop");
    const res = await getDoStatus(sessionId);
    const body = (await res.json()) as any;
    expect(typeof body.usage.input_tokens).toBe("number");
    expect(typeof body.usage.output_tokens).toBe("number");
  });
});

// ============================================================
// WebSocket behavior
// ============================================================
describe("WebSocket behavior", () => {
  it("new WebSocket gets full event replay", async () => {
    const sessionId = await createSessionWith("multi-msg");
    await postAndWait(sessionId, "ws test", 600);
    await waitForIdle(sessionId);
    // Open a new WS connection that should replay all events
    const events = await collectReplayedEvents(sessionId);
    expect(events.length).toBeGreaterThanOrEqual(3); // user.message + 3 agent.messages minimum
  });

  it("two WebSocket clients both receive replayed events", async () => {
    const sessionId = await createSessionWith("multi-msg");
    await postAndWait(sessionId, "dual ws", 600);
    await waitForIdle(sessionId);

    // Both should get events via independent replay connections
    const events1 = await collectReplayedEvents(sessionId, 200);
    const events2 = await collectReplayedEvents(sessionId, 200);

    expect(events1.length).toBeGreaterThan(0);
    expect(events2.length).toBeGreaterThan(0);
    // Both get the same replayed events
    expect(events1.length).toBe(events2.length);
  });

  it("WebSocket replay includes status events", async () => {
    const sessionId = await createSessionWith("sh-noop");
    await postAndWait(sessionId, "status ws", 600);
    await waitForIdle(sessionId);
    const events = await collectReplayedEvents(sessionId);
    const types = events.map((e) => e.type);
    expect(types).toContain("session.status_running");
    expect(types).toContain("session.status_idle");
  });
});

// ============================================================
// Additional harness integration tests
// ============================================================
describe("Harness integration — additional scenarios", () => {
  it("tool harness tool_use event has correct fields", async () => {
    const sessionId = await createSessionWith("tool-harness");
    await postAndWait(sessionId, "check fields", 600);
    await waitForIdle(sessionId);
    const events = await collectReplayedEvents(sessionId);
    const toolUse = events.find((e) => e.type === "agent.tool_use");
    expect(toolUse).toBeTruthy();
    expect(toolUse.id).toBe("tc_1");
    expect(toolUse.name).toBe("bash");
    expect(toolUse.input).toEqual({ command: "ls" });
  });

  it("tool harness tool_result event has correct fields", async () => {
    const sessionId = await createSessionWith("tool-harness");
    await postAndWait(sessionId, "check result", 600);
    await waitForIdle(sessionId);
    const events = await collectReplayedEvents(sessionId);
    const toolResult = events.find((e) => e.type === "agent.tool_result");
    expect(toolResult).toBeTruthy();
    expect(toolResult.tool_use_id).toBe("tc_1");
    expect(toolResult.content).toContain("file1.txt");
  });

  it("noop harness produces only status events (no agent messages)", async () => {
    const sessionId = await createSessionWith("sh-noop");
    await postAndWait(sessionId, "noop", 600);
    await waitForIdle(sessionId);
    const events = await collectReplayedEvents(sessionId);
    const agentMsgs = events.filter((e) => e.type === "agent.message");
    expect(agentMsgs.length).toBe(0);
    const types = events.map((e) => e.type);
    expect(types).toContain("user.message");
    expect(types).toContain("session.status_running");
  });

  it("session with echo harness returns expected text", async () => {
    registerHarness("exact-echo-sh", () => ({
      async run(ctx) {
        const text = ctx.userMessage.content[0]?.text || "";
        ctx.runtime.broadcast({
          type: "agent.message",
          content: [{ type: "text", text: `echo: ${text}` }],
        });
      },
    }));
    const sessionId = await createSessionWith("exact-echo-sh");
    await postAndWait(sessionId, "hello world", 600);
    await waitForIdle(sessionId);
    const events = await collectReplayedEvents(sessionId);
    const agentMsg = events.find((e) => e.type === "agent.message");
    expect(agentMsg).toBeTruthy();
    expect(agentMsg.content[0].text).toBe("echo: hello world");
  });

  it("harness can access userMessage content blocks count", async () => {
    registerHarness("content-reader-sh", () => ({
      async run(ctx) {
        const blocks = ctx.userMessage.content.length;
        ctx.runtime.broadcast({
          type: "agent.message",
          content: [{ type: "text", text: `blocks=${blocks}` }],
        });
      },
    }));
    const sessionId = await createSessionWith("content-reader-sh");
    await post(`/v1/sessions/${sessionId}/events`, {
      events: [{ type: "user.message", content: [
        { type: "text", text: "b1" },
        { type: "text", text: "b2" },
      ] }],
    });
    await new Promise(r => setTimeout(r, 600));
    await waitForIdle(sessionId);
    const events = await collectReplayedEvents(sessionId);
    const msg = events.find((e) => e.type === "agent.message");
    expect(msg).toBeTruthy();
    expect(msg.content[0].text).toBe("blocks=2");
  });

  it("session title is preserved through harness execution", async () => {
    const a = await post("/v1/agents", { name: "TitleKeep", model: "claude-sonnet-4-6", harness: "sh-noop" });
    const e = await post("/v1/environments", { name: "titlekeep-env", config: { type: "cloud" } });
    const s = await post("/v1/sessions", {
      agent: ((await a.json()) as any).id,
      environment_id: ((await e.json()) as any).id,
      title: "My Important Session",
    });
    const session = (await s.json()) as any;
    await postAndWait(session.id, "keep title", 600);

    const getRes = await get(`/v1/sessions/${session.id}`);
    const fetched = (await getRes.json()) as any;
    expect(fetched.title).toBe("My Important Session");
  });

  it("session events GET returns correct content-type for JSON", async () => {
    const sessionId = await createSessionWith("sh-noop");
    await postAndWait(sessionId, "content type", 600);
    const res = await get(`/v1/sessions/${sessionId}/events`, { Accept: "application/json" });
    expect(res.status).toBe(200);
    const ct = res.headers.get("Content-Type");
    expect(ct).toContain("application/json");
    const body = (await res.json()) as any;
    expect(body.data).toBeInstanceOf(Array);
  });

  it("session events GET returns SSE for text/event-stream", async () => {
    const sessionId = await createSessionWith("sh-noop");
    await postAndWait(sessionId, "sse test", 600);
    const res = await get(`/v1/sessions/${sessionId}/events`, { Accept: "text/event-stream" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
  });
});
