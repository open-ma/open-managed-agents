import { exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { resolveSkills } from "../../src/harness/skills";
import { registerHarness } from "../../src/harness/registry";
import type { HarnessInterface, HarnessContext } from "../../src/harness/interface";

// Register a test harness that completes immediately (no real LLM call).
class ConstraintTestHarness implements HarnessInterface {
  async run(ctx: HarnessContext): Promise<void> {
    ctx.runtime.broadcast({
      type: "agent.message",
      content: [{ type: "text", text: "constraint-test-response" }],
    });
  }
}
registerHarness("constraint-test", () => new ConstraintTestHarness());

const HEADERS = {
  "x-api-key": "test-key",
  "Content-Type": "application/json",
};

function api(path: string, init?: RequestInit) {
  return exports.default.fetch(new Request(`http://localhost${path}`, init));
}

function post(path: string, body: Record<string, unknown>) {
  return api(path, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
}

function put(path: string, body: Record<string, unknown>) {
  return api(path, {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
}

function del(path: string) {
  return api(path, { method: "DELETE", headers: HEADERS });
}

async function createAgent(overrides?: Record<string, unknown>) {
  const res = await post("/v1/agents", {
    name: "Constraint Agent",
    model: "claude-sonnet-4-6",
    system: "You are helpful.",
    tools: [{ type: "agent_toolset_20260401" }],
    harness: "constraint-test",
    ...overrides,
  });
  return (await res.json()) as any;
}

async function createEnv(overrides?: Record<string, unknown>) {
  const res = await post("/v1/environments", {
    name: "constraint-env",
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
// Constraint validations
// ============================================================
describe("Constraint validations", () => {
  // ----------------------------------------------------------
  // Agent no-op update
  // ----------------------------------------------------------
  it("agent update no-op: same data doesn't bump version", async () => {
    const agent = await createAgent({ system: "stable system" });
    expect(agent.version).toBe(1);

    // Update with the same data
    const updateRes = await put(`/v1/agents/${agent.id}`, {
      system: "stable system",
    });
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as any;
    expect(updated.version).toBe(1); // Should NOT bump

    // Verify no version history was created
    const versionsRes = await api(`/v1/agents/${agent.id}/versions`, {
      headers: HEADERS,
    });
    const versions = (await versionsRes.json()) as any;
    expect(versions.data.length).toBe(0);
  });

  // ----------------------------------------------------------
  // Agent create/update sets updated_at
  // ----------------------------------------------------------
  it("agent create/update sets updated_at", async () => {
    const agent = await createAgent();
    // On create, updated_at should be set (same as created_at)
    expect(agent.updated_at).toBeTruthy();
    expect(agent.updated_at).toBe(agent.created_at);

    // Update with a real change
    const updateRes = await put(`/v1/agents/${agent.id}`, {
      system: "changed system",
    });
    const updated = (await updateRes.json()) as any;
    expect(updated.updated_at).toBeTruthy();
    expect(updated.version).toBe(2);
    // updated_at should be >= created_at
    expect(updated.updated_at >= agent.created_at).toBe(true);
  });

  // ----------------------------------------------------------
  // Memory rejects content > 100KB
  // ----------------------------------------------------------
  it("memory rejects content > 100KB", async () => {
    // Create a memory store
    const storeRes = await post("/v1/memory_stores", { name: "size-test" });
    const store = (await storeRes.json()) as any;

    // Try to create memory with content > 100KB
    const bigContent = "x".repeat(100 * 1024 + 1);
    const createRes = await post(`/v1/memory_stores/${store.id}/memories`, {
      path: "big-file",
      content: bigContent,
    });
    expect(createRes.status).toBe(400);
    const body = (await createRes.json()) as any;
    expect(body.error).toContain("100KB");

    // Content exactly at limit should succeed
    const okContent = "x".repeat(100 * 1024);
    const okRes = await post(`/v1/memory_stores/${store.id}/memories`, {
      path: "ok-file",
      content: okContent,
    });
    expect(okRes.status).toBe(201);

    // Update with oversized content should also fail
    const mem = (await okRes.json()) as any;
    const updateRes = await post(
      `/v1/memory_stores/${store.id}/memories/${mem.id}`,
      { content: bigContent }
    );
    expect(updateRes.status).toBe(400);
    const updateBody = (await updateRes.json()) as any;
    expect(updateBody.error).toContain("100KB");
  });

  // ----------------------------------------------------------
  // Vault rejects > 20 credentials
  // ----------------------------------------------------------
  it("vault rejects > 20 credentials", async () => {
    const vaultRes = await post("/v1/vaults", { name: "limit-vault" });
    const vault = (await vaultRes.json()) as any;

    // Create 20 credentials (the maximum)
    for (let i = 0; i < 20; i++) {
      const res = await post(`/v1/vaults/${vault.id}/credentials`, {
        display_name: `cred-${i}`,
        auth: {
          type: "static_bearer",
          mcp_server_url: `https://mcp-${i}.example.com/mcp`,
          token: `token-${i}`,
        },
      });
      expect(res.status).toBe(201);
    }

    // The 21st should fail
    const overRes = await post(`/v1/vaults/${vault.id}/credentials`, {
      display_name: "cred-overflow",
      auth: {
        type: "static_bearer",
        mcp_server_url: "https://overflow.example.com/mcp",
        token: "overflow",
      },
    });
    expect(overRes.status).toBe(400);
    const overBody = (await overRes.json()) as any;
    expect(overBody.error).toContain("20");
  });

  // ----------------------------------------------------------
  // Vault rejects duplicate mcp_server_url with 409
  // ----------------------------------------------------------
  it("vault rejects duplicate mcp_server_url with 409", async () => {
    const vaultRes = await post("/v1/vaults", { name: "dup-vault" });
    const vault = (await vaultRes.json()) as any;

    const url = "https://unique-mcp.example.com/mcp";

    // First credential succeeds
    const first = await post(`/v1/vaults/${vault.id}/credentials`, {
      display_name: "first",
      auth: { type: "static_bearer", mcp_server_url: url, token: "a" },
    });
    expect(first.status).toBe(201);

    // Duplicate mcp_server_url should 409
    const dup = await post(`/v1/vaults/${vault.id}/credentials`, {
      display_name: "duplicate",
      auth: { type: "static_bearer", mcp_server_url: url, token: "b" },
    });
    expect(dup.status).toBe(409);
    const dupBody = (await dup.json()) as any;
    expect(dupBody.error).toContain("mcp_server_url");
  });

  // ----------------------------------------------------------
  // Environment delete blocked when sessions reference it
  // ----------------------------------------------------------
  it("environment delete blocked when sessions reference it", async () => {
    const agent = await createAgent();
    const env = await createEnv();

    // Create a session referencing this environment
    const session = await createSession(agent.id, env.id);
    expect(session.id).toBeTruthy();

    // Try to delete the environment — should be blocked
    const deleteRes = await del(`/v1/environments/${env.id}`);
    expect(deleteRes.status).toBe(409);
    const deleteBody = (await deleteRes.json()) as any;
    expect(deleteBody.error).toContain("sessions");

    // After archiving the session, delete should succeed
    await post(`/v1/sessions/${session.id}/archive`, {});
    const deleteRes2 = await del(`/v1/environments/${env.id}`);
    expect(deleteRes2.status).toBe(200);
  });

  // ----------------------------------------------------------
  // Session rejects > 100 file resources
  // ----------------------------------------------------------
  it("session rejects > 100 file resources", async () => {
    const agent = await createAgent();
    const env = await createEnv();
    const session = await createSession(agent.id, env.id);

    // To test the limit without creating 100 real files,
    // we inject 100 resource keys directly into KV, then try to add one more
    // via the API. The API counts keys with the sesrsc: prefix.

    // Create a real file first (for the resource POST to reference)
    const fileRes = await post("/v1/files", {
      filename: "test.txt",
      content: "hello",
    });
    const file = (await fileRes.json()) as any;

    // We need to add 100 resource entries. We can add memory_store resources
    // (they don't require file verification) to fill up the count.
    for (let i = 0; i < 100; i++) {
      const res = await post(`/v1/sessions/${session.id}/resources`, {
        type: "memory_store",
        memory_store_id: `memstore_fake_${i}`,
      });
      expect(res.status).toBe(201);
    }

    // The 101st should fail
    const overRes = await post(`/v1/sessions/${session.id}/resources`, {
      type: "memory_store",
      memory_store_id: "memstore_overflow",
    });
    expect(overRes.status).toBe(400);
    const overBody = (await overRes.json()) as any;
    expect(overBody.error).toContain("100");
  });

  // ----------------------------------------------------------
  // Predefined skills are registered
  // ----------------------------------------------------------
  it("predefined skills are registered (xlsx, pptx, pdf, docx)", () => {
    const skillIds = ["xlsx_processing", "pptx_processing", "pdf_processing", "docx_processing"];
    const resolved = resolveSkills(skillIds.map((id) => ({ skill_id: id })));

    expect(resolved).toHaveLength(4);
    expect(resolved.map((s) => s.id)).toEqual(skillIds);

    // Verify each skill has required fields
    for (const skill of resolved) {
      expect(skill.name).toBeTruthy();
      expect(skill.system_prompt_addition).toBeTruthy();
      expect(skill.system_prompt_addition.length).toBeGreaterThan(10);
    }

    // Also verify original built-in skills still work
    const builtins = resolveSkills([
      { skill_id: "web_research" },
      { skill_id: "code_review" },
      { skill_id: "data_analysis" },
    ]);
    expect(builtins).toHaveLength(3);
  });

  // ----------------------------------------------------------
  // Memory version actor tracking
  // ----------------------------------------------------------
  it("memory version includes actor field", async () => {
    const storeRes = await post("/v1/memory_stores", { name: "actor-test" });
    const store = (await storeRes.json()) as any;

    // Create a memory
    const memRes = await post(`/v1/memory_stores/${store.id}/memories`, {
      path: "actor-check",
      content: "test content",
    });
    expect(memRes.status).toBe(201);
    const mem = (await memRes.json()) as any;

    // List versions and check actor field
    const versionsRes = await api(
      `/v1/memory_stores/${store.id}/memory_versions?memory_id=${mem.id}`,
      { headers: HEADERS }
    );
    const versions = (await versionsRes.json()) as any;
    expect(versions.data.length).toBeGreaterThanOrEqual(1);

    // Get the full version with content to verify actor
    const verId = versions.data[0].id;
    const verRes = await api(
      `/v1/memory_stores/${store.id}/memory_versions/${verId}`,
      { headers: HEADERS }
    );
    const ver = (await verRes.json()) as any;
    expect(ver.actor).toEqual({ type: "api_key", id: "api" });
    expect(ver.operation).toBe("created");
  });
});
