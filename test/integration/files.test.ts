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
function get(path: string, extraHeaders?: Record<string, string>) {
  return api(path, { headers: { ...H, ...extraHeaders } });
}
function del(path: string) {
  return api(path, { method: "DELETE", headers: H });
}

// Register test harness
registerHarness("files-test", () => ({ async run() {} }));

// ============================================================
// File Upload (JSON body)
// ============================================================
describe("File upload", () => {
  it("uploads a file via JSON body", async () => {
    const res = await post("/v1/files", {
      filename: "data.csv",
      content: "col1,col2\n1,2",
      media_type: "text/csv",
    });
    expect(res.status).toBe(201);
    const file = (await res.json()) as any;
    expect(file.id).toMatch(/^file_/);
    expect(file.filename).toBe("data.csv");
    expect(file.media_type).toBe("text/csv");
    expect(file.size_bytes).toBe(new TextEncoder().encode("col1,col2\n1,2").length);
    expect(file.created_at).toBeTruthy();
  });

  it("defaults media_type to application/octet-stream", async () => {
    const res = await post("/v1/files", {
      filename: "unknown.bin",
      content: "binary-ish",
    });
    expect(res.status).toBe(201);
    const file = (await res.json()) as any;
    expect(file.media_type).toBe("application/octet-stream");
  });

  it("rejects upload without filename", async () => {
    const res = await post("/v1/files", { content: "data" });
    expect(res.status).toBe(400);
  });

  it("rejects upload without content", async () => {
    const res = await post("/v1/files", { filename: "empty.txt" });
    expect(res.status).toBe(400);
  });

  it("uploads a file with scope_id", async () => {
    const res = await post("/v1/files", {
      filename: "scoped.txt",
      content: "scoped content",
      scope_id: "sess_abc123",
    });
    expect(res.status).toBe(201);
    const file = (await res.json()) as any;
    expect(file.scope_id).toBe("sess_abc123");
  });

  it("accepts empty string as content", async () => {
    const res = await post("/v1/files", {
      filename: "empty-content.txt",
      content: "",
      media_type: "text/plain",
    });
    expect(res.status).toBe(201);
    const file = (await res.json()) as any;
    expect(file.size_bytes).toBe(0);
  });
});

// ============================================================
// File List
// ============================================================
describe("File list", () => {
  let scopedFileId: string;

  beforeAll(async () => {
    // Create files for listing
    await post("/v1/files", { filename: "list1.txt", content: "one" });
    await post("/v1/files", { filename: "list2.txt", content: "two" });
    const scopedRes = await post("/v1/files", {
      filename: "list-scoped.txt",
      content: "scoped",
      scope_id: "sess_filtertest",
    });
    scopedFileId = ((await scopedRes.json()) as any).id;
  });

  it("lists all files", async () => {
    const res = await get("/v1/files");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data).toBeInstanceOf(Array);
    expect(body.data.length).toBeGreaterThanOrEqual(2);
  });

  it("filters by scope_id", async () => {
    const res = await get("/v1/files?scope_id=sess_filtertest");
    const body = (await res.json()) as any;
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data.every((f: any) => f.scope_id === "sess_filtertest")).toBe(true);
  });

  it("limits results", async () => {
    const res = await get("/v1/files?limit=1");
    const body = (await res.json()) as any;
    expect(body.data.length).toBe(1);
  });

  it("orders ascending", async () => {
    const res = await get("/v1/files?order=asc&limit=50");
    const body = (await res.json()) as any;
    for (let i = 1; i < body.data.length; i++) {
      expect(body.data[i].created_at >= body.data[i - 1].created_at).toBe(true);
    }
  });
});

// ============================================================
// File Get Metadata
// ============================================================
describe("File get metadata", () => {
  it("retrieves file metadata by id", async () => {
    const createRes = await post("/v1/files", {
      filename: "meta.json",
      content: '{"key":"value"}',
      media_type: "application/json",
    });
    const file = (await createRes.json()) as any;

    const res = await get(`/v1/files/${file.id}`);
    expect(res.status).toBe(200);
    const fetched = (await res.json()) as any;
    expect(fetched.id).toBe(file.id);
    expect(fetched.filename).toBe("meta.json");
    expect(fetched.media_type).toBe("application/json");
  });

  it("returns 404 for nonexistent file", async () => {
    const res = await get("/v1/files/file_nonexistent");
    expect(res.status).toBe(404);
  });
});

// ============================================================
// File Download Content
// ============================================================
describe("File download content", () => {
  it("downloads file content with correct Content-Type", async () => {
    const createRes = await post("/v1/files", {
      filename: "hello.txt",
      content: "Hello, world!",
      media_type: "text/plain",
    });
    const file = (await createRes.json()) as any;

    const res = await get(`/v1/files/${file.id}/content`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain");
    const text = await res.text();
    expect(text).toBe("Hello, world!");
  });

  it("returns 404 for content of nonexistent file", async () => {
    const res = await get("/v1/files/file_nonexistent/content");
    expect(res.status).toBe(404);
  });
});

// ============================================================
// File Delete
// ============================================================
describe("File delete", () => {
  it("deletes a file and its content", async () => {
    const createRes = await post("/v1/files", {
      filename: "to-delete.txt",
      content: "delete me",
    });
    const file = (await createRes.json()) as any;

    const delRes = await del(`/v1/files/${file.id}`);
    expect(delRes.status).toBe(200);
    const body = (await delRes.json()) as any;
    expect(body.type).toBe("file_deleted");
    expect(body.id).toBe(file.id);

    // Verify gone
    const getRes = await get(`/v1/files/${file.id}`);
    expect(getRes.status).toBe(404);

    // Content should be gone too
    const contentRes = await get(`/v1/files/${file.id}/content`);
    expect(contentRes.status).toBe(404);
  });

  it("returns 404 for deleting nonexistent file", async () => {
    const res = await del("/v1/files/file_nonexistent");
    expect(res.status).toBe(404);
  });
});

// ============================================================
// Session Resource Add / List / Delete
// ============================================================
describe("Session resource add/list/delete", () => {
  let sessionId: string;
  let fileId: string;

  beforeAll(async () => {
    // Create agent + env + session
    const a = await post("/v1/agents", { name: "ResAgent", model: "claude-sonnet-4-6", harness: "files-test" });
    const e = await post("/v1/environments", { name: "res-env", config: { type: "cloud" } });
    const s = await post("/v1/sessions", {
      agent: ((await a.json()) as any).id,
      environment_id: ((await e.json()) as any).id,
      title: "Resource Test",
    });
    sessionId = ((await s.json()) as any).id;

    // Create a file
    const f = await post("/v1/files", {
      filename: "resource.txt",
      content: "resource content",
      media_type: "text/plain",
    });
    fileId = ((await f.json()) as any).id;
  });

  it("adds a file resource to session", async () => {
    const res = await post(`/v1/sessions/${sessionId}/resources`, {
      type: "file",
      file_id: fileId,
      mount_path: "/workspace/resource.txt",
    });
    expect(res.status).toBe(201);
    const resource = (await res.json()) as any;
    expect(resource.id).toMatch(/^sesrsc_/);
    expect(resource.session_id).toBe(sessionId);
    expect(resource.type).toBe("file");
    expect(resource.file_id).toBe(fileId);
    expect(resource.mount_path).toBe("/workspace/resource.txt");
  });

  it("adds a memory_store resource", async () => {
    const res = await post(`/v1/sessions/${sessionId}/resources`, {
      type: "memory_store",
      memory_store_id: "memstore_abc123",
    });
    expect(res.status).toBe(201);
    const resource = (await res.json()) as any;
    expect(resource.type).toBe("memory_store");
    expect(resource.memory_store_id).toBe("memstore_abc123");
  });

  it("lists resources for session", async () => {
    const res = await get(`/v1/sessions/${sessionId}/resources`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data).toBeInstanceOf(Array);
    expect(body.data.length).toBeGreaterThanOrEqual(2);
  });

  it("deletes a resource", async () => {
    // Add a resource first
    const addRes = await post(`/v1/sessions/${sessionId}/resources`, {
      type: "file",
      file_id: fileId,
      mount_path: "/tmp/todelete.txt",
    });
    const resource = (await addRes.json()) as any;

    const delRes = await del(`/v1/sessions/${sessionId}/resources/${resource.id}`);
    expect(delRes.status).toBe(200);
    const body = (await delRes.json()) as any;
    expect(body.type).toBe("resource_deleted");
    expect(body.id).toBe(resource.id);
  });

  it("returns 404 for resource on nonexistent session", async () => {
    const res = await post("/v1/sessions/sess_ghost/resources", {
      type: "file",
      file_id: fileId,
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for listing resources on nonexistent session", async () => {
    const res = await get("/v1/sessions/sess_ghost/resources");
    expect(res.status).toBe(404);
  });

  it("returns 404 for deleting nonexistent resource", async () => {
    const res = await del(`/v1/sessions/${sessionId}/resources/sesrsc_nonexistent`);
    expect(res.status).toBe(404);
  });

  it("rejects resource without type", async () => {
    const res = await post(`/v1/sessions/${sessionId}/resources`, {
      file_id: fileId,
    });
    expect(res.status).toBe(400);
  });

  it("rejects file resource without file_id", async () => {
    const res = await post(`/v1/sessions/${sessionId}/resources`, {
      type: "file",
    });
    expect(res.status).toBe(400);
  });

  it("rejects memory_store resource without memory_store_id", async () => {
    const res = await post(`/v1/sessions/${sessionId}/resources`, {
      type: "memory_store",
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when file_id does not exist", async () => {
    const res = await post(`/v1/sessions/${sessionId}/resources`, {
      type: "file",
      file_id: "file_nonexistent",
    });
    expect(res.status).toBe(404);
  });
});

// ============================================================
// Session Creation with Resources
// ============================================================
describe("Session creation with resources", () => {
  let agentId: string;
  let envId: string;
  let fileId: string;

  beforeAll(async () => {
    const a = await post("/v1/agents", { name: "WithRes", model: "claude-sonnet-4-6", harness: "files-test" });
    agentId = ((await a.json()) as any).id;
    const e = await post("/v1/environments", { name: "withres-env", config: { type: "cloud" } });
    envId = ((await e.json()) as any).id;

    // Create a file to attach
    const f = await post("/v1/files", {
      filename: "init-file.txt",
      content: "initial content",
      media_type: "text/plain",
    });
    fileId = ((await f.json()) as any).id;
  });

  it("creates session with file resources", async () => {
    const res = await post("/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      title: "With Resources",
      resources: [
        { type: "file", file_id: fileId, mount_path: "/workspace/init-file.txt" },
      ],
    });
    expect(res.status).toBe(201);
    const session = (await res.json()) as any;
    expect(session.id).toMatch(/^sess_/);
    expect(session.resources).toBeInstanceOf(Array);
    expect(session.resources.length).toBe(1);
    expect(session.resources[0].type).toBe("file");
    expect(session.resources[0].mount_path).toBe("/workspace/init-file.txt");
    // The file_id should be a new scoped copy, not the original
    expect(session.resources[0].file_id).not.toBe(fileId);
    expect(session.resources[0].file_id).toMatch(/^file_/);
  });

  it("scoped file copy has session scope_id", async () => {
    const res = await post("/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      resources: [{ type: "file", file_id: fileId }],
    });
    const session = (await res.json()) as any;
    const scopedFileId = session.resources[0].file_id;

    // Check the scoped file has scope_id = session ID
    const fileRes = await get(`/v1/files/${scopedFileId}`);
    expect(fileRes.status).toBe(200);
    const file = (await fileRes.json()) as any;
    expect(file.scope_id).toBe(session.id);
  });

  it("scoped file copy preserves content", async () => {
    const res = await post("/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      resources: [{ type: "file", file_id: fileId }],
    });
    const session = (await res.json()) as any;
    const scopedFileId = session.resources[0].file_id;

    const contentRes = await get(`/v1/files/${scopedFileId}/content`);
    expect(contentRes.status).toBe(200);
    const content = await contentRes.text();
    expect(content).toBe("initial content");
  });

  it("session creation without resources does not include resources field", async () => {
    const res = await post("/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      title: "No Resources",
    });
    const session = (await res.json()) as any;
    expect(session.resources).toBeUndefined();
  });

  it("resources listing shows resources created at session creation", async () => {
    const res = await post("/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      resources: [{ type: "file", file_id: fileId, mount_path: "/data.txt" }],
    });
    const session = (await res.json()) as any;

    const listRes = await get(`/v1/sessions/${session.id}/resources`);
    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as any;
    expect(body.data.length).toBe(1);
    expect(body.data[0].mount_path).toBe("/data.txt");
  });

  it("skips nonexistent file resources silently", async () => {
    const res = await post("/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      resources: [{ type: "file", file_id: "file_nonexistent" }],
    });
    expect(res.status).toBe(201);
    const session = (await res.json()) as any;
    // No resources should be created since the file doesn't exist
    expect(session.resources).toBeUndefined();
  });

  it("creates session with memory_store resources", async () => {
    const res = await post("/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      resources: [{ type: "memory_store", memory_store_id: "memstore_test123" }],
    });
    expect(res.status).toBe(201);
    const session = (await res.json()) as any;
    expect(session.resources.length).toBe(1);
    expect(session.resources[0].type).toBe("memory_store");
    expect(session.resources[0].memory_store_id).toBe("memstore_test123");
  });
});

// ============================================================
// File Scoping by Session
// ============================================================
describe("File scoping by session", () => {
  it("files scoped to a session appear in scope_id filter", async () => {
    // Create a file scoped to a specific session
    const res = await post("/v1/files", {
      filename: "session-scoped.txt",
      content: "session data",
      scope_id: "sess_scope_test_123",
    });
    expect(res.status).toBe(201);

    // Filter should return it
    const listRes = await get("/v1/files?scope_id=sess_scope_test_123");
    const body = (await listRes.json()) as any;
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data.every((f: any) => f.scope_id === "sess_scope_test_123")).toBe(true);

    // Different scope should not return it
    const otherRes = await get("/v1/files?scope_id=sess_other");
    const otherBody = (await otherRes.json()) as any;
    const ids = otherBody.data.map((f: any) => f.id);
    const thisFile = (await res.json) as any;
    // Just verify no files from this scope leak into another
    expect(otherBody.data.every((f: any) => f.scope_id === "sess_other")).toBe(true);
  });
});
