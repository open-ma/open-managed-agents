import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { agentView, agentWire, makeAgentsPort } from "./fixtures";
import { buildAgentsTestApi } from "./test-api";

describe("Managed Agents API — POST /v1/agents/:agent_id", () => {
  it("maps the official SDK update request to an application command", async () => {
    const updateCalls: unknown[] = [];
    const updatedAgent = {
      ...agentView,
      description: "Updated description",
      metadata: { owner: "platform" },
      model: {
        id: "claude-opus-5",
        effort: "max" as const,
        inferenceGeo: "us",
        providerOptions: { anthropic: { beta: ["context-1m"] } },
        speed: "fast" as const,
      },
      version: 4,
    };
    const api = buildAgentsTestApi(
      makeAgentsPort({
        updateAgent: async (command) => {
          updateCalls.push(command);
          return { type: "updated", agent: updatedAgent };
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

    const result = await client.beta.agents.update(agentWire.id, {
      description: "Updated description",
      metadata: { owner: "platform", obsolete: null },
      model: {
        id: "claude-opus-5",
        effort: "max",
        inference_geo: "us",
        provider_options: { anthropic: { beta: ["context-1m"] } },
        speed: "fast",
      },
      version: 3,
    });

    expect(updateCalls).toEqual([
      {
        agentId: agentWire.id,
        description: "Updated description",
        metadata: { owner: "platform", obsolete: null },
        model: {
          id: "claude-opus-5",
          effort: "max",
          inferenceGeo: "us",
          providerOptions: { anthropic: { beta: ["context-1m"] } },
          speed: "fast",
        },
        expectedVersion: 3,
      },
    ]);
    expect(result).toEqual({
      ...agentWire,
      description: "Updated description",
      metadata: { owner: "platform" },
      model: {
        id: "claude-opus-5",
        effort: { type: "max" },
        inference_geo: "us",
        provider_options: { anthropic: { beta: ["context-1m"] } },
        speed: "fast",
      },
      version: 4,
    });
  });

  it("forwards typed OpenMA clears through the official SDK escape hatch", async () => {
    const updateCalls: unknown[] = [];
    const api = buildAgentsTestApi(
      makeAgentsPort({
        updateAgent: async (command) => {
          updateCalls.push(command);
          return { type: "updated", agent: agentView };
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

    const result = await client.beta.agents.update(
      agentWire.id,
      {
        name: "Coding Assistant",
        _oma: {
          aux_model: null,
          appendable_prompts: [],
        },
      } as Parameters<typeof client.beta.agents.update>[1] & {
        _oma: {
          aux_model: null;
          appendable_prompts: string[];
        };
      },
    );

    expect(updateCalls).toEqual([
      {
        agentId: agentWire.id,
        name: "Coding Assistant",
        openma: {
          auxiliaryModel: null,
          appendablePrompts: [],
        },
      },
    ]);
    expect(result).toEqual(agentWire);
  });

  it("maps an optimistic version conflict to the official SDK error", async () => {
    const api = buildAgentsTestApi(
      makeAgentsPort({
        updateAgent: async () => ({
          type: "version_conflict",
          message: "Agent version does not match the current version",
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

    await expect(
      client.beta.agents.update(agentWire.id, { name: "New name", version: 2 }),
    ).rejects.toMatchObject({
      status: 409,
      type: "conflict_error",
      error: {
        type: "error",
        error: {
          type: "conflict_error",
          message: "Agent version does not match the current version",
        },
      },
    });
  });

  it("maps the explicit application not-found result to the official SDK error", async () => {
    const api = buildAgentsTestApi(
      makeAgentsPort({
        updateAgent: async () => ({ type: "not_found" }),
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

    await expect(
      client.beta.agents.update("agent_missing", { name: "New name" }),
    ).rejects.toMatchObject({
      status: 404,
      type: "not_found_error",
      error: {
        error: {
          type: "not_found_error",
          message: expect.stringContaining("agent_missing"),
        },
      },
    });
  });

  it("maps application validation failure to invalid_request_error", async () => {
    const api = buildAgentsTestApi(
      makeAgentsPort({
        updateAgent: async () => ({
          type: "invalid_request",
          message: "Referenced MCP server does not exist",
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

    await expect(
      client.beta.agents.update(agentWire.id, { name: "New name" }),
    ).rejects.toMatchObject({
      status: 400,
      type: "invalid_request_error",
      error: {
        error: {
          type: "invalid_request_error",
          message: "Referenced MCP server does not exist",
        },
      },
    });
  });
});
