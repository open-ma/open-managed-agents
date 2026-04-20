// @ts-nocheck
import { env, exports } from "cloudflare:workers";
import { describe, it, expect, beforeAll } from "vitest";
import { registerHarness } from "../../apps/agent/src/harness/registry";
import type { HarnessInterface, HarnessContext } from "../../apps/agent/src/harness/interface";

// ---------- Test Harness ----------
registerHarness("edge-noop", () => ({ async run() {} }));

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

async function createAgent(overrides?: Record<string, unknown>) {
  const res = await post("/v1/agents", {
    name: "EdgeAgent",
    model: "claude-sonnet-4-6",
    harness: "edge-noop",
    ...overrides,
  });
  return (await res.json()) as any;
}

async function createEnv(overrides?: Record<string, unknown>) {
  const res = await post("/v1/environments", {
    name: `edge-env-${Date.now()}`,
    config: { type: "cloud" },
    ...overrides,
  });
  return (await res.json()) as any;
}

async function createSession(agentId: string, envId: string, extra?: Record<string, unknown>) {
  const res = await post("/v1/sessions", {
    agent: agentId,
    environment_id: envId,
    ...extra,
  });
  return (await res.json()) as any;
}

// ============================================================
// API validation
// ============================================================
describe("API validation", () => {
  it("agent with extra unknown fields is accepted (201)", async () => {
    const res = await post("/v1/agents", {
      name: "ExtraFields",
      model: "claude-sonnet-4-6",
      harness: "edge-noop",
      unknown_field: "should be ignored or stored",
      another_random: 42,
    });
    expect(res.status).toBe(201);
    const agent = (await res.json()) as any;
    expect(agent.id).toMatch(/^agent-/);
    expect(agent.name).toBe("ExtraFields");
  });

  it("session without title is created with no title", async () => {
    const agent = await createAgent();
    const envObj = await createEnv();
    const session = await createSession(agent.id, envObj.id);
    expect(session.id).toMatch(/^sess-/);
    // title should be undefined or empty, not cause an error
    expect(session.title === undefined || session.title === "" || session.title === null).toBe(true);
  });

  it("session with empty metadata object is created", async () => {
    const agent = await createAgent();
    const envObj = await createEnv();
    const res = await post("/v1/sessions", {
      agent: agent.id,
      environment_id: envObj.id,
      metadata: {},
    });
    expect(res.status).toBe(201);
  });

  it("agent update with empty body is a no-op (version unchanged)", async () => {
    const agent = await createAgent({ system: "stable" });
    const v1 = agent.version;

    const updateRes = await put(`/v1/agents/${agent.id}`, {});
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as any;
    // Version should not bump for a no-op update
    expect(updated.version).toBe(v1);
  });

  it("environment update changing only name preserves config", async () => {
    const envObj = await createEnv();
    const origConfig = envObj.config;

    const updateRes = await put(`/v1/environments/${envObj.id}`, { name: "edge-renamed" });
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as any;
    expect(updated.name).toBe("edge-renamed");
    expect(updated.config.type).toBe(origConfig.type);
  });
});

// ============================================================
// Concurrent operations
// ============================================================
describe("Concurrent operations", () => {
  it("create and immediately GET returns created agent", async () => {
    const createRes = await post("/v1/agents", {
      name: "ImmediateGet",
      model: "claude-sonnet-4-6",
      harness: "edge-noop",
    });
    const agent = (await createRes.json()) as any;

    const getRes = await get(`/v1/agents/${agent.id}`);
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as any;
    expect(fetched.id).toBe(agent.id);
    expect(fetched.name).toBe("ImmediateGet");
  });

  it("create and immediately DELETE succeeds", async () => {
    const createRes = await post("/v1/agents", {
      name: "ImmediateDel",
      model: "claude-sonnet-4-6",
      harness: "edge-noop",
    });
    const agent = (await createRes.json()) as any;

    const delRes = await del(`/v1/agents/${agent.id}`);
    expect(delRes.status).toBe(200);

    const getRes = await get(`/v1/agents/${agent.id}`);
    expect(getRes.status).toBe(404);
  });

  it("two PUT updates to same agent simultaneously both succeed, last wins", async () => {
    const agent = await createAgent({ system: "concurrent-v0" });

    const [res1, res2] = await Promise.all([
      put(`/v1/agents/${agent.id}`, { system: "concurrent-v1" }),
      put(`/v1/agents/${agent.id}`, { system: "concurrent-v2" }),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // The final state should be one of the two updates
    const getRes = await get(`/v1/agents/${agent.id}`);
    const final = (await getRes.json()) as any;
    expect(["concurrent-v1", "concurrent-v2"]).toContain(final.system);
  });

  it("create session + POST event rapidly, event accepted", async () => {
    const agent = await createAgent();
    const envObj = await createEnv();
    const session = await createSession(agent.id, envObj.id);

    // Immediately post an event
    const evtRes = await post(`/v1/sessions/${session.id}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "rapid event" }] }],
    });
    expect(evtRes.status).toBe(202);
  });

  it("archive then delete same resource succeeds or returns 404", async () => {
    const agent = await createAgent();

    // Archive first
    const archRes = await post(`/v1/agents/${agent.id}/archive`, {});
    expect(archRes.status).toBe(200);

    // Then delete
    const delRes = await del(`/v1/agents/${agent.id}`);
    // Should succeed (delete archived agent) or return 404 if implementation differs
    expect([200, 404]).toContain(delRes.status);
  });
});

// ============================================================
// Boundary conditions
// ============================================================
describe("Boundary conditions", () => {
  it("agent list with limit=0 returns empty data or error", async () => {
    const res = await get("/v1/agents?limit=0");
    // Either returns empty array or treats 0 as no-limit or errors
    if (res.status === 200) {
      const body = (await res.json()) as any;
      expect(body.data).toBeInstanceOf(Array);
    } else {
      // 400 is also acceptable for invalid limit
      expect(res.status).toBe(400);
    }
  });

  it("agent list with very large limit returns all available", async () => {
    // Create a few agents to be sure
    await post("/v1/agents", { name: "Limit-1", model: "claude-sonnet-4-6", harness: "edge-noop" });
    await post("/v1/agents", { name: "Limit-2", model: "claude-sonnet-4-6", harness: "edge-noop" });

    const res = await get("/v1/agents?limit=9999");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data).toBeInstanceOf(Array);
    expect(body.data.length).toBeGreaterThanOrEqual(2);
  });

  it("session events limit=1000 (max) works", async () => {
    const agent = await createAgent();
    const envObj = await createEnv();
    const session = await createSession(agent.id, envObj.id);

    // Post a few events
    for (let i = 0; i < 3; i++) {
      await post(`/v1/sessions/${session.id}/events`, {
        events: [{ type: "user.message", content: [{ type: "text", text: `limit-msg-${i}` }] }],
      });
    }
    await new Promise((r) => setTimeout(r, 200));

    const res = await get(`/v1/sessions/${session.id}/events?limit=1000`, { Accept: "application/json" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data).toBeInstanceOf(Array);
    expect(body.data.length).toBeGreaterThanOrEqual(3);
  });

  it("memory with path containing slashes and dots", async () => {
    const storeRes = await post("/v1/memory_stores", { name: "path-test-store" });
    const store = (await storeRes.json()) as any;

    const res = await post(`/v1/memory_stores/${store.id}/memories`, {
      path: "deep/nested/path/with.dots/and-dashes/file.v2.txt",
      content: "path test content",
    });
    expect(res.status).toBe(201);
    const mem = (await res.json()) as any;
    expect(mem.path).toBe("deep/nested/path/with.dots/and-dashes/file.v2.txt");
  });

  it("memory with unicode path", async () => {
    const storeRes = await post("/v1/memory_stores", { name: "unicode-path-store" });
    const store = (await storeRes.json()) as any;

    const unicodePath = "\u6587\u4EF6/\u30C6\u30B9\u30C8/\u00E9\u00E0\u00FC.txt";
    const res = await post(`/v1/memory_stores/${store.id}/memories`, {
      path: unicodePath,
      content: "unicode path content",
    });
    expect(res.status).toBe(201);
    const mem = (await res.json()) as any;
    expect(mem.path).toBe(unicodePath);
  });

  it("file with long filename (200 chars)", async () => {
    const longName = "a".repeat(196) + ".txt"; // 200 chars total
    const res = await post("/v1/files", {
      filename: longName,
      content: "long filename content",
      media_type: "text/plain",
    });
    expect(res.status).toBe(201);
    const file = (await res.json()) as any;
    expect(file.filename).toBe(longName);
    expect(file.filename.length).toBe(200);
  });

  it("file with special chars in filename", async () => {
    const specialName = "test file (1) [copy] {v2} @special #tag.txt";
    const res = await post("/v1/files", {
      filename: specialName,
      content: "special filename content",
      media_type: "text/plain",
    });
    expect(res.status).toBe(201);
    const file = (await res.json()) as any;
    expect(file.filename).toBe(specialName);
  });

  it("session with empty resources array is treated as no resources", async () => {
    const agent = await createAgent();
    const envObj = await createEnv();

    const res = await post("/v1/sessions", {
      agent: agent.id,
      environment_id: envObj.id,
      resources: [],
    });
    expect(res.status).toBe(201);
    const session = (await res.json()) as any;
    // Empty resources array should result in no resources
    expect(
      session.resources === undefined ||
      (Array.isArray(session.resources) && session.resources.length === 0),
    ).toBe(true);
  });

  it("agent with empty string system prompt is accepted", async () => {
    const res = await post("/v1/agents", {
      name: "EmptySystem",
      model: "claude-sonnet-4-6",
      system: "",
      harness: "edge-noop",
    });
    expect(res.status).toBe(201);
    const agent = (await res.json()) as any;
    expect(agent.system).toBeNull();
  });

  it("multiple rapid creates (20 agents) all produce unique IDs", async () => {
    const promises = Array.from({ length: 20 }, (_, i) =>
      post("/v1/agents", {
        name: `Rapid-${i}`,
        model: "claude-sonnet-4-6",
        harness: "edge-noop",
      }),
    );
    const results = await Promise.all(promises);
    expect(results.every((r) => r.status === 201)).toBe(true);

    const ids = await Promise.all(
      results.map((r) => r.json().then((b: any) => b.id)),
    );
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(20);
  });
});
