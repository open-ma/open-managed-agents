import { env, exports } from "cloudflare:workers";
import { describe, it, expect, beforeAll } from "vitest";
import { registerHarness } from "../../src/harness/registry";
import type { HarnessInterface, HarnessContext } from "../../src/harness/interface";

const H = { "x-api-key": "test-key", "Content-Type": "application/json" };
function api(path: string, init?: RequestInit) {
  return exports.default.fetch(new Request(`http://localhost${path}`, init));
}
function post(path: string, body: any) {
  return api(path, { method: "POST", headers: H, body: JSON.stringify(body) });
}
function put(path: string, body: any) {
  return api(path, { method: "PUT", headers: H, body: JSON.stringify(body) });
}
function del(path: string) {
  return api(path, { method: "DELETE", headers: H });
}
function get(path: string, extraHeaders?: Record<string, string>) {
  return api(path, { headers: { ...H, ...extraHeaders } });
}

// Register test harness
registerHarness("noop-test", () => ({ async run() {} }));
registerHarness("echo-test", () => ({
  async run(ctx: HarnessContext) {
    ctx.runtime.broadcast({
      type: "agent.message",
      content: [{ type: "text", text: "echo reply" }],
    });
  },
}));

// ============================================================
// Agent Update
// ============================================================
describe("Agent update (PUT)", () => {
  let agentId: string;

  beforeAll(async () => {
    const res = await post("/v1/agents", {
      name: "Updatable",
      model: "claude-sonnet-4-6",
      system: "original system",
      harness: "noop-test",
    });
    agentId = ((await res.json()) as any).id;
  });

  it("updates name", async () => {
    const res = await put(`/v1/agents/${agentId}`, { name: "Updated Name" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.name).toBe("Updated Name");
    expect(body.system).toBe("original system"); // preserved
  });

  it("increments version on update", async () => {
    const before = (await (await get(`/v1/agents/${agentId}`)).json()) as any;
    await put(`/v1/agents/${agentId}`, { system: "updated system" });
    const after = (await (await get(`/v1/agents/${agentId}`)).json()) as any;
    expect(after.version).toBe(before.version + 1);
  });

  it("updates model", async () => {
    const res = await put(`/v1/agents/${agentId}`, { model: "claude-opus-4-6" });
    const body = (await res.json()) as any;
    expect(body.model).toBe("claude-opus-4-6");
  });

  it("updates tools", async () => {
    const res = await put(`/v1/agents/${agentId}`, {
      tools: [{ type: "agent_toolset_20260401", default_config: { enabled: false } }],
    });
    const body = (await res.json()) as any;
    expect(body.tools[0].default_config.enabled).toBe(false);
  });

  it("updates description", async () => {
    const res = await put(`/v1/agents/${agentId}`, { description: "A test agent" });
    const body = (await res.json()) as any;
    expect(body.description).toBe("A test agent");
  });

  it("returns 404 for nonexistent agent", async () => {
    const res = await put("/v1/agents/agent_ghost", { name: "x" });
    expect(res.status).toBe(404);
  });
});

// ============================================================
// Agent Delete
// ============================================================
describe("Agent delete (DELETE)", () => {
  it("deletes an agent", async () => {
    const createRes = await post("/v1/agents", { name: "ToDelete", model: "claude-sonnet-4-6", harness: "noop-test" });
    const agent = (await createRes.json()) as any;

    const delRes = await del(`/v1/agents/${agent.id}`);
    expect(delRes.status).toBe(200);
    const body = (await delRes.json()) as any;
    expect(body.type).toBe("agent_deleted");

    const getRes = await get(`/v1/agents/${agent.id}`);
    expect(getRes.status).toBe(404);
  });

  it("returns 404 for nonexistent agent", async () => {
    const res = await del("/v1/agents/agent_ghost");
    expect(res.status).toBe(404);
  });
});

// ============================================================
// Agent Archive
// ============================================================
describe("Agent archive", () => {
  it("archives an agent", async () => {
    const createRes = await post("/v1/agents", { name: "ToArchive", model: "claude-sonnet-4-6", harness: "noop-test" });
    const agent = (await createRes.json()) as any;
    expect(agent.archived_at).toBeFalsy();

    const archRes = await post(`/v1/agents/${agent.id}/archive`, {});
    expect(archRes.status).toBe(200);
    const archived = (await archRes.json()) as any;
    expect(archived.archived_at).toBeTruthy();

    // Verify persisted
    const getRes = await get(`/v1/agents/${archived.id}`);
    const fetched = (await getRes.json()) as any;
    expect(fetched.archived_at).toBeTruthy();
  });

  it("returns 404 for nonexistent agent", async () => {
    const res = await post("/v1/agents/agent_ghost/archive", {});
    expect(res.status).toBe(404);
  });
});

// ============================================================
// Agent Version History
// ============================================================
describe("Agent version history", () => {
  let agentId: string;

  beforeAll(async () => {
    const res = await post("/v1/agents", { name: "Versioned", model: "claude-sonnet-4-6", system: "v1", harness: "noop-test" });
    agentId = ((await res.json()) as any).id;
    // Create 3 versions
    await put(`/v1/agents/${agentId}`, { system: "v2" });
    await put(`/v1/agents/${agentId}`, { system: "v3" });
  });

  it("lists all versions", async () => {
    const res = await get(`/v1/agents/${agentId}/versions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.length).toBe(2); // v1 and v2 saved, v3 is current
    expect(body.data[0].version).toBe(1);
    expect(body.data[1].version).toBe(2);
  });

  it("gets a specific version", async () => {
    const res = await get(`/v1/agents/${agentId}/versions/1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.system).toBe("v1");
    expect(body.version).toBe(1);
  });

  it("current version is v3", async () => {
    const res = await get(`/v1/agents/${agentId}`);
    const body = (await res.json()) as any;
    expect(body.version).toBe(3);
    expect(body.system).toBe("v3");
  });

  it("returns 404 for nonexistent version", async () => {
    const res = await get(`/v1/agents/${agentId}/versions/99`);
    expect(res.status).toBe(404);
  });
});

// ============================================================
// Agent List with filters
// ============================================================
describe("Agent list filters", () => {
  beforeAll(async () => {
    // Create a few agents
    for (let i = 0; i < 3; i++) {
      await post("/v1/agents", { name: `ListTest-${i}`, model: "claude-sonnet-4-6", harness: "noop-test" });
    }
  });

  it("lists agents (default desc)", async () => {
    const res = await get("/v1/agents");
    const body = (await res.json()) as any;
    expect(body.data.length).toBeGreaterThanOrEqual(3);
  });

  it("limits results", async () => {
    const res = await get("/v1/agents?limit=2");
    const body = (await res.json()) as any;
    expect(body.data.length).toBe(2);
  });

  it("orders ascending", async () => {
    const res = await get("/v1/agents?order=asc&limit=50");
    const body = (await res.json()) as any;
    for (let i = 1; i < body.data.length; i++) {
      expect(body.data[i].created_at >= body.data[i - 1].created_at).toBe(true);
    }
  });
});

// ============================================================
// Environment Update / Delete / Archive
// ============================================================
describe("Environment update/delete/archive", () => {
  let envId: string;

  beforeAll(async () => {
    const res = await post("/v1/environments", { name: "updatable-env", config: { type: "cloud" } });
    envId = ((await res.json()) as any).id;
  });

  it("updates environment name", async () => {
    const res = await put(`/v1/environments/${envId}`, { name: "renamed-env" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.name).toBe("renamed-env");
  });

  it("updates environment config", async () => {
    const res = await put(`/v1/environments/${envId}`, {
      config: { type: "cloud", networking: { type: "limited", allowed_hosts: ["api.example.com"] } },
    });
    const body = (await res.json()) as any;
    expect(body.config.networking.type).toBe("limited");
  });

  it("archives environment", async () => {
    const envRes = await post("/v1/environments", { name: "to-archive", config: { type: "cloud" } });
    const env = (await envRes.json()) as any;

    const archRes = await post(`/v1/environments/${env.id}/archive`, {});
    expect(archRes.status).toBe(200);
    const archived = (await archRes.json()) as any;
    expect(archived.archived_at).toBeTruthy();
  });

  it("deletes environment", async () => {
    const envRes = await post("/v1/environments", { name: "to-delete", config: { type: "cloud" } });
    const env = (await envRes.json()) as any;

    const delRes = await del(`/v1/environments/${env.id}`);
    expect(delRes.status).toBe(200);
    expect(((await delRes.json()) as any).type).toBe("environment_deleted");

    const getRes = await get(`/v1/environments/${env.id}`);
    expect(getRes.status).toBe(404);
  });

  it("returns 404 for update/delete/archive on nonexistent env", async () => {
    expect((await put("/v1/environments/env_ghost", { name: "x" })).status).toBe(404);
    expect((await del("/v1/environments/env_ghost")).status).toBe(404);
    expect((await post("/v1/environments/env_ghost/archive", {})).status).toBe(404);
  });
});

// ============================================================
// Session Update / Delete / Archive
// ============================================================
describe("Session update/delete/archive", () => {
  let sessionId: string;
  let agentId: string;
  let envId: string;

  beforeAll(async () => {
    const a = await post("/v1/agents", { name: "SA", model: "claude-sonnet-4-6", harness: "noop-test" });
    agentId = ((await a.json()) as any).id;
    const e = await post("/v1/environments", { name: "se", config: { type: "cloud" } });
    envId = ((await e.json()) as any).id;
    const s = await post("/v1/sessions", { agent: agentId, environment_id: envId, title: "Original" });
    sessionId = ((await s.json()) as any).id;
  });

  it("updates session title", async () => {
    const res = await post(`/v1/sessions/${sessionId}`, { title: "Updated Title" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.title).toBe("Updated Title");
    expect(body.updated_at).toBeTruthy();
  });

  it("updates session metadata", async () => {
    const res = await post(`/v1/sessions/${sessionId}`, {
      metadata: { env: "staging", priority: "high" },
    });
    const body = (await res.json()) as any;
    expect(body.metadata.env).toBe("staging");
    expect(body.metadata.priority).toBe("high");
  });

  it("metadata null deletes key", async () => {
    const res = await post(`/v1/sessions/${sessionId}`, {
      metadata: { priority: null },
    });
    const body = (await res.json()) as any;
    expect(body.metadata.env).toBe("staging"); // preserved
    expect(body.metadata.priority).toBeUndefined(); // deleted
  });

  it("archives session", async () => {
    const s = await post("/v1/sessions", { agent: agentId, environment_id: envId });
    const sess = (await s.json()) as any;

    const archRes = await post(`/v1/sessions/${sess.id}/archive`, {});
    expect(archRes.status).toBe(200);
    const body = (await archRes.json()) as any;
    expect(body.archived_at).toBeTruthy();
  });

  it("deletes session", async () => {
    const s = await post("/v1/sessions", { agent: agentId, environment_id: envId });
    const sess = (await s.json()) as any;

    const delRes = await del(`/v1/sessions/${sess.id}`);
    expect(delRes.status).toBe(200);
    expect(((await delRes.json()) as any).type).toBe("session_deleted");

    expect((await get(`/v1/sessions/${sess.id}`)).status).toBe(404);
  });
});

// ============================================================
// Session List with filters
// ============================================================
describe("Session list filters", () => {
  let agentId1: string;
  let agentId2: string;
  let envId: string;

  beforeAll(async () => {
    const a1 = await post("/v1/agents", { name: "Filter1", model: "claude-sonnet-4-6", harness: "noop-test" });
    agentId1 = ((await a1.json()) as any).id;
    const a2 = await post("/v1/agents", { name: "Filter2", model: "claude-sonnet-4-6", harness: "noop-test" });
    agentId2 = ((await a2.json()) as any).id;
    const e = await post("/v1/environments", { name: "filt-env", config: { type: "cloud" } });
    envId = ((await e.json()) as any).id;

    // Create 2 sessions for agent1, 1 for agent2
    await post("/v1/sessions", { agent: agentId1, environment_id: envId, title: "S1A1" });
    await post("/v1/sessions", { agent: agentId1, environment_id: envId, title: "S2A1" });
    await post("/v1/sessions", { agent: agentId2, environment_id: envId, title: "S1A2" });
    // Archive one
    const archSess = await post("/v1/sessions", { agent: agentId1, environment_id: envId, title: "Archived" });
    const archId = ((await archSess.json()) as any).id;
    await post(`/v1/sessions/${archId}/archive`, {});
  });

  it("filters by agent_id", async () => {
    const res = await get(`/v1/sessions?agent_id=${agentId1}`);
    const body = (await res.json()) as any;
    expect(body.data.every((s: any) => s.agent_id === agentId1)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(2);
  });

  it("excludes archived by default", async () => {
    const res = await get(`/v1/sessions?agent_id=${agentId1}`);
    const body = (await res.json()) as any;
    expect(body.data.every((s: any) => !s.archived_at)).toBe(true);
  });

  it("includes archived when requested", async () => {
    const res = await get(`/v1/sessions?agent_id=${agentId1}&include_archived=true`);
    const body = (await res.json()) as any;
    const hasArchived = body.data.some((s: any) => s.archived_at);
    expect(hasArchived).toBe(true);
  });

  it("limits results", async () => {
    const res = await get("/v1/sessions?limit=1");
    const body = (await res.json()) as any;
    expect(body.data.length).toBe(1);
  });
});

// ============================================================
// New Event Types in Session DO
// ============================================================
describe("New event types", () => {
  let sessionId: string;

  beforeAll(async () => {
    const a = await post("/v1/agents", { name: "Evt", model: "claude-sonnet-4-6", harness: "echo-test" });
    const e = await post("/v1/environments", { name: "evt-env", config: { type: "cloud" } });
    const s = await post("/v1/sessions", {
      agent: ((await a.json()) as any).id,
      environment_id: ((await e.json()) as any).id,
    });
    sessionId = ((await s.json()) as any).id;
  });

  it("accepts user.interrupt", async () => {
    const res = await post(`/v1/sessions/${sessionId}/events`, {
      events: [{ type: "user.interrupt" }],
    });
    expect(res.status).toBe(202);
  });

  it("accepts user.tool_confirmation (allow)", async () => {
    const res = await post(`/v1/sessions/${sessionId}/events`, {
      events: [{ type: "user.tool_confirmation", tool_use_id: "toolu_test", result: "allow" }],
    });
    expect(res.status).toBe(202);
  });

  it("accepts user.tool_confirmation (deny)", async () => {
    const res = await post(`/v1/sessions/${sessionId}/events`, {
      events: [{
        type: "user.tool_confirmation",
        tool_use_id: "toolu_test2",
        result: "deny",
        deny_message: "Not allowed",
      }],
    });
    expect(res.status).toBe(202);
  });

  it("accepts user.custom_tool_result", async () => {
    const res = await post(`/v1/sessions/${sessionId}/events`, {
      events: [{
        type: "user.custom_tool_result",
        custom_tool_use_id: "toolu_custom1",
        content: [{ type: "text", text: "Weather is sunny" }],
      }],
    });
    expect(res.status).toBe(202);
  });

  it("all events appear in replay", async () => {
    await new Promise((r) => setTimeout(r, 200));

    const doId = env.SESSION_DO!.idFromName(sessionId);
    const stub = env.SESSION_DO!.get(doId);
    const wsRes = await stub.fetch(
      new Request("http://internal/ws", { headers: { Upgrade: "websocket" } })
    );
    const ws = wsRes.webSocket!;
    ws.accept();

    const events: any[] = [];
    await new Promise<void>((resolve) => {
      ws.addEventListener("message", (e) => events.push(JSON.parse(e.data as string)));
      setTimeout(() => { ws.close(); resolve(); }, 100);
    });

    const types = events.map((e) => e.type);
    expect(types).toContain("user.interrupt");
    expect(types).toContain("user.tool_confirmation");
    expect(types).toContain("user.custom_tool_result");
  });
});

// ============================================================
// Events Pagination (JSON mode)
// ============================================================
describe("Events pagination", () => {
  let sessionId: string;

  beforeAll(async () => {
    const a = await post("/v1/agents", { name: "Pag", model: "claude-sonnet-4-6", harness: "noop-test" });
    const e = await post("/v1/environments", { name: "pag-env", config: { type: "cloud" } });
    const s = await post("/v1/sessions", {
      agent: ((await a.json()) as any).id,
      environment_id: ((await e.json()) as any).id,
    });
    sessionId = ((await s.json()) as any).id;

    // Post 5 messages
    for (let i = 0; i < 5; i++) {
      await post(`/v1/sessions/${sessionId}/events`, {
        events: [{ type: "user.message", content: [{ type: "text", text: `msg-${i}` }] }],
      });
    }
    await new Promise((r) => setTimeout(r, 200));
  });

  it("returns JSON with Accept: application/json", async () => {
    const res = await get(`/v1/sessions/${sessionId}/events`, { Accept: "application/json" });
    expect(res.status).toBe(200);
    const ct = res.headers.get("Content-Type");
    expect(ct).toContain("application/json");
    const body = (await res.json()) as any;
    expect(body.data).toBeInstanceOf(Array);
    expect(body.data.length).toBeGreaterThanOrEqual(5);
    expect(typeof body.has_more).toBe("boolean");
  });

  it("returns SSE with Accept: text/event-stream", async () => {
    const res = await get(`/v1/sessions/${sessionId}/events`, { Accept: "text/event-stream" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
  });

  it("limits results", async () => {
    const res = await get(`/v1/sessions/${sessionId}/events?limit=2`, { Accept: "application/json" });
    const body = (await res.json()) as any;
    expect(body.data.length).toBe(2);
    expect(body.has_more).toBe(true);
  });

  it("paginates with cursor", async () => {
    const page1 = await get(`/v1/sessions/${sessionId}/events?limit=2`, { Accept: "application/json" });
    const body1 = (await page1.json()) as any;
    expect(body1.next_page).toBeTruthy();

    const page2 = await get(`/v1/sessions/${sessionId}/events?limit=2&after=${body1.next_page}`, { Accept: "application/json" });
    const body2 = (await page2.json()) as any;
    expect(body2.data.length).toBeGreaterThanOrEqual(1);

    // No overlap between pages
    const ids1 = body1.data.map((e: any) => e.seq);
    const ids2 = body2.data.map((e: any) => e.seq);
    for (const id of ids2) {
      expect(ids1).not.toContain(id);
    }
  });
});

// ============================================================
// Session Agent Snapshot
// ============================================================
describe("Session agent snapshot", () => {
  it("session stores agent snapshot at creation time", async () => {
    const a = await post("/v1/agents", {
      name: "Snapshot Agent",
      model: "claude-sonnet-4-6",
      system: "snapshot v1",
      harness: "noop-test",
    });
    const agent = (await a.json()) as any;
    const e = await post("/v1/environments", { name: "snap-env", config: { type: "cloud" } });
    const envObj = (await e.json()) as any;

    const s = await post("/v1/sessions", { agent: agent.id, environment_id: envObj.id });
    const session = (await s.json()) as any;

    // Update agent AFTER session creation
    await put(`/v1/agents/${agent.id}`, { system: "snapshot v2" });

    // Session should still show original system prompt
    const getRes = await get(`/v1/sessions/${session.id}`);
    const fetched = (await getRes.json()) as any;
    if (fetched.agent) {
      expect(fetched.agent.system).toBe("snapshot v1");
    }
  });
});

// ============================================================
// Session Harness + Status Flow
// ============================================================
describe("Session harness status flow", () => {
  it("emits running → idle events during processing", async () => {
    const a = await post("/v1/agents", { name: "Status", model: "claude-sonnet-4-6", harness: "echo-test" });
    const e = await post("/v1/environments", { name: "stat-env", config: { type: "cloud" } });
    const s = await post("/v1/sessions", {
      agent: ((await a.json()) as any).id,
      environment_id: ((await e.json()) as any).id,
    });
    const session = (await s.json()) as any;

    await post(`/v1/sessions/${session.id}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "go" }] }],
    });

    // Wait for processing
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const doId = env.SESSION_DO!.idFromName(session.id);
      const stub = env.SESSION_DO!.get(doId);
      const statusRes = await stub.fetch(new Request("http://internal/status"));
      const st = (await statusRes.json()) as any;
      if (st.status === "idle") break;
    }

    // Check events include status events
    const doId = env.SESSION_DO!.idFromName(session.id);
    const stub = env.SESSION_DO!.get(doId);
    const wsRes = await stub.fetch(new Request("http://internal/ws", { headers: { Upgrade: "websocket" } }));
    const ws = wsRes.webSocket!;
    ws.accept();
    const events: any[] = [];
    await new Promise<void>((resolve) => {
      ws.addEventListener("message", (e) => events.push(JSON.parse(e.data as string)));
      setTimeout(() => { ws.close(); resolve(); }, 100);
    });

    const types = events.map((e) => e.type);
    expect(types).toContain("session.status_running");
    expect(types).toContain("session.status_idle");
  });

  it("idle event has stop_reason", async () => {
    const a = await post("/v1/agents", { name: "StopR", model: "claude-sonnet-4-6", harness: "echo-test" });
    const e = await post("/v1/environments", { name: "stop-env", config: { type: "cloud" } });
    const s = await post("/v1/sessions", {
      agent: ((await a.json()) as any).id,
      environment_id: ((await e.json()) as any).id,
    });
    const session = (await s.json()) as any;

    await post(`/v1/sessions/${session.id}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "test" }] }],
    });
    await new Promise((r) => setTimeout(r, 500));

    const doId = env.SESSION_DO!.idFromName(session.id);
    const stub = env.SESSION_DO!.get(doId);
    const wsRes = await stub.fetch(new Request("http://internal/ws", { headers: { Upgrade: "websocket" } }));
    const ws = wsRes.webSocket!;
    ws.accept();
    const events: any[] = [];
    await new Promise<void>((resolve) => {
      ws.addEventListener("message", (e) => events.push(JSON.parse(e.data as string)));
      setTimeout(() => { ws.close(); resolve(); }, 100);
    });

    const idle = events.find((e) => e.type === "session.status_idle");
    expect(idle).toBeTruthy();
    if (idle?.stop_reason) {
      expect(idle.stop_reason.type).toBe("user.message_required");
    }
  });
});

// ============================================================
// Harness crash with new status events
// ============================================================
describe("Harness crash recovery", () => {
  it("emits session.error on crash and returns to idle", async () => {
    registerHarness("crash-v2", () => ({
      async run() { throw new Error("boom v2"); },
    }));

    const a = await post("/v1/agents", { name: "Crash", model: "claude-sonnet-4-6", harness: "crash-v2" });
    const e = await post("/v1/environments", { name: "crash-env", config: { type: "cloud" } });
    const s = await post("/v1/sessions", {
      agent: ((await a.json()) as any).id,
      environment_id: ((await e.json()) as any).id,
    });
    const session = (await s.json()) as any;

    await post(`/v1/sessions/${session.id}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "crash" }] }],
    });

    // Wait for crash
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const doId = env.SESSION_DO!.idFromName(session.id);
      const stub = env.SESSION_DO!.get(doId);
      const statusRes = await stub.fetch(new Request("http://internal/status"));
      const st = (await statusRes.json()) as any;
      if (st.status === "idle") break;
    }

    const doId = env.SESSION_DO!.idFromName(session.id);
    const stub = env.SESSION_DO!.get(doId);
    const wsRes = await stub.fetch(new Request("http://internal/ws", { headers: { Upgrade: "websocket" } }));
    const ws = wsRes.webSocket!;
    ws.accept();
    const events: any[] = [];
    await new Promise<void>((resolve) => {
      ws.addEventListener("message", (e) => events.push(JSON.parse(e.data as string)));
      setTimeout(() => { ws.close(); resolve(); }, 100);
    });

    const error = events.find((e) => e.type === "session.error");
    expect(error).toBeTruthy();
    expect(error.error).toContain("boom v2");
  });
});
