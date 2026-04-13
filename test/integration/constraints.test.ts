// @ts-nocheck
import { exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { resolveSkills } from "../../apps/agent/src/harness/skills";
import { registerHarness } from "../../apps/agent/src/harness/registry";
import type { HarnessInterface, HarnessContext } from "../../apps/agent/src/harness/interface";

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
  it("no hardcoded built-in skills — all managed via API/KV", () => {
    // All skills (pptx, xlsx, etc.) are now in KV, not hardcoded
    const resolved = resolveSkills([
      { skill_id: "xlsx_processing" },
      { skill_id: "pptx" },
      { skill_id: "web_research" },
    ]);
    expect(resolved).toHaveLength(0);
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

  // ============================================================
  // Agent extended fields
  // ============================================================
  describe("Agent extended fields", () => {
    // ----------------------------------------------------------
    // description
    // ----------------------------------------------------------
    it("agent with description is stored and retrieved", async () => {
      const agent = await createAgent({ description: "A helpful research assistant" });
      expect(agent.description).toBe("A helpful research assistant");

      const getRes = await api(`/v1/agents/${agent.id}`, { headers: HEADERS });
      const fetched = (await getRes.json()) as any;
      expect(fetched.description).toBe("A helpful research assistant");
    });

    // ----------------------------------------------------------
    // mcp_servers
    // ----------------------------------------------------------
    it("agent with mcp_servers is stored and retrieved", async () => {
      const mcpServers = [
        { name: "github", type: "sse", url: "https://mcp.github.com/sse" },
        { name: "slack", type: "sse", url: "https://mcp.slack.com/sse" },
      ];
      const agent = await createAgent({ mcp_servers: mcpServers });
      expect(agent.mcp_servers).toEqual(mcpServers);

      const getRes = await api(`/v1/agents/${agent.id}`, { headers: HEADERS });
      const fetched = (await getRes.json()) as any;
      expect(fetched.mcp_servers).toEqual(mcpServers);
    });

    // ----------------------------------------------------------
    // skills
    // ----------------------------------------------------------
    it("agent with skills is stored and retrieved", async () => {
      const skills = [
        { type: "anthropic", skill_id: "web_research" },
        { type: "custom", skill_id: "my_custom_skill", version: "1.2.0" },
      ];
      const agent = await createAgent({ skills });
      expect(agent.skills).toEqual(skills);

      const getRes = await api(`/v1/agents/${agent.id}`, { headers: HEADERS });
      const fetched = (await getRes.json()) as any;
      expect(fetched.skills).toEqual(skills);
    });

    // ----------------------------------------------------------
    // callable_agents
    // ----------------------------------------------------------
    it("agent with callable_agents is stored and retrieved", async () => {
      const callableAgents = [
        { type: "agent", id: "agent_abc123", version: 1 },
        { type: "agent", id: "agent_def456", version: 2 },
      ];
      const agent = await createAgent({ callable_agents: callableAgents });
      expect(agent.callable_agents).toEqual(callableAgents);

      const getRes = await api(`/v1/agents/${agent.id}`, { headers: HEADERS });
      const fetched = (await getRes.json()) as any;
      expect(fetched.callable_agents).toEqual(callableAgents);
    });

    // ----------------------------------------------------------
    // metadata
    // ----------------------------------------------------------
    it("agent with metadata is stored and retrieved", async () => {
      const metadata = { team: "research", priority: "high", tags: ["v2", "beta"] };
      const agent = await createAgent({ metadata });
      expect(agent.metadata).toEqual(metadata);

      const getRes = await api(`/v1/agents/${agent.id}`, { headers: HEADERS });
      const fetched = (await getRes.json()) as any;
      expect(fetched.metadata).toEqual(metadata);
    });

    // ----------------------------------------------------------
    // model as object
    // ----------------------------------------------------------
    it("agent with model object {id, speed} is stored", async () => {
      const model = { id: "claude-sonnet-4-6", speed: "fast" };
      const agent = await createAgent({ model });
      expect(agent.model).toEqual(model);

      const getRes = await api(`/v1/agents/${agent.id}`, { headers: HEADERS });
      const fetched = (await getRes.json()) as any;
      expect(fetched.model).toEqual(model);
    });

    // ----------------------------------------------------------
    // PUT adds mcp_servers
    // ----------------------------------------------------------
    it("agent update adds mcp_servers", async () => {
      const agent = await createAgent();
      expect(agent.mcp_servers).toEqual([]);

      const mcpServers = [{ name: "jira", type: "sse", url: "https://mcp.jira.com/sse" }];
      const updateRes = await put(`/v1/agents/${agent.id}`, { mcp_servers: mcpServers });
      expect(updateRes.status).toBe(200);
      const updated = (await updateRes.json()) as any;
      expect(updated.mcp_servers).toEqual(mcpServers);
      expect(updated.version).toBe(2);
    });

    // ----------------------------------------------------------
    // PUT adds skills
    // ----------------------------------------------------------
    it("agent update adds skills", async () => {
      const agent = await createAgent();
      expect(agent.skills).toEqual([]);

      const skills = [{ type: "anthropic", skill_id: "data_analysis" }];
      const updateRes = await put(`/v1/agents/${agent.id}`, { skills });
      expect(updateRes.status).toBe(200);
      const updated = (await updateRes.json()) as any;
      expect(updated.skills).toEqual(skills);
      expect(updated.version).toBe(2);
    });

    // ----------------------------------------------------------
    // PUT adds callable_agents
    // ----------------------------------------------------------
    it("agent update adds callable_agents", async () => {
      const agent = await createAgent();
      expect(agent.callable_agents).toEqual([]);

      const callableAgents = [{ type: "agent", id: "agent_xyz789", version: 3 }];
      const updateRes = await put(`/v1/agents/${agent.id}`, { callable_agents: callableAgents });
      expect(updateRes.status).toBe(200);
      const updated = (await updateRes.json()) as any;
      expect(updated.callable_agents).toEqual(callableAgents);
      expect(updated.version).toBe(2);
    });

    // ----------------------------------------------------------
    // PUT changes description
    // ----------------------------------------------------------
    it("agent update changes description", async () => {
      const agent = await createAgent({ description: "original description" });
      expect(agent.description).toBe("original description");

      const updateRes = await put(`/v1/agents/${agent.id}`, { description: "updated description" });
      expect(updateRes.status).toBe(200);
      const updated = (await updateRes.json()) as any;
      expect(updated.description).toBe("updated description");
      expect(updated.version).toBe(2);
    });

    // ----------------------------------------------------------
    // PUT metadata merges keys
    // ----------------------------------------------------------
    it("agent update with metadata merges keys", async () => {
      const agent = await createAgent({ metadata: { team: "alpha", env: "staging" } });
      expect(agent.metadata).toEqual({ team: "alpha", env: "staging" });

      // Update metadata — the route replaces the whole metadata object
      const updateRes = await put(`/v1/agents/${agent.id}`, {
        metadata: { team: "beta", region: "us-east" },
      });
      expect(updateRes.status).toBe(200);
      const updated = (await updateRes.json()) as any;
      // The PUT handler does a field-level replace (agent[key] = body[key]),
      // so metadata is replaced entirely, not deep-merged.
      expect(updated.metadata).toEqual({ team: "beta", env: "staging", region: "us-east" });
      expect(updated.version).toBe(2);
    });

    // ----------------------------------------------------------
    // Version history preserves extended fields
    // ----------------------------------------------------------
    it("version history preserves mcp_servers/skills/callable_agents", async () => {
      const originalMcp = [{ name: "github", type: "sse", url: "https://mcp.github.com/sse" }];
      const originalSkills = [{ type: "anthropic", skill_id: "web_research" }];
      const originalCallable = [{ type: "agent", id: "agent_old", version: 1 }];

      const agent = await createAgent({
        description: "v1 agent",
        mcp_servers: originalMcp,
        skills: originalSkills,
        callable_agents: originalCallable,
        metadata: { release: "v1" },
      });
      expect(agent.version).toBe(1);

      // Update all extended fields to new values
      const updateRes = await put(`/v1/agents/${agent.id}`, {
        description: "v2 agent",
        mcp_servers: [{ name: "slack", type: "sse", url: "https://mcp.slack.com/sse" }],
        skills: [{ type: "custom", skill_id: "custom_skill", version: "2.0" }],
        callable_agents: [{ type: "agent", id: "agent_new", version: 5 }],
        metadata: { release: "v2" },
      });
      expect(updateRes.status).toBe(200);
      const updated = (await updateRes.json()) as any;
      expect(updated.version).toBe(2);

      // Retrieve the old version (v1) and verify it preserved original fields
      const v1Res = await api(`/v1/agents/${agent.id}/versions/1`, { headers: HEADERS });
      expect(v1Res.status).toBe(200);
      const v1 = (await v1Res.json()) as any;
      expect(v1.version).toBe(1);
      expect(v1.description).toBe("v1 agent");
      expect(v1.mcp_servers).toEqual(originalMcp);
      expect(v1.skills).toEqual(originalSkills);
      expect(v1.callable_agents).toEqual(originalCallable);
      expect(v1.metadata).toEqual({ release: "v1" });

      // Verify current version has updated fields
      const currentRes = await api(`/v1/agents/${agent.id}`, { headers: HEADERS });
      const current = (await currentRes.json()) as any;
      expect(current.version).toBe(2);
      expect(current.description).toBe("v2 agent");
      expect(current.mcp_servers).toEqual([{ name: "slack", type: "sse", url: "https://mcp.slack.com/sse" }]);
      expect(current.skills).toEqual([{ type: "custom", skill_id: "custom_skill", version: "2.0" }]);
      expect(current.callable_agents).toEqual([{ type: "agent", id: "agent_new", version: 5 }]);
      expect(current.metadata).toEqual({ release: "v2" });
    });
  });
});
