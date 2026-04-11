// @ts-nocheck
import { env, exports } from "cloudflare:workers";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { registerHarness } from "../../apps/agent/src/harness/registry";
import type { HarnessContext } from "../../apps/agent/src/harness/interface";
import { isRateLimited, windows } from "../../apps/main/src/rate-limit";

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

// Register test harness
registerHarness("parity-noop", () => ({ async run() {} }));
registerHarness("parity-echo", () => ({
  async run(ctx: HarnessContext) {
    ctx.runtime.broadcast({
      type: "agent.message",
      content: [{ type: "text", text: "parity echo" }],
    });
  },
}));

// ============================================================
// Rate Limiting — unit tests on isRateLimited
// ============================================================
describe("Rate limiting", () => {
  beforeEach(() => {
    windows.clear();
  });

  it("allows requests under the limit", () => {
    for (let i = 0; i < 5; i++) {
      expect(isRateLimited("test-key", 5, 60000)).toBe(false);
    }
  });

  it("blocks requests over the limit", () => {
    for (let i = 0; i < 5; i++) {
      isRateLimited("block-key", 5, 60000);
    }
    expect(isRateLimited("block-key", 5, 60000)).toBe(true);
  });

  it("uses separate buckets for different keys", () => {
    for (let i = 0; i < 3; i++) {
      isRateLimited("key-a", 3, 60000);
    }
    expect(isRateLimited("key-a", 3, 60000)).toBe(true);
    expect(isRateLimited("key-b", 3, 60000)).toBe(false);
  });

  it("rate limit middleware is wired — normal requests succeed", async () => {
    const res = await get("/v1/agents");
    expect(res.status).toBe(200);
  });
});

// ============================================================
// user.define_outcome event type
// ============================================================
describe("user.define_outcome event", () => {
  let sessionId: string;

  beforeAll(async () => {
    const a = await post("/v1/agents", {
      name: "OutcomeAgent",
      model: "claude-sonnet-4-6",
      harness: "parity-noop",
    });
    const e = await post("/v1/environments", {
      name: "outcome-env",
      config: { type: "cloud" },
    });
    const s = await post("/v1/sessions", {
      agent: ((await a.json()) as any).id,
      environment_id: ((await e.json()) as any).id,
    });
    sessionId = ((await s.json()) as any).id;
  });

  it("accepts user.define_outcome event", async () => {
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

  it("accepts user.define_outcome with criteria", async () => {
    const res = await post(`/v1/sessions/${sessionId}/events`, {
      events: [
        {
          type: "user.define_outcome",
          outcome: {
            description: "Build a REST API",
            criteria: ["Has GET /health", "Returns JSON"],
          },
        },
      ],
    });
    expect(res.status).toBe(202);
  });

  it("define_outcome events appear in event replay", async () => {
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
      }, 100);
    });

    const outcomeEvents = events.filter(
      (e) => e.type === "user.define_outcome"
    );
    expect(outcomeEvents.length).toBe(2);
    expect(outcomeEvents[0].outcome.description).toBe(
      "Create a working fibonacci script"
    );
    expect(outcomeEvents[1].outcome.criteria).toEqual([
      "Has GET /health",
      "Returns JSON",
    ]);
  });
});

// ============================================================
// Vaults CRUD
// ============================================================
describe("Vaults CRUD", () => {
  it("creates a vault", async () => {
    const res = await post("/v1/vaults", { name: "Test Vault" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.id).toMatch(/^vlt-/);
    expect(body.name).toBe("Test Vault");
    expect(body.created_at).toBeTruthy();
  });

  it("rejects vault without name", async () => {
    const res = await post("/v1/vaults", {});
    expect(res.status).toBe(400);
  });

  it("lists vaults", async () => {
    // Create one to be sure
    await post("/v1/vaults", { name: "List Vault" });
    const res = await get("/v1/vaults");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data).toBeInstanceOf(Array);
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("gets vault by id", async () => {
    const createRes = await post("/v1/vaults", { name: "Get Vault" });
    const vault = (await createRes.json()) as any;
    const res = await get(`/v1/vaults/${vault.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBe(vault.id);
    expect(body.name).toBe("Get Vault");
  });

  it("returns 404 for nonexistent vault", async () => {
    const res = await get("/v1/vaults/vlt_nonexistent");
    expect(res.status).toBe(404);
  });

  it("archives vault", async () => {
    const createRes = await post("/v1/vaults", { name: "Archive Vault" });
    const vault = (await createRes.json()) as any;
    const res = await post(`/v1/vaults/${vault.id}/archive`, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.archived_at).toBeTruthy();
  });

  it("deletes vault", async () => {
    const createRes = await post("/v1/vaults", { name: "Delete Vault" });
    const vault = (await createRes.json()) as any;
    const res = await del(`/v1/vaults/${vault.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.type).toBe("vault_deleted");

    // Verify it's gone
    const getRes = await get(`/v1/vaults/${vault.id}`);
    expect(getRes.status).toBe(404);
  });

  it("excludes archived vaults by default", async () => {
    const createRes = await post("/v1/vaults", { name: "Archived Vault" });
    const vault = (await createRes.json()) as any;
    await post(`/v1/vaults/${vault.id}/archive`, {});

    const listRes = await get("/v1/vaults");
    const body = (await listRes.json()) as any;
    const archivedInList = body.data.find((v: any) => v.id === vault.id);
    expect(archivedInList).toBeUndefined();
  });

  it("includes archived vaults when requested", async () => {
    const createRes = await post("/v1/vaults", {
      name: "Archived Vault Include",
    });
    const vault = (await createRes.json()) as any;
    await post(`/v1/vaults/${vault.id}/archive`, {});

    const listRes = await get("/v1/vaults?include_archived=true");
    const body = (await listRes.json()) as any;
    const found = body.data.find((v: any) => v.id === vault.id);
    expect(found).toBeTruthy();
    expect(found.archived_at).toBeTruthy();
  });
});

// ============================================================
// Credentials CRUD
// ============================================================
describe("Credentials CRUD", () => {
  let vaultId: string;

  beforeAll(async () => {
    const res = await post("/v1/vaults", { name: "Cred Vault" });
    vaultId = ((await res.json()) as any).id;
  });

  it("creates a credential", async () => {
    const res = await post(`/v1/vaults/${vaultId}/credentials`, {
      display_name: "Test Cred",
      auth: {
        type: "static_bearer",
        mcp_server_url: "https://mcp.example.com",
        token: "secret-token-123",
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.id).toMatch(/^cred-/);
    expect(body.display_name).toBe("Test Cred");
    // Token should NOT be in response
    expect(body.auth.token).toBeUndefined();
    expect(body.auth.type).toBe("static_bearer");
    expect(body.auth.mcp_server_url).toBe("https://mcp.example.com");
  });

  it("rejects credential without required fields", async () => {
    const res = await post(`/v1/vaults/${vaultId}/credentials`, {});
    expect(res.status).toBe(400);
  });

  it("returns 404 for credential on nonexistent vault", async () => {
    const res = await post("/v1/vaults/vlt_ghost/credentials", {
      display_name: "X",
      auth: { type: "static_bearer", mcp_server_url: "https://x.com", token: "t" },
    });
    expect(res.status).toBe(404);
  });

  it("lists credentials (no secrets)", async () => {
    const res = await get(`/v1/vaults/${vaultId}/credentials`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data).toBeInstanceOf(Array);
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    // No secrets in listed credentials
    for (const cred of body.data) {
      expect(cred.auth.token).toBeUndefined();
      expect(cred.auth.access_token).toBeUndefined();
      expect(cred.auth.refresh_token).toBeUndefined();
      expect(cred.auth.client_secret).toBeUndefined();
    }
  });

  it("archives credential", async () => {
    const createRes = await post(`/v1/vaults/${vaultId}/credentials`, {
      display_name: "To Archive",
      auth: { type: "static_bearer", mcp_server_url: "https://x.com", token: "t" },
    });
    const cred = (await createRes.json()) as any;

    const archRes = await post(
      `/v1/vaults/${vaultId}/credentials/${cred.id}/archive`,
      {}
    );
    expect(archRes.status).toBe(200);
    const body = (await archRes.json()) as any;
    expect(body.archived_at).toBeTruthy();
    // Secrets still stripped
    expect(body.auth.token).toBeUndefined();
  });

  it("deletes credential", async () => {
    const createRes = await post(`/v1/vaults/${vaultId}/credentials`, {
      display_name: "To Delete",
      auth: { type: "static_bearer", mcp_server_url: "https://x.com", token: "t" },
    });
    const cred = (await createRes.json()) as any;

    const delRes = await del(
      `/v1/vaults/${vaultId}/credentials/${cred.id}`
    );
    expect(delRes.status).toBe(200);
    const body = (await delRes.json()) as any;
    expect(body.type).toBe("credential_deleted");
  });

  it("creates oauth credential with all secret fields stripped", async () => {
    const res = await post(`/v1/vaults/${vaultId}/credentials`, {
      display_name: "OAuth Cred",
      auth: {
        type: "mcp_oauth",
        mcp_server_url: "https://mcp-oauth.example.com",
        access_token: "at_secret",
        refresh_token: "rt_secret",
        token_endpoint: "https://auth.example.com/token",
        client_id: "client123",
        client_secret: "cs_secret",
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.auth.access_token).toBeUndefined();
    expect(body.auth.refresh_token).toBeUndefined();
    expect(body.auth.client_secret).toBeUndefined();
    // Non-secret fields preserved
    expect(body.auth.type).toBe("mcp_oauth");
    expect(body.auth.token_endpoint).toBe("https://auth.example.com/token");
    expect(body.auth.client_id).toBe("client123");
  });
});
