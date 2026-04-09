import { env, exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { resolveModel } from "../../src/harness/provider";
import { evaluateOutcome } from "../../src/harness/outcome-evaluator";
import { outboundByHost } from "../../src/outbound";
import { registerHarness } from "../../src/harness/registry";
import type { Env } from "../../src/env";

// ============================================================
// Helpers
// ============================================================
const HEADERS = { "x-api-key": "test-key", "Content-Type": "application/json" };

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

async function createAgentAndEnv(overrides?: {
  agentBody?: Record<string, unknown>;
  envBody?: Record<string, unknown>;
}) {
  const agentRes = await post("/v1/agents", {
    name: "Core Test Agent",
    model: "claude-sonnet-4-6",
    ...overrides?.agentBody,
  });
  const agent = (await agentRes.json()) as any;

  const envRes = await post("/v1/environments", {
    name: "core-test-env",
    config: { type: "cloud" },
    ...overrides?.envBody,
  });
  const environment = (await envRes.json()) as any;

  return { agent, environment };
}

async function createSession(
  agentId: string,
  environmentId: string,
  extra?: Record<string, unknown>
) {
  const sessRes = await post("/v1/sessions", {
    agent: agentId,
    environment_id: environmentId,
    ...extra,
  });
  return (await sessRes.json()) as any;
}

// ============================================================
// 1. Provider — resolveModel
// ============================================================
describe("Provider", () => {
  it("resolves string model ID", () => {
    const model = resolveModel("claude-sonnet-4-6", "fake-key");
    expect(model).toBeTruthy();
    expect(model.modelId).toContain("claude-sonnet-4-6");
  });

  it("resolves object model with speed", () => {
    const model = resolveModel(
      { id: "claude-opus-4-6", speed: "fast" },
      "fake-key"
    );
    expect(model).toBeTruthy();
    expect(model.modelId).toContain("claude-opus-4-6");
  });

  it("strips provider prefix", () => {
    const model = resolveModel("anthropic/claude-sonnet-4-6", "fake-key");
    expect(model.modelId).toContain("claude-sonnet-4-6");
    expect(model.modelId).not.toContain("anthropic/");
  });

  it("accepts custom base URL", () => {
    const model = resolveModel(
      "claude-sonnet-4-6",
      "key",
      "https://custom.api.com/v1"
    );
    expect(model).toBeTruthy();
    expect(model.modelId).toContain("claude-sonnet-4-6");
  });

  it("works without base URL", () => {
    const model = resolveModel("claude-sonnet-4-6", "key");
    expect(model).toBeTruthy();
    expect(model.modelId).toContain("claude-sonnet-4-6");
  });

  it("handles deeply nested provider prefix", () => {
    const model = resolveModel("provider/sub/claude-sonnet-4-6", "key");
    expect(model.modelId).toContain("claude-sonnet-4-6");
    expect(model.modelId).not.toContain("provider");
  });
});

// ============================================================
// 2. Outbound Worker — outboundByHost
// ============================================================
describe("Outbound Worker", () => {
  function makeMockEnv(kvData: Record<string, string | null>, kvListData?: Record<string, { keys: { name: string }[] }>): Env {
    return {
      CONFIG_KV: {
        get: async (key: string) => kvData[key] ?? null,
        list: async (opts: { prefix: string }) => {
          if (kvListData && kvListData[opts.prefix]) {
            return kvListData[opts.prefix];
          }
          return { keys: [] };
        },
        put: async () => {},
        delete: async () => {},
        getWithMetadata: async () => ({ value: null, metadata: null }),
      } as unknown as KVNamespace,
      SESSION_DO: {} as any,
      SANDBOX: {} as any,
      API_KEY: "test",
      ANTHROPIC_API_KEY: "test",
    } as Env;
  }

  it("outboundByHost returns null without sessionId", async () => {
    const mockEnv = makeMockEnv({});
    const result = await outboundByHost("example.com", mockEnv, undefined);
    expect(result).toBeNull();
  });

  it("outboundByHost returns null without sessionId (empty string)", async () => {
    const mockEnv = makeMockEnv({});
    const result = await outboundByHost("example.com", mockEnv, "");
    expect(result).toBeNull();
  });

  it("outboundByHost returns 'outbound' for host with matching credential", async () => {
    const mockEnv = makeMockEnv(
      {
        "session:sess_test": JSON.stringify({ vault_ids: ["vlt_1"] }),
        "cred:vlt_1:cred_1": JSON.stringify({
          auth: {
            type: "static_bearer",
            mcp_server_url: "https://mcp.example.com/mcp",
            token: "secret-token",
          },
        }),
      },
      {
        "cred:vlt_1:": { keys: [{ name: "cred:vlt_1:cred_1" }] },
      }
    );

    const result = await outboundByHost("mcp.example.com", mockEnv, "sess_test");
    expect(result).toBe("outbound");
  });

  it("outboundByHost returns null for host without matching credential", async () => {
    const mockEnv = makeMockEnv(
      {
        "session:sess_test": JSON.stringify({ vault_ids: ["vlt_1"] }),
        "cred:vlt_1:cred_1": JSON.stringify({
          auth: {
            type: "static_bearer",
            mcp_server_url: "https://other.example.com/mcp",
            token: "token",
          },
        }),
      },
      {
        "cred:vlt_1:": { keys: [{ name: "cred:vlt_1:cred_1" }] },
      }
    );

    const result = await outboundByHost("nomatch.example.com", mockEnv, "sess_test");
    expect(result).toBeNull();
  });

  it("outboundByHost returns null when session has no vault_ids", async () => {
    const mockEnv = makeMockEnv({
      "session:sess_no_vaults": JSON.stringify({ agent_id: "a1" }),
    });

    const result = await outboundByHost("example.com", mockEnv, "sess_no_vaults");
    expect(result).toBeNull();
  });

  it("outboundByHost handles missing session gracefully", async () => {
    const mockEnv = makeMockEnv({});
    const result = await outboundByHost("example.com", mockEnv, "sess_nonexistent");
    expect(result).toBeNull();
  });

  it("outboundByHost handles credential with invalid mcp_server_url", async () => {
    const mockEnv = makeMockEnv(
      {
        "session:sess_bad_url": JSON.stringify({ vault_ids: ["vlt_2"] }),
        "cred:vlt_2:cred_1": JSON.stringify({
          auth: {
            type: "static_bearer",
            mcp_server_url: "not-a-valid-url",
            token: "token",
          },
        }),
      },
      {
        "cred:vlt_2:": { keys: [{ name: "cred:vlt_2:cred_1" }] },
      }
    );

    // Should not crash, just return null
    const result = await outboundByHost("example.com", mockEnv, "sess_bad_url");
    expect(result).toBeNull();
  });
});

// ============================================================
// 3. Outcome evaluator — real model tests
// ============================================================
describe("Outcome evaluator", () => {
  it("returns needs_revision on parse failure", async () => {
    const fakeModel = {
      specificationVersion: "v1" as const,
      provider: "test",
      modelId: "test-model",
      defaultObjectGenerationMode: undefined,
      doGenerate: async () => ({
        text: "This is not valid JSON",
        finishReason: "stop" as const,
        usage: { promptTokens: 0, completionTokens: 0 },
        rawCall: { rawPrompt: "", rawSettings: {} },
      }),
    } as any;

    const result = await evaluateOutcome(
      fakeModel,
      { description: "test" },
      "test output"
    );
    expect(result.result).toBe("needs_revision");
    expect(result.feedback).toContain("Failed to parse");
  });

  it("returns satisfied when model outputs valid JSON", async () => {
    const fakeModel = {
      specificationVersion: "v1" as const,
      provider: "test",
      modelId: "test-model",
      defaultObjectGenerationMode: undefined,
      doGenerate: async () => ({
        text: JSON.stringify({ result: "satisfied", feedback: "All criteria met." }),
        finishReason: "stop" as const,
        usage: { promptTokens: 10, completionTokens: 20 },
        rawCall: { rawPrompt: "", rawSettings: {} },
      }),
    } as any;

    const result = await evaluateOutcome(
      fakeModel,
      { description: "Write hello world", criteria: ["Must print Hello"] },
      "console.log('Hello')"
    );
    expect(result.result).toBe("satisfied");
    expect(result.feedback).toBe("All criteria met.");
  });

  it("returns needs_revision with feedback from model", async () => {
    const fakeModel = {
      specificationVersion: "v1" as const,
      provider: "test",
      modelId: "test-model",
      defaultObjectGenerationMode: undefined,
      doGenerate: async () => ({
        text: JSON.stringify({ result: "needs_revision", feedback: "Missing error handling" }),
        finishReason: "stop" as const,
        usage: { promptTokens: 10, completionTokens: 20 },
        rawCall: { rawPrompt: "", rawSettings: {} },
      }),
    } as any;

    const result = await evaluateOutcome(
      fakeModel,
      { description: "Build API" },
      "partial code"
    );
    expect(result.result).toBe("needs_revision");
    expect(result.feedback).toBe("Missing error handling");
  });

  it("handles model returning empty text", async () => {
    const fakeModel = {
      specificationVersion: "v1" as const,
      provider: "test",
      modelId: "test-model",
      defaultObjectGenerationMode: undefined,
      doGenerate: async () => ({
        text: "",
        finishReason: "stop" as const,
        usage: { promptTokens: 0, completionTokens: 0 },
        rawCall: { rawPrompt: "", rawSettings: {} },
      }),
    } as any;

    const result = await evaluateOutcome(fakeModel, { description: "test" }, "output");
    expect(result.result).toBe("needs_revision");
  });
});

// ============================================================
// 5. Integration edge cases
// ============================================================
describe("Edge cases - concurrent and complex operations", () => {
  it("handles rapid session creation", async () => {
    const { agent, environment } = await createAgentAndEnv();

    // Create 5 sessions rapidly in parallel
    const promises = Array.from({ length: 5 }, () =>
      createSession(agent.id, environment.id)
    );
    const sessions = await Promise.all(promises);

    // All should succeed with unique IDs
    const ids = new Set(sessions.map((s: any) => s.id));
    expect(ids.size).toBe(5);

    // All should reference the same agent
    for (const s of sessions) {
      expect(s.agent_id).toBe(agent.id);
      expect(s.environment_id).toBe(environment.id);
      expect(s.status).toBe("idle");
    }
  });

  it("handles creating agent with description", async () => {
    const res = await post("/v1/agents", {
      name: "Full Agent",
      model: "claude-sonnet-4-6",
      system: "You are a comprehensive assistant.",
      tools: [
        {
          type: "agent_toolset_20260401",
          default_config: { enabled: true },
          configs: [
            { name: "bash", enabled: true },
            { name: "read", enabled: true },
            { name: "write", enabled: true },
          ],
        },
      ],
    });
    expect(res.status).toBe(201);

    const agent = (await res.json()) as any;
    expect(agent.name).toBe("Full Agent");
    expect(agent.system).toBe("You are a comprehensive assistant.");
    expect(agent.tools).toHaveLength(1);
    expect(agent.tools[0].configs).toHaveLength(3);
    expect(agent.version).toBe(1);
    expect(agent.created_at).toBeTruthy();
  });

  it("handles environment with packages config", async () => {
    const res = await post("/v1/environments", {
      name: "packaged-env",
      config: {
        type: "cloud",
        packages: {
          pip: ["numpy", "pandas"],
          npm: ["lodash"],
          apt: ["curl", "jq"],
        },
        networking: {
          type: "limited",
          allowed_hosts: ["api.example.com"],
          allow_mcp_servers: true,
          allow_package_managers: true,
        },
      },
    });
    expect(res.status).toBe(201);

    const environment = (await res.json()) as any;
    expect(environment.config.packages.pip).toEqual(["numpy", "pandas"]);
    expect(environment.config.packages.npm).toEqual(["lodash"]);
    expect(environment.config.packages.apt).toEqual(["curl", "jq"]);
    expect(environment.config.networking.type).toBe("limited");
    expect(environment.config.networking.allowed_hosts).toEqual(["api.example.com"]);
  });

  it("session with vault_ids stores them", async () => {
    const { agent, environment } = await createAgentAndEnv();
    const session = await createSession(agent.id, environment.id, {
      vault_ids: ["vlt_abc", "vlt_def"],
    });

    expect(session.vault_ids).toEqual(["vlt_abc", "vlt_def"]);

    // Verify persisted via GET
    const getRes = await api(`/v1/sessions/${session.id}`, {
      headers: HEADERS,
    });
    const fetched = (await getRes.json()) as any;
    expect(fetched.vault_ids).toEqual(["vlt_abc", "vlt_def"]);
  });

  it("agent created with callable_agents is stored via buildTools", async () => {
    // The API doesn't store callable_agents directly, but buildTools uses them
    // Test that buildTools creates call_agent tools from config
    const { buildTools } = await import("../../src/harness/tools");
    const { StubSandbox } = await import("../../src/runtime/sandbox");
    const sandbox = new StubSandbox();
    const tools = await buildTools({
      id: "agent_test_ca",
      name: "CA Agent",
      model: "claude-sonnet-4-6",
      system: "",
      tools: [{ type: "agent_toolset_20260401" }],
      callable_agents: [
        { type: "agent", id: "agent_w1", version: 1 },
        { type: "agent", id: "agent_w2", version: 2 },
      ],
      version: 1,
      created_at: new Date().toISOString(),
    }, sandbox, { ANTHROPIC_API_KEY: "sk-test" });
    expect(tools.call_agent_agent_w1).toBeDefined();
    expect(tools.call_agent_agent_w2).toBeDefined();
  });

  it("agent created with mcp_servers generates MCP tools via buildTools", async () => {
    const { buildTools } = await import("../../src/harness/tools");
    const { StubSandbox } = await import("../../src/runtime/sandbox");
    const sandbox = new StubSandbox();
    const tools = await buildTools({
      id: "agent_test_mcp",
      name: "MCP Agent",
      model: "claude-sonnet-4-6",
      system: "",
      tools: [{ type: "agent_toolset_20260401" }],
      mcp_servers: [
        { name: "github", type: "sse", url: "https://mcp.github.com/sse" },
        { name: "slack", type: "sse", url: "https://mcp.slack.com/sse" },
      ],
      version: 1,
      created_at: new Date().toISOString(),
    }, sandbox);
    expect(tools.mcp_github_list_tools).toBeDefined();
    expect(tools.mcp_github_call).toBeDefined();
    expect(tools.mcp_slack_list_tools).toBeDefined();
    expect(tools.mcp_slack_call).toBeDefined();
  });

  it("agent with skills resolves via resolveSkills", async () => {
    const { resolveSkills } = await import("../../src/harness/skills");
    const skills = resolveSkills([
      { skill_id: "web_research" },
      { skill_id: "code_review" },
    ]);
    expect(skills).toHaveLength(2);
    expect(skills[0].name).toBe("Web Research");
    expect(skills[1].name).toBe("Code Review");
    // Each has system_prompt_addition
    for (const s of skills) {
      expect(s.system_prompt_addition.length).toBeGreaterThan(0);
    }
  });

  it("agent with custom tools via API is stored", async () => {
    const res = await post("/v1/agents", {
      name: "Custom Tool Agent",
      model: "claude-sonnet-4-6",
      tools: [
        { type: "agent_toolset_20260401" },
        { type: "custom", name: "get_weather", description: "Get weather forecast", input_schema: {} },
      ],
    });
    expect(res.status).toBe(201);
    const agent = (await res.json()) as any;
    expect(agent.tools).toHaveLength(2);
    expect(agent.tools[1].type).toBe("custom");
    expect(agent.tools[1].name).toBe("get_weather");
  });

  it("agent with mixed tools (toolset + custom) both stored", async () => {
    const res = await post("/v1/agents", {
      name: "Mixed Tools Agent",
      model: "claude-sonnet-4-6",
      tools: [
        {
          type: "agent_toolset_20260401",
          default_config: { enabled: false },
          configs: [{ name: "bash", enabled: true }],
        },
        { type: "custom", name: "deploy", description: "Deploy app" },
        { type: "custom", name: "rollback", description: "Rollback deploy" },
      ],
    });
    expect(res.status).toBe(201);
    const agent = (await res.json()) as any;
    expect(agent.tools).toHaveLength(3);
    expect(agent.tools[0].type).toBe("agent_toolset_20260401");
    expect(agent.tools[1].name).toBe("deploy");
    expect(agent.tools[2].name).toBe("rollback");
  });

  it("agent with all supported fields via API", async () => {
    const res = await post("/v1/agents", {
      name: "Full Agent",
      model: { id: "claude-sonnet-4-6", speed: "fast" },
      system: "You are comprehensive.",
      tools: [{ type: "agent_toolset_20260401" }],
      harness: "custom-harness-name",
    });
    expect(res.status).toBe(201);
    const agent = (await res.json()) as any;
    expect(agent.name).toBe("Full Agent");
    expect(agent.model.id).toBe("claude-sonnet-4-6");
    expect(agent.model.speed).toBe("fast");
    expect(agent.system).toBe("You are comprehensive.");
    expect(agent.harness).toBe("custom-harness-name");
    expect(agent.version).toBe(1);
  });

  it("agent model as object {id, speed} via API", async () => {
    const res = await post("/v1/agents", {
      name: "Speed Agent",
      model: { id: "claude-opus-4-6", speed: "fast" },
    });
    expect(res.status).toBe(201);
    const agent = (await res.json()) as any;
    expect(agent.model.id).toBe("claude-opus-4-6");
    expect(agent.model.speed).toBe("fast");
  });

  it("agent update system preserves tools in version history", async () => {
    const createRes = await post("/v1/agents", {
      name: "Versioned Tools",
      model: "claude-sonnet-4-6",
      system: "v1 system",
      tools: [{
        type: "agent_toolset_20260401",
        default_config: { enabled: false },
        configs: [{ name: "bash", enabled: true }],
      }],
    });
    const agent = (await createRes.json()) as any;

    // Update system
    await api(`/v1/agents/${agent.id}`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ system: "v2 system" }),
    });

    // Version 1 should have original system
    const v1Res = await api(`/v1/agents/${agent.id}/versions/1`, { headers: HEADERS });
    const v1 = (await v1Res.json()) as any;
    expect(v1.system).toBe("v1 system");
    expect(v1.tools[0].default_config.enabled).toBe(false);

    // Current should have updated system
    const currentRes = await api(`/v1/agents/${agent.id}`, { headers: HEADERS });
    const current = (await currentRes.json()) as any;
    expect(current.system).toBe("v2 system");
    expect(current.version).toBe(2);
  });

  it("session events with unicode content round-trip correctly", async () => {
    registerHarness("echo-unicode", () => ({
      async run(ctx) {
        const text = ctx.userMessage.content[0]?.text || "";
        ctx.runtime.broadcast({
          type: "agent.message",
          content: [{ type: "text", text: `echo: ${text}` }],
        });
      },
    }));

    const agentRes = await post("/v1/agents", {
      name: "Unicode Echo",
      model: "claude-sonnet-4-6",
      harness: "echo-unicode",
    });
    const agent = (await agentRes.json()) as any;

    const envRes = await post("/v1/environments", {
      name: "e",
      config: { type: "cloud" },
    });
    const environment = (await envRes.json()) as any;

    const session = await createSession(agent.id, environment.id);

    const unicodeText = "Erd\u0151s \u2013 R\u00e9nyi \u2228 \u00e9l\u00e9ments \ud83c\udf1f \u6d4b\u8bd5";
    await api(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        events: [{ type: "user.message", content: [{ type: "text", text: unicodeText }] }],
      }),
    });

    await new Promise((r) => setTimeout(r, 300));

    // Replay events from the DO
    const doId = env.SESSION_DO.idFromName(session.id);
    const stub = env.SESSION_DO.get(doId);
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

    const userMsg = events.find((e: any) => e.type === "user.message");
    expect(userMsg).toBeTruthy();
    expect(userMsg.content[0].text).toBe(unicodeText);

    const agentMsg = events.find((e: any) => e.type === "agent.message");
    expect(agentMsg).toBeTruthy();
    expect(agentMsg.content[0].text).toContain(unicodeText);
  });

  it("session title is persisted and retrievable", async () => {
    const { agent, environment } = await createAgentAndEnv();
    const session = await createSession(agent.id, environment.id, {
      title: "My test conversation",
    });

    expect(session.title).toBe("My test conversation");

    const getRes = await api(`/v1/sessions/${session.id}`, {
      headers: HEADERS,
    });
    const fetched = (await getRes.json()) as any;
    expect(fetched.title).toBe("My test conversation");
  });
});
