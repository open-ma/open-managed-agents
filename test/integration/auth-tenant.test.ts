// @ts-nocheck
import { env, exports } from "cloudflare:workers";
import { describe, it, expect, beforeAll } from "vitest";

const HEADERS = {
  "x-api-key": "test-key",
  "Content-Type": "application/json",
};

function api(path: string, init?: RequestInit) {
  return exports.default.fetch(new Request(`http://localhost${path}`, init));
}

// ============================================================
// Auth middleware
// ============================================================

describe("auth middleware", () => {
  it("rejects requests without auth", async () => {
    const res = await api("/v1/agents");
    expect(res.status).toBe(401);
  });

  it("accepts legacy static API_KEY", async () => {
    const res = await api("/v1/agents", { headers: HEADERS });
    expect(res.status).toBe(200);
  });

  it("rejects invalid API key", async () => {
    const res = await api("/v1/agents", {
      headers: { "x-api-key": "wrong-key" },
    });
    expect(res.status).toBe(401);
  });

  it("health endpoint is public", async () => {
    const res = await api("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("auth-info endpoint is public", async () => {
    const res = await api("/auth-info");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providers).toContain("email");
  });
});

// ============================================================
// API Keys
// ============================================================

describe("API keys", () => {
  let createdKeyRaw: string;
  let createdKeyId: string;

  it("creates an API key", async () => {
    const res = await api("/v1/api_keys", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ name: "Test CLI Key" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.key).toMatch(/^oma_/);
    expect(body.name).toBe("Test CLI Key");
    expect(body.prefix).toBe(body.key.slice(0, 8));
    createdKeyRaw = body.key;
    createdKeyId = body.id;
  });

  it("lists API keys", async () => {
    const res = await api("/v1/api_keys", { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    const found = body.data.find((k: any) => k.id === createdKeyId);
    expect(found).toBeTruthy();
    expect(found.name).toBe("Test CLI Key");
    // Key should NOT be returned in list
    expect(found.key).toBeUndefined();
  });

  it("authenticates with the created API key", async () => {
    const res = await api("/v1/agents", {
      headers: { "x-api-key": createdKeyRaw },
    });
    expect(res.status).toBe(200);
  });

  it("revokes an API key", async () => {
    const res = await api(`/v1/api_keys/${createdKeyId}`, {
      method: "DELETE",
      headers: HEADERS,
    });
    expect(res.status).toBe(200);

    // Key should no longer work
    const res2 = await api("/v1/agents", {
      headers: { "x-api-key": createdKeyRaw },
    });
    expect(res2.status).toBe(401);
  });
});

// ============================================================
// Multi-tenant KV isolation
// ============================================================

describe("multi-tenant KV isolation", () => {
  it("agents are scoped to tenant via D1 column", async () => {
    // Create an agent under default tenant (via static API_KEY)
    const createRes = await api("/v1/agents", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        name: "Tenant Test Agent",
        model: "claude-sonnet-4-6",
        system: "test",
      }),
    });
    expect(createRes.status).toBe(201);
    const agent = await createRes.json();

    // Agents are in D1 now (was KV pre-storage-port). Verify the row exists
    // for tenant=default and the agent name round-trips through `config` JSON.
    const row = await env.AUTH_DB.prepare(
      "SELECT tenant_id, config FROM agents WHERE id = ?",
    ).bind(agent.id).first<{ tenant_id: string; config: string }>();
    expect(row).toBeTruthy();
    expect(row!.tenant_id).toBe("default");
    expect(JSON.parse(row!.config).name).toBe("Tenant Test Agent");
  });
});

// ============================================================
// Model Cards
// ============================================================

describe("model cards", () => {
  let cardId: string;

  it("creates a model card", async () => {
    const res = await api("/v1/model_cards", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        name: "Test Anthropic",
        provider: "ant",
        model_id: "claude-sonnet-4-6",
        api_key: "sk-ant-test-1234567890",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("Test Anthropic");
    expect(body.provider).toBe("ant");
    expect(body.api_key_preview).toBe("7890");
    // Full key should NOT be in response
    expect(body.api_key).toBeUndefined();
    cardId = body.id;
  });

  it("creates a model card with custom headers", async () => {
    const res = await api("/v1/model_cards", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        name: "Test Compatible",
        provider: "oai-compatible",
        model_id: "deepseek-chat",
        api_key: "sk-test-deepseek",
        base_url: "https://api.deepseek.com/v1",
        custom_headers: { "X-Project-Id": "proj_123" },
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.custom_headers).toEqual({ "X-Project-Id": "proj_123" });
  });

  it("lists model cards without exposing keys", async () => {
    const res = await api("/v1/model_cards", { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    for (const card of body.data) {
      expect(card.api_key).toBeUndefined();
    }
  });

  it("updates a model card", async () => {
    const res = await api(`/v1/model_cards/${cardId}`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ name: "Updated Anthropic", is_default: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Updated Anthropic");
    expect(body.is_default).toBe(true);
  });

  it("gets model card key via internal endpoint", async () => {
    const res = await api(`/v1/model_cards/${cardId}/key`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.api_key).toBe("sk-ant-test-1234567890");
  });

  it("deletes a model card", async () => {
    const res = await api(`/v1/model_cards/${cardId}`, {
      method: "DELETE",
      headers: HEADERS,
    });
    expect(res.status).toBe(200);

    const getRes = await api(`/v1/model_cards/${cardId}`, { headers: HEADERS });
    expect(getRes.status).toBe(404);
  });
});

// ============================================================
// Provider resolution
// ============================================================

describe("provider resolution", () => {
  it("resolveModel creates anthropic model for ant compat", async () => {
    // Import directly since tests run in the same isolate
    const { resolveModel } = await import("../../apps/agent/src/harness/provider");
    const model = resolveModel("claude-sonnet-4-6", "sk-test", undefined, "ant");
    expect(model.modelId).toBe("claude-sonnet-4-6");
  });

  it("resolveModel creates anthropic model for ant-compatible", async () => {
    const { resolveModel } = await import("../../apps/agent/src/harness/provider");
    const model = resolveModel("my-model", "sk-test", "https://proxy.example.com", "ant-compatible");
    expect(model.modelId).toBe("my-model");
  });

  it("resolveModel creates openai model for oai compat", async () => {
    const { resolveModel } = await import("../../apps/agent/src/harness/provider");
    const model = resolveModel("gpt-4o", "sk-test", undefined, "oai");
    expect(model.modelId).toBe("gpt-4o");
  });

  it("resolveModel creates openai model for oai-compatible", async () => {
    const { resolveModel } = await import("../../apps/agent/src/harness/provider");
    const model = resolveModel("deepseek-chat", "sk-test", "https://api.deepseek.com/v1", "oai-compatible");
    expect(model.modelId).toBe("deepseek-chat");
  });

  it("resolveModel strips provider prefix", async () => {
    const { resolveModel } = await import("../../apps/agent/src/harness/provider");
    const model = resolveModel("anthropic/claude-sonnet-4-6", "sk-test", undefined, "ant");
    expect(model.modelId).toBe("claude-sonnet-4-6");
  });

  it("resolveModel defaults to ant when no compat specified", async () => {
    const { resolveModel } = await import("../../apps/agent/src/harness/provider");
    const model = resolveModel("claude-sonnet-4-6", "sk-test");
    expect(model.modelId).toBe("claude-sonnet-4-6");
  });
});

// ============================================================
// Models list endpoint
// ============================================================

describe("models list endpoint", () => {
  it("rejects when no api_key provided", async () => {
    const res = await api("/v1/models/list", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ provider: "ant" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("api_key");
  });

  it("returns 502 for invalid Anthropic key", async () => {
    const res = await api("/v1/models/list", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ provider: "ant", api_key: "sk-ant-invalid" }),
    });
    expect(res.status).toBe(502);
  });

  it("returns 502 for invalid OpenAI key", async () => {
    const res = await api("/v1/models/list", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ provider: "oai", api_key: "sk-invalid" }),
    });
    expect(res.status).toBe(502);
  });

  it("returns empty array for unknown provider", async () => {
    const res = await api("/v1/models/list", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ provider: "unknown", api_key: "some-key" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
  });
});

// ============================================================
// KV helper functions
// ============================================================

describe("kv helpers", () => {
  it("kvKey builds tenant-scoped keys", async () => {
    const { kvKey } = await import("../../apps/main/src/kv-helpers");
    expect(kvKey("t1", "agent", "a1")).toBe("t:t1:agent:a1");
    expect(kvKey("t1", "cred", "v1", "c1")).toBe("t:t1:cred:v1:c1");
  });

  it("kvPrefix builds tenant-scoped prefixes", async () => {
    const { kvPrefix } = await import("../../apps/main/src/kv-helpers");
    expect(kvPrefix("t1", "agent")).toBe("t:t1:agent:");
    expect(kvPrefix("t1", "cred", "v1")).toBe("t:t1:cred:v1:");
  });
});
