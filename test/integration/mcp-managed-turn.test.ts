// @ts-nocheck
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultHarness } from "../../apps/agent/src/harness/default-loop";
import { registerHarness } from "../../apps/agent/src/harness/registry";
import { getCfServicesForTenant } from "@open-managed-agents/services";
import {
  createScriptedLanguageModel,
  finishChunk,
  streamStep,
  textChunks,
  toolCallChunks,
} from "../fakes/scripted-language-model";
import { createScriptedMcpServer } from "../fakes/scripted-mcp-server";

const HEADERS = {
  "x-api-key": "test-key",
  "anthropic-beta": "managed-agents-2026-04-01",
  "content-type": "application/json",
};
const MCP_ORIGIN = "https://managed-turn-mcp.example.test";
const BROKEN_MCP_ORIGIN = "https://broken-managed-turn-mcp.example.test";
const OAUTH_ORIGIN = "https://managed-turn-oauth.example.test";
const HARNESS_NAME = "managed-turn-mcp-e2e";

let turnModel: ReturnType<typeof createScriptedLanguageModel> | null = null;

registerHarness(HARNESS_NAME, () => {
  const harness = new DefaultHarness();
  return {
    async run(ctx) {
      if (!turnModel) throw new Error("managed-turn fake LLM was not installed");
      await harness.run({ ...ctx, model: turnModel.model });
    },
  };
});

function api(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(`http://localhost${path}`, init));
}

async function post(path: string, body: Record<string, unknown>) {
  return api(path, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
}

function usage() {
  return {
    inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 7, text: 7, reasoning: 0 },
  };
}

function createTurnModel() {
  const toolChunks = toolCallChunks({
    id: "mcp-call-1",
    toolName: "mcp__fake__echo",
    inputDeltas: ['{"value":', '"managed"}'],
  });
  const finalChunks = textChunks("text-1", ["MCP echo ", "completed."]);
  return createScriptedLanguageModel([
    streamStep([
      toolChunks[0],
      { type: "response-metadata", id: "mock-response-tool" },
      ...toolChunks.slice(1),
      finishChunk("tool-calls", usage()),
    ]),
    streamStep([
      finalChunks[0],
      { type: "response-metadata", id: "mock-response-final" },
      ...finalChunks.slice(1),
      finishChunk("stop", usage()),
    ]),
  ], {
    provider: "openma-e2e-mock",
    modelId: "managed-turn-mock-model",
  });
}

type ExternalState = {
  oauthRefreshCount: number;
  staleBearerCount: number;
  freshBearerCount: number;
  sawSessionOnToolCall: boolean;
};

function installExternalMocks() {
  const originalFetch = globalThis.fetch;
  const state: ExternalState = {
    oauthRefreshCount: 0,
    staleBearerCount: 0,
    freshBearerCount: 0,
    sawSessionOnToolCall: false,
  };
  const mcp = createScriptedMcpServer({
    sessionId: "managed-turn-session",
    serverInfo: { name: "managed-turn-fake", version: "1.0.0" },
    tools: [{
      name: "echo",
      description: "Echo a value",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
    }],
    callTool({ arguments: args, request }) {
      state.sawSessionOnToolCall =
        request.headers.get("mcp-session-id") === "managed-turn-session";
      return {
        content: [{ type: "text", text: `echo:${args?.value}` }],
        structuredContent: { echoed: args?.value },
      };
    },
  });

  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    if (url.origin === BROKEN_MCP_ORIGIN) {
      return new Response("broken external MCP", { status: 503 });
    }

    if (url.origin === OAUTH_ORIGIN) {
      state.oauthRefreshCount += 1;
      expect(request.method).toBe("POST");
      const body = new URLSearchParams(
        new TextDecoder().decode(await request.arrayBuffer()),
      );
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("refresh-token-1");
      return Response.json({
        access_token: "fresh-access-token",
        refresh_token: "refresh-token-2",
        token_type: "Bearer",
      });
    }

    if (url.origin !== MCP_ORIGIN) return originalFetch(input, init);

    const authorization = request.headers.get("authorization");
    if (authorization === "Bearer stale-access-token") {
      state.staleBearerCount += 1;
      return new Response("expired", { status: 401 });
    }
    if (authorization === "Bearer fresh-access-token") {
      state.freshBearerCount += 1;
    } else {
      return new Response("missing managed bearer", { status: 401 });
    }

    // Keep remote session termination observably asynchronous. The turn is
    // only lifecycle-complete once the runtime publishes status_idle after
    // awaiting MCP cleanup; waiting merely for the final agent.message is a
    // race that fast local machines can hide.
    if (request.method === "DELETE") {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    return mcp.fetch(request);
  };

  return {
    state,
    mcp,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

async function waitForCompletedTurn(sessionId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await api(`/v1/oma/sessions/${sessionId}/events?limit=100&order=asc`, {
      headers: HEADERS,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Array<Record<string, unknown>> };
    const events = body.data.map((row) =>
      row.data && typeof row.data === "object"
        ? row.data as Record<string, unknown>
        : row);
    const completedMessageIndex = events.findIndex((event) =>
      event.type === "agent.message"
      && JSON.stringify(event.content ?? "").includes("MCP echo completed."));
    const settledAfterMessage = completedMessageIndex >= 0
      && events.slice(completedMessageIndex + 1).some((event) =>
        event.type === "session.status_idle");
    if (settledAfterMessage) {
      return events;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("managed MCP turn did not complete");
}

afterEach(() => {
  turnModel = null;
});

describe("managed turn MCP E2E", () => {
  it("proxies official v1 Session and Vault credentials through the real service binding", async () => {
    const external = installExternalMocks();
    let vaultId;
    let credentialId;
    let agentId;
    let environmentId;
    let sessionId;
    try {
      const vaultResponse = await post("/v1/vaults", {
        display_name: `managed-v1-vault-${crypto.randomUUID()}`,
      });
      expect(vaultResponse.status).toBe(201);
      vaultId = ((await vaultResponse.json()) as { id: string }).id;

      const credentialResponse = await post(`/v1/vaults/${vaultId}/credentials`, {
        display_name: "Managed v1 MCP OAuth",
        auth: {
          type: "mcp_oauth",
          mcp_server_url: `${MCP_ORIGIN}/rpc`,
          access_token: "stale-access-token",
          refresh: {
            client_id: "managed-v1-client",
            refresh_token: "refresh-token-1",
            token_endpoint: `${OAUTH_ORIGIN}/token`,
            token_endpoint_auth: { type: "none" },
          },
        },
      });
      expect(credentialResponse.status).toBe(201);
      credentialId = ((await credentialResponse.json()) as { id: string }).id;

      const environmentResponse = await post("/v1/environments", {
        name: `managed-v1-env-${crypto.randomUUID()}`,
        scope: "organization",
        config: {
          type: "cloud",
          networking: { type: "unrestricted" },
          packages: { type: "packages" },
        },
      });
      expect(environmentResponse.status).toBe(201);
      environmentId = ((await environmentResponse.json()) as { id: string }).id;

      const agentResponse = await post("/v1/agents", {
        name: `Managed v1 MCP ${crypto.randomUUID()}`,
        model: "managed-turn-model",
        mcp_servers: [{ type: "url", name: "fake", url: `${MCP_ORIGIN}/rpc` }],
        tools: [{
          type: "mcp_toolset",
          mcp_server_name: "fake",
          default_config: { enabled: true },
        }],
      });
      expect(agentResponse.status).toBe(201);
      const agent = (await agentResponse.json()) as { id: string; version: number };
      agentId = agent.id;

      const sessionResponse = await post("/v1/sessions", {
        agent: { type: "agent", id: agent.id, version: agent.version },
        environment_id: environmentId,
        vault_ids: [vaultId],
      });
      expect(sessionResponse.status).toBe(201);
      sessionId = ((await sessionResponse.json()) as { id: string }).id;

      const proxied = await env.MAIN_MCP.fetch(new Request(`${MCP_ORIGIN}/rpc`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "x-oma-tenant": "default",
          "x-oma-session": sessionId,
          "x-oma-mcp-server": "fake",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "managed-v1-test", version: "1.0.0" },
          },
        }),
      }));
      expect(proxied.status).toBe(200);
      expect((await proxied.json()).result.serverInfo.name).toBe("managed-turn-fake");
      expect(external.state).toMatchObject({
        oauthRefreshCount: 1,
        staleBearerCount: 1,
        freshBearerCount: 1,
      });
    } finally {
      if (sessionId) await api(`/v1/sessions/${sessionId}`, { method: "DELETE", headers: HEADERS });
      if (agentId) await api(`/v1/agents/${agentId}/archive`, { method: "POST", headers: HEADERS });
      if (environmentId) {
        await api(`/v1/environments/${environmentId}`, { method: "DELETE", headers: HEADERS });
      }
      if (credentialId && vaultId) {
        await api(`/v1/vaults/${vaultId}/credentials/${credentialId}`, {
          method: "DELETE",
          headers: HEADERS,
        });
      }
      if (vaultId) await api(`/v1/vaults/${vaultId}`, { method: "DELETE", headers: HEADERS });
      external.restore();
    }
  }, 120_000);

  it("keeps OpenMA internals real while mocking only LLM, MCP, and OAuth", async () => {
    expect(env.MAIN_MCP).toBeDefined();

    const external = installExternalMocks();
    turnModel = createTurnModel();
    try {
      const vaultResponse = await post("/v1/oma/vaults", {
        name: `managed-turn-vault-${crypto.randomUUID()}`,
      });
      expect(vaultResponse.status).toBe(201);
      const vault = (await vaultResponse.json()) as { id: string };

      const credentialResponse = await post(
        `/v1/oma/vaults/${vault.id}/credentials`,
        {
          display_name: "Managed turn MCP OAuth",
          auth: {
            type: "mcp_oauth",
            mcp_server_url: `${MCP_ORIGIN}/rpc`,
            access_token: "stale-access-token",
            refresh_token: "refresh-token-1",
            token_endpoint: `${OAUTH_ORIGIN}/token`,
            client_id: "managed-turn-client",
          },
        },
      );
      expect(credentialResponse.status).toBe(201);
      const credential = (await credentialResponse.json()) as { id: string };

      const agentResponse = await post("/v1/oma/agents", {
        name: `Managed MCP turn ${crypto.randomUUID()}`,
        model: "managed-turn-model",
        system: "Use the MCP echo tool.",
        tools: [{ type: "agent_toolset_20260401" }],
        harness: HARNESS_NAME,
        mcp_servers: [
          {
            name: "broken",
            type: "url",
            url: `${BROKEN_MCP_ORIGIN}/rpc`,
            authorization_token: "broken-token",
          },
          { name: "fake", type: "url", url: `${MCP_ORIGIN}/rpc` },
        ],
      });
      expect(agentResponse.status).toBe(201);
      const agent = (await agentResponse.json()) as { id: string };

      const environmentResponse = await post("/v1/oma/environments", {
        name: `managed-turn-env-${crypto.randomUUID()}`,
        config: { type: "cloud" },
      });
      expect(environmentResponse.status).toBe(201);
      const environment = (await environmentResponse.json()) as { id: string };

      const sessionResponse = await post("/v1/oma/sessions", {
        agent: agent.id,
        environment_id: environment.id,
        vault_ids: [vault.id],
      });
      expect(sessionResponse.status).toBe(201);
      const session = (await sessionResponse.json()) as { id: string };

      const messageResponse = await post(`/v1/oma/sessions/${session.id}/events`, {
        events: [{
          type: "user.message",
          content: [{ type: "text", text: "Echo managed through MCP" }],
        }],
      });
      expect(messageResponse.status).toBe(202);

      const events = await waitForCompletedTurn(session.id);
      const mcpUse = events.find((event) => event.type === "agent.mcp_tool_use");
      const mcpResult = events.find((event) => event.type === "agent.mcp_tool_result");
      const degradedMcp = events.find((event) =>
        event.type === "session.warning"
        && String(event.message ?? "").includes('MCP setup failed for "broken"'));

      expect(mcpUse).toMatchObject({
        id: "mcp-call-1",
        mcp_server_name: "fake",
        name: "mcp__fake__echo",
        input: { value: "managed" },
      });
      expect(JSON.stringify(mcpResult?.content)).toContain("echo:managed");
      expect(mcpResult?.parent_event_id).toBe("mcp-call-1");
      expect(degradedMcp).toBeDefined();

      const services = await getCfServicesForTenant(env, "default");
      const persistedCredential = await services.credentials.get({
        tenantId: "default",
        vaultId: vault.id,
        credentialId: credential.id,
      });
      expect(persistedCredential?.auth).toMatchObject({
        access_token: "fresh-access-token",
        refresh_token: "refresh-token-2",
      });

      expect(external.state).toMatchObject({
        oauthRefreshCount: 1,
        staleBearerCount: 1,
        sawSessionOnToolCall: true,
      });
      expect(external.mcp.state.counts).toMatchObject({
        "server/discover": 1,
        initialize: 1,
        "tools/list": 1,
        "tools/call": 1,
        DELETE: 1,
      });
      expect(turnModel.model.doStreamCalls).toHaveLength(2);
      expect(turnModel.assertExhausted).not.toThrow();
    } finally {
      external.restore();
    }
  }, 120_000);
});
