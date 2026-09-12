import { describe, expect, it } from "vitest";
import type { AgentView } from "../src/index";
import { agentView, agentWire, makeAgentsPort } from "./fixtures";
import { buildAgentsTestApi } from "./test-api";

describe("Managed Agents API — POST /v1/agents", () => {
  it("rejects requests that omit the managed-agents beta header", async () => {
    const createCalls: unknown[] = [];
    const api = buildAgentsTestApi(
      makeAgentsPort({
        createAgent: async (input) => {
          createCalls.push(input);
          throw new Error("agent create port must not run without the beta header");
        },
      }),
    );

    const response = await api.request("/v1/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Coding Assistant",
        model: "claude-opus-5",
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: expect.stringContaining("managed-agents-2026-04-01"),
      },
    });
    expect(createCalls).toEqual([]);
  });

  it("passes an official create request to the application port and returns the agent resource", async () => {
    const createCalls: unknown[] = [];
    const api = buildAgentsTestApi(
      makeAgentsPort({
        createAgent: async (input) => {
          createCalls.push(input);
          return { type: "created", agent: agentView };
        },
      }),
    );

    const response = await api.request("/v1/agents", {
      method: "POST",
      headers: {
        "anthropic-beta": "managed-agents-2026-04-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Coding Assistant",
        model: "claude-opus-5",
      }),
    });

    expect(response.status).toBe(201);
    expect(createCalls).toEqual([
      {
        name: "Coding Assistant",
        model: "claude-opus-5",
      },
    ]);
    expect(await response.json()).toEqual(agentWire);
  });

  it("maps nested agent definitions to application-native camelCase Port values", async () => {
    const createCalls: unknown[] = [];
    const api = buildAgentsTestApi(
      makeAgentsPort({
        createAgent: async (input) => {
          createCalls.push(input);
          return { type: "created", agent: agentView };
        },
      }),
    );

    const response = await api.request("/v1/agents", {
      method: "POST",
      headers: {
        "anthropic-beta": "managed-agents-2026-04-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Coordinator",
        model: "claude-opus-5",
        mcp_servers: [
          { type: "url", name: "docs", url: "https://mcp.example.test" },
        ],
        multiagent: {
          type: "coordinator",
          agents: [
            { type: "agent", id: "agent_child", version: 2 },
            { type: "advisor", model: "claude-sonnet-5" },
          ],
        },
        skills: [{ type: "custom", skill_id: "skill_review", version: "3" }],
        tools: [
          {
            type: "agent_toolset_20260401",
            default_config: {
              enabled: false,
              permission_policy: { type: "always_ask" },
            },
            configs: [
              {
                name: "bash",
                enabled: true,
                permission_policy: { type: "always_allow" },
              },
            ],
          },
          {
            type: "mcp_toolset",
            mcp_server_name: "docs",
            default_config: { enabled: true },
            configs: [{ name: "search_docs", enabled: false }],
          },
        ],
      }),
    });

    expect(response.status).toBe(201);
    expect(createCalls).toEqual([
      {
        name: "Coordinator",
        model: "claude-opus-5",
        mcpServers: [
          { type: "url", name: "docs", url: "https://mcp.example.test" },
        ],
        multiagent: {
          type: "coordinator",
          agents: [
            { type: "agent", agentId: "agent_child", version: 2 },
            { type: "advisor", model: "claude-sonnet-5" },
          ],
        },
        skills: [
          { type: "custom", skillId: "skill_review", version: "3" },
        ],
        tools: [
          {
            type: "agent_toolset_20260401",
            defaultConfig: {
              enabled: false,
              permissionPolicy: { type: "always_ask" },
            },
            configs: [
              {
                name: "bash",
                enabled: true,
                permissionPolicy: { type: "always_allow" },
              },
            ],
          },
          {
            type: "mcp_toolset",
            mcpServerName: "docs",
            defaultConfig: { enabled: true },
            configs: [{ name: "search_docs", enabled: false }],
          },
        ],
      },
    ]);
  });

  it("rejects a create request without the required agent name", async () => {
    const createCalls: unknown[] = [];
    const api = buildAgentsTestApi(
      makeAgentsPort({
        createAgent: async (input) => {
          createCalls.push(input);
          throw new Error("agent create port must not run for an invalid request");
        },
      }),
    );

    const response = await api.request("/v1/agents", {
      method: "POST",
      headers: {
        "anthropic-beta": "managed-agents-2026-04-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "claude-opus-5" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: expect.stringContaining("name"),
      },
    });
    expect(createCalls).toEqual([]);
  });

  it("rejects a create request without the required model", async () => {
    const createCalls: unknown[] = [];
    const api = buildAgentsTestApi(
      makeAgentsPort({
        createAgent: async (input) => {
          createCalls.push(input);
          throw new Error("agent create port must not run for an invalid request");
        },
      }),
    );

    const response = await api.request("/v1/agents", {
      method: "POST",
      headers: {
        "anthropic-beta": "managed-agents-2026-04-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Coding Assistant" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: expect.stringContaining("model"),
      },
    });
    expect(createCalls).toEqual([]);
  });

  it("maps the namespaced OpenMA extension without changing the Managed Agents route", async () => {
    const createCalls: unknown[] = [];
    const extendedAgent = {
      ...agentView,
      openma: {
        auxiliaryModel: { id: "deepseek-chat", speed: "fast" as const },
        appendablePrompts: ["prompt_review"],
        harness: "acp-sandbox",
        acp: {
          agent: {
            id: "pi",
            command: "pi-acp",
            args: ["--stdio"],
            env: { PI_PROFILE: "managed" },
            cwd: "/workspace",
          },
          restart: { mode: "on-crash" as const, maxRestarts: 2, windowMs: 60_000 },
          idleTimeoutMs: 30_000,
          perTurnTimeoutMs: 120_000,
        },
        runtimeBinding: {
          runtimeId: "runtime_pi",
          acpAgentId: "pi",
          localSkillBlocklist: ["unsafe-local-skill"],
        },
        enableGeneralSubagent: true,
      },
    };
    const api = buildAgentsTestApi(
      makeAgentsPort({
        createAgent: async (input) => {
          createCalls.push(input);
          return { type: "created", agent: extendedAgent };
        },
      }),
    );

    const response = await api.request("/v1/agents", {
      method: "POST",
      headers: {
        "anthropic-beta": "managed-agents-2026-04-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Coding Assistant",
        model: "claude-opus-5",
        _oma: {
          aux_model: { id: "deepseek-chat", speed: "fast" },
          appendable_prompts: ["prompt_review"],
          harness: "acp-sandbox",
          acp: {
            agent: {
              id: "pi",
              command: "pi-acp",
              args: ["--stdio"],
              env: { PI_PROFILE: "managed", REMOVE_ME: null },
              cwd: "/workspace",
            },
            restart: { mode: "on-crash", max_restarts: 2, window_ms: 60_000 },
            idle_timeout_ms: 30_000,
            per_turn_timeout_ms: 120_000,
          },
          runtime_binding: {
            runtime_id: "runtime_pi",
            acp_agent_id: "pi",
            local_skill_blocklist: ["unsafe-local-skill"],
          },
          enable_general_subagent: true,
        },
      }),
    });

    expect(response.status).toBe(201);
    expect(createCalls).toEqual([
      {
        name: "Coding Assistant",
        model: "claude-opus-5",
        openma: {
          auxiliaryModel: { id: "deepseek-chat", speed: "fast" },
          appendablePrompts: ["prompt_review"],
          harness: "acp-sandbox",
          acp: {
            agent: {
              id: "pi",
              command: "pi-acp",
              args: ["--stdio"],
              env: { PI_PROFILE: "managed" },
              cwd: "/workspace",
            },
            restart: { mode: "on-crash", maxRestarts: 2, windowMs: 60_000 },
            idleTimeoutMs: 30_000,
            perTurnTimeoutMs: 120_000,
          },
          runtimeBinding: {
            runtimeId: "runtime_pi",
            acpAgentId: "pi",
            localSkillBlocklist: ["unsafe-local-skill"],
          },
          enableGeneralSubagent: true,
        },
      },
    ]);
    const mappedEnvironment = (createCalls[0] as {
      openma: { acp: { agent: { env: Record<string, string> } } };
    }).openma.acp.agent.env;
    expect(Object.hasOwn(mappedEnvironment, "REMOVE_ME")).toBe(false);
    expect(await response.json()).toEqual({
      ...agentWire,
      _oma: {
        aux_model: { id: "deepseek-chat", speed: "fast" },
        appendable_prompts: ["prompt_review"],
        harness: "acp-sandbox",
        acp: {
          agent: {
            id: "pi",
            command: "pi-acp",
            args: ["--stdio"],
            env: { PI_PROFILE: "managed" },
            cwd: "/workspace",
          },
          restart: { mode: "on-crash", max_restarts: 2, window_ms: 60_000 },
          idle_timeout_ms: 30_000,
          per_turn_timeout_ms: 120_000,
        },
        runtime_binding: {
          runtime_id: "runtime_pi",
          acp_agent_id: "pi",
          local_skill_blocklist: ["unsafe-local-skill"],
        },
        enable_general_subagent: true,
      },
    });
  });

  it("rejects unknown fields inside the OpenMA namespace", async () => {
    const createCalls: unknown[] = [];
    const api = buildAgentsTestApi(
      makeAgentsPort({
        createAgent: async (input) => {
          createCalls.push(input);
          throw new Error("agent create port must not run for an invalid extension");
        },
      }),
    );

    const response = await api.request("/v1/agents", {
      method: "POST",
      headers: {
        "anthropic-beta": "managed-agents-2026-04-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Coding Assistant",
        model: "claude-opus-5",
        _oma: { unreviewed_passthrough: true },
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: expect.stringContaining("unreviewed_passthrough"),
      },
    });
    expect(createCalls).toEqual([]);
  });

  it("does not emit an application response that violates the official agent shape", async () => {
    const api = buildAgentsTestApi(
      makeAgentsPort({
        createAgent: async () => ({
          type: "created",
          agent: {
            id: "agent_invalid",
            name: "Missing the rest of the required response",
          } as AgentView,
        }),
      }),
    );

    const response = await api.request("/v1/agents", {
      method: "POST",
      headers: {
        "anthropic-beta": "managed-agents-2026-04-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Coding Assistant",
        model: "claude-opus-5",
      }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      type: "error",
      error: {
        type: "api_error",
      },
    });
  });

  it("returns an invalid_request_error for malformed JSON", async () => {
    const createCalls: unknown[] = [];
    const api = buildAgentsTestApi(
      makeAgentsPort({
        createAgent: async (input) => {
          createCalls.push(input);
          throw new Error("agent create port must not run for malformed JSON");
        },
      }),
    );

    const response = await api.request("/v1/agents", {
      method: "POST",
      headers: {
        "anthropic-beta": "managed-agents-2026-04-01",
        "content-type": "application/json",
      },
      body: "{",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      type: "error",
      error: {
        type: "invalid_request_error",
      },
    });
    expect(createCalls).toEqual([]);
  });

  it("rejects malformed members of official nested agent input unions", async () => {
    const createCalls: unknown[] = [];
    const api = buildAgentsTestApi(
      makeAgentsPort({
        createAgent: async (input) => {
          createCalls.push(input);
          return { type: "created", agent: agentView };
        },
      }),
    );

    const response = await api.request("/v1/agents", {
      method: "POST",
      headers: {
        "anthropic-beta": "managed-agents-2026-04-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Coding Assistant",
        model: "claude-opus-5",
        mcp_servers: [{ name: "missing-url", type: "url" }],
        tools: [{}],
      }),
    });

    expect(response.status).toBe(400);
    expect(createCalls).toEqual([]);
  });

  it("rejects an unsupported model effort level", async () => {
    const createCalls: unknown[] = [];
    const api = buildAgentsTestApi(
      makeAgentsPort({
        createAgent: async (input) => {
          createCalls.push(input);
          throw new Error("agent create port must not run for an invalid model");
        },
      }),
    );

    const response = await api.request("/v1/agents", {
      method: "POST",
      headers: {
        "anthropic-beta": "managed-agents-2026-04-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Coding Assistant",
        model: {
          id: "claude-opus-5",
          effort: "turbo",
        },
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: expect.stringContaining("model"),
      },
    });
    expect(createCalls).toEqual([]);
  });
});
