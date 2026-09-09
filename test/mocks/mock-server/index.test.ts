import { describe, expect, it } from "vitest";
import worker, { MockStateDO, type Env } from "./index";

const REPOSITORY_SHA = "9e79e0dd41e23a8900b0b4adec5f55e4ecf24529";

describe("mock-services default Anthropic model", () => {
  it("returns a deterministic non-streaming message for model-card probes", async () => {
    const response = await worker.fetch(
      new Request("https://mock.test/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "mock-key" },
        body: JSON.stringify({
          model: "openma-e2e-mock",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      {} as Env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "E2E_OK" }],
    });
  });

  it("streams the Anthropic message lifecycle used by the default harness", async () => {
    const response = await worker.fetch(
      new Request("https://mock.test/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "mock-key" },
        body: JSON.stringify({
          model: "openma-e2e-mock",
          max_tokens: 32,
          stream: true,
          messages: [{ role: "user", content: "Reply exactly E2E_OK." }],
        }),
      }),
      {} as Env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain("event: message_start");
    expect(body).toContain('"type":"text_delta","text":"E2E_OK"');
    expect(body).toContain("event: message_stop");
  });
});

describe("mock-services input certification model", () => {
  it("drives bash, MCP, and final-answer rounds from one turn", async () => {
    const messages: Array<Record<string, unknown>> = [{
      role: "user",
      content: `Run certification. Expected repository SHA: ${REPOSITORY_SHA}.`,
    }];

    const first = await modelRequest(messages);
    expect(first.stop_reason).toBe("tool_use");
    expect(first.content[0].name).toBe("bash");
    expect(first.content[0].input.command).toContain("FILE_INPUT_OK");
    expect(first.content[0].input.command).toContain("SKILL_INPUT_OK");
    expect(first.content[0].input.command).toContain("MEMORY_INPUT_OK");
    expect(first.content[0].input.command).toContain(REPOSITORY_SHA);

    messages.push(
      { role: "assistant", content: first.content },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: first.content[0].id,
          content: "FILES_REPO_SKILL_MEMORY_OUTPUT_OK",
        }],
      },
    );
    const second = await modelRequest(messages);
    expect(second.stop_reason).toBe("tool_use");
    expect(second.content[0]).toMatchObject({
      name: "mcp__certification__echo",
      input: { value: "MCP_INPUT_OK" },
    });

    messages.push(
      { role: "assistant", content: second.content },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: second.content[0].id,
          content: "MCP_PROXY_OK",
        }],
      },
    );
    const final = await modelRequest(messages);
    expect(final.stop_reason).toBe("end_turn");
    expect(final.content).toEqual([{ type: "text", text: "ALL_INPUTS_OK" }]);
  });

  it("streams a complete Anthropic tool-use block", async () => {
    const response = await worker.fetch(new Request("https://mock.test/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "fixture" },
      body: JSON.stringify({
        model: "openma-e2e-inputs",
        stream: true,
        messages: [{
          role: "user",
          content: `Expected repository SHA: ${REPOSITORY_SHA}`,
        }],
      }),
    }), {} as Env);
    const body = await response.text();
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain('"name":"bash"');
    expect(body).toContain('"type":"input_json_delta"');
    expect(body).toContain(REPOSITORY_SHA);
    expect(body).toContain('"stop_reason":"tool_use"');
  });
});

describe("mock-services MCP fixture", () => {
  it("implements initialize, tools/list, and tools/call with bearer auth", async () => {
    const env = mockEnv("ok");
    const initialize = await mcpRequest(env, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(initialize.status).toBe(200);
    const sessionId = initialize.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    expect((await initialize.json()).result.serverInfo.name).toBe("openma-mock-services");

    const list = await mcpRequest(env, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    }, sessionId!);
    expect((await list.json()).result.tools[0].name).toBe("echo");

    const call = await mcpRequest(env, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "echo", arguments: { value: "MCP_INPUT_OK" } },
    }, sessionId!);
    expect(JSON.stringify((await call.json()).result)).toContain("MCP_PROXY_OK");
  });
});

async function modelRequest(messages: Array<Record<string, unknown>>) {
  const response = await worker.fetch(new Request("https://mock.test/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "fixture" },
    body: JSON.stringify({ model: "openma-e2e-inputs", messages }),
  }), {} as Env);
  expect(response.status).toBe(200);
  return response.json() as Promise<any>;
}

function mockEnv(scenario: string): Env {
  const durable = new MockStateDO({ id: { name: scenario } } as DurableObjectState);
  return {
    MOCK_STATE: {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          durable.fetch(new Request(input, init)),
      }),
    } as unknown as DurableObjectNamespace,
  };
}

function mcpRequest(env: Env, body: Record<string, unknown>, sessionId?: string) {
  return worker.fetch(new Request("https://mock.test/mcp/ok/", {
    method: "POST",
    headers: {
      authorization: "Bearer openma-local-release-mcp-token",
      "content-type": "application/json",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  }), env);
}
