import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { agentView, agentWire, makeAgentsPort } from "./fixtures";
import { buildAgentsTestApi } from "./test-api";

describe("Managed Agents API — GET /v1/agents/:agent_id", () => {
  it("serves the official SDK retrieve call without rewriting its path", async () => {
    const retrieveCalls: unknown[] = [];
    const applicationAgent = {
      ...agentView,
      version: 3,
    };
    const wireAgent = { ...agentWire, version: 3 };
    const api = buildAgentsTestApi(
      makeAgentsPort({
        retrieveAgent: async (input) => {
          retrieveCalls.push(input);
          return { type: "found", agent: applicationAgent };
        },
      }),
    );
    const client = new Anthropic({
      apiKey: "test-key",
      baseURL: "http://openma.test",
      maxRetries: 0,
      fetch: async (input, init) => {
        const request =
          input instanceof Request
            ? new Request(input, init)
            : new Request(input.toString(), init);
        return api.fetch(request);
      },
    });

    const result = await client.beta.agents.retrieve(wireAgent.id, { version: 3 });

    expect(result).toEqual(wireAgent);
    expect(retrieveCalls).toEqual([{ agentId: wireAgent.id, version: 3 }]);
  });

  it("maps the explicit application not-found result to the official SDK error", async () => {
    const api = buildAgentsTestApi(
      makeAgentsPort({
        retrieveAgent: async () => ({ type: "not_found" }),
      }),
    );
    const client = new Anthropic({
      apiKey: "test-key",
      baseURL: "http://openma.test",
      maxRetries: 0,
      fetch: async (input, init) => {
        const request =
          input instanceof Request
            ? new Request(input, init)
            : new Request(input.toString(), init);
        return api.fetch(request);
      },
    });

    await expect(client.beta.agents.retrieve("agent_missing")).rejects.toMatchObject({
      status: 404,
      type: "not_found_error",
      error: {
        type: "error",
        error: {
          type: "not_found_error",
          message: expect.stringContaining("agent_missing"),
        },
      },
    });
  });

  it("rejects a resolved agent with a non-official MCP server shape", async () => {
    const api = buildAgentsTestApi(
      makeAgentsPort({
        retrieveAgent: async () => ({
          type: "found",
          agent: {
            ...agentView,
            mcpServers: [{ name: "incomplete" } as never],
          },
        }),
      }),
    );

    const response = await api.request(
      `http://openma.test/v1/agents/${agentWire.id}`,
      { headers: { "anthropic-beta": "managed-agents-2026-04-01" } },
    );

    expect(response.status).toBe(500);
  });

  it("encodes an application-native resolved definition into the official nested wire shape", async () => {
    const api = buildAgentsTestApi(
      makeAgentsPort({
        retrieveAgent: async () => ({
          type: "found",
          agent: {
            ...agentView,
            mcpServers: [
              {
                type: "url",
                name: "docs",
                url: "https://mcp.example.test",
              },
              {
                type: "stdio",
                name: "workspace",
                command: "/usr/local/bin/workspace-mcp",
                args: ["--root", "/workspace"],
                env: { LOG_LEVEL: "info" },
              },
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
                  enabled: true,
                  permissionPolicy: { type: "always_ask" },
                },
                configs: [
                  {
                    type: "bash",
                    name: "bash",
                    enabled: true,
                    permissionPolicy: { type: "always_allow" },
                  },
                ],
              },
              {
                type: "mcp_toolset",
                mcpServerName: "docs",
                defaultConfig: {
                  enabled: true,
                  permissionPolicy: { type: "always_allow" },
                },
                configs: [
                  {
                    name: "search_docs",
                    enabled: true,
                    permissionPolicy: { type: "always_ask" },
                  },
                ],
              },
            ],
          },
        }),
      }),
    );
    const client = new Anthropic({
      apiKey: "test-key",
      baseURL: "http://openma.test",
      maxRetries: 0,
      fetch: async (input, init) => {
        const request =
          input instanceof Request
            ? new Request(input, init)
            : new Request(input.toString(), init);
        return api.fetch(request);
      },
    });

    const result = await client.beta.agents.retrieve(agentWire.id);

    expect(result).toMatchObject({
      mcp_servers: [
        { type: "url", name: "docs", url: "https://mcp.example.test" },
        {
          type: "stdio",
          name: "workspace",
          command: "/usr/local/bin/workspace-mcp",
          args: ["--root", "/workspace"],
          env: { LOG_LEVEL: "info" },
        },
      ],
      multiagent: {
        type: "coordinator",
        agents: [
          { type: "agent", id: "agent_child", version: 2 },
          { type: "advisor", model: "claude-sonnet-5" },
        ],
      },
      skills: [
        { type: "custom", skill_id: "skill_review", version: "3" },
      ],
      tools: [
        {
          type: "agent_toolset_20260401",
          default_config: {
            enabled: true,
            permission_policy: { type: "always_ask" },
          },
          configs: [
            {
              type: "bash",
              name: "bash",
              enabled: true,
              permission_policy: { type: "always_allow" },
            },
          ],
        },
        {
          type: "mcp_toolset",
          mcp_server_name: "docs",
          default_config: {
            enabled: true,
            permission_policy: { type: "always_allow" },
          },
          configs: [
            {
              name: "search_docs",
              enabled: true,
              permission_policy: { type: "always_ask" },
            },
          ],
        },
      ],
    });
  });
});
