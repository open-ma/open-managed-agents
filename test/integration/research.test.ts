// @ts-nocheck
import { env, exports } from "cloudflare:workers";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { registerHarness } from "../../apps/agent/src/harness/registry";
import type { HarnessContext } from "../../apps/agent/src/harness/interface";

const H = { "x-api-key": "test-key", "Content-Type": "application/json" };
function api(path: string, init?: RequestInit) {
  return exports.default.fetch(new Request(`http://localhost${path}`, init));
}
function post(path: string, body: any) {
  return api(path, { method: "POST", headers: H, body: JSON.stringify(body) });
}
function get(path: string) {
  return api(path, { headers: H });
}
function del(path: string) {
  return api(path, { method: "DELETE", headers: H });
}

// ============================================================
// Register test harnesses for outcome tests
// ============================================================
registerHarness("outcome-test", () => ({
  async run(ctx: HarnessContext) {
    ctx.runtime.broadcast({
      type: "agent.message",
      content: [{ type: "text", text: "Here is the fibonacci script:\n\nfunction fib(n) { return n <= 1 ? n : fib(n-1) + fib(n-2); }" }],
    });
  },
}));

registerHarness("outcome-multi", () => ({
  async run(ctx: HarnessContext) {
    ctx.runtime.broadcast({
      type: "agent.message",
      content: [{ type: "text", text: "Step 1: Setting up REST API" }],
    });
    ctx.runtime.broadcast({
      type: "agent.message",
      content: [{ type: "text", text: "Step 2: Added GET /health endpoint returning JSON" }],
    });
  },
}));

// ============================================================
// Memory Stores CRUD
// ============================================================
describe("Memory stores CRUD", () => {
  it("creates a memory store", async () => {
    const res = await post("/v1/memory_stores", {
      name: "Research Notes",
      description: "Notes from research sessions",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.id).toMatch(/^memstore-/);
    expect(body.name).toBe("Research Notes");
    expect(body.description).toBe("Notes from research sessions");
    expect(body.created_at).toBeTruthy();
  });

  it("rejects memory store without name", async () => {
    const res = await post("/v1/memory_stores", {});
    expect(res.status).toBe(400);
  });

  it("creates a memory store without description", async () => {
    const res = await post("/v1/memory_stores", { name: "Minimal Store" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.name).toBe("Minimal Store");
    expect(body.description).toBeUndefined();
  });

  it("lists memory stores", async () => {
    await post("/v1/memory_stores", { name: "List Store A" });
    await post("/v1/memory_stores", { name: "List Store B" });
    const res = await get("/v1/memory_stores");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data).toBeInstanceOf(Array);
    expect(body.data.length).toBeGreaterThanOrEqual(2);
  });

  it("gets memory store by id", async () => {
    const createRes = await post("/v1/memory_stores", {
      name: "Specific Store",
      description: "For retrieval test",
    });
    const store = (await createRes.json()) as any;

    const res = await get(`/v1/memory_stores/${store.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBe(store.id);
    expect(body.name).toBe("Specific Store");
    expect(body.description).toBe("For retrieval test");
  });

  it("returns 404 for unknown store", async () => {
    const res = await get("/v1/memory_stores/mst_nonexistent");
    expect(res.status).toBe(404);
  });

  it("archives memory store", async () => {
    const createRes = await post("/v1/memory_stores", { name: "Archive Me" });
    const store = (await createRes.json()) as any;

    const res = await post(`/v1/memory_stores/${store.id}/archive`, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.archived_at).toBeTruthy();
    expect(body.name).toBe("Archive Me");
  });

  it("excludes archived stores from default list", async () => {
    const createRes = await post("/v1/memory_stores", {
      name: "Hidden Archived Store",
    });
    const store = (await createRes.json()) as any;
    await post(`/v1/memory_stores/${store.id}/archive`, {});

    const listRes = await get("/v1/memory_stores");
    const body = (await listRes.json()) as any;
    const found = body.data.find((s: any) => s.id === store.id);
    expect(found).toBeUndefined();
  });

  it("includes archived stores when requested", async () => {
    const createRes = await post("/v1/memory_stores", {
      name: "Visible Archived Store",
    });
    const store = (await createRes.json()) as any;
    await post(`/v1/memory_stores/${store.id}/archive`, {});

    const listRes = await get("/v1/memory_stores?include_archived=true");
    const body = (await listRes.json()) as any;
    const found = body.data.find((s: any) => s.id === store.id);
    expect(found).toBeTruthy();
    expect(found.archived_at).toBeTruthy();
  });

  it("deletes memory store", async () => {
    const createRes = await post("/v1/memory_stores", { name: "Delete Me" });
    const store = (await createRes.json()) as any;

    const res = await del(`/v1/memory_stores/${store.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.type).toBe("memory_store_deleted");
    expect(body.id).toBe(store.id);

    // Verify it's gone
    const getRes = await get(`/v1/memory_stores/${store.id}`);
    expect(getRes.status).toBe(404);
  });

  it("returns 404 when deleting nonexistent store", async () => {
    const res = await del("/v1/memory_stores/mst_ghost");
    expect(res.status).toBe(404);
  });

  it("returns 404 when archiving nonexistent store", async () => {
    const res = await post("/v1/memory_stores/mst_ghost/archive", {});
    expect(res.status).toBe(404);
  });

  // ==============================================================
  // Memory Items
  // ==============================================================
  describe("Memory items", () => {
    let storeId: string;

    beforeAll(async () => {
      const res = await post("/v1/memory_stores", {
        name: "Items Test Store",
        description: "Store for memory item tests",
      });
      storeId = ((await res.json()) as any).id;
    });

    it("creates a memory item", async () => {
      const res = await post(`/v1/memory_stores/${storeId}/memories`, {
        path: "notes/meeting-2026-04-09.md",
        content: "# Meeting Notes\n\nDiscussed project timeline.",
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.id).toMatch(/^mem-/);
      expect(body.store_id).toBe(storeId);
      expect(body.path).toBe("notes/meeting-2026-04-09.md");
      expect(body.content).toBe("# Meeting Notes\n\nDiscussed project timeline.");
      expect(body.size_bytes).toBeGreaterThan(0);
      expect(body.created_at).toBeTruthy();
    });

    it("rejects memory item without path", async () => {
      const res = await post(`/v1/memory_stores/${storeId}/memories`, {
        content: "some content",
      });
      expect(res.status).toBe(400);
    });

    it("rejects memory item without content", async () => {
      const res = await post(`/v1/memory_stores/${storeId}/memories`, {
        path: "notes/orphan.md",
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 when creating memory in nonexistent store", async () => {
      const res = await post("/v1/memory_stores/mst_ghost/memories", {
        path: "notes/ghost.md",
        content: "ghost content",
      });
      expect(res.status).toBe(404);
    });

    it("lists memories (metadata only, no content)", async () => {
      // Create a couple of memories
      await post(`/v1/memory_stores/${storeId}/memories`, {
        path: "data/alpha.txt",
        content: "Alpha content here",
      });
      await post(`/v1/memory_stores/${storeId}/memories`, {
        path: "data/beta.txt",
        content: "Beta content here",
      });

      const res = await get(`/v1/memory_stores/${storeId}/memories`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toBeInstanceOf(Array);
      expect(body.data.length).toBeGreaterThanOrEqual(2);

      // Verify no content field in list response
      for (const mem of body.data) {
        expect(mem.id).toBeTruthy();
        expect(mem.path).toBeTruthy();
        expect(mem.store_id).toBe(storeId);
        expect(mem.size_bytes).toBeGreaterThan(0);
        expect(mem.content).toBeUndefined();
      }
    });

    it("gets memory with full content", async () => {
      const createRes = await post(`/v1/memory_stores/${storeId}/memories`, {
        path: "full/content-test.txt",
        content: "Full content visible here",
      });
      const mem = (await createRes.json()) as any;

      const res = await get(
        `/v1/memory_stores/${storeId}/memories/${mem.id}`
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.id).toBe(mem.id);
      expect(body.path).toBe("full/content-test.txt");
      expect(body.content).toBe("Full content visible here");
    });

    it("updates memory content", async () => {
      const createRes = await post(`/v1/memory_stores/${storeId}/memories`, {
        path: "update/original.txt",
        content: "Original content",
      });
      const mem = (await createRes.json()) as any;

      const updateRes = await post(
        `/v1/memory_stores/${storeId}/memories/${mem.id}`,
        { content: "Updated content with more details" }
      );
      expect(updateRes.status).toBe(200);
      const body = (await updateRes.json()) as any;
      expect(body.content).toBe("Updated content with more details");
      expect(body.updated_at).toBeTruthy();
      expect(body.size_bytes).toBe(
        new TextEncoder().encode("Updated content with more details").length
      );
    });

    it("updates memory path", async () => {
      const createRes = await post(`/v1/memory_stores/${storeId}/memories`, {
        path: "old/path.txt",
        content: "Path change content",
      });
      const mem = (await createRes.json()) as any;

      const updateRes = await post(
        `/v1/memory_stores/${storeId}/memories/${mem.id}`,
        { path: "new/path.txt" }
      );
      expect(updateRes.status).toBe(200);
      const body = (await updateRes.json()) as any;
      expect(body.path).toBe("new/path.txt");
      expect(body.content).toBe("Path change content"); // content unchanged
    });

    it("returns 404 for unknown memory", async () => {
      const res = await get(
        `/v1/memory_stores/${storeId}/memories/mem_nonexistent`
      );
      expect(res.status).toBe(404);
    });

    it("returns 404 when updating unknown memory", async () => {
      const res = await post(
        `/v1/memory_stores/${storeId}/memories/mem_nonexistent`,
        { content: "nope" }
      );
      expect(res.status).toBe(404);
    });

    it("deletes memory", async () => {
      const createRes = await post(`/v1/memory_stores/${storeId}/memories`, {
        path: "delete/me.txt",
        content: "To be deleted",
      });
      const mem = (await createRes.json()) as any;

      const delRes = await del(
        `/v1/memory_stores/${storeId}/memories/${mem.id}`
      );
      expect(delRes.status).toBe(200);
      const body = (await delRes.json()) as any;
      expect(body.type).toBe("memory_deleted");
      expect(body.id).toBe(mem.id);

      // Verify it's gone
      const getRes = await get(
        `/v1/memory_stores/${storeId}/memories/${mem.id}`
      );
      expect(getRes.status).toBe(404);
    });

    it("returns 404 when deleting unknown memory", async () => {
      const res = await del(
        `/v1/memory_stores/${storeId}/memories/mem_ghost`
      );
      expect(res.status).toBe(404);
    });

    it("filters memories by prefix", async () => {
      // Create memories with distinct path prefixes
      await post(`/v1/memory_stores/${storeId}/memories`, {
        path: "prefix-test/docs/readme.md",
        content: "Readme content",
      });
      await post(`/v1/memory_stores/${storeId}/memories`, {
        path: "prefix-test/docs/guide.md",
        content: "Guide content",
      });
      await post(`/v1/memory_stores/${storeId}/memories`, {
        path: "prefix-test/src/index.ts",
        content: "Index content",
      });

      // Filter by docs prefix
      const docsRes = await get(
        `/v1/memory_stores/${storeId}/memories?prefix=prefix-test/docs/`
      );
      expect(docsRes.status).toBe(200);
      const docsBody = (await docsRes.json()) as any;
      expect(docsBody.data.length).toBe(2);
      for (const mem of docsBody.data) {
        expect(mem.path).toMatch(/^prefix-test\/docs\//);
      }

      // Filter by src prefix
      const srcRes = await get(
        `/v1/memory_stores/${storeId}/memories?prefix=prefix-test/src/`
      );
      expect(srcRes.status).toBe(200);
      const srcBody = (await srcRes.json()) as any;
      expect(srcBody.data.length).toBe(1);
      expect(srcBody.data[0].path).toBe("prefix-test/src/index.ts");
    });

    it("returns 404 when listing memories for nonexistent store", async () => {
      const res = await get("/v1/memory_stores/mst_ghost/memories");
      expect(res.status).toBe(404);
    });

    it("deleting store deletes all memories", async () => {
      // Create a dedicated store
      const storeRes = await post("/v1/memory_stores", {
        name: "Cascade Delete Store",
      });
      const store = (await storeRes.json()) as any;

      // Add several memories
      const mem1Res = await post(`/v1/memory_stores/${store.id}/memories`, {
        path: "cascade/a.txt",
        content: "Content A",
      });
      const mem1 = (await mem1Res.json()) as any;
      const mem2Res = await post(`/v1/memory_stores/${store.id}/memories`, {
        path: "cascade/b.txt",
        content: "Content B",
      });
      const mem2 = (await mem2Res.json()) as any;

      // Verify memories exist
      const listBefore = await get(`/v1/memory_stores/${store.id}/memories`);
      const beforeBody = (await listBefore.json()) as any;
      expect(beforeBody.data.length).toBe(2);

      // Delete the store
      const delRes = await del(`/v1/memory_stores/${store.id}`);
      expect(delRes.status).toBe(200);

      // Store is gone
      const getStore = await get(`/v1/memory_stores/${store.id}`);
      expect(getStore.status).toBe(404);

      // Memories are also gone (store 404 prevents listing, but we can check
      // that individual memory GETs also fail since the KV keys were deleted)
      const getMem1 = await get(
        `/v1/memory_stores/${store.id}/memories/${mem1.id}`
      );
      expect(getMem1.status).toBe(404);
      const getMem2 = await get(
        `/v1/memory_stores/${store.id}/memories/${mem2.id}`
      );
      expect(getMem2.status).toBe(404);
    });

    it("correctly computes size_bytes for unicode content", async () => {
      const unicodeContent = "Hello \u{1F30D} \u00E9\u00E0\u00FC \u4F60\u597D";
      const res = await post(`/v1/memory_stores/${storeId}/memories`, {
        path: "unicode/test.txt",
        content: unicodeContent,
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      const expectedBytes = new TextEncoder().encode(unicodeContent).length;
      expect(body.size_bytes).toBe(expectedBytes);
    });
  });
});

// ============================================================
// Outcomes
// ============================================================
describe("Outcomes", () => {
  let agentId: string;
  let envId: string;

  beforeAll(async () => {
    const agentRes = await post("/v1/agents", {
      name: "OutcomeTestAgent",
      model: "claude-sonnet-4-6",
      harness: "outcome-test",
    });
    agentId = ((await agentRes.json()) as any).id;

    const envRes = await post("/v1/environments", {
      name: "outcome-test-env",
      config: { type: "cloud" },
    });
    envId = ((await envRes.json()) as any).id;
  });

  it("accepts user.define_outcome event", async () => {
    const sessionRes = await post("/v1/sessions", {
      agent: agentId,
      environment_id: envId,
    });
    const sessionId = ((await sessionRes.json()) as any).id;

    const res = await post(`/v1/sessions/${sessionId}/events`, {
      events: [
        {
          type: "user.define_outcome",
          outcome: { description: "Create a working fibonacci script" },
        },
      ],
    });
    expect(res.status).toBe(202);
  });

  it("accepts user.define_outcome with criteria and max_iterations", async () => {
    const sessionRes = await post("/v1/sessions", {
      agent: agentId,
      environment_id: envId,
    });
    const sessionId = ((await sessionRes.json()) as any).id;

    const res = await post(`/v1/sessions/${sessionId}/events`, {
      events: [
        {
          type: "user.define_outcome",
          outcome: {
            description: "Build a REST API",
            criteria: ["Has GET /health", "Returns JSON", "Handles errors"],
            max_iterations: 5,
          },
        },
      ],
    });
    expect(res.status).toBe(202);
  });

  it("stores outcome in session meta via DO", async () => {
    const sessionRes = await post("/v1/sessions", {
      agent: agentId,
      environment_id: envId,
    });
    const sessionId = ((await sessionRes.json()) as any).id;

    // Send define_outcome
    await post(`/v1/sessions/${sessionId}/events`, {
      events: [
        {
          type: "user.define_outcome",
          outcome: {
            description: "Write unit tests",
            criteria: ["Coverage > 80%"],
          },
        },
      ],
    });

    // Wait for DO to process the event
    await new Promise((r) => setTimeout(r, 100));

    // Connect via WebSocket to replay events and verify outcome was stored
    const doId = env.SESSION_DO!.idFromName(sessionId);
    const stub = env.SESSION_DO!.get(doId);
    const wsRes = await stub.fetch(
      new Request("http://internal/ws", { headers: { Upgrade: "websocket" } })
    );
    const ws = wsRes.webSocket!;
    ws.accept();

    const events: any[] = [];
    await new Promise<void>((resolve) => {
      ws.addEventListener("message", (e) =>
        events.push(JSON.parse(e.data as string))
      );
      setTimeout(() => {
        ws.close();
        resolve();
      }, 150);
    });

    const outcomeEvents = events.filter(
      (e) => e.type === "user.define_outcome"
    );
    expect(outcomeEvents.length).toBe(1);
    expect(outcomeEvents[0].outcome.description).toBe("Write unit tests");
    expect(outcomeEvents[0].outcome.criteria).toEqual(["Coverage > 80%"]);
  });

  it("harness runs normally when outcome is set (no LLM needed for event acceptance)", async () => {
    const sessionRes = await post("/v1/sessions", {
      agent: agentId,
      environment_id: envId,
    });
    const sessionId = ((await sessionRes.json()) as any).id;

    // First, define an outcome
    const outcomeRes = await post(`/v1/sessions/${sessionId}/events`, {
      events: [
        {
          type: "user.define_outcome",
          outcome: { description: "Write fibonacci" },
        },
      ],
    });
    expect(outcomeRes.status).toBe(202);

    // Then send a user message to trigger harness execution
    // The harness will run and produce agent.message events.
    // Outcome evaluation will fail (no real LLM) but the harness itself runs fine.
    const msgRes = await post(`/v1/sessions/${sessionId}/events`, {
      events: [
        {
          type: "user.message",
          content: [{ type: "text", text: "Write fibonacci" }],
        },
      ],
    });
    expect(msgRes.status).toBe(202);

    // Wait for harness to complete (outcome eval will error but session recovers)
    await new Promise((r) => setTimeout(r, 500));

    // Connect via WebSocket to verify the harness did run
    const doId = env.SESSION_DO!.idFromName(sessionId);
    const stub = env.SESSION_DO!.get(doId);
    const wsRes = await stub.fetch(
      new Request("http://internal/ws", { headers: { Upgrade: "websocket" } })
    );
    const ws = wsRes.webSocket!;
    ws.accept();

    const events: any[] = [];
    await new Promise<void>((resolve) => {
      ws.addEventListener("message", (e) =>
        events.push(JSON.parse(e.data as string))
      );
      setTimeout(() => {
        ws.close();
        resolve();
      }, 150);
    });

    // The harness should have produced agent.message events
    const agentMessages = events.filter((e) => e.type === "agent.message");
    expect(agentMessages.length).toBeGreaterThanOrEqual(1);
    expect(agentMessages[0].content[0].text).toContain("fibonacci");

    // Session should have a running event
    const runningEvents = events.filter(
      (e) => e.type === "session.status_running"
    );
    expect(runningEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("multiple define_outcome events appear in replay", async () => {
    const sessionRes = await post("/v1/sessions", {
      agent: agentId,
      environment_id: envId,
    });
    const sessionId = ((await sessionRes.json()) as any).id;

    // Send two different outcomes
    await post(`/v1/sessions/${sessionId}/events`, {
      events: [
        {
          type: "user.define_outcome",
          outcome: { description: "First outcome" },
        },
      ],
    });
    await post(`/v1/sessions/${sessionId}/events`, {
      events: [
        {
          type: "user.define_outcome",
          outcome: {
            description: "Second outcome",
            criteria: ["Criterion A", "Criterion B"],
          },
        },
      ],
    });

    await new Promise((r) => setTimeout(r, 100));

    const doId = env.SESSION_DO!.idFromName(sessionId);
    const stub = env.SESSION_DO!.get(doId);
    const wsRes = await stub.fetch(
      new Request("http://internal/ws", { headers: { Upgrade: "websocket" } })
    );
    const ws = wsRes.webSocket!;
    ws.accept();

    const events: any[] = [];
    await new Promise<void>((resolve) => {
      ws.addEventListener("message", (e) =>
        events.push(JSON.parse(e.data as string))
      );
      setTimeout(() => {
        ws.close();
        resolve();
      }, 150);
    });

    const outcomeEvents = events.filter(
      (e) => e.type === "user.define_outcome"
    );
    expect(outcomeEvents.length).toBe(2);
    expect(outcomeEvents[0].outcome.description).toBe("First outcome");
    expect(outcomeEvents[1].outcome.description).toBe("Second outcome");
    expect(outcomeEvents[1].outcome.criteria).toEqual([
      "Criterion A",
      "Criterion B",
    ]);
  });
});

// ============================================================
// Memory Enhancements: SHA256, Preconditions, Versions
// ============================================================
describe("Memory enhancements", () => {
  let storeId: string;

  beforeAll(async () => {
    const res = await post("/v1/memory_stores", {
      name: "Enhancements Test Store",
    });
    storeId = ((await res.json()) as any).id;
  });

  // --- content_sha256 ---
  describe("content_sha256", () => {
    it("returns content_sha256 on create", async () => {
      const res = await post(`/v1/memory_stores/${storeId}/memories`, {
        path: "sha/test1.txt",
        content: "hello world",
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.content_sha256).toBeTruthy();
      expect(body.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it("returns consistent sha256 for same content", async () => {
      const content = "deterministic content";
      const r1 = await post(`/v1/memory_stores/${storeId}/memories`, {
        path: "sha/det1.txt",
        content,
      });
      const r2 = await post(`/v1/memory_stores/${storeId}/memories`, {
        path: "sha/det2.txt",
        content,
      });
      const b1 = (await r1.json()) as any;
      const b2 = (await r2.json()) as any;
      expect(b1.content_sha256).toBe(b2.content_sha256);
    });

    it("updates content_sha256 on update", async () => {
      const createRes = await post(`/v1/memory_stores/${storeId}/memories`, {
        path: "sha/update.txt",
        content: "original",
      });
      const mem = (await createRes.json()) as any;
      const originalHash = mem.content_sha256;

      const updateRes = await post(
        `/v1/memory_stores/${storeId}/memories/${mem.id}`,
        { content: "updated" }
      );
      const updated = (await updateRes.json()) as any;
      expect(updated.content_sha256).toBeTruthy();
      expect(updated.content_sha256).not.toBe(originalHash);
    });

    it("includes content_sha256 in list response", async () => {
      await post(`/v1/memory_stores/${storeId}/memories`, {
        path: "sha/list-check.txt",
        content: "list check content",
      });

      const listRes = await get(`/v1/memory_stores/${storeId}/memories`);
      const body = (await listRes.json()) as any;
      const found = body.data.find(
        (m: any) => m.path === "sha/list-check.txt"
      );
      expect(found).toBeTruthy();
      expect(found.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it("includes content_sha256 in get response", async () => {
      const createRes = await post(`/v1/memory_stores/${storeId}/memories`, {
        path: "sha/get-check.txt",
        content: "get check content",
      });
      const mem = (await createRes.json()) as any;

      const getRes = await get(
        `/v1/memory_stores/${storeId}/memories/${mem.id}`
      );
      const body = (await getRes.json()) as any;
      expect(body.content_sha256).toBe(mem.content_sha256);
    });
  });

  // --- Preconditions ---
  describe("Preconditions", () => {
    it("not_exists allows creation when path is new", async () => {
      const res = await post(`/v1/memory_stores/${storeId}/memories`, {
        path: "precond/unique-path.txt",
        content: "unique content",
        precondition: { type: "not_exists" },
      });
      expect(res.status).toBe(201);
    });

    it("not_exists returns 409 when path already exists", async () => {
      const path = "precond/duplicate.txt";
      await post(`/v1/memory_stores/${storeId}/memories`, {
        path,
        content: "first",
      });

      const res = await post(`/v1/memory_stores/${storeId}/memories`, {
        path,
        content: "second",
        precondition: { type: "not_exists" },
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as any;
      expect(body.error).toBe("memory_precondition_failed");
    });

    it("content_sha256 precondition passes when hash matches", async () => {
      const createRes = await post(`/v1/memory_stores/${storeId}/memories`, {
        path: "precond/hash-match.txt",
        content: "original content",
      });
      const mem = (await createRes.json()) as any;

      const updateRes = await post(
        `/v1/memory_stores/${storeId}/memories/${mem.id}`,
        {
          content: "updated content",
          precondition: {
            type: "content_sha256",
            content_sha256: mem.content_sha256,
          },
        }
      );
      expect(updateRes.status).toBe(200);
      const updated = (await updateRes.json()) as any;
      expect(updated.content).toBe("updated content");
    });

    it("content_sha256 precondition returns 409 when hash mismatches", async () => {
      const createRes = await post(`/v1/memory_stores/${storeId}/memories`, {
        path: "precond/hash-mismatch.txt",
        content: "original content",
      });
      const mem = (await createRes.json()) as any;

      const updateRes = await post(
        `/v1/memory_stores/${storeId}/memories/${mem.id}`,
        {
          content: "conflicting update",
          precondition: {
            type: "content_sha256",
            content_sha256: "0000000000000000000000000000000000000000000000000000000000000000",
          },
        }
      );
      expect(updateRes.status).toBe(409);
      const body = (await updateRes.json()) as any;
      expect(body.error).toBe("memory_precondition_failed");
    });

    it("update without precondition still works", async () => {
      const createRes = await post(`/v1/memory_stores/${storeId}/memories`, {
        path: "precond/no-precond.txt",
        content: "original",
      });
      const mem = (await createRes.json()) as any;

      const updateRes = await post(
        `/v1/memory_stores/${storeId}/memories/${mem.id}`,
        { content: "updated without precondition" }
      );
      expect(updateRes.status).toBe(200);
    });
  });

  // --- Memory Versions ---
  describe("Memory versions", () => {
    it("creates a version when a memory is created", async () => {
      const createRes = await post(`/v1/memory_stores/${storeId}/memories`, {
        path: "ver/created.txt",
        content: "version test",
      });
      const mem = (await createRes.json()) as any;

      const versionsRes = await get(
        `/v1/memory_stores/${storeId}/memory_versions?memory_id=${mem.id}`
      );
      expect(versionsRes.status).toBe(200);
      const body = (await versionsRes.json()) as any;
      expect(body.data.length).toBe(1);
      expect(body.data[0].operation).toBe("created");
      expect(body.data[0].memory_id).toBe(mem.id);
      expect(body.data[0].store_id).toBe(storeId);
      expect(body.data[0].id).toMatch(/^memver-/);
      // List should not include content
      expect(body.data[0].content).toBeUndefined();
    });

    it("creates a version when a memory is updated", async () => {
      const createRes = await post(`/v1/memory_stores/${storeId}/memories`, {
        path: "ver/updated.txt",
        content: "before update",
      });
      const mem = (await createRes.json()) as any;

      await post(`/v1/memory_stores/${storeId}/memories/${mem.id}`, {
        content: "after update",
      });

      const versionsRes = await get(
        `/v1/memory_stores/${storeId}/memory_versions?memory_id=${mem.id}`
      );
      const body = (await versionsRes.json()) as any;
      expect(body.data.length).toBe(2);
      // Newest first
      expect(body.data[0].operation).toBe("modified");
      expect(body.data[1].operation).toBe("created");
    });

    it("creates a version when a memory is deleted", async () => {
      const createRes = await post(`/v1/memory_stores/${storeId}/memories`, {
        path: "ver/deleted.txt",
        content: "to be deleted",
      });
      const mem = (await createRes.json()) as any;

      await del(`/v1/memory_stores/${storeId}/memories/${mem.id}`);

      const versionsRes = await get(
        `/v1/memory_stores/${storeId}/memory_versions?memory_id=${mem.id}`
      );
      const body = (await versionsRes.json()) as any;
      expect(body.data.length).toBe(2);
      expect(body.data[0].operation).toBe("deleted");
      expect(body.data[1].operation).toBe("created");
    });

    it("gets a single version with full content", async () => {
      const createRes = await post(`/v1/memory_stores/${storeId}/memories`, {
        path: "ver/full.txt",
        content: "full version content",
      });
      const mem = (await createRes.json()) as any;

      const versionsRes = await get(
        `/v1/memory_stores/${storeId}/memory_versions?memory_id=${mem.id}`
      );
      const list = (await versionsRes.json()) as any;
      const verId = list.data[0].id;

      const verRes = await get(
        `/v1/memory_stores/${storeId}/memory_versions/${verId}`
      );
      expect(verRes.status).toBe(200);
      const body = (await verRes.json()) as any;
      expect(body.content).toBe("full version content");
      expect(body.content_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(body.size_bytes).toBeGreaterThan(0);
      expect(body.path).toBe("ver/full.txt");
    });

    it("returns 404 for unknown version", async () => {
      const res = await get(
        `/v1/memory_stores/${storeId}/memory_versions/memver_nonexistent`
      );
      expect(res.status).toBe(404);
    });

    it("returns 404 for versions of nonexistent store", async () => {
      const res = await get(
        "/v1/memory_stores/memstore_ghost/memory_versions"
      );
      expect(res.status).toBe(404);
    });

    it("lists all versions without memory_id filter", async () => {
      // We already created some versions above; just check the endpoint works
      const versionsRes = await get(
        `/v1/memory_stores/${storeId}/memory_versions`
      );
      expect(versionsRes.status).toBe(200);
      const body = (await versionsRes.json()) as any;
      expect(body.data.length).toBeGreaterThanOrEqual(1);
    });

    it("versions are sorted newest first", async () => {
      const createRes = await post(`/v1/memory_stores/${storeId}/memories`, {
        path: "ver/sort.txt",
        content: "v1",
      });
      const mem = (await createRes.json()) as any;

      await post(`/v1/memory_stores/${storeId}/memories/${mem.id}`, {
        content: "v2",
      });
      await post(`/v1/memory_stores/${storeId}/memories/${mem.id}`, {
        content: "v3",
      });

      const versionsRes = await get(
        `/v1/memory_stores/${storeId}/memory_versions?memory_id=${mem.id}`
      );
      const body = (await versionsRes.json()) as any;
      expect(body.data.length).toBe(3);
      // Newest first
      for (let i = 0; i < body.data.length - 1; i++) {
        expect(body.data[i].created_at >= body.data[i + 1].created_at).toBe(
          true
        );
      }
    });

    // --- Redact ---
    it("redacts a version", async () => {
      const createRes = await post(`/v1/memory_stores/${storeId}/memories`, {
        path: "ver/redact.txt",
        content: "sensitive data",
      });
      const mem = (await createRes.json()) as any;

      const versionsRes = await get(
        `/v1/memory_stores/${storeId}/memory_versions?memory_id=${mem.id}`
      );
      const list = (await versionsRes.json()) as any;
      const verId = list.data[0].id;

      const redactRes = await post(
        `/v1/memory_stores/${storeId}/memory_versions/${verId}/redact`,
        {}
      );
      expect(redactRes.status).toBe(200);
      const body = (await redactRes.json()) as any;
      expect(body.redacted).toBe(true);
      expect(body.content).toBeUndefined();
      expect(body.content_sha256).toBeUndefined();
      expect(body.size_bytes).toBeUndefined();
      expect(body.path).toBeUndefined();
      // Audit fields preserved
      expect(body.id).toBe(verId);
      expect(body.memory_id).toBe(mem.id);
      expect(body.operation).toBe("created");
      expect(body.created_at).toBeTruthy();
    });

    it("redacted version stays redacted on re-read", async () => {
      const createRes = await post(`/v1/memory_stores/${storeId}/memories`, {
        path: "ver/redact-persist.txt",
        content: "more sensitive data",
      });
      const mem = (await createRes.json()) as any;

      const versionsRes = await get(
        `/v1/memory_stores/${storeId}/memory_versions?memory_id=${mem.id}`
      );
      const list = (await versionsRes.json()) as any;
      const verId = list.data[0].id;

      await post(
        `/v1/memory_stores/${storeId}/memory_versions/${verId}/redact`,
        {}
      );

      const getRes = await get(
        `/v1/memory_stores/${storeId}/memory_versions/${verId}`
      );
      const body = (await getRes.json()) as any;
      expect(body.redacted).toBe(true);
      expect(body.content).toBeUndefined();
    });

    it("returns 404 when redacting nonexistent version", async () => {
      const res = await post(
        `/v1/memory_stores/${storeId}/memory_versions/memver_ghost/redact`,
        {}
      );
      expect(res.status).toBe(404);
    });

    it("version includes content_sha256 and size_bytes", async () => {
      const content = "version hash test";
      const createRes = await post(`/v1/memory_stores/${storeId}/memories`, {
        path: "ver/hash.txt",
        content,
      });
      const mem = (await createRes.json()) as any;

      const versionsRes = await get(
        `/v1/memory_stores/${storeId}/memory_versions?memory_id=${mem.id}`
      );
      const list = (await versionsRes.json()) as any;
      const verId = list.data[0].id;

      const verRes = await get(
        `/v1/memory_stores/${storeId}/memory_versions/${verId}`
      );
      const body = (await verRes.json()) as any;
      expect(body.content_sha256).toBe(mem.content_sha256);
      expect(body.size_bytes).toBe(
        new TextEncoder().encode(content).length
      );
    });
  });
});
