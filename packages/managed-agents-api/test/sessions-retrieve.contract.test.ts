import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { makeSessionsPort, sessionView, sessionWire } from "./session-fixtures";
import { buildSessionsTestApi } from "./test-api";

describe("Managed Agents API — GET /v1/sessions/:session_id", () => {
  it("maps the official SDK retrieve call to an application query", async () => {
    const retrieveCalls: unknown[] = [];
    const port = makeSessionsPort({
      retrieveSession: async (query) => {
        retrieveCalls.push(query);
        return { type: "found", session: sessionView };
      },
    });
    const api = buildSessionsTestApi(port);
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

    const result = await client.beta.sessions.retrieve(sessionWire.id);

    expect(retrieveCalls).toEqual([{ sessionId: sessionWire.id }]);
    expect(result).toEqual(sessionWire);
  });

  it("maps the explicit application not-found result to the official SDK error", async () => {
    const port = makeSessionsPort({
      retrieveSession: async () => ({ type: "not_found" }),
    });
    const api = buildSessionsTestApi(port);
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

    await expect(client.beta.sessions.retrieve("session_missing")).rejects.toMatchObject({
      status: 404,
      type: "not_found_error",
      error: {
        error: {
          type: "not_found_error",
          message: expect.stringContaining("session_missing"),
        },
      },
    });
  });

  it("maps strongly typed outcome evaluations to the official wire shape", async () => {
    const port = makeSessionsPort({
      retrieveSession: async () => ({
        type: "found",
        session: {
          ...sessionView,
          outcomeEvaluations: [{
            type: "outcome_evaluation",
            completedAt: "2026-08-26T06:00:00.000Z",
            description: "Ship the API migration",
            explanation: "All contract checks pass",
            iteration: 1,
            outcomeId: "outc_01",
            result: "satisfied",
          }],
        },
      }),
    });
    const api = buildSessionsTestApi(port);
    const client = new Anthropic({
      apiKey: "test-key",
      baseURL: "http://openma.test",
      maxRetries: 0,
      fetch: async (input, init) => {
        const request = input instanceof Request
          ? new Request(input, init)
          : new Request(input.toString(), init);
        return api.fetch(request);
      },
    });

    const result = await client.beta.sessions.retrieve(sessionWire.id);

    expect(result.outcome_evaluations).toEqual([{
      type: "outcome_evaluation",
      completed_at: "2026-08-26T06:00:00.000Z",
      description: "Ship the API migration",
      explanation: "All contract checks pass",
      iteration: 1,
      outcome_id: "outc_01",
      result: "satisfied",
    }]);
  });

  it("returns the OpenMA extension pinned to the Session agent snapshot", async () => {
    const port = makeSessionsPort({
      retrieveSession: async () => ({
        type: "found",
        session: {
          ...sessionView,
          agent: {
            ...sessionView.agent,
            openma: {
              auxiliaryModel: {
                id: "deepseek-chat",
                providerOptions: { pi: { reasoning: "off" } },
                speed: "fast",
              },
              appendablePrompts: ["prompt_linear"],
              harness: "pi",
            },
          },
        },
      }),
    });
    const api = buildSessionsTestApi(port);

    const response = await api.request(
      `http://openma.test/v1/sessions/${sessionWire.id}`,
      { headers: { "anthropic-beta": "managed-agents-2026-04-01" } },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      agent: {
        _oma: {
          aux_model: {
            id: "deepseek-chat",
            provider_options: { pi: { reasoning: "off" } },
            speed: "fast",
          },
          appendable_prompts: ["prompt_linear"],
          harness: "pi",
        },
      },
    });
  });

  it("rejects a session whose application resource cannot satisfy the official resource union", async () => {
    const port = makeSessionsPort({
      retrieveSession: async () => ({
        type: "found",
        session: {
          ...sessionView,
          resources: [{ type: "file", fileId: "file_incomplete" } as never],
        },
      }),
    });
    const api = buildSessionsTestApi(port);

    const response = await api.request(
      `http://openma.test/v1/sessions/${sessionWire.id}`,
      { headers: { "anthropic-beta": "managed-agents-2026-04-01" } },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      type: "error",
      error: { type: "api_error" },
    });
  });

  it("rejects a resolved agent snapshot with a non-official tool shape", async () => {
    const api = buildSessionsTestApi(
      makeSessionsPort({
        retrieveSession: async () => ({
          type: "found",
          session: {
            ...sessionView,
            agent: { ...sessionView.agent, tools: [{} as never] },
          },
        }),
      }),
    );

    const response = await api.request(
      `http://openma.test/v1/sessions/${sessionWire.id}`,
      { headers: { "anthropic-beta": "managed-agents-2026-04-01" } },
    );

    expect(response.status).toBe(500);
  });

  it("encodes a resolved Session agent roster into the official nested shape", async () => {
    const resolvedTool = {
      type: "agent_toolset_20260401" as const,
      configs: [],
      defaultConfig: {
        enabled: true,
        permissionPolicy: { type: "always_allow" as const },
      },
    };
    const api = buildSessionsTestApi(
      makeSessionsPort({
        retrieveSession: async () => ({
          type: "found",
          session: {
            ...sessionView,
            agent: {
              ...sessionView.agent,
              mcpServers: [
                {
                  type: "url",
                  name: "docs",
                  url: "https://mcp.example.test",
                },
              ],
              skills: [
                { type: "anthropic", skillId: "pdf", version: "2026-08" },
              ],
              tools: [resolvedTool],
              multiagent: {
                type: "coordinator",
                agents: [
                  { type: "advisor", model: "claude-sonnet-5" },
                  {
                    type: "agent",
                    id: "agent_reviewer",
                    description: "Reviews changes",
                    mcpServers: [],
                    model: { id: "claude-sonnet-5" },
                    name: "Reviewer",
                    skills: [],
                    system: null,
                    tools: [resolvedTool],
                    version: 4,
                  },
                ],
              },
            },
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

    const result = await client.beta.sessions.retrieve(sessionWire.id);

    expect(result.agent).toMatchObject({
      mcp_servers: [
        { type: "url", name: "docs", url: "https://mcp.example.test" },
      ],
      skills: [
        { type: "anthropic", skill_id: "pdf", version: "2026-08" },
      ],
      tools: [
        {
          type: "agent_toolset_20260401",
          configs: [],
          default_config: {
            enabled: true,
            permission_policy: { type: "always_allow" },
          },
        },
      ],
      multiagent: {
        type: "coordinator",
        agents: [
          { type: "advisor", model: "claude-sonnet-5" },
          {
            type: "agent",
            id: "agent_reviewer",
            name: "Reviewer",
            skills: [],
            tools: [
              {
                type: "agent_toolset_20260401",
                configs: [],
                default_config: {
                  enabled: true,
                  permission_policy: { type: "always_allow" },
                },
              },
            ],
            version: 4,
          },
        ],
      },
    });
  });
});
