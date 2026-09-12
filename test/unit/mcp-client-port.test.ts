import { describe, expect, it } from "vitest";
import * as harnessTools from "../../apps/agent/src/harness/tools";
import { TestSandbox } from "../../apps/agent/src/runtime/sandbox";
import { createScriptedMcpServer } from "../fakes/scripted-mcp-server";

function createFakeMcpFetch(options: { hangDelete?: boolean } = {}) {
  return createScriptedMcpServer({
    sessionId: "mcp-session-1",
    serverInfo: { name: "fake-mcp", version: "1.0.0" },
    tools: [{
      name: "echo",
      title: "Echo",
      description: "Echo an input value",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
      outputSchema: {
        type: "object",
        properties: { echoed: { type: "string" } },
        required: ["echoed"],
      },
    }],
    methodPlans: options.hangDelete
      ? { DELETE: [{ type: "hang" }] }
      : undefined,
    callTool({ arguments: args }) {
      return {
        content: [{ type: "text", text: `echo:${args?.value}` }],
        structuredContent: { echoed: args?.value },
      };
    },
  });
}

describe("OpenMA MCP client port", () => {
  it("keeps the official MCP shape while allowing a platform-owned fetch", async () => {
    const connectHttpMcpClient = (
      harnessTools as Record<string, unknown>
    ).connectHttpMcpClient as undefined | ((options: Record<string, unknown>) => Promise<{
      listTools(options?: { timeoutMs?: number }): Promise<Array<Record<string, unknown>>>;
      callTool(
        input: { name: string; arguments?: Record<string, unknown> },
        options?: { timeoutMs?: number },
      ): Promise<Record<string, unknown>>;
      close(): Promise<void>;
    }>);
    expect(connectHttpMcpClient).toBeTypeOf("function");

    const fake = createFakeMcpFetch();
    const platformFetch: typeof globalThis.fetch = (input, init) => {
      const request = new Request(input, init);
      request.headers.set("x-openma-port", "strict");
      return fake.fetch(request);
    };

    const client = await connectHttpMcpClient!({
      url: "https://mcp.example.test/rpc",
      clientInfo: { name: "openma-test", version: "1.0.0" },
      fetch: platformFetch,
      versionNegotiation: "legacy",
      timeoutMs: 1_000,
    });

    const definitions = await client.listTools({ timeoutMs: 1_000 });
    expect(definitions).toEqual([
      expect.objectContaining({
        name: "echo",
        title: "Echo",
        inputSchema: expect.objectContaining({ type: "object" }),
        outputSchema: expect.objectContaining({ type: "object" }),
      }),
    ]);

    await expect(client.callTool({
      name: "echo",
      arguments: { value: "hello" },
    }, { timeoutMs: 1_000 })).resolves.toEqual(expect.objectContaining({
      content: [{ type: "text", text: "echo:hello" }],
      structuredContent: { echoed: "hello" },
    }));

    expect(fake.state.requests.every((request) => request.headers.get("x-openma-port") === "strict")).toBe(true);
    const postInitRequests = fake.state.requests.filter((request) => request.method === "POST").slice(1);
    expect(postInitRequests.every((request) => request.headers.get("mcp-session-id") === "mcp-session-1")).toBe(true);

    await client.close();
    await client.close();
    expect(fake.state.counts.DELETE).toBe(1);
  });

  it("projects MCP tools into a disposable harness tool set", async () => {
    const disposeTools = (
      harnessTools as Record<string, unknown>
    ).disposeTools as undefined | ((tools: Record<string, unknown>) => Promise<void>);
    expect(disposeTools).toBeTypeOf("function");

    const fake = createFakeMcpFetch();
    const tools = await harnessTools.buildTools({
      id: "agent_mcp_port",
      name: "MCP Port Agent",
      model: "claude-sonnet-4-6",
      system: "",
      tools: [{ type: "agent_toolset_20260401" }],
      mcp_servers: [{ name: "demo", type: "sse", url: "https://mcp.example.test/rpc" }],
      version: 1,
      created_at: new Date().toISOString(),
    }, new TestSandbox(), {
      mcpBinding: { fetch: fake.fetch },
      tenantId: "tenant-1",
      sessionId: "session-1",
    });

    const echo = tools.mcp__demo__echo;
    expect(echo).toBeDefined();
    expect(echo.inputSchema.jsonSchema).toEqual(expect.objectContaining({ type: "object" }));

    await expect(echo.execute({ value: "managed" }, {
      toolCallId: "tool-1",
      messages: [],
      abortSignal: undefined,
    })).resolves.toEqual(expect.objectContaining({
      content: [{ type: "text", text: "echo:managed" }],
      structuredContent: { echoed: "managed" },
    }));

    expect(fake.state.requests.every((request) => request.headers.get("x-oma-tenant") === "tenant-1")).toBe(true);
    expect(fake.state.requests.every((request) => request.headers.get("x-oma-session") === "session-1")).toBe(true);
    expect(fake.state.requests.every((request) => request.headers.get("x-oma-mcp-server") === "demo")).toBe(true);

    await disposeTools!(tools);
    await disposeTools!(tools);
    expect(fake.state.counts.DELETE).toBe(1);
  });

  it("does not expose a remote MCP tool disabled by its server toolset", async () => {
    const fake = createFakeMcpFetch();
    const tools = await harnessTools.buildTools({
      id: "agent_mcp_disabled",
      name: "MCP Disabled Agent",
      model: "claude-sonnet-4-6",
      system: "",
      tools: [
        { type: "agent_toolset_20260401" },
        {
          type: "mcp_toolset",
          mcp_server_name: "demo",
          default_config: { enabled: true, permission_policy: { type: "always_allow" } },
          configs: [{ name: "echo", enabled: false }],
        },
      ],
      mcp_servers: [{ name: "demo", type: "sse", url: "https://mcp.example.test/rpc" }],
      version: 1,
      created_at: new Date().toISOString(),
    }, new TestSandbox(), {
      mcpBinding: { fetch: fake.fetch },
      tenantId: "tenant-1",
      sessionId: "session-1",
    });

    expect(tools.mcp__demo__echo).toBeUndefined();
    await harnessTools.disposeTools(tools);
  });

  it("does not contact or expose MCP servers when the Environment policy disables them", async () => {
    const fake = createFakeMcpFetch();
    const tools = await harnessTools.buildTools({
      id: "agent_mcp_environment_denied",
      name: "MCP Environment Denied Agent",
      model: "claude-sonnet-4-6",
      system: "",
      tools: [{ type: "agent_toolset_20260401" }],
      mcp_servers: [{ name: "demo", type: "sse", url: "https://mcp.example.test/rpc" }],
      version: 1,
      created_at: new Date().toISOString(),
    }, new TestSandbox(), {
      mcpBinding: { fetch: fake.fetch },
      tenantId: "tenant-1",
      sessionId: "session-1",
      environmentConfig: {
        networking: {
          type: "limited",
          allow_mcp_servers: false,
          allowed_hosts: [],
        },
      },
    });

    expect(tools.mcp__demo__echo).toBeUndefined();
    expect(fake.state.requests).toHaveLength(0);
  });

  it("fails closed when a declared MCP server has no routing context", async () => {
    await expect(harnessTools.buildTools({
      id: "agent_mcp_missing_route",
      name: "MCP Missing Route Agent",
      model: "claude-sonnet-4-6",
      system: "",
      tools: [{ type: "agent_toolset_20260401" }],
      mcp_servers: [{ name: "demo", type: "sse", url: "https://mcp.example.test/rpc" }],
      version: 1,
      created_at: new Date().toISOString(),
    }, new TestSandbox())).rejects.toThrow(
      "Declared MCP servers require mcpBinding, tenantId, and sessionId",
    );
  });

  it("fails closed when a declared stdio MCP server has not been prepared", async () => {
    const fake = createFakeMcpFetch();
    await expect(harnessTools.buildTools({
      id: "agent_mcp_missing_stdio_url",
      name: "MCP Missing Stdio URL Agent",
      model: "claude-sonnet-4-6",
      system: "",
      tools: [{ type: "agent_toolset_20260401" }],
      mcp_servers: [{
        name: "local",
        type: "stdio",
        command: "/usr/local/bin/demo",
      }],
      version: 1,
      created_at: new Date().toISOString(),
    }, new TestSandbox(), {
      mcpBinding: { fetch: fake.fetch },
      tenantId: "tenant-1",
      sessionId: "session-1",
    })).rejects.toThrow(
      'Standard MCP stdio server "local" requires a harness-in-sandbox runtime',
    );
    expect(fake.state.requests).toHaveLength(0);
  });

  it("bounds remote session termination so local disposal cannot hang", async () => {
    const connectHttpMcpClient = (
      harnessTools as Record<string, unknown>
    ).connectHttpMcpClient as (options: Record<string, unknown>) => Promise<{
      close(): Promise<void>;
    }>;
    const fake = createFakeMcpFetch({ hangDelete: true });
    const client = await connectHttpMcpClient({
      url: "https://mcp.example.test/rpc",
      clientInfo: { name: "openma-test", version: "1.0.0" },
      fetch: fake.fetch,
      versionNegotiation: "legacy",
      timeoutMs: 1_000,
      closeTimeoutMs: 10,
    });

    const closed = await Promise.race([
      client.close().then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);

    expect(closed).toBe(true);
    expect(fake.state.counts.DELETE).toBe(1);
  });
});
