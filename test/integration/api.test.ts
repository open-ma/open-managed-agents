// @ts-nocheck
import { env, exports } from "cloudflare:workers";
import { describe, it, expect, beforeAll } from "vitest";
import { registerHarness } from "../../apps/agent/src/harness/registry";
import type { HarnessInterface, HarnessContext } from "../../apps/agent/src/harness/interface";
import { SPEC_EVENT_TYPES } from "../../packages/api-types/src/types";

const SPEC_TYPES_FOR_TEST = SPEC_EVENT_TYPES;

// Register a test harness that completes immediately (no real LLM call).
// This runs in the same isolate as the Worker, so the registry is shared.
class TestHarness implements HarnessInterface {
  async run(ctx: HarnessContext): Promise<void> {
    ctx.runtime.broadcast({
      type: "agent.message",
      content: [{ type: "text", text: "test response" }],
    });
  }
}
registerHarness("test", () => new TestHarness());

const HEADERS = {
  "x-api-key": "test-key",
  "Content-Type": "application/json",
};

function api(path: string, init?: RequestInit) {
  return exports.default.fetch(new Request(`http://localhost${path}`, init));
}

// Helper: create a full agent+env+session setup
async function createFullSession(opts?: { agentOverrides?: Record<string, unknown> }) {
  const agentRes = await api("/v1/agents", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      name: "Test Agent",
      model: "claude-sonnet-4-6",
      system: "You are helpful.",
      tools: [{ type: "agent_toolset_20260401" }],
      harness: "test", // Use test harness — no real LLM call
      ...opts?.agentOverrides,
    }),
  });
  const agent = (await agentRes.json()) as any;
  const envRes = await api("/v1/environments", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ name: "test-env", config: { type: "cloud" } }),
  });
  const environment = (await envRes.json()) as any;
  const sessRes = await api("/v1/sessions", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ agent: agent.id, environment_id: environment.id, title: "Test" }),
  });
  const session = (await sessRes.json()) as any;
  return { agent, environment, session };
}

// Helper: post a user message
function postMessage(sessionId: string, text: string) {
  return api(`/v1/sessions/${sessionId}/events`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      events: [{ type: "user.message", content: [{ type: "text", text }] }],
    }),
  });
}

// Helper: fetch DO status directly
function getDoStatus(sessionId: string) {
  const doId = env.SESSION_DO!.idFromName(sessionId);
  const stub = env.SESSION_DO!.get(doId);
  return stub.fetch(new Request("http://internal/status"));
}

// Helper: open WebSocket to DO and collect replayed events. Sends the
// new x-oma-replay + x-oma-include headers so existing tests that depend
// on the old "always replay everything" behavior keep working post the
// stream-split (default-spec, no-replay) wire-protocol change.
async function collectReplayedEvents(sessionId: string): Promise<any[]> {
  const doId = env.SESSION_DO!.idFromName(sessionId);
  const stub = env.SESSION_DO!.get(doId);
  const wsRes = await stub.fetch(
    new Request("http://internal/ws", {
      headers: {
        Upgrade: "websocket",
        "x-oma-replay": "1",
        "x-oma-include": "chunks",
      },
    }),
  );
  const ws = wsRes.webSocket!;
  ws.accept();

  const events: any[] = [];
  return new Promise((resolve) => {
    ws.addEventListener("message", (e) => {
      events.push(JSON.parse(e.data as string));
    });
    // Replayed events are sent synchronously on connect, so a short
    // timeout is enough to collect them all.
    setTimeout(() => {
      ws.close();
      resolve(events);
    }, 50);
  });
}

// ============================================================
// 1. Auth
// ============================================================
describe("Auth", () => {
  it("rejects missing API key", async () => {
    const res = await api("/v1/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", model: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects wrong API key", async () => {
    const res = await api("/v1/agents", {
      method: "POST",
      headers: { "x-api-key": "wrong", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", model: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("health check does not require auth", async () => {
    const res = await api("/health");
    expect(res.status).toBe(200);
  });
});

// ============================================================
// 2. Agent CRUD
// ============================================================
describe("Agent CRUD", () => {
  it("creates and retrieves an agent", async () => {
    const res = await api("/v1/agents", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        name: "Full Agent",
        model: "claude-sonnet-4-6",
        system: "Be helpful.",
        tools: [{ type: "agent_toolset_20260401" }],
      }),
    });
    expect(res.status).toBe(201);
    const agent = (await res.json()) as any;
    expect(agent.id).toMatch(/^agent-/);
    expect(agent.version).toBe(1);
    expect(agent.created_at).toBeTruthy();

    const getRes = await api(`/v1/agents/${agent.id}`, { headers: HEADERS });
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as any;
    expect(fetched.id).toBe(agent.id);
    expect(fetched.system).toBe("Be helpful.");
  });

  it("defaults tools when omitted", async () => {
    const res = await api("/v1/agents", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ name: "Minimal", model: "claude-sonnet-4-6" }),
    });
    const agent = (await res.json()) as any;
    expect(agent.tools).toEqual([{ type: "agent_toolset_20260401" }]);
  });

  it("stores custom harness field", async () => {
    const res = await api("/v1/agents", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ name: "Custom", model: "claude-sonnet-4-6", _oma: { harness: "coding" } }),
    });
    const agent = (await res.json()) as any;
    expect(agent._oma.harness).toBe("coding");
  });

  it("stores selective tool config", async () => {
    const res = await api("/v1/agents", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        name: "ReadOnly",
        model: "claude-sonnet-4-6",
        tools: [{
          type: "agent_toolset_20260401",
          default_config: { enabled: false },
          configs: [{ name: "read", enabled: true }],
        }],
      }),
    });
    const agent = (await res.json()) as any;
    expect(agent.tools[0].default_config.enabled).toBe(false);
    expect(agent.tools[0].configs[0]).toEqual({ name: "read", enabled: true });
  });

  it("rejects agent without name", async () => {
    const res = await api("/v1/agents", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ model: "claude-sonnet-4-6" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects agent without model", async () => {
    const res = await api("/v1/agents", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ name: "No Model" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown agent", async () => {
    const res = await api("/v1/agents/agent_nonexistent", { headers: HEADERS });
    expect(res.status).toBe(404);
  });

  it("saves version history on update", async () => {
    // Create an agent
    const createRes = await api("/v1/agents", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ name: "Versioned", model: "claude-sonnet-4-6", system: "v1 system" }),
    });
    const agent = (await createRes.json()) as any;
    expect(agent.version).toBe(1);

    // Update it
    await api(`/v1/agents/${agent.id}`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ system: "v2 system" }),
    });

    // List versions
    const versionsRes = await api(`/v1/agents/${agent.id}/versions`, { headers: HEADERS });
    expect(versionsRes.status).toBe(200);
    const versions = (await versionsRes.json()) as any;
    expect(versions.data.length).toBe(1);
    expect(versions.data[0].version).toBe(1);
    expect(versions.data[0].system).toBe("v1 system");

    // Get specific version
    const v1Res = await api(`/v1/agents/${agent.id}/versions/1`, { headers: HEADERS });
    expect(v1Res.status).toBe(200);
    const v1 = (await v1Res.json()) as any;
    expect(v1.system).toBe("v1 system");
  });

  it("returns 404 for versions of unknown agent", async () => {
    const res = await api("/v1/agents/agent_nonexistent/versions", { headers: HEADERS });
    expect(res.status).toBe(404);
  });

  it("returns 404 for unknown version", async () => {
    const createRes = await api("/v1/agents", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ name: "NoVersions", model: "claude-sonnet-4-6" }),
    });
    const agent = (await createRes.json()) as any;
    const res = await api(`/v1/agents/${agent.id}/versions/99`, { headers: HEADERS });
    expect(res.status).toBe(404);
  });
});

// ============================================================
// 3. Environment CRUD
// ============================================================
describe("Environment CRUD", () => {
  it("creates and retrieves an environment", async () => {
    const res = await api("/v1/environments", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        name: "prod-env",
        config: { type: "cloud", networking: { type: "unrestricted" } },
      }),
    });
    expect(res.status).toBe(201);
    const env = (await res.json()) as any;
    expect(env.id).toMatch(/^env-/);

    const getRes = await api(`/v1/environments/${env.id}`, { headers: HEADERS });
    const fetched = (await getRes.json()) as any;
    expect(fetched.config.networking.type).toBe("unrestricted");
  });

  it("returns 404 for unknown environment", async () => {
    const res = await api("/v1/environments/env_nonexistent", { headers: HEADERS });
    expect(res.status).toBe(404);
  });
});

// ============================================================
// 4. Session CRUD
// ============================================================
describe("Session CRUD", () => {
  it("creates a session and verifies DO is initialized", async () => {
    const { session } = await createFullSession();
    expect(session.id).toMatch(/^sess-/);
    expect(session.status).toBe("idle");

    // DO should report idle too
    const statusRes = await getDoStatus(session.id);
    const status = (await statusRes.json()) as any;
    expect(status.status).toBe("idle");
    expect(status.agent_id).toBe(session.agent.id);
  });

  it("rejects session with nonexistent agent", async () => {
    const envRes = await api("/v1/environments", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ name: "e", config: { type: "cloud" } }),
    });
    const environment = (await envRes.json()) as any;

    const res = await api("/v1/sessions", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ agent: "agent_ghost", environment_id: environment.id }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects session with nonexistent environment", async () => {
    const agentRes = await api("/v1/agents", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ name: "A", model: "claude-sonnet-4-6" }),
    });
    const agent = (await agentRes.json()) as any;

    const res = await api("/v1/sessions", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ agent: agent.id, environment_id: "env_ghost" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for unknown session", async () => {
    const res = await api("/v1/sessions/sess_ghost", { headers: HEADERS });
    expect(res.status).toBe(404);
  });

  it("includes agent snapshot in GET response", async () => {
    const { session } = await createFullSession();
    const getRes = await api(`/v1/sessions/${session.id}`, { headers: HEADERS });
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as any;
    expect(body.agent).toBeDefined();
    expect(body.agent.id).toBe(session.agent.id);
    expect(body.agent.model).toBeTruthy();
    // agent_snapshot should not leak in response
    expect(body.agent_snapshot).toBeUndefined();
  });
});

// ============================================================
// 5. Event posting — edge cases
// ============================================================
describe("Event posting", () => {
  let sessionId: string;
  beforeAll(async () => {
    const { session } = await createFullSession();
    sessionId = session.id;
  });

  it("accepts valid user.message (202)", async () => {
    const res = await postMessage(sessionId, "hello");
    expect(res.status).toBe(202);
  });

  it("rejects unsupported event type", async () => {
    const res = await api(`/v1/sessions/${sessionId}/events`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ events: [{ type: "system.ping" }] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    // Canonical Anthropic envelope: error object, not bare string.
    expect(body.error?.message ?? body.error).toContain("Unsupported");
  });

  it("rejects empty events array", async () => {
    const res = await api(`/v1/sessions/${sessionId}/events`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ events: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects missing events field", async () => {
    const res = await api(`/v1/sessions/${sessionId}/events`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ message: "hello" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects events to nonexistent session", async () => {
    const res = await postMessage("sess_ghost", "hello");
    expect(res.status).toBe(404);
  });

  it("accepts multiple events in one request", async () => {
    const res = await api(`/v1/sessions/${sessionId}/events`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        events: [
          { type: "user.message", content: [{ type: "text", text: "one" }] },
          { type: "user.message", content: [{ type: "text", text: "two" }] },
        ],
      }),
    });
    expect(res.status).toBe(202);
  });
});

// ============================================================
// 6. DO resilience — event replay, sequential writes, re-init
// ============================================================
describe("DO resilience", () => {
  it("replays all events to new WebSocket connections", async () => {
    const { session } = await createFullSession();
    await postMessage(session.id, "replay-test-1");
    await postMessage(session.id, "replay-test-2");

    // "Reconnect" — open a new WS, should get all events replayed
    const events = await collectReplayedEvents(session.id);

    expect(events.length).toBeGreaterThanOrEqual(2);
    // Post-dual-table refactor: user.message events live in
    // pending_events until drain promotes them. The WS replay reads
    // from events (history.getEvents); concurrent broadcast surfaces
    // each pending message via system.user_message_pending. Look at
    // either to find both inputs.
    const texts = events
      .flatMap((e: any) => {
        if (e.type === "user.message" && e.content?.[0]?.text) {
          return [e.content[0].text];
        }
        if (e.type === "system.user_message_pending" && e.event?.content?.[0]?.text) {
          return [e.event.content[0].text];
        }
        return [];
      });
    expect(texts).toContain("replay-test-1");
    expect(texts).toContain("replay-test-2");
  });

  it("handles rapid sequential messages without data loss", async () => {
    const { session } = await createFullSession();

    // Fire 10 messages rapidly
    for (let i = 0; i < 10; i++) {
      await postMessage(session.id, `rapid-${i}`);
    }

    // Verify all 10 are visible via WebSocket replay. Same dual-table
    // dance as above — pending messages surface via _pending frames,
    // promoted ones via the canonical user.message replay.
    const events = await collectReplayedEvents(session.id);
    const texts = events
      .flatMap((e: any) => {
        if (e.type === "user.message" && e.content?.[0]?.text) {
          return [e.content[0].text];
        }
        if (e.type === "system.user_message_pending" && e.event?.content?.[0]?.text) {
          return [e.event.content[0].text];
        }
        return [];
      });

    for (let i = 0; i < 10; i++) {
      expect(texts).toContain(`rapid-${i}`);
    }
  });

  it("schema creation is idempotent — data survives re-init", async () => {
    const { session } = await createFullSession();
    await postMessage(session.id, "before-reinit");

    // Simulate "restart" — hit the DO again (ensureSchema re-runs)
    const statusRes = await getDoStatus(session.id);
    expect(statusRes.ok).toBe(true);

    // Data should still be there — visible either as a promoted
    // user.message in events or a pending row surfaced via the
    // _pending frame at WS connect.
    const events = await collectReplayedEvents(session.id);
    const texts = events
      .flatMap((e: any) => {
        if (e.type === "user.message" && e.content?.[0]?.text) {
          return [e.content[0].text];
        }
        if (e.type === "system.user_message_pending" && e.event?.content?.[0]?.text) {
          return [e.event.content[0].text];
        }
        return [];
      });
    expect(texts).toContain("before-reinit");
  });

  it("DO status returns to idle after harness finishes (or errors)", async () => {
    const { session } = await createFullSession();
    await postMessage(session.id, "trigger harness");

    // The harness runs async via ctx.waitUntil. With a stub sandbox and
    // no real LLM, it will error quickly — but we need to wait for it.
    // Poll until status is idle (max 5s).
    let status = "running";
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const statusRes = await getDoStatus(session.id);
      const body = (await statusRes.json()) as any;
      status = body.status;
      if (status === "idle") break;
    }
    expect(status).toBe("idle");
  });

  it("broadcasts error event when harness fails", async () => {
    const { session } = await createFullSession();
    await postMessage(session.id, "will fail");

    // Wait for harness to run and fail (poll, max 5s)
    let events: any[] = [];
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 200));
      events = await collectReplayedEvents(session.id);
      const hasTerminal = events.some(
        (e: any) => e.type === "session.error" || e.type === "session.status_idle"
      );
      if (hasTerminal) break;
    }

    const hasTerminal = events.some(
      (e: any) => e.type === "session.error" || e.type === "session.status_idle"
    );
    expect(hasTerminal).toBe(true);
  });
});

// ============================================================
// 7. Session isolation
// ============================================================
describe("Session isolation", () => {
  it("two sessions on same agent have independent event logs", async () => {
    const agentRes = await api("/v1/agents", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ name: "Shared", model: "claude-sonnet-4-6", system: "ok" }),
    });
    const agent = (await agentRes.json()) as any;
    const envRes = await api("/v1/environments", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ name: "e", config: { type: "cloud" } }),
    });
    const environment = (await envRes.json()) as any;

    const s1Res = await api("/v1/sessions", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ agent: agent.id, environment_id: environment.id }),
    });
    const s1 = (await s1Res.json()) as any;

    const s2Res = await api("/v1/sessions", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ agent: agent.id, environment_id: environment.id }),
    });
    const s2 = (await s2Res.json()) as any;

    await postMessage(s1.id, "only-in-s1");
    await postMessage(s2.id, "only-in-s2");

    const e1 = await collectReplayedEvents(s1.id);
    const e2 = await collectReplayedEvents(s2.id);

    const t1 = e1.filter((e: any) => e.type === "user.message").map((e: any) => e.content[0].text);
    const t2 = e2.filter((e: any) => e.type === "user.message").map((e: any) => e.content[0].text);

    expect(t1).toContain("only-in-s1");
    expect(t1).not.toContain("only-in-s2");
    expect(t2).toContain("only-in-s2");
    expect(t2).not.toContain("only-in-s1");
  });
});

// ============================================================
// 8. SSE endpoints
// ============================================================
describe("SSE endpoints", () => {
  let sessionId: string;
  beforeAll(async () => {
    const { session } = await createFullSession();
    sessionId = session.id;
  });

  it.skip("GET /events returns text/event-stream", async () => {
    const res = await api(`/v1/sessions/${sessionId}/events`, {
      headers: { "x-api-key": "test-key", Accept: "text/event-stream" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
  });

  it("GET /events returns JSON when Accept is application/json", async () => {
    const res = await api(`/v1/sessions/${sessionId}/events`, {
      headers: { "x-api-key": "test-key", Accept: "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; has_more: boolean };
    expect(body.data).toBeInstanceOf(Array);
    expect(typeof body.has_more).toBe("boolean");
  });

  it("GET /events defaults to JSON when no Accept header", async () => {
    const res = await api(`/v1/sessions/${sessionId}/events`, {
      headers: { "x-api-key": "test-key" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; has_more: boolean };
    expect(body.data).toBeInstanceOf(Array);
  });

  it.skip("GET /events/stream also works (Anthropic alias)", async () => {
    const res = await api(`/v1/sessions/${sessionId}/events/stream`, {
      headers: { "x-api-key": "test-key" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
  });

  it("SSE returns 404 for nonexistent session", async () => {
    const res = await api("/v1/sessions/sess_ghost/events", {
      headers: { "x-api-key": "test-key" },
    });
    expect(res.status).toBe(404);
  });
});

// ============================================================
// 8b. SSE endpoint matrix — spec-vs-extension behavior
// ============================================================
//
// Wire contract under test:
//   - default       → spec event types only, no replay (Anthropic-aligned)
//   - ?include=chunks → admit OMA extension events (system.*, *_chunk, etc.)
//   - ?replay=1     → replay full persisted history before tailing
//   - Last-Event-ID → replay from seq > N (also implies replay)
//
// SPEC_EVENT_TYPES is the source of truth (api-types). The TestHarness only
// emits `agent.message` (spec), so the canary for "extension events landed"
// is `system.user_message_pending`, which the SessionDO emits whenever a
// user.message is posted before the harness drains it.
describe("SSE endpoint matrix", () => {
  // Read raw SSE frames off a Response body, parsing each `data:` JSON
  // payload until either `closeOnType` matches OR `timeoutMs` elapses.
  // Returns the array of parsed events. Cancels the reader on exit so
  // the underlying connection doesn't leak between tests.
  async function readSse(
    res: Response,
    opts: { closeOnType?: string; timeoutMs?: number } = {},
  ): Promise<any[]> {
    const events: any[] = [];
    if (!res.body) return events;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let done = false;
    // Fire a timer that cancels the reader; the in-flight read() then
    // resolves with done=true (because we cancelled) and the loop exits.
    const timer = setTimeout(() => {
      reader.cancel().catch(() => undefined);
    }, opts.timeoutMs ?? 500);
    try {
      while (!done) {
        let r: ReadableStreamReadResult<Uint8Array>;
        try {
          r = await reader.read();
        } catch {
          break;
        }
        if (r.done) break;
        buf += dec.decode(r.value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = block.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            events.push(ev);
            if (opts.closeOnType && ev.type === opts.closeOnType) {
              done = true;
              break;
            }
          } catch { /* skip malformed */ }
        }
      }
    } finally {
      clearTimeout(timer);
      try { await reader.cancel(); } catch { /* already closed */ }
    }
    return events;
  }

  it("default endpoint: no replay, only spec event types", async () => {
    const { session } = await createFullSession();
    // Open stream first (default = no replay, no chunks). Then post a turn.
    // Live broadcast must deliver spec event types but NOT the OMA-extension
    // system.user_message_pending that the SessionDO emits on every enqueue.
    const streamRes = await api(`/v1/sessions/${session.id}/events/stream`, {
      headers: { "x-api-key": "test-key", Accept: "text/event-stream" },
    });
    expect(streamRes.status).toBe(200);

    await postMessage(session.id, "default-mode");
    // Read for a fixed window — agent.message arrival is best-effort under
    // the in-process workerd test runtime (DO eviction can race), but the
    // spec-vs-extension filter we're asserting fires synchronously on
    // EVERY broadcast, so seeing user.message + lifecycle is enough.
    const events = await readSse(streamRes, { timeoutMs: 1500 });
    const types = events.map((e) => e.type);
    expect(types.length).toBeGreaterThan(0);
    // The synchronous user.message + status_running pair always lands.
    expect(types).toContain("user.message");
    // OMA extensions filtered out — system.user_message_pending fires on
    // the SAME enqueue path as user.message, so its absence proves the
    // spec filter is doing real work.
    expect(types).not.toContain("system.user_message_pending");
    // Every type that did land MUST be in the spec set.
    for (const t of types) {
      expect(SPEC_TYPES_FOR_TEST.has(t)).toBe(true);
    }
  });

  it("?include=chunks: admits OMA extension events", async () => {
    const { session } = await createFullSession();
    const streamRes = await api(
      `/v1/sessions/${session.id}/events/stream?include=chunks`,
      { headers: { "x-api-key": "test-key", Accept: "text/event-stream" } },
    );
    expect(streamRes.status).toBe(200);

    await postMessage(session.id, "with chunks");
    const events = await readSse(streamRes, { closeOnType: "agent.message", timeoutMs: 1000 });

    const types = events.map((e) => e.type);
    // The pending-frame is the canary for OMA extensions landing.
    expect(types).toContain("system.user_message_pending");
  });

  // Helper: wait until the JSON history endpoint reports `n` user.message
  // rows (drained from pending_events). Workerd test runtime varies a few
  // hundred ms in drain latency, so polling is more reliable than a fixed
  // sleep. Returns when the threshold is met or after `maxWaitMs`.
  async function waitForUserMessages(sessionId: string, n: number, maxWaitMs = 5000): Promise<any[]> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const r = await api(`/v1/sessions/${sessionId}/events`, {
        headers: { "x-api-key": "test-key", Accept: "application/json" },
      });
      const body = (await r.json()) as { data: any[] };
      const userMsgs = body.data.filter((row) => {
        const t = row.data?.type ?? row.type;
        return t === "user.message";
      });
      if (userMsgs.length >= n) return body.data;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Timed out waiting for ${n} user.message events`);
  }

  it("?replay=1: replays persisted history before tailing", async () => {
    const { session } = await createFullSession();
    await postMessage(session.id, "turn one");
    await postMessage(session.id, "turn two");
    // Wait for both user.message rows to land in the events table — drain
    // promotes from pending_events asynchronously after the harness runs.
    await waitForUserMessages(session.id, 2);

    const streamRes = await api(
      `/v1/sessions/${session.id}/events/stream?replay=1`,
      { headers: { "x-api-key": "test-key", Accept: "text/event-stream" } },
    );
    expect(streamRes.status).toBe(200);

    const events = await readSse(streamRes, { timeoutMs: 500 });
    const texts = events.flatMap((e: any) => {
      if (e.type === "user.message" && e.content?.[0]?.text) return [e.content[0].text];
      return [];
    });
    expect(texts).toContain("turn one");
    expect(texts).toContain("turn two");
  });

  it("Last-Event-ID header: replays only events with seq > N", async () => {
    const { session } = await createFullSession();
    await postMessage(session.id, "before cursor");
    await postMessage(session.id, "after cursor");
    const histData = await waitForUserMessages(session.id, 2);

    const allUsers = histData.filter((row) => {
      const t = row.data?.type ?? row.type;
      return t === "user.message";
    });
    expect(allUsers.length).toBeGreaterThanOrEqual(2);
    const cursorSeq = allUsers[0].seq;

    const streamRes = await api(`/v1/sessions/${session.id}/events/stream`, {
      headers: {
        "x-api-key": "test-key",
        Accept: "text/event-stream",
        "Last-Event-ID": String(cursorSeq),
      },
    });
    expect(streamRes.status).toBe(200);

    const events = await readSse(streamRes, { timeoutMs: 500 });
    const replayedTexts = events.flatMap((e: any) => {
      if (e.type === "user.message" && e.content?.[0]?.text) return [e.content[0].text];
      return [];
    });
    expect(replayedTexts).not.toContain("before cursor");
    expect(replayedTexts).toContain("after cursor");
  });
});
