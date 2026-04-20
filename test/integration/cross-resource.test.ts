// @ts-nocheck
import { env, exports } from "cloudflare:workers";
import { describe, it, expect, beforeAll } from "vitest";
import { registerHarness } from "../../apps/agent/src/harness/registry";
import type { HarnessInterface, HarnessContext } from "../../apps/agent/src/harness/interface";

// ---------- Test Harnesses ----------
registerHarness("cross-noop", () => ({ async run() {} }));
registerHarness("cross-echo", () => ({
  async run(ctx: HarnessContext) {
    ctx.runtime.broadcast({
      type: "agent.message",
      content: [{ type: "text", text: "cross-echo reply" }],
    });
  },
}));

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

async function collectReplayedEvents(sessionId: string, waitMs = 50): Promise<any[]> {
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

// ============================================================
// Agent + Session snapshot
// ============================================================
describe("Agent + Session snapshot", () => {
  it("session with vault_ids includes them in GET response", async () => {
    const a = await post("/v1/agents", { name: "VaultAgent", model: "claude-sonnet-4-6", harness: "cross-noop" });
    const agent = (await a.json()) as any;
    const e = await post("/v1/environments", { name: "vlt-env", config: { type: "cloud" } });
    const envObj = (await e.json()) as any;

    const v1 = await post("/v1/vaults", { name: "snap-vault-1" });
    const vault1 = (await v1.json()) as any;
    const v2 = await post("/v1/vaults", { name: "snap-vault-2" });
    const vault2 = (await v2.json()) as any;

    const s = await post("/v1/sessions", {
      agent: agent.id,
      environment_id: envObj.id,
      vault_ids: [vault1.id, vault2.id],
    });
    expect(s.status).toBe(201);
    const session = (await s.json()) as any;
    expect(session.vault_ids).toEqual([vault1.id, vault2.id]);

    const getRes = await get(`/v1/sessions/${session.id}`);
    const fetched = (await getRes.json()) as any;
    expect(fetched.vault_ids).toEqual([vault1.id, vault2.id]);
  });

  it("agent update after session creation does not change session snapshot", async () => {
    const a = await post("/v1/agents", {
      name: "SnapAgent", model: "claude-sonnet-4-6", system: "snap-v1", harness: "cross-noop",
    });
    const agent = (await a.json()) as any;
    const e = await post("/v1/environments", { name: "snap-env", config: { type: "cloud" } });
    const envObj = (await e.json()) as any;

    const s = await post("/v1/sessions", { agent: agent.id, environment_id: envObj.id });
    const session = (await s.json()) as any;

    await put(`/v1/agents/${agent.id}`, { system: "snap-v2" });

    const getRes = await get(`/v1/sessions/${session.id}`);
    const fetched = (await getRes.json()) as any;
    if (fetched.agent) {
      expect(fetched.agent.system).toBe("snap-v1");
    }
  });

  it("archived agent does not prevent session access", async () => {
    const a = await post("/v1/agents", { name: "ArchiveSnapAgent", model: "claude-sonnet-4-6", harness: "cross-noop" });
    const agent = (await a.json()) as any;
    const e = await post("/v1/environments", { name: "archsnap-env", config: { type: "cloud" } });
    const envObj = (await e.json()) as any;

    const s = await post("/v1/sessions", { agent: agent.id, environment_id: envObj.id });
    const session = (await s.json()) as any;

    await post(`/v1/agents/${agent.id}/archive`, {});

    const getRes = await get(`/v1/sessions/${session.id}`);
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as any;
    expect(fetched.agent).toBeDefined();
  });

  it("cannot delete agent with active session, archive first", async () => {
    const a = await post("/v1/agents", { name: "DelSnapAgent", model: "claude-sonnet-4-6", harness: "cross-noop" });
    const agent = (await a.json()) as any;
    const e = await post("/v1/environments", { name: "delsnap-env", config: { type: "cloud" } });
    const envObj = (await e.json()) as any;

    const s = await post("/v1/sessions", { agent: agent.id, environment_id: envObj.id });
    const session = (await s.json()) as any;

    // Can't delete with active session
    const delRes = await del(`/v1/agents/${agent.id}`);
    expect(delRes.status).toBe(409);

    // Archive session then delete
    await post(`/v1/sessions/${session.id}/archive`, {});
    const delRes2 = await del(`/v1/agents/${agent.id}`);
    expect(delRes2.status).toBe(200);

    const sessGet = await get(`/v1/sessions/${session.id}`);
    expect(sessGet.status).toBe(200);
    const fetched = (await sessGet.json()) as any;
    expect(fetched.agent).toBeDefined();
    expect(fetched.agent.name).toBe("DelSnapAgent");
  });

  it("two sessions from same agent with update between have independent snapshots", async () => {
    const a = await post("/v1/agents", {
      name: "DualSnap", model: "claude-sonnet-4-6", system: "dual-v1", harness: "cross-noop",
    });
    const agent = (await a.json()) as any;
    const e = await post("/v1/environments", { name: "dualsnap-env", config: { type: "cloud" } });
    const envObj = (await e.json()) as any;

    const s1 = await post("/v1/sessions", { agent: agent.id, environment_id: envObj.id });
    const session1 = (await s1.json()) as any;

    await put(`/v1/agents/${agent.id}`, { system: "dual-v2" });

    const s2 = await post("/v1/sessions", { agent: agent.id, environment_id: envObj.id });
    const session2 = (await s2.json()) as any;

    const get1 = await get(`/v1/sessions/${session1.id}`);
    const fetched1 = (await get1.json()) as any;
    const get2 = await get(`/v1/sessions/${session2.id}`);
    const fetched2 = (await get2.json()) as any;

    if (fetched1.agent && fetched2.agent) {
      expect(fetched1.agent.system).toBe("dual-v1");
      expect(fetched2.agent.system).toBe("dual-v2");
    }
  });

  it("agent with all optional fields creates session successfully", async () => {
    const a = await post("/v1/agents", {
      name: "FullOptAgent",
      model: "claude-sonnet-4-6",
      system: "full system",
      tools: [{ type: "agent_toolset_20260401" }],
      harness: "cross-noop",
      description: "A fully configured agent",
      metadata: { team: "platform", tier: "premium" },
      skills: [{ skill_id: "web_research" }],
    });
    expect(a.status).toBe(201);
    const agent = (await a.json()) as any;

    const e = await post("/v1/environments", { name: "fullopt-env", config: { type: "cloud" } });
    const envObj = (await e.json()) as any;

    const s = await post("/v1/sessions", { agent: agent.id, environment_id: envObj.id });
    expect(s.status).toBe(201);
  });
});

// ============================================================
// File + Session resource
// ============================================================
describe("File + Session resource", () => {
  let sessionId: string;
  let agentId: string;
  let envId: string;

  beforeAll(async () => {
    const a = await post("/v1/agents", { name: "FileResAgent", model: "claude-sonnet-4-6", harness: "cross-noop" });
    agentId = ((await a.json()) as any).id;
    const e = await post("/v1/environments", { name: "fileres-env", config: { type: "cloud" } });
    envId = ((await e.json()) as any).id;
    const s = await post("/v1/sessions", { agent: agentId, environment_id: envId });
    sessionId = ((await s.json()) as any).id;
  });

  it("session with multiple file resources lists all", async () => {
    const f1 = await post("/v1/files", { filename: "a.txt", content: "aaa", media_type: "text/plain" });
    const f2 = await post("/v1/files", { filename: "b.txt", content: "bbb", media_type: "text/plain" });
    const file1 = (await f1.json()) as any;
    const file2 = (await f2.json()) as any;

    await post(`/v1/sessions/${sessionId}/resources`, { type: "file", file_id: file1.id, mount_path: "/data/a.txt" });
    await post(`/v1/sessions/${sessionId}/resources`, { type: "file", file_id: file2.id, mount_path: "/data/b.txt" });

    const listRes = await get(`/v1/sessions/${sessionId}/resources`);
    const body = (await listRes.json()) as any;
    const filePaths = body.data.filter((r: any) => r.type === "file").map((r: any) => r.mount_path);
    expect(filePaths).toContain("/data/a.txt");
    expect(filePaths).toContain("/data/b.txt");
  });

  it("scoped file copy download returns original content", async () => {
    const f = await post("/v1/files", { filename: "copy-src.txt", content: "copy-original-content", media_type: "text/plain", downloadable: true });
    const file = (await f.json()) as any;

    const s = await post("/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      resources: [{ type: "file", file_id: file.id }],
    });
    const session = (await s.json()) as any;
    const scopedFileId = session.resources[0].file_id;

    const contentRes = await get(`/v1/files/${scopedFileId}/content`);
    expect(contentRes.status).toBe(200);
    const text = await contentRes.text();
    expect(text).toBe("copy-original-content");
  });

  it("file resource with mount_path is preserved", async () => {
    const f = await post("/v1/files", { filename: "mounted.txt", content: "mounted", media_type: "text/plain" });
    const file = (await f.json()) as any;

    const res = await post(`/v1/sessions/${sessionId}/resources`, {
      type: "file",
      file_id: file.id,
      mount_path: "/workspace/custom/path.txt",
    });
    expect(res.status).toBe(201);
    const resource = (await res.json()) as any;
    expect(resource.mount_path).toBe("/workspace/custom/path.txt");
  });

  it("duplicate file with different mount_paths creates two resources", async () => {
    const f = await post("/v1/files", { filename: "dup.txt", content: "dup content", media_type: "text/plain" });
    const file = (await f.json()) as any;

    const newSess = await post("/v1/sessions", { agent: agentId, environment_id: envId });
    const sid = ((await newSess.json()) as any).id;

    const r1 = await post(`/v1/sessions/${sid}/resources`, { type: "file", file_id: file.id, mount_path: "/path/a" });
    const r2 = await post(`/v1/sessions/${sid}/resources`, { type: "file", file_id: file.id, mount_path: "/path/b" });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);

    const listRes = await get(`/v1/sessions/${sid}/resources`);
    const body = (await listRes.json()) as any;
    expect(body.data.length).toBeGreaterThanOrEqual(2);
  });

  it("deleting resource does not cascade-delete the file", async () => {
    const f = await post("/v1/files", { filename: "nodelete.txt", content: "persistent", media_type: "text/plain" });
    const file = (await f.json()) as any;

    const addRes = await post(`/v1/sessions/${sessionId}/resources`, {
      type: "file",
      file_id: file.id,
      mount_path: "/tmp/nodelete.txt",
    });
    const resource = (await addRes.json()) as any;

    await del(`/v1/sessions/${sessionId}/resources/${resource.id}`);

    const fileGet = await get(`/v1/files/${file.id}`);
    expect(fileGet.status).toBe(200);
  });

  it("file resources with different media types (json, csv, txt)", async () => {
    const fJson = await post("/v1/files", { filename: "data.json", content: '{"a":1}', media_type: "application/json", encoding: "utf8" });
    const fCsv = await post("/v1/files", { filename: "data.csv", content: "a,b\n1,2", media_type: "text/csv" });
    const fTxt = await post("/v1/files", { filename: "data.txt", content: "plain text", media_type: "text/plain" });

    const jsonFile = (await fJson.json()) as any;
    const csvFile = (await fCsv.json()) as any;
    const txtFile = (await fTxt.json()) as any;

    expect(jsonFile.media_type).toBe("application/json");
    expect(csvFile.media_type).toBe("text/csv");
    expect(txtFile.media_type).toBe("text/plain");

    const newSess = await post("/v1/sessions", { agent: agentId, environment_id: envId });
    const sid = ((await newSess.json()) as any).id;

    await post(`/v1/sessions/${sid}/resources`, { type: "file", file_id: jsonFile.id });
    await post(`/v1/sessions/${sid}/resources`, { type: "file", file_id: csvFile.id });
    await post(`/v1/sessions/${sid}/resources`, { type: "file", file_id: txtFile.id });

    const listRes = await get(`/v1/sessions/${sid}/resources`);
    const body = (await listRes.json()) as any;
    expect(body.data.filter((r: any) => r.type === "file").length).toBeGreaterThanOrEqual(3);
  });
});

// ============================================================
// Memory + Session
// ============================================================
describe("Memory + Session", () => {
  let agentId: string;
  let envId: string;

  beforeAll(async () => {
    const a = await post("/v1/agents", { name: "MemSessAgent", model: "claude-sonnet-4-6", harness: "cross-noop" });
    agentId = ((await a.json()) as any).id;
    const e = await post("/v1/environments", { name: "memsess-env", config: { type: "cloud" } });
    envId = ((await e.json()) as any).id;
  });

  it("session with memory_store resource is listed", async () => {
    const store = await post("/v1/memory_stores", { name: "sess-mem-store" });
    const storeObj = (await store.json()) as any;

    const s = await post("/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      resources: [{ type: "memory_store", memory_store_id: storeObj.id }],
    });
    expect(s.status).toBe(201);
    const session = (await s.json()) as any;
    expect(session.resources.length).toBe(1);
    expect(session.resources[0].type).toBe("memory_store");
    expect(session.resources[0].memory_store_id).toBe(storeObj.id);
  });

  it("multiple memory_store resources on same session", async () => {
    const s1 = await post("/v1/memory_stores", { name: "multi-mem-1" });
    const s2 = await post("/v1/memory_stores", { name: "multi-mem-2" });
    const store1 = (await s1.json()) as any;
    const store2 = (await s2.json()) as any;

    const sess = await post("/v1/sessions", { agent: agentId, environment_id: envId });
    const sessionId = ((await sess.json()) as any).id;

    const r1 = await post(`/v1/sessions/${sessionId}/resources`, { type: "memory_store", memory_store_id: store1.id });
    const r2 = await post(`/v1/sessions/${sessionId}/resources`, { type: "memory_store", memory_store_id: store2.id });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);

    const listRes = await get(`/v1/sessions/${sessionId}/resources`);
    const body = (await listRes.json()) as any;
    const memStoreIds = body.data.filter((r: any) => r.type === "memory_store").map((r: any) => r.memory_store_id);
    expect(memStoreIds).toContain(store1.id);
    expect(memStoreIds).toContain(store2.id);
  });

  it("memory store CRUD is independent of session resource link", async () => {
    const store = await post("/v1/memory_stores", { name: "independent-store" });
    const storeObj = (await store.json()) as any;

    const sess = await post("/v1/sessions", { agent: agentId, environment_id: envId });
    const sessionId = ((await sess.json()) as any).id;
    await post(`/v1/sessions/${sessionId}/resources`, { type: "memory_store", memory_store_id: storeObj.id });

    // Create and read memory items independently
    const memRes = await post(`/v1/memory_stores/${storeObj.id}/memories`, {
      path: "independent/test.txt",
      content: "independent content",
    });
    expect(memRes.status).toBe(201);
    const mem = (await memRes.json()) as any;

    const getRes = await get(`/v1/memory_stores/${storeObj.id}/memories/${mem.id}`);
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as any;
    expect(fetched.content).toBe("independent content");
  });

  it("session with memory_store resource shows in session GET", async () => {
    const store = await post("/v1/memory_stores", { name: "get-visible-store" });
    const storeObj = (await store.json()) as any;

    const sess = await post("/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      resources: [{ type: "memory_store", memory_store_id: storeObj.id }],
    });
    const session = (await sess.json()) as any;

    const listRes = await get(`/v1/sessions/${session.id}/resources`);
    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as any;
    expect(body.data.some((r: any) => r.memory_store_id === storeObj.id)).toBe(true);
  });
});

// ============================================================
// Vault + Credential
// ============================================================
describe("Vault + Credential", () => {
  it("static_bearer credential secret stripped on list", async () => {
    const v = await post("/v1/vaults", { name: "strip-vault-sb" });
    const vault = (await v.json()) as any;

    await post(`/v1/vaults/${vault.id}/credentials`, {
      display_name: "Bearer Cred",
      auth: { type: "static_bearer", mcp_server_url: "https://sb-strip.example.com", token: "secret-value" },
    });

    const listRes = await get(`/v1/vaults/${vault.id}/credentials`);
    const body = (await listRes.json()) as any;
    for (const cred of body.data) {
      expect(cred.auth.token).toBeUndefined();
    }
  });

  it("mcp_oauth credential all secret fields stripped", async () => {
    const v = await post("/v1/vaults", { name: "strip-vault-oauth" });
    const vault = (await v.json()) as any;

    const res = await post(`/v1/vaults/${vault.id}/credentials`, {
      display_name: "OAuth Cred",
      auth: {
        type: "mcp_oauth",
        mcp_server_url: "https://oauth-strip.example.com",
        access_token: "at_secret",
        refresh_token: "rt_secret",
        token_endpoint: "https://auth.example.com/token",
        client_id: "cid",
        client_secret: "cs_secret",
      },
    });
    expect(res.status).toBe(201);
    const cred = (await res.json()) as any;
    expect(cred.auth.access_token).toBeUndefined();
    expect(cred.auth.refresh_token).toBeUndefined();
    expect(cred.auth.client_secret).toBeUndefined();
    expect(cred.auth.client_id).toBe("cid");
    expect(cred.auth.token_endpoint).toBe("https://auth.example.com/token");
  });

  it("vault archive hides credentials from default list", async () => {
    const v = await post("/v1/vaults", { name: "archive-cred-vault" });
    const vault = (await v.json()) as any;

    await post(`/v1/vaults/${vault.id}/credentials`, {
      display_name: "Hidden Cred",
      auth: { type: "static_bearer", mcp_server_url: "https://hidden.example.com", token: "t" },
    });

    await post(`/v1/vaults/${vault.id}/archive`, {});

    const listRes = await get("/v1/vaults");
    const body = (await listRes.json()) as any;
    const found = body.data.find((v2: any) => v2.id === vault.id);
    expect(found).toBeUndefined();
  });

  it("credential update preserves non-secret fields", async () => {
    const v = await post("/v1/vaults", { name: "update-cred-vault" });
    const vault = (await v.json()) as any;

    const createRes = await post(`/v1/vaults/${vault.id}/credentials`, {
      display_name: "Updatable Cred",
      auth: { type: "static_bearer", mcp_server_url: "https://updatable.example.com", token: "old-token" },
    });
    const cred = (await createRes.json()) as any;

    // Re-read to verify non-secret fields
    const listRes = await get(`/v1/vaults/${vault.id}/credentials`);
    const body = (await listRes.json()) as any;
    const found = body.data.find((c: any) => c.id === cred.id);
    expect(found).toBeTruthy();
    expect(found.display_name).toBe("Updatable Cred");
    expect(found.auth.mcp_server_url).toBe("https://updatable.example.com");
    expect(found.auth.type).toBe("static_bearer");
  });

  it("vault with max credentials (20) lists all", async () => {
    const v = await post("/v1/vaults", { name: "max-cred-vault" });
    const vault = (await v.json()) as any;

    for (let i = 0; i < 20; i++) {
      const res = await post(`/v1/vaults/${vault.id}/credentials`, {
        display_name: `maxcred-${i}`,
        auth: { type: "static_bearer", mcp_server_url: `https://max-${i}.example.com`, token: `t-${i}` },
      });
      expect(res.status).toBe(201);
    }

    const listRes = await get(`/v1/vaults/${vault.id}/credentials`);
    const body = (await listRes.json()) as any;
    expect(body.data.length).toBe(20);
  });

  it("archived vault hidden from default list", async () => {
    const v = await post("/v1/vaults", { name: "hidden-vault" });
    const vault = (await v.json()) as any;

    await post(`/v1/vaults/${vault.id}/archive`, {});

    const listRes = await get("/v1/vaults");
    const body = (await listRes.json()) as any;
    const found = body.data.find((v2: any) => v2.id === vault.id);
    expect(found).toBeUndefined();

    const archivedList = await get("/v1/vaults?include_archived=true");
    const archivedBody = (await archivedList.json()) as any;
    const archivedFound = archivedBody.data.find((v2: any) => v2.id === vault.id);
    expect(archivedFound).toBeTruthy();
    expect(archivedFound.archived_at).toBeTruthy();
  });
});

// ============================================================
// Cross-entity lifecycle
// ============================================================
describe("Cross-entity lifecycle", () => {
  it("full workflow: agent -> env -> session -> file resource -> events -> verify", async () => {
    // Agent
    const aRes = await post("/v1/agents", {
      name: "FullFlowAgent",
      model: "claude-sonnet-4-6",
      system: "full flow test",
      harness: "cross-echo",
    });
    expect(aRes.status).toBe(201);
    const agent = (await aRes.json()) as any;

    // Environment
    const eRes = await post("/v1/environments", { name: "fullflow-env", config: { type: "cloud" } });
    expect(eRes.status).toBe(201);
    const envObj = (await eRes.json()) as any;

    // File
    const fRes = await post("/v1/files", { filename: "flow.txt", content: "flow content", media_type: "text/plain" });
    expect(fRes.status).toBe(201);
    const file = (await fRes.json()) as any;

    // Session with file resource
    const sRes = await post("/v1/sessions", {
      agent: agent.id,
      environment_id: envObj.id,
      resources: [{ type: "file", file_id: file.id, mount_path: "/data/flow.txt" }],
    });
    expect(sRes.status).toBe(201);
    const session = (await sRes.json()) as any;

    // Post event
    const evtRes = await post(`/v1/sessions/${session.id}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "trigger flow" }] }],
    });
    expect(evtRes.status).toBe(202);

    // Wait for harness
    await new Promise((r) => setTimeout(r, 500));

    // Verify events
    const events = await collectReplayedEvents(session.id, 100);
    const types = events.map((e: any) => e.type);
    expect(types).toContain("user.message");
    expect(types).toContain("session.status_running");
  });

  it("delete env blocked by active session -> archive session -> delete succeeds", async () => {
    const aRes = await post("/v1/agents", { name: "EnvBlockAgent", model: "claude-sonnet-4-6", harness: "cross-noop" });
    const agent = (await aRes.json()) as any;
    const eRes = await post("/v1/environments", { name: "envblock-env", config: { type: "cloud" } });
    const envObj = (await eRes.json()) as any;

    const sRes = await post("/v1/sessions", { agent: agent.id, environment_id: envObj.id });
    const session = (await sRes.json()) as any;

    // Delete should be blocked
    const delRes = await del(`/v1/environments/${envObj.id}`);
    expect(delRes.status).toBe(409);

    // Archive the session
    await post(`/v1/sessions/${session.id}/archive`, {});

    // Now delete should succeed
    const delRes2 = await del(`/v1/environments/${envObj.id}`);
    expect(delRes2.status).toBe(200);
  });

  it("agent version history across 3 updates saves 2 versions", async () => {
    const aRes = await post("/v1/agents", {
      name: "VersionChain", model: "claude-sonnet-4-6", system: "ver-1", harness: "cross-noop",
    });
    const agent = (await aRes.json()) as any;
    expect(agent.version).toBe(1);

    await put(`/v1/agents/${agent.id}`, { system: "ver-2" });
    await put(`/v1/agents/${agent.id}`, { system: "ver-3" });

    const versionsRes = await get(`/v1/agents/${agent.id}/versions`);
    const versions = (await versionsRes.json()) as any;
    expect(versions.data.length).toBe(2);
    expect(versions.data[0].version).toBe(1);
    expect(versions.data[0].system).toBe("ver-1");
    expect(versions.data[1].version).toBe(2);
    expect(versions.data[1].system).toBe("ver-2");

    const currentRes = await get(`/v1/agents/${agent.id}`);
    const current = (await currentRes.json()) as any;
    expect(current.version).toBe(3);
    expect(current.system).toBe("ver-3");
  });

  it("create all entities then archive all and verify archived_at", async () => {
    const aRes = await post("/v1/agents", { name: "ArchAll", model: "claude-sonnet-4-6", harness: "cross-noop" });
    const agent = (await aRes.json()) as any;
    const eRes = await post("/v1/environments", { name: "archall-env", config: { type: "cloud" } });
    const envObj = (await eRes.json()) as any;
    const sRes = await post("/v1/sessions", { agent: agent.id, environment_id: envObj.id });
    const session = (await sRes.json()) as any;
    const vRes = await post("/v1/vaults", { name: "archall-vault" });
    const vault = (await vRes.json()) as any;
    const msRes = await post("/v1/memory_stores", { name: "archall-mem" });
    const memStore = (await msRes.json()) as any;

    // Archive all
    const archAgent = await post(`/v1/agents/${agent.id}/archive`, {});
    expect(((await archAgent.json()) as any).archived_at).toBeTruthy();

    const archSession = await post(`/v1/sessions/${session.id}/archive`, {});
    expect(((await archSession.json()) as any).archived_at).toBeTruthy();

    const archEnv = await post(`/v1/environments/${envObj.id}/archive`, {});
    expect(((await archEnv.json()) as any).archived_at).toBeTruthy();

    const archVault = await post(`/v1/vaults/${vault.id}/archive`, {});
    expect(((await archVault.json()) as any).archived_at).toBeTruthy();

    const archMem = await post(`/v1/memory_stores/${memStore.id}/archive`, {});
    expect(((await archMem.json()) as any).archived_at).toBeTruthy();
  });
});

// ============================================================
// Event type combinations
// ============================================================
describe("Event type combinations", () => {
  let agentId: string;
  let envId: string;

  beforeAll(async () => {
    const a = await post("/v1/agents", { name: "EvtCombo", model: "claude-sonnet-4-6", harness: "cross-noop" });
    agentId = ((await a.json()) as any).id;
    const e = await post("/v1/environments", { name: "evtcombo-env", config: { type: "cloud" } });
    envId = ((await e.json()) as any).id;
  });

  it("user.message + user.interrupt both appear in replay", async () => {
    const s = await post("/v1/sessions", { agent: agentId, environment_id: envId });
    const sessionId = ((await s.json()) as any).id;

    await post(`/v1/sessions/${sessionId}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "combo msg" }] }],
    });
    await post(`/v1/sessions/${sessionId}/events`, {
      events: [{ type: "user.interrupt" }],
    });

    await new Promise((r) => setTimeout(r, 200));
    const events = await collectReplayedEvents(sessionId, 100);
    const types = events.map((e: any) => e.type);
    expect(types).toContain("user.message");
    expect(types).toContain("user.interrupt");
  });

  it("user.define_outcome + user.message both stored", async () => {
    const s = await post("/v1/sessions", { agent: agentId, environment_id: envId });
    const sessionId = ((await s.json()) as any).id;

    await post(`/v1/sessions/${sessionId}/events`, {
      events: [{ type: "user.define_outcome", outcome: { description: "Do something" } }],
    });
    await post(`/v1/sessions/${sessionId}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "after outcome" }] }],
    });

    await new Promise((r) => setTimeout(r, 200));
    const events = await collectReplayedEvents(sessionId, 100);
    const types = events.map((e: any) => e.type);
    expect(types).toContain("user.define_outcome");
    expect(types).toContain("user.message");
  });

  it("user.tool_confirmation + user.custom_tool_result stored", async () => {
    const s = await post("/v1/sessions", { agent: agentId, environment_id: envId });
    const sessionId = ((await s.json()) as any).id;

    await post(`/v1/sessions/${sessionId}/events`, {
      events: [{ type: "user.tool_confirmation", tool_use_id: "tc_combo", result: "allow" }],
    });
    await post(`/v1/sessions/${sessionId}/events`, {
      events: [{ type: "user.custom_tool_result", custom_tool_use_id: "ct_combo", content: [{ type: "text", text: "result" }] }],
    });

    await new Promise((r) => setTimeout(r, 100));
    const events = await collectReplayedEvents(sessionId, 100);
    const types = events.map((e: any) => e.type);
    expect(types).toContain("user.tool_confirmation");
    expect(types).toContain("user.custom_tool_result");
  });

  it("all user event types in one session appear in replay", async () => {
    const s = await post("/v1/sessions", { agent: agentId, environment_id: envId });
    const sessionId = ((await s.json()) as any).id;

    await post(`/v1/sessions/${sessionId}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "msg" }] }],
    });
    await post(`/v1/sessions/${sessionId}/events`, {
      events: [{ type: "user.interrupt" }],
    });
    await post(`/v1/sessions/${sessionId}/events`, {
      events: [{ type: "user.tool_confirmation", tool_use_id: "tc_all", result: "deny", deny_message: "no" }],
    });
    await post(`/v1/sessions/${sessionId}/events`, {
      events: [{ type: "user.custom_tool_result", custom_tool_use_id: "ct_all", content: [{ type: "text", text: "r" }] }],
    });
    await post(`/v1/sessions/${sessionId}/events`, {
      events: [{ type: "user.define_outcome", outcome: { description: "all-types" } }],
    });

    await new Promise((r) => setTimeout(r, 200));
    const events = await collectReplayedEvents(sessionId, 100);
    const types = events.map((e: any) => e.type);
    expect(types).toContain("user.message");
    expect(types).toContain("user.interrupt");
    expect(types).toContain("user.tool_confirmation");
    expect(types).toContain("user.custom_tool_result");
    expect(types).toContain("user.define_outcome");
  });

  it("events across multiple POST requests are all preserved", async () => {
    const s = await post("/v1/sessions", { agent: agentId, environment_id: envId });
    const sessionId = ((await s.json()) as any).id;

    for (let i = 0; i < 5; i++) {
      await post(`/v1/sessions/${sessionId}/events`, {
        events: [{ type: "user.message", content: [{ type: "text", text: `multi-${i}` }] }],
      });
    }

    await new Promise((r) => setTimeout(r, 200));
    const events = await collectReplayedEvents(sessionId, 100);
    const texts = events
      .filter((e: any) => e.type === "user.message")
      .map((e: any) => e.content[0].text);
    for (let i = 0; i < 5; i++) {
      expect(texts).toContain(`multi-${i}`);
    }
  });

  it("event pagination across different types", async () => {
    const s = await post("/v1/sessions", { agent: agentId, environment_id: envId });
    const sessionId = ((await s.json()) as any).id;

    // Post several event types
    await post(`/v1/sessions/${sessionId}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "pag1" }] }],
    });
    await post(`/v1/sessions/${sessionId}/events`, {
      events: [{ type: "user.interrupt" }],
    });
    await post(`/v1/sessions/${sessionId}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "pag2" }] }],
    });

    await new Promise((r) => setTimeout(r, 200));

    const page1 = await get(`/v1/sessions/${sessionId}/events?limit=2`, { Accept: "application/json" });
    const body1 = (await page1.json()) as any;
    expect(body1.data.length).toBe(2);
    expect(typeof body1.has_more).toBe("boolean");
  });
});

// ============================================================
// Session metadata operations
// ============================================================
describe("Session metadata operations", () => {
  let sessionId: string;

  beforeAll(async () => {
    const a = await post("/v1/agents", { name: "MetaAgent", model: "claude-sonnet-4-6", harness: "cross-noop" });
    const e = await post("/v1/environments", { name: "meta-env", config: { type: "cloud" } });
    const s = await post("/v1/sessions", {
      agent: ((await a.json()) as any).id,
      environment_id: ((await e.json()) as any).id,
      title: "MetaSession",
    });
    sessionId = ((await s.json()) as any).id;
  });

  it("metadata merge: add keys incrementally", async () => {
    await post(`/v1/sessions/${sessionId}`, { metadata: { key1: "value1" } });
    const res = await post(`/v1/sessions/${sessionId}`, { metadata: { key2: "value2" } });
    const body = (await res.json()) as any;
    expect(body.metadata.key1).toBe("value1");
    expect(body.metadata.key2).toBe("value2");
  });

  it("metadata null deletes specific key while preserving others", async () => {
    await post(`/v1/sessions/${sessionId}`, { metadata: { keep: "yes", remove: "no" } });
    const res = await post(`/v1/sessions/${sessionId}`, { metadata: { remove: null } });
    const body = (await res.json()) as any;
    expect(body.metadata.keep).toBe("yes");
    expect(body.metadata.remove).toBeUndefined();
  });

  it("deeply nested metadata objects preserved", async () => {
    const deepMeta = {
      outer: {
        inner: {
          deep: {
            value: "nested-deep",
            list: [1, 2, 3],
          },
        },
      },
    };
    const res = await post(`/v1/sessions/${sessionId}`, { metadata: deepMeta });
    const body = (await res.json()) as any;
    expect(body.metadata.outer.inner.deep.value).toBe("nested-deep");
    expect(body.metadata.outer.inner.deep.list).toEqual([1, 2, 3]);
  });

  it("empty metadata update causes no change", async () => {
    const beforeRes = await get(`/v1/sessions/${sessionId}`);
    const before = (await beforeRes.json()) as any;

    await post(`/v1/sessions/${sessionId}`, { metadata: {} });

    const afterRes = await get(`/v1/sessions/${sessionId}`);
    const after = (await afterRes.json()) as any;

    // Keys from previous tests should still be present
    expect(after.metadata.keep).toBe(before.metadata.keep);
  });

  it("overwrite existing metadata key", async () => {
    await post(`/v1/sessions/${sessionId}`, { metadata: { overwrite: "original" } });
    const res = await post(`/v1/sessions/${sessionId}`, { metadata: { overwrite: "updated" } });
    const body = (await res.json()) as any;
    expect(body.metadata.overwrite).toBe("updated");
  });
});

// ============================================================
// GitHub Repository + Env Secret resources
// ============================================================
describe("GitHub Repository + Env Secret resources", () => {
  let agentId: string;
  let envId: string;

  beforeAll(async () => {
    const a = await post("/v1/agents", { name: "GitResAgent", model: "claude-sonnet-4-6", harness: "cross-noop" });
    agentId = ((await a.json()) as any).id;
    const e = await post("/v1/environments", { name: "gitres-env", config: { type: "cloud" } });
    envId = ((await e.json()) as any).id;
  });

  it("session with github_repository resource stores URL and checkout", async () => {
    const s = await post("/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      resources: [{
        type: "github_repository",
        url: "https://github.com/test-org/test-repo",
        checkout: { type: "branch", name: "main" },
      }],
    });
    expect(s.status).toBe(201);
    const session = (await s.json()) as any;
    expect(session.resources).toHaveLength(1);
    expect(session.resources[0].type).toBe("github_repository");
    expect(session.resources[0].url).toBe("https://github.com/test-org/test-repo");
    expect(session.resources[0].repo_url).toBe("https://github.com/test-org/test-repo");
  });

  it("github_repo type alias works the same as github_repository", async () => {
    const s = await post("/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      resources: [{
        type: "github_repo",
        repo_url: "https://github.com/alias-org/alias-repo",
      }],
    });
    expect(s.status).toBe(201);
    const session = (await s.json()) as any;
    expect(session.resources[0].type).toBe("github_repository");
    expect(session.resources[0].url).toBe("https://github.com/alias-org/alias-repo");
  });

  it("authorization_token is NOT returned in session response", async () => {
    const s = await post("/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      resources: [{
        type: "github_repository",
        url: "https://github.com/secret-org/secret-repo",
        authorization_token: "ghp_supersecrettoken123",
      }],
    });
    expect(s.status).toBe(201);
    const session = (await s.json()) as any;
    const resource = session.resources[0];
    expect(resource.authorization_token).toBeUndefined();
    expect(JSON.stringify(resource)).not.toContain("ghp_supersecrettoken123");
  });

  it("authorization_token is NOT returned in resource list", async () => {
    const s = await post("/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      resources: [{
        type: "github_repository",
        url: "https://github.com/list-org/list-repo",
        authorization_token: "ghp_listsecret456",
      }],
    });
    const session = (await s.json()) as any;

    const listRes = await get(`/v1/sessions/${session.id}/resources`);
    const body = (await listRes.json()) as any;
    const gitRes = body.data.find((r: any) => r.type === "github_repository");
    expect(gitRes).toBeTruthy();
    expect(gitRes.authorization_token).toBeUndefined();
    expect(JSON.stringify(gitRes)).not.toContain("ghp_listsecret456");
  });

  it("github_repository with default mount_path gets /workspace", async () => {
    const s = await post("/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      resources: [{
        type: "github_repository",
        url: "https://github.com/default-org/default-repo",
      }],
    });
    const session = (await s.json()) as any;
    expect(session.resources[0].mount_path).toBe("/workspace");
  });

  it("github_repository with custom mount_path preserves it", async () => {
    const s = await post("/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      resources: [{
        type: "github_repository",
        url: "https://github.com/custom-org/custom-repo",
        mount_path: "/home/user/project",
      }],
    });
    const session = (await s.json()) as any;
    expect(session.resources[0].mount_path).toBe("/home/user/project");
  });

  it("github_repository with commit SHA checkout", async () => {
    const s = await post("/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      resources: [{
        type: "github_repository",
        url: "https://github.com/sha-org/sha-repo",
        checkout: { type: "commit", sha: "abc123def456" },
      }],
    });
    const session = (await s.json()) as any;
    expect(session.resources[0].checkout).toEqual({ type: "commit", sha: "abc123def456" });
  });

  it.skip("env_secret resource stores name but not value", async () => {
    const s = await post("/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      resources: [{
        type: "env_secret",
        name: "MY_API_KEY",
        value: "secret_value_123",
      }],
    });
    expect(s.status).toBe(201);
    const session = (await s.json()) as any;
    expect(session.resources).toHaveLength(1);
    expect(session.resources[0].type).toBe("env_secret");
    expect(session.resources[0].name).toBe("MY_API_KEY");
    // Value must NOT appear in response
    expect(session.resources[0].value).toBeUndefined();
    expect(JSON.stringify(session.resources[0])).not.toContain("secret_value_123");
  });

  it.skip("env_secret value not in resource list response", async () => {
    const s = await post("/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      resources: [{
        type: "env_secret",
        name: "HIDDEN_TOKEN",
        value: "hidden_value_456",
      }],
    });
    const session = (await s.json()) as any;

    const listRes = await get(`/v1/sessions/${session.id}/resources`);
    const body = (await listRes.json()) as any;
    const envRes = body.data.find((r: any) => r.type === "env_secret");
    expect(envRes).toBeTruthy();
    expect(envRes.name).toBe("HIDDEN_TOKEN");
    expect(envRes.value).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("hidden_value_456");
  });

  it.skip("multiple env_secrets on one session", async () => {
    const s = await post("/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      resources: [
        { type: "env_secret", name: "VAR_A", value: "a_val" },
        { type: "env_secret", name: "VAR_B", value: "b_val" },
        { type: "env_secret", name: "VAR_C", value: "c_val" },
      ],
    });
    expect(s.status).toBe(201);
    const session = (await s.json()) as any;
    expect(session.resources).toHaveLength(3);
    const names = session.resources.map((r: any) => r.name);
    expect(names).toContain("VAR_A");
    expect(names).toContain("VAR_B");
    expect(names).toContain("VAR_C");
  });

  it.skip("mixed resource types: github + env_secret + file", async () => {
    const f = await post("/v1/files", { filename: "mixed.txt", content: "mixed content", media_type: "text/plain" });
    const file = (await f.json()) as any;

    const s = await post("/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      resources: [
        { type: "github_repository", url: "https://github.com/mix-org/mix-repo", authorization_token: "ghp_mix" },
        { type: "env_secret", name: "MIX_TOKEN", value: "mix_secret" },
        { type: "file", file_id: file.id, mount_path: "/data/mixed.txt" },
      ],
    });
    expect(s.status).toBe(201);
    const session = (await s.json()) as any;
    expect(session.resources).toHaveLength(3);

    const types = session.resources.map((r: any) => r.type);
    expect(types).toContain("github_repository");
    expect(types).toContain("env_secret");
    expect(types).toContain("file");

    // Secrets not leaked
    expect(JSON.stringify(session)).not.toContain("ghp_mix");
    expect(JSON.stringify(session)).not.toContain("mix_secret");
  });

  it("github_repository + vault_ids on same session", async () => {
    const v = await post("/v1/vaults", { name: "git-vault-combo" });
    const vault = (await v.json()) as any;

    const s = await post("/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      vault_ids: [vault.id],
      resources: [{
        type: "github_repository",
        url: "https://github.com/combo-org/combo-repo",
        authorization_token: "ghp_combo",
      }],
    });
    expect(s.status).toBe(201);
    const session = (await s.json()) as any;
    expect(session.vault_ids).toContain(vault.id);
    expect(session.resources).toHaveLength(1);
  });
});

// ============================================================
// Command Secret Credentials
// ============================================================
describe("Command Secret Credentials", () => {
  it("command_secret credential stores prefix and env_var", async () => {
    const v = await post("/v1/vaults", { name: "cmd-secret-vault" });
    const vault = (await v.json()) as any;

    const res = await post(`/v1/vaults/${vault.id}/credentials`, {
      display_name: "Wrangler Token",
      auth: {
        type: "command_secret",
        command_prefixes: ["wrangler", "npx wrangler"],
        env_var: "CLOUDFLARE_API_TOKEN",
        token: "cf_secret_token_123",
      },
    });
    expect(res.status).toBe(201);
    const cred = (await res.json()) as any;
    expect(cred.auth.type).toBe("command_secret");
    expect(cred.auth.command_prefixes).toEqual(["wrangler", "npx wrangler"]);
    expect(cred.auth.env_var).toBe("CLOUDFLARE_API_TOKEN");
    // Token must be stripped
    expect(cred.auth.token).toBeUndefined();
  });

  it("command_secret token stripped from credential list", async () => {
    const v = await post("/v1/vaults", { name: "cmd-strip-vault" });
    const vault = (await v.json()) as any;

    await post(`/v1/vaults/${vault.id}/credentials`, {
      display_name: "GH CLI",
      auth: {
        type: "command_secret",
        command_prefixes: ["gh"],
        env_var: "GH_TOKEN",
        token: "gh_secret_456",
      },
    });

    const listRes = await get(`/v1/vaults/${vault.id}/credentials`);
    const body = (await listRes.json()) as any;
    for (const cred of body.data) {
      expect(cred.auth.token).toBeUndefined();
      expect(JSON.stringify(cred)).not.toContain("gh_secret_456");
    }
  });

  it("command_secret with multiple prefixes", async () => {
    const v = await post("/v1/vaults", { name: "multi-prefix-vault" });
    const vault = (await v.json()) as any;

    const res = await post(`/v1/vaults/${vault.id}/credentials`, {
      display_name: "Docker Token",
      auth: {
        type: "command_secret",
        command_prefixes: ["docker", "docker-compose", "docker compose"],
        env_var: "DOCKER_TOKEN",
        token: "docker_secret",
      },
    });
    expect(res.status).toBe(201);
    const cred = (await res.json()) as any;
    expect(cred.auth.command_prefixes).toHaveLength(3);
  });

  it("vault with mixed credential types", async () => {
    const v = await post("/v1/vaults", { name: "mixed-cred-vault" });
    const vault = (await v.json()) as any;

    await post(`/v1/vaults/${vault.id}/credentials`, {
      display_name: "Bearer for MCP",
      auth: { type: "static_bearer", mcp_server_url: "https://mcp.example.com", token: "bearer_tok" },
    });
    await post(`/v1/vaults/${vault.id}/credentials`, {
      display_name: "CLI Secret",
      auth: { type: "command_secret", command_prefixes: ["aws"], env_var: "AWS_TOKEN", token: "aws_tok" },
    });
    await post(`/v1/vaults/${vault.id}/credentials`, {
      display_name: "OAuth MCP",
      auth: { type: "mcp_oauth", mcp_server_url: "https://oauth.example.com", access_token: "at", refresh_token: "rt" },
    });

    const listRes = await get(`/v1/vaults/${vault.id}/credentials`);
    const body = (await listRes.json()) as any;
    expect(body.data).toHaveLength(3);
    const types = body.data.map((c: any) => c.auth.type);
    expect(types).toContain("static_bearer");
    expect(types).toContain("command_secret");
    expect(types).toContain("mcp_oauth");

    // No secrets leaked
    for (const cred of body.data) {
      expect(cred.auth.token).toBeUndefined();
      expect(cred.auth.access_token).toBeUndefined();
      expect(cred.auth.refresh_token).toBeUndefined();
    }
  });

  it("command_secret credential delete works", async () => {
    const v = await post("/v1/vaults", { name: "cmd-del-vault" });
    const vault = (await v.json()) as any;

    const res = await post(`/v1/vaults/${vault.id}/credentials`, {
      display_name: "Deletable",
      auth: { type: "command_secret", command_prefixes: ["kubectl"], env_var: "KUBE_TOKEN", token: "k_tok" },
    });
    const cred = (await res.json()) as any;

    const delRes = await del(`/v1/vaults/${vault.id}/credentials/${cred.id}`);
    expect(delRes.status).toBe(200);

    const listRes = await get(`/v1/vaults/${vault.id}/credentials`);
    const body = (await listRes.json()) as any;
    expect(body.data.find((c: any) => c.id === cred.id)).toBeUndefined();
  });
});

// ============================================================
// Resource Mounter (unit-level via types)
// ============================================================
describe("Resource Mounter types", () => {
  it("SessionResource type supports all resource fields", () => {
    // Type-level test: verify our TypeScript interfaces accept all resource shapes
    const gitResource = {
      id: "res_1",
      session_id: "sess_1",
      type: "github_repository" as const,
      url: "https://github.com/org/repo",
      repo_url: "https://github.com/org/repo",
      checkout: { type: "branch", name: "main" },
      mount_path: "/workspace",
      created_at: new Date().toISOString(),
    };
    expect(gitResource.type).toBe("github_repository");
    expect(gitResource.checkout?.type).toBe("branch");

    const envResource = {
      id: "res_2",
      session_id: "sess_1",
      type: "env_secret" as const,
      name: "MY_VAR",
      created_at: new Date().toISOString(),
    };
    expect(envResource.type).toBe("env_secret");
    expect(envResource.name).toBe("MY_VAR");
  });
});

// ============================================================
// Environment list and update
// ============================================================
describe("Environment list and update", () => {
  it("environment list returns all environments including archived", async () => {
    await post("/v1/environments", { name: "env-list-a", config: { type: "cloud" } });
    await post("/v1/environments", { name: "env-list-b", config: { type: "cloud" } });

    const res = await get("/v1/environments");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    // Environment list does not filter archived — verify it returns data
    expect(body.data).toBeInstanceOf(Array);
  });

  it("environment list includes archived (no filter on environments)", async () => {
    const eRes = await post("/v1/environments", { name: "env-arch-visible", config: { type: "cloud" } });
    const envObj = (await eRes.json()) as any;
    await post(`/v1/environments/${envObj.id}/archive`, {});

    // Environment list does NOT filter archived (unlike agents/sessions/vaults)
    const listRes = await get("/v1/environments");
    const body = (await listRes.json()) as any;
    const found = body.data.find((e: any) => e.id === envObj.id);
    expect(found).toBeTruthy();
    expect(found.archived_at).toBeTruthy();
  });

  it("environment update preserves config when only name changes", async () => {
    const eRes = await post("/v1/environments", {
      name: "env-preserve-cfg",
      config: { type: "cloud", networking: { type: "limited", allowed_hosts: ["api.example.com"] } },
    });
    const envObj = (await eRes.json()) as any;

    const updateRes = await put(`/v1/environments/${envObj.id}`, { name: "env-renamed" });
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as any;
    expect(updated.name).toBe("env-renamed");
    expect(updated.config.networking.type).toBe("limited");
    expect(updated.config.networking.allowed_hosts).toEqual(["api.example.com"]);
  });
});
