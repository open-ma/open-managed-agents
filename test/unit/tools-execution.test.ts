// @ts-nocheck
import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { buildTools, buildMemoryTools } from "../../apps/agent/src/harness/tools";
import { TestSandbox } from "../../apps/agent/src/runtime/sandbox";
import { InMemoryHistory, eventsToMessages } from "../../apps/agent/src/runtime/history";
import type { AgentConfig } from "@open-managed-agents/shared";

// ============================================================
// Helpers
// ============================================================

function makeAgentConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    id: "agent_test",
    name: "Test Agent",
    model: "claude-sonnet-4-6",
    system: "You are a test agent.",
    tools: [{ type: "agent_toolset_20260401" }],
    version: 1,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeMockKV() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async (opts: { prefix: string }) => ({
      keys: [...store.keys()]
        .filter((k) => k.startsWith(opts.prefix))
        .map((name) => ({ name })),
    }),
  } as unknown as KVNamespace;
}

const TOOL_EXEC_OPTS = {
  toolCallId: "tc_test",
  messages: [],
  abortSignal: undefined as any,
};

// ============================================================
// 1. Built-in tool execution
// ============================================================
describe("Built-in tool execution", () => {
  it("bash tool execute returns sandbox result", async () => {
    const sandbox = new TestSandbox();
    const tools = await buildTools(makeAgentConfig(), sandbox);

    const result = await tools.bash.execute(
      { command: "echo hello" },
      TOOL_EXEC_OPTS
    );
    expect(result).toContain("exit=0");
    expect(result).toContain("echo hello");
  });

  it("bash tool passes timeout to sandbox", async () => {
    let capturedTimeout: number | undefined;
    const sandbox: any = {
      exec: async (cmd: string, timeout?: number) => {
        capturedTimeout = timeout;
        return `exit=0\n(done)`;
      },
      readFile: async () => "",
      writeFile: async () => "ok",
    };
    const tools = await buildTools(makeAgentConfig(), sandbox);

    await tools.bash.execute(
      { command: "sleep 10", timeout: 60000 },
      TOOL_EXEC_OPTS
    );
    expect(capturedTimeout).toBe(60000);
  });

  it("bash tool appends a retry hint after chained secret-backed command failure", async () => {
    const sandbox: any = {
      exec: async () =>
        "exit=1\nfatal: could not read Username for 'https://github.com': terminal prompts disabled\n\nHint: This chained shell command includes a secret-backed command (`git`) and failed. Retry with a single authenticated command when possible.",
      registerCommandSecrets: () => {},
      readFile: async () => "",
      writeFile: async () => "ok",
    };
    const tools = await buildTools(makeAgentConfig(), sandbox);

    const result = await tools.bash.execute(
      { command: "cd /workspace && git push origin main" },
      TOOL_EXEC_OPTS
    );

    expect(result).toContain("fatal: could not read Username");
    expect(result).toContain("Hint:");
    expect(result).toContain("secret-backed command (`git`)");
  });

  it("bash tool does not append the retry hint for simple command failures", async () => {
    const sandbox: any = {
      exec: async () => "exit=1\nls: missing operand",
      registerCommandSecrets: () => {},
      readFile: async () => "",
      writeFile: async () => "ok",
    };
    const tools = await buildTools(makeAgentConfig(), sandbox);

    const result = await tools.bash.execute(
      { command: "ls" },
      TOOL_EXEC_OPTS
    );

    expect(result).toContain("ls: missing operand");
    expect(result).not.toContain("secret-backed command");
  });

  it("read tool calls readFile with path", async () => {
    const sandbox = new TestSandbox();
    const tools = await buildTools(makeAgentConfig(), sandbox);

    const result = await tools.read.execute(
      { file_path: "/workspace/readme.md" },
      TOOL_EXEC_OPTS
    );
    expect(result).toContain("/workspace/readme.md");
    expect(result).toContain("test");
  });

  it("write tool calls writeFile with path and content", async () => {
    const sandbox = new TestSandbox();
    const tools = await buildTools(makeAgentConfig(), sandbox);

    const result = await tools.write.execute(
      { file_path: "/workspace/out.txt", content: "hello world" },
      TOOL_EXEC_OPTS
    );
    expect(result).toBe("ok");
  });

  it("edit tool uses readFile and writeFile", async () => {
    let readPath = "";
    let writtenPath = "";
    let writtenContent = "";
    const sandbox: any = {
      exec: async (cmd: string) => "exit=0\n",
      readFile: async (path: string) => {
        readPath = path;
        return "hello foo world";
      },
      writeFile: async (path: string, content: string) => {
        writtenPath = path;
        writtenContent = content;
        return "ok";
      },
    };
    const tools = await buildTools(makeAgentConfig(), sandbox);

    const result = await tools.edit.execute(
      {
        file_path: "/workspace/file.py",
        old_string: "foo",
        new_string: "bar",
      },
      TOOL_EXEC_OPTS
    );
    expect(readPath).toBe("/workspace/file.py");
    expect(writtenPath).toBe("/workspace/file.py");
    expect(writtenContent).toBe("hello bar world");
    expect(result).toBe("ok");
  });

  it("glob tool uses bash globstar", async () => {
    let capturedCmd = "";
    const sandbox: any = {
      exec: async (cmd: string) => {
        capturedCmd = cmd;
        return "exit=0\n";
      },
      readFile: async () => "",
      writeFile: async () => "ok",
    };
    const tools = await buildTools(makeAgentConfig(), sandbox);

    await tools.glob.execute(
      { pattern: "**/*.ts", path: "/workspace/src" },
      TOOL_EXEC_OPTS
    );
    expect(capturedCmd).toContain("globstar");
    expect(capturedCmd).toContain("/workspace/src");
    expect(capturedCmd).toContain("**/*.ts");
  });

  it("grep tool uses grep command with pattern", async () => {
    let capturedCmd = "";
    const sandbox: any = {
      exec: async (cmd: string) => {
        capturedCmd = cmd;
        return "exit=0\n";
      },
      readFile: async () => "",
      writeFile: async () => "ok",
    };
    const tools = await buildTools(makeAgentConfig(), sandbox);

    await tools.grep.execute(
      { pattern: "TODO", path: "/workspace" },
      TOOL_EXEC_OPTS
    );
    expect(capturedCmd).toContain("grep");
    expect(capturedCmd).toContain("TODO");
    expect(capturedCmd).toContain("/workspace");
  });

  it("web_fetch tool constructs curl with URL", async () => {
    let capturedCmd = "";
    const sandbox: any = {
      exec: async (cmd: string) => {
        capturedCmd = cmd;
        return "exit=0\n<html></html>";
      },
      readFile: async () => "",
      writeFile: async () => "ok",
    };
    const tools = await buildTools(makeAgentConfig(), sandbox);

    await tools.web_fetch.execute(
      { url: "https://example.com" },
      TOOL_EXEC_OPTS
    );
    expect(capturedCmd).toContain("curl");
    expect(capturedCmd).toContain("https://example.com");
  });

  it("web_fetch tool respects max_length param", async () => {
    let capturedCmd = "";
    const sandbox: any = {
      exec: async (cmd: string) => {
        capturedCmd = cmd;
        return "exit=0\ndata";
      },
      readFile: async () => "",
      writeFile: async () => "ok",
    };
    const tools = await buildTools(makeAgentConfig(), sandbox);

    await tools.web_fetch.execute(
      { url: "https://example.com", max_length: 1000 },
      TOOL_EXEC_OPTS
    );
    expect(capturedCmd).toContain("head -c 1000");
  });

  it("web_search default (DDG) is defined in agent_toolset", async () => {
    const sandbox = new TestSandbox();
    const tools = await buildTools(makeAgentConfig(), sandbox);
    // Default web_search is DuckDuckGo — always available, no API key needed
    expect(tools.web_search).toBeDefined();
    expect(typeof tools.web_search.execute).toBe("function");
  });

  it("web_search with TAVILY_API_KEY is defined", async () => {
    const sandbox = new TestSandbox();
    const tools = await buildTools(makeAgentConfig(), sandbox, {
      TAVILY_API_KEY: "tvly-test-key",
    });
    expect(tools.web_search).toBeDefined();
    expect(typeof tools.web_search).toBe("object");
  });
});

// ============================================================
// 2. Tool enable/disable combinations
// ============================================================
describe("Tool enable/disable combinations", () => {
  it("default_config enabled=true, specific tools disabled via configs", async () => {
    const config = makeAgentConfig({
      tools: [
        {
          type: "agent_toolset_20260401",
          default_config: { enabled: true },
          configs: [
            { name: "web_fetch", enabled: false },
            { name: "web_search", enabled: false },
          ],
        },
      ],
    });
    const tools = await buildTools(config, new TestSandbox());

    expect(tools.bash).toBeDefined();
    expect(tools.read).toBeDefined();
    expect(tools.write).toBeDefined();
    expect(tools.edit).toBeDefined();
    expect(tools.glob).toBeDefined();
    expect(tools.grep).toBeDefined();
    expect(tools.web_fetch).toBeUndefined();
    expect(tools.web_search).toBeUndefined();
  });

  it("default_config enabled=false with empty configs results in no tools", async () => {
    // Note: the filtering logic only activates when `configs` is present.
    // With configs=[] and default_config.enabled=false, no tools are enabled.
    const config = makeAgentConfig({
      tools: [
        {
          type: "agent_toolset_20260401",
          default_config: { enabled: false },
          configs: [],
        },
      ],
    });
    const tools = await buildTools(config, new TestSandbox());

    expect(tools.bash).toBeUndefined();
    expect(tools.read).toBeUndefined();
    expect(tools.write).toBeUndefined();
    expect(tools.edit).toBeUndefined();
    expect(tools.glob).toBeUndefined();
    expect(tools.grep).toBeUndefined();
    expect(tools.web_fetch).toBeUndefined();
    expect(tools.web_search).toBeUndefined();
  });

  it("only bash+grep enabled, 6 others disabled", async () => {
    const config = makeAgentConfig({
      tools: [
        {
          type: "agent_toolset_20260401",
          default_config: { enabled: false },
          configs: [
            { name: "bash", enabled: true },
            { name: "grep", enabled: true },
          ],
        },
      ],
    });
    const tools = await buildTools(config, new TestSandbox());

    expect(tools.bash).toBeDefined();
    expect(tools.grep).toBeDefined();
    expect(tools.read).toBeUndefined();
    expect(tools.write).toBeUndefined();
    expect(tools.edit).toBeUndefined();
    expect(tools.glob).toBeUndefined();
    expect(tools.web_fetch).toBeUndefined();
    expect(tools.web_search).toBeUndefined();
  });

  it("all tools explicitly disabled", async () => {
    const config = makeAgentConfig({
      tools: [
        {
          type: "agent_toolset_20260401",
          default_config: { enabled: true },
          configs: [
            { name: "bash", enabled: false },
            { name: "read", enabled: false },
            { name: "write", enabled: false },
            { name: "edit", enabled: false },
            { name: "glob", enabled: false },
            { name: "grep", enabled: false },
            { name: "web_fetch", enabled: false },
            { name: "web_search", enabled: false },
          ],
        },
      ],
    });
    const tools = await buildTools(config, new TestSandbox());

    expect(tools.bash).toBeUndefined();
    expect(tools.read).toBeUndefined();
    expect(tools.write).toBeUndefined();
    expect(tools.edit).toBeUndefined();
    expect(tools.glob).toBeUndefined();
    expect(tools.grep).toBeUndefined();
    expect(tools.web_fetch).toBeUndefined();
    expect(tools.web_search).toBeUndefined();
  });

  it("only web tools (web_fetch + web_search)", async () => {
    const config = makeAgentConfig({
      tools: [
        {
          type: "agent_toolset_20260401",
          default_config: { enabled: false },
          configs: [
            { name: "web_fetch", enabled: true },
            { name: "web_search", enabled: true },
          ],
        },
      ],
    });
    const tools = await buildTools(config, new TestSandbox());

    expect(tools.web_fetch).toBeDefined();
    expect(tools.web_search).toBeDefined();
    expect(tools.bash).toBeUndefined();
    expect(tools.read).toBeUndefined();
    expect(tools.write).toBeUndefined();
    expect(tools.edit).toBeUndefined();
    expect(tools.glob).toBeUndefined();
    expect(tools.grep).toBeUndefined();
  });

  it("only file tools (read + write + edit)", async () => {
    const config = makeAgentConfig({
      tools: [
        {
          type: "agent_toolset_20260401",
          default_config: { enabled: false },
          configs: [
            { name: "read", enabled: true },
            { name: "write", enabled: true },
            { name: "edit", enabled: true },
          ],
        },
      ],
    });
    const tools = await buildTools(config, new TestSandbox());

    expect(tools.read).toBeDefined();
    expect(tools.write).toBeDefined();
    expect(tools.edit).toBeDefined();
    expect(tools.bash).toBeUndefined();
    expect(tools.glob).toBeUndefined();
    expect(tools.grep).toBeUndefined();
    expect(tools.web_fetch).toBeUndefined();
    expect(tools.web_search).toBeUndefined();
  });

  it("no tools config results in all 8 enabled", async () => {
    const config = makeAgentConfig({ tools: [] });
    const tools = await buildTools(config, new TestSandbox());

    expect(tools.bash).toBeDefined();
    expect(tools.read).toBeDefined();
    expect(tools.write).toBeDefined();
    expect(tools.edit).toBeDefined();
    expect(tools.glob).toBeDefined();
    expect(tools.grep).toBeDefined();
    expect(tools.web_fetch).toBeDefined();
    expect(tools.web_search).toBeDefined();
  });
});

// ============================================================
// 3. Custom tools
// ============================================================
describe("Custom tools", () => {
  it("custom tool appears in tools map", async () => {
    const config = makeAgentConfig({
      tools: [
        { type: "agent_toolset_20260401" },
        {
          type: "custom",
          name: "get_weather",
          description: "Get weather forecast",
          input_schema: {},
        },
      ],
    });
    const tools = await buildTools(config, new TestSandbox());

    expect(tools.get_weather).toBeDefined();
  });

  it("custom tool has no execute function", async () => {
    const config = makeAgentConfig({
      tools: [
        {
          type: "custom",
          name: "deploy_app",
          description: "Deploy an application",
          input_schema: {},
        },
      ],
    });
    const tools = await buildTools(config, new TestSandbox());

    expect(tools.deploy_app).toBeDefined();
    // Custom tools created via tool() without execute have no execute property
    expect(tools.deploy_app.execute).toBeUndefined();
  });

  it("multiple custom tools alongside toolset", async () => {
    const config = makeAgentConfig({
      tools: [
        { type: "agent_toolset_20260401" },
        {
          type: "custom",
          name: "tool_a",
          description: "Tool A",
          input_schema: {},
        },
        {
          type: "custom",
          name: "tool_b",
          description: "Tool B",
          input_schema: {},
        },
      ],
    });
    const tools = await buildTools(config, new TestSandbox());

    // Built-in tools present
    expect(tools.bash).toBeDefined();
    expect(tools.read).toBeDefined();
    // Custom tools present
    expect(tools.tool_a).toBeDefined();
    expect(tools.tool_b).toBeDefined();
  });

  it("buildTools with only custom tools (no toolset)", async () => {
    const config = makeAgentConfig({
      tools: [
        {
          type: "custom",
          name: "only_custom",
          description: "The only tool",
          input_schema: {},
        },
      ],
    });
    const tools = await buildTools(config, new TestSandbox());

    // All built-in tools should be present since there is no toolset config
    // (getEnabledTools returns allTools when no ToolsetConfig is found)
    expect(tools.bash).toBeDefined();
    expect(tools.only_custom).toBeDefined();
  });
});

// ============================================================
// 4. MCP tools
// ============================================================
describe("MCP tools", () => {
  it("single MCP server creates list_tools and call tools", async () => {
    const config = makeAgentConfig({
      mcp_servers: [
        { name: "github", type: "sse", url: "https://mcp.github.com/sse" },
      ],
    });
    const tools = await buildTools(config, new TestSandbox());

    expect(tools.mcp_github_list_tools).toBeDefined();
    expect(tools.mcp_github_call).toBeDefined();
  });

  it("multiple MCP servers create independent tool pairs", async () => {
    const config = makeAgentConfig({
      mcp_servers: [
        { name: "github", type: "sse", url: "https://mcp.github.com/sse" },
        { name: "slack", type: "sse", url: "https://mcp.slack.com/sse" },
      ],
    });
    const tools = await buildTools(config, new TestSandbox());

    expect(tools.mcp_github_list_tools).toBeDefined();
    expect(tools.mcp_github_call).toBeDefined();
    expect(tools.mcp_slack_list_tools).toBeDefined();
    expect(tools.mcp_slack_call).toBeDefined();
    // Verify they are distinct objects
    expect(tools.mcp_github_list_tools).not.toBe(tools.mcp_slack_list_tools);
    expect(tools.mcp_github_call).not.toBe(tools.mcp_slack_call);
  });

  it("MCP list_tools tool can be executed (calls sandbox.exec with curl)", async () => {
    let capturedCmd = "";
    const sandbox: any = {
      exec: async (cmd: string) => {
        capturedCmd = cmd;
        return 'exit=0\n{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}';
      },
      readFile: async () => "",
      writeFile: async () => "ok",
    };
    const config = makeAgentConfig({
      mcp_servers: [
        { name: "testmcp", type: "sse", url: "https://mcp.test.com/rpc" },
      ],
    });
    const tools = await buildTools(config, sandbox);

    const result = await tools.mcp_testmcp_list_tools.execute(
      {},
      TOOL_EXEC_OPTS
    );
    expect(capturedCmd).toContain("curl");
    expect(capturedCmd).toContain("https://mcp.test.com/rpc");
    expect(capturedCmd).toContain("tools/list");
    expect(result).toContain("tools");
  });

  it("MCP call tool can be executed with tool_name and arguments", async () => {
    let capturedCmd = "";
    const sandbox: any = {
      exec: async (cmd: string) => {
        capturedCmd = cmd;
        return 'exit=0\n{"jsonrpc":"2.0","id":1,"result":{"content":"done"}}';
      },
      readFile: async () => "",
      writeFile: async () => "ok",
    };
    const config = makeAgentConfig({
      mcp_servers: [
        { name: "testmcp", type: "sse", url: "https://mcp.test.com/rpc" },
      ],
    });
    const tools = await buildTools(config, sandbox);

    const result = await tools.mcp_testmcp_call.execute(
      { tool_name: "create_issue", arguments: { title: "Bug fix" } },
      TOOL_EXEC_OPTS
    );
    expect(capturedCmd).toContain("curl");
    expect(capturedCmd).toContain("tools/call");
    expect(capturedCmd).toContain("create_issue");
    expect(result).toContain("done");
  });
});

// ============================================================
// 5. Memory tools
// ============================================================
describe("Memory tools", () => {
  it("buildMemoryTools with store IDs creates 6 tools", () => {
    const kv = makeMockKV();
    const memTools = buildMemoryTools(["store_abc"], kv);

    expect(memTools.memory_list).toBeDefined();
    expect(memTools.memory_read).toBeDefined();
    expect(memTools.memory_write).toBeDefined();
    expect(memTools.memory_search).toBeDefined();
    expect(memTools.memory_delete).toBeDefined();
    expect(Object.keys(memTools)).toHaveLength(6);
  });

  it("buildMemoryTools with empty array returns empty", () => {
    const kv = makeMockKV();
    const memTools = buildMemoryTools([], kv);
    expect(Object.keys(memTools)).toHaveLength(0);
  });

  it("memory_write execute creates entry in KV", async () => {
    const kv = makeMockKV();
    const memTools = buildMemoryTools(["store_1"], kv);

    const result = await memTools.memory_write.execute(
      {
        store_id: "store_1",
        path: "project/notes",
        content: "Important notes here",
      },
      TOOL_EXEC_OPTS
    );
    expect(result).toContain("Created memory at project/notes");

    // Verify the entry exists in KV via memory_list
    const listResult = await memTools.memory_list.execute(
      { store_id: "store_1" },
      TOOL_EXEC_OPTS
    );
    const parsed = JSON.parse(listResult);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0].path).toBe("project/notes");
  });

  it("memory_delete execute removes from KV", async () => {
    const kv = makeMockKV();
    const memTools = buildMemoryTools(["store_1"], kv);

    // First create a memory
    await memTools.memory_write.execute(
      {
        store_id: "store_1",
        path: "temp/data",
        content: "temporary data",
      },
      TOOL_EXEC_OPTS
    );

    // Find the memory ID from the list
    const listResult = await memTools.memory_list.execute(
      { store_id: "store_1" },
      TOOL_EXEC_OPTS
    );
    const items = JSON.parse(listResult);
    expect(items.length).toBe(1);
    const memoryId = items[0].id;

    // Delete it
    const deleteResult = await memTools.memory_delete.execute(
      { store_id: "store_1", memory_id: memoryId },
      TOOL_EXEC_OPTS
    );
    expect(deleteResult).toBe("Deleted");

    // Verify it is gone
    const afterDelete = await memTools.memory_list.execute(
      { store_id: "store_1" },
      TOOL_EXEC_OPTS
    );
    const afterItems = JSON.parse(afterDelete);
    expect(afterItems).toHaveLength(0);
  });
});

// ============================================================
// 5. New features: truncation, edit safety, glob fix, custom tool schema, event IDs
// ============================================================
describe("Tool result truncation", () => {
  it("truncates results exceeding MAX_TOOL_RESULT_CHARS", async () => {
    const bigOutput = "x".repeat(60000);
    const sandbox: any = {
      exec: async () => bigOutput,
      readFile: async () => bigOutput,
      writeFile: async () => "ok",
    };
    const tools = await buildTools(makeAgentConfig(), sandbox);

    const result = await tools.bash.execute(
      { command: "cat bigfile" },
      TOOL_EXEC_OPTS
    );
    expect(result.length).toBeLessThan(60000);
    expect(result).toContain("truncated");
    expect(result).toContain("60000");
  });

  it("does not truncate small results", async () => {
    const sandbox = new TestSandbox();
    const tools = await buildTools(makeAgentConfig(), sandbox);

    const result = await tools.bash.execute(
      { command: "echo hello" },
      TOOL_EXEC_OPTS
    );
    expect(result).not.toContain("truncated");
  });

  it("truncates read tool results", async () => {
    const bigContent = "y".repeat(60000);
    const sandbox: any = {
      exec: async () => "exit=0",
      readFile: async () => bigContent,
      writeFile: async () => "ok",
    };
    const tools = await buildTools(makeAgentConfig(), sandbox);

    const result = await tools.read.execute(
      { path: "/big.txt" },
      TOOL_EXEC_OPTS
    );
    expect(result.length).toBeLessThan(60000);
    expect(result).toContain("truncated");
  });
});

describe("Edit tool safety", () => {
  it("handles strings with triple quotes safely", async () => {
    let writtenContent = "";
    const sandbox: any = {
      exec: async () => "exit=0",
      readFile: async () => "before '''dangerous''' after",
      writeFile: async (_p: string, content: string) => {
        writtenContent = content;
        return "ok";
      },
    };
    const tools = await buildTools(makeAgentConfig(), sandbox);

    const result = await tools.edit.execute(
      {
        path: "/test.py",
        old_string: "'''dangerous'''",
        new_string: "'''safe'''",
      },
      TOOL_EXEC_OPTS
    );
    expect(result).toBe("ok");
    expect(writtenContent).toBe("before '''safe''' after");
  });

  it("returns error when old_string not found", async () => {
    const sandbox: any = {
      exec: async () => "exit=0",
      readFile: async () => "file content here",
      writeFile: async () => "ok",
    };
    const tools = await buildTools(makeAgentConfig(), sandbox);

    const result = await tools.edit.execute(
      {
        path: "/test.py",
        old_string: "nonexistent",
        new_string: "replacement",
      },
      TOOL_EXEC_OPTS
    );
    expect(result).toContain("not found");
  });
});

describe("Custom tool input_schema", () => {
  it("converts JSON Schema properties to Zod parameters", async () => {
    const config = makeAgentConfig({
      tools: [
        { type: "agent_toolset_20260401" },
        {
          type: "custom",
          name: "my_tool",
          description: "A custom tool",
          input_schema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query" },
              limit: { type: "number", description: "Max results" },
              verbose: { type: "boolean" },
            },
            required: ["query"],
          },
        } as any,
      ],
    });
    const tools = await buildTools(config, new TestSandbox());

    expect(tools.my_tool).toBeDefined();
    // Custom tools should not have execute (they are client-handled)
    expect(tools.my_tool.execute).toBeUndefined();
    // The tool should have an inputSchema (ai@6 renamed parameters → inputSchema)
    expect(tools.my_tool.inputSchema).toBeDefined();
  });

  it("uses empty schema when input_schema is not provided", async () => {
    const config = makeAgentConfig({
      tools: [
        { type: "agent_toolset_20260401" },
        {
          type: "custom",
          name: "simple_tool",
          description: "A simple custom tool",
          input_schema: {},
        } as any,
      ],
    });
    const tools = await buildTools(config, new TestSandbox());
    expect(tools.simple_tool).toBeDefined();
  });
});

describe("Event IDs on history", () => {
  it("events get stamped with id and processed_at on append", () => {
    const history = new InMemoryHistory();

    const event: any = {
      type: "user.message",
      content: [{ type: "text", text: "hello" }],
    };
    history.append(event);

    const events = history.getEvents();
    expect(events[0].id).toBeDefined();
    expect((events[0] as any).id).toMatch(/^sevt-/);
    expect((events[0] as any).processed_at).toBeDefined();
  });

  it("preserves existing id if already set", () => {
    const history = new InMemoryHistory();

    const event: any = {
      type: "user.message",
      id: "evt_custom_123",
      content: [{ type: "text", text: "hello" }],
    };
    history.append(event);

    const events = history.getEvents();
    expect((events[0] as any).id).toBe("evt_custom_123");
  });
});

describe("MCP event types in eventsToMessages", () => {
  it("converts agent.mcp_tool_use and agent.mcp_tool_result to messages", () => {
    const events: any[] = [
      { type: "user.message", content: [{ type: "text", text: "use mcp" }] },
      {
        type: "agent.mcp_tool_use",
        id: "tc_mcp_1",
        mcp_server_name: "github",
        name: "mcp_github_call",
        input: { tool_name: "get_issue", arguments: { number: 42 } },
      },
      {
        type: "agent.mcp_tool_result",
        mcp_tool_use_id: "tc_mcp_1",
        content: '{"title": "Bug fix"}',
      },
      { type: "agent.message", content: [{ type: "text", text: "Done" }] },
    ];
    const messages = eventsToMessages(events);
    // user, assistant (tool-call), tool (tool-result), assistant (text)
    expect(messages).toHaveLength(4);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
    expect(messages[2].role).toBe("tool");
    expect(messages[3].role).toBe("assistant");
  });
});
