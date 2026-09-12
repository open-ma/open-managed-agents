import { describe, expect, it } from "vitest";
import type { Session } from "@open-managed-agents/managed-agents-application";
import * as managedAgentCodec from "../src/lib/node-managed-agent-codec.js";
import {
  allowAllLegacyHarnessTools,
  toLegacyHarnessAgentConfig,
} from "../src/lib/node-managed-agent-codec.js";

const session: Session = {
  id: "session_01",
  agent: {
    id: "agent_coordinator",
    description: null,
    mcpServers: [
      { type: "url", name: "docs", url: "https://mcp.example.test" },
    ],
    model: {
      id: "claude-opus-5",
      effort: "high",
      inferenceGeo: "us",
      speed: "fast",
    },
    multiagent: {
      type: "coordinator",
      agents: [
        {
          type: "agent",
          id: "agent_reviewer",
          description: null,
          mcpServers: [],
          model: { id: "claude-sonnet-4-6" },
          name: "Reviewer",
          skills: [],
          system: null,
          tools: [],
          version: 7,
        },
        { type: "advisor", model: "claude-haiku-4-5" },
      ],
    },
    name: "Coordinator",
    openma: {
      auxiliaryModel: { id: "deepseek-chat", speed: "fast" },
      appendablePrompts: ["prompt_review"],
      harness: "pi",
      acp: {
        agent: { id: "pi", command: "pi-acp", args: ["--stdio"] },
        restart: { mode: "on-crash", maxRestarts: 2, windowMs: 30_000 },
        idleTimeoutMs: 60_000,
        perTurnTimeoutMs: 120_000,
      },
      runtimeBinding: {
        runtimeId: "runtime_local",
        acpAgentId: "pi",
        localSkillBlocklist: ["unsafe-skill"],
      },
      enableGeneralSubagent: true,
    },
    skills: [{ type: "custom", skillId: "skill_review", version: "3" }],
    system: "Coordinate carefully",
    tools: [
      {
        type: "agent_toolset_20260401",
        configs: [
          {
            type: "web_search",
            name: "web_search",
            enabled: true,
            permissionPolicy: { type: "always_ask" },
            allowedDomains: ["docs.example.com"],
            blockedDomains: ["private.example.com"],
            userLocation: {
              type: "approximate",
              city: "Shanghai",
              timezone: "Asia/Shanghai",
            },
          },
        ],
        defaultConfig: {
          enabled: false,
          permissionPolicy: { type: "always_allow" },
        },
      },
      {
        type: "mcp_toolset",
        mcpServerName: "docs",
        configs: [
          {
            name: "search",
            enabled: true,
            permissionPolicy: { type: "always_ask" },
          },
        ],
        defaultConfig: {
          enabled: true,
          permissionPolicy: { type: "always_allow" },
        },
      },
      {
        type: "custom",
        name: "release",
        description: "Release the service",
        inputSchema: {
          type: "object",
          properties: { tag: { type: "string" } },
          required: ["tag"],
        },
      },
    ],
    version: 4,
  },
  archivedAt: null,
  budget: null,
  createdAt: "2026-08-26T00:00:00.000Z",
  environmentId: "env_01",
  metadata: {},
  outcomeEvaluations: [],
  resources: [],
  stats: {},
  status: "running",
  title: null,
  updatedAt: "2026-08-26T00:00:01.000Z",
  usage: {},
  vaultIds: [],
};

describe("managed Agent to legacy Node harness codec", () => {
  it("resolves the pinned auxiliary model for tool execution", async () => {
    const resolveAuxiliary = (managedAgentCodec as Record<string, unknown>)
      .resolveNodeManagedAuxiliaryToolModel as undefined | ((
        session: Session,
        buildModel: (model: Session["agent"]["model"]) => Promise<unknown>,
      ) => Promise<unknown>);
    expect(resolveAuxiliary).toBeTypeOf("function");
    if (resolveAuxiliary === undefined) return;
    const selectedModels: Session["agent"]["model"][] = [];
    const model = { provider: "test-model" };

    await expect(resolveAuxiliary(session, async (selected) => {
      selectedModels.push(selected);
      return model;
    })).resolves.toEqual({
      model,
      modelInfo: { model_id: "deepseek-chat" },
    });
    expect(selectedModels).toEqual([{ id: "deepseek-chat", speed: "fast" }]);
  });

  it("projects Environment networking policy for the shared harness tools", () => {
    const encodeEnvironment = (managedAgentCodec as Record<string, unknown>)
      .toLegacyHarnessEnvironmentConfig as undefined | ((environment: unknown) => unknown);
    expect(encodeEnvironment).toBeTypeOf("function");
    if (encodeEnvironment === undefined) return;

    expect(encodeEnvironment({
      id: "env_limited",
      archivedAt: null,
      config: {
        type: "cloud",
        networking: {
          type: "limited",
          allowMcpServers: false,
          allowPackageManagers: true,
          allowedHosts: ["api.example.test"],
        },
        packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] },
      },
      createdAt: "2026-09-09T00:00:00.000Z",
      description: null,
      metadata: {},
      name: "Limited",
      updatedAt: "2026-09-09T00:00:00.000Z",
    })).toEqual({
      networking: {
        type: "limited",
        allow_mcp_servers: false,
        allow_package_managers: true,
        allowed_hosts: ["api.example.test"],
      },
    });
  });

  it("encodes application-native resolved definitions at the final adapter", () => {
    expect(toLegacyHarnessAgentConfig(session)).toEqual({
      id: "agent_coordinator",
      name: "Coordinator",
      model: { id: "claude-opus-5", effort: "high", speed: "fast" },
      system: "Coordinate carefully",
      tools: [
        {
          type: "agent_toolset_20260401",
          configs: [
            {
              type: "web_search",
              name: "web_search",
              enabled: true,
              permission_policy: { type: "always_ask" },
              allowed_domains: ["docs.example.com"],
              blocked_domains: ["private.example.com"],
              user_location: {
                type: "approximate",
                city: "Shanghai",
                timezone: "Asia/Shanghai",
              },
            },
          ],
          default_config: {
            enabled: false,
            permission_policy: { type: "always_allow" },
          },
        },
        {
          type: "mcp_toolset",
          mcp_server_name: "docs",
          configs: [
            {
              name: "search",
              enabled: true,
              permission_policy: { type: "always_ask" },
            },
          ],
          default_config: {
            enabled: true,
            permission_policy: { type: "always_allow" },
          },
        },
        {
          type: "custom",
          name: "release",
          description: "Release the service",
          input_schema: {
            type: "object",
            properties: { tag: { type: "string" } },
            required: ["tag"],
          },
        },
      ],
      mcp_servers: [
        { type: "url", name: "docs", url: "https://mcp.example.test" },
      ],
      skills: [{ type: "custom", skill_id: "skill_review", version: "3" }],
      callable_agents: [
        { type: "agent", id: "agent_reviewer", version: 7 },
      ],
      multiagent: {
        type: "coordinator",
        agents: [
          { type: "agent", id: "agent_reviewer", version: 7 },
          { type: "advisor", model: "claude-haiku-4-5" },
        ],
      },
      aux_model: { id: "deepseek-chat", speed: "fast" },
      appendable_prompts: ["prompt_review"],
      harness: "pi",
      acp: {
        agent: { id: "pi", command: "pi-acp", args: ["--stdio"] },
        restart: { mode: "on-crash", max_restarts: 2, window_ms: 30_000 },
        idle_timeout_ms: 60_000,
        per_turn_timeout_ms: 120_000,
      },
      runtime_binding: {
        runtime_id: "runtime_local",
        acp_agent_id: "pi",
        local_skill_blocklist: ["unsafe-skill"],
      },
      enable_general_subagent: true,
      version: 4,
      created_at: "2026-08-26T00:00:00.000Z",
      updated_at: "2026-08-26T00:00:01.000Z",
    });
  });

  it("creates a non-mutating executable copy for confirmed tool execution", () => {
    const encoded = toLegacyHarnessAgentConfig(session);
    const executable = allowAllLegacyHarnessTools(encoded);

    expect(executable.tools.slice(0, 2)).toMatchObject([
      {
        default_config: { permission_policy: { type: "always_allow" } },
        configs: [
          { name: "web_search", permission_policy: { type: "always_allow" } },
        ],
      },
      {
        default_config: { permission_policy: { type: "always_allow" } },
        configs: [
          { name: "search", permission_policy: { type: "always_allow" } },
        ],
      },
    ]);
    expect(encoded.tools.slice(0, 2)).toMatchObject([
      {
        default_config: { permission_policy: { type: "always_allow" } },
        configs: [
          { name: "web_search", permission_policy: { type: "always_ask" } },
        ],
      },
      {
        default_config: { permission_policy: { type: "always_allow" } },
        configs: [
          { name: "search", permission_policy: { type: "always_ask" } },
        ],
      },
    ]);
  });
});
