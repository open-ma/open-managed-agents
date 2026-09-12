import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { makeSessionThreadsPort } from "./session-thread-fixtures";
import { sessionView, sessionWire } from "./session-fixtures";
import { buildSessionThreadsTestApi } from "./test-api";

describe("Managed Agents API — GET /v1/sessions/:session_id/threads/:thread_id", () => {
  it("maps session and thread identifiers into a retrieve query", async () => {
    const retrieveCalls: unknown[] = [];
    const port = makeSessionThreadsPort({
      retrieveSessionThread: async (query) => {
        retrieveCalls.push(query);
        return {
          type: "found",
          thread: {
            id: "sthr_advisor_02",
            agent: { type: "advisor", model: "claude-sonnet-5" },
            archivedAt: null,
            createdAt: "2026-08-26T06:10:00.000Z",
            parentThreadId: "sthr_primary_01",
            sessionId: sessionWire.id,
            stats: null,
            status: "idle",
            updatedAt: "2026-08-26T06:10:05.000Z",
            usage: null,
          },
        };
      },
    });
    const api = buildSessionThreadsTestApi(port);
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

    const thread = await client.beta.sessions.threads.retrieve("sthr_advisor_02", {
      session_id: sessionWire.id,
    });

    expect(retrieveCalls).toEqual([
      { sessionId: sessionWire.id, threadId: "sthr_advisor_02" },
    ]);
    expect(thread).toMatchObject({
      id: "sthr_advisor_02",
      agent: { type: "advisor", model: "claude-sonnet-5" },
      session_id: sessionWire.id,
      type: "session_thread",
    });
  });

  it("rejects a thread agent snapshot with a non-official tool shape", async () => {
    const api = buildSessionThreadsTestApi(
      makeSessionThreadsPort({
        retrieveSessionThread: async () => ({
          type: "found",
          thread: {
            id: "sthr_agent_invalid",
            agent: {
              type: "agent",
              id: sessionView.agent.id,
              description: sessionView.agent.description,
              mcpServers: sessionView.agent.mcpServers,
              model: sessionView.agent.model,
              name: sessionView.agent.name,
              skills: sessionView.agent.skills,
              system: sessionView.agent.system,
              tools: [{} as never],
              version: sessionView.agent.version,
            },
            archivedAt: null,
            createdAt: "2026-08-26T06:10:00.000Z",
            parentThreadId: null,
            sessionId: sessionWire.id,
            stats: null,
            status: "idle",
            updatedAt: "2026-08-26T06:10:05.000Z",
            usage: null,
          },
        }),
      }),
    );

    const response = await api.request(
      `http://openma.test/v1/sessions/${sessionWire.id}/threads/sthr_agent_invalid`,
      { headers: { "anthropic-beta": "managed-agents-2026-04-01" } },
    );

    expect(response.status).toBe(500);
  });

  it("encodes an application-native thread agent snapshot", async () => {
    const api = buildSessionThreadsTestApi(
      makeSessionThreadsPort({
        retrieveSessionThread: async () => ({
          type: "found",
          thread: {
            id: "sthr_agent_resolved",
            agent: {
              type: "agent",
              id: sessionView.agent.id,
              description: sessionView.agent.description,
              mcpServers: [],
              model: sessionView.agent.model,
              name: sessionView.agent.name,
              skills: [
                { type: "custom", skillId: "skill_review", version: "2" },
              ],
              system: sessionView.agent.system,
              tools: [
                {
                  type: "agent_toolset_20260401",
                  configs: [],
                  defaultConfig: {
                    enabled: true,
                    permissionPolicy: { type: "always_allow" },
                  },
                },
              ],
              version: sessionView.agent.version,
            },
            archivedAt: null,
            createdAt: "2026-08-26T06:10:00.000Z",
            parentThreadId: null,
            sessionId: sessionWire.id,
            stats: null,
            status: "idle",
            updatedAt: "2026-08-26T06:10:05.000Z",
            usage: null,
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

    const thread = await client.beta.sessions.threads.retrieve(
      "sthr_agent_resolved",
      { session_id: sessionWire.id },
    );

    expect(thread.agent).toMatchObject({
      type: "agent",
      skills: [
        { type: "custom", skill_id: "skill_review", version: "2" },
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
    });
  });

  it("returns the OpenMA extension pinned to a resolved thread agent", async () => {
    const api = buildSessionThreadsTestApi(
      makeSessionThreadsPort({
        retrieveSessionThread: async () => ({
          type: "found",
          thread: {
            id: "sthr_agent_openma",
            agent: {
              type: "agent",
              id: sessionView.agent.id,
              description: sessionView.agent.description,
              mcpServers: [],
              model: sessionView.agent.model,
              name: sessionView.agent.name,
              openma: {
                appendablePrompts: ["prompt_review"],
                runtimeBinding: {
                  runtimeId: "runtime_pi",
                  acpAgentId: "pi",
                },
              },
              skills: [],
              system: sessionView.agent.system,
              tools: [],
              version: sessionView.agent.version,
            },
            archivedAt: null,
            createdAt: "2026-08-26T06:10:00.000Z",
            parentThreadId: null,
            sessionId: sessionWire.id,
            stats: null,
            status: "idle",
            updatedAt: "2026-08-26T06:10:05.000Z",
            usage: null,
          },
        }),
      }),
    );

    const response = await api.request(
      `http://openma.test/v1/sessions/${sessionWire.id}/threads/sthr_agent_openma`,
      { headers: { "anthropic-beta": "managed-agents-2026-04-01" } },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      agent: {
        _oma: {
          appendable_prompts: ["prompt_review"],
          runtime_binding: {
            runtime_id: "runtime_pi",
            acp_agent_id: "pi",
          },
        },
      },
    });
  });
});
