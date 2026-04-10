import { describe, it, expect } from "vitest";
import { buildTools, buildMemoryTools, getToolPermission } from "../../src/harness/tools";
import { TestSandbox } from "../../src/runtime/sandbox";
import type { AgentConfig } from "../../src/types";
import type { SandboxExecutor } from "../../src/harness/interface";

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
// Fix 1: Permission policy enforcement
// ============================================================
describe("Permission policy enforcement", () => {
  it("getToolPermission returns always_ask for per-tool config", () => {
    const config = makeAgentConfig({
      tools: [{
        type: "agent_toolset_20260401",
        configs: [{ name: "bash", enabled: true, permission_policy: { type: "always_ask" } }],
      }],
    });
    expect(getToolPermission(config, "bash")).toBe("always_ask");
  });

  it("getToolPermission returns always_allow by default", () => {
    const config = makeAgentConfig();
    expect(getToolPermission(config, "bash")).toBe("always_allow");
  });

  it("getToolPermission returns default policy when no per-tool config", () => {
    const config = makeAgentConfig({
      tools: [{
        type: "agent_toolset_20260401",
        default_config: { enabled: true, permission_policy: { type: "always_ask" } },
      }],
    });
    expect(getToolPermission(config, "bash")).toBe("always_ask");
    expect(getToolPermission(config, "read")).toBe("always_ask");
  });

  it("per-tool policy overrides default policy", () => {
    const config = makeAgentConfig({
      tools: [{
        type: "agent_toolset_20260401",
        default_config: { enabled: true, permission_policy: { type: "always_ask" } },
        configs: [{ name: "bash", enabled: true, permission_policy: { type: "always_allow" } }],
      }],
    });
    expect(getToolPermission(config, "bash")).toBe("always_allow");
    expect(getToolPermission(config, "read")).toBe("always_ask");
  });

  it("tool with always_ask has no execute function", async () => {
    const config = makeAgentConfig({
      tools: [{
        type: "agent_toolset_20260401",
        configs: [{ name: "bash", enabled: true, permission_policy: { type: "always_ask" } }],
      }],
    });
    const tools = await buildTools(config, new TestSandbox());
    expect(tools.bash).toBeDefined();
    expect(tools.bash.execute).toBeUndefined();
    // Other tools should still have execute
    expect(tools.read.execute).toBeDefined();
  });

  it("tool with always_allow retains execute function", async () => {
    const config = makeAgentConfig({
      tools: [{
        type: "agent_toolset_20260401",
        configs: [{ name: "bash", enabled: true, permission_policy: { type: "always_allow" } }],
      }],
    });
    const tools = await buildTools(config, new TestSandbox());
    expect(tools.bash).toBeDefined();
    expect(tools.bash.execute).toBeDefined();
  });

  it("default_config always_ask strips execute from all tools", async () => {
    const config = makeAgentConfig({
      tools: [{
        type: "agent_toolset_20260401",
        default_config: { enabled: true, permission_policy: { type: "always_ask" } },
      }],
    });
    const tools = await buildTools(config, new TestSandbox());
    expect(tools.bash.execute).toBeUndefined();
    expect(tools.read.execute).toBeUndefined();
    expect(tools.write.execute).toBeUndefined();
    expect(tools.edit.execute).toBeUndefined();
    expect(tools.glob.execute).toBeUndefined();
    expect(tools.grep.execute).toBeUndefined();
    expect(tools.web_fetch.execute).toBeUndefined();
    expect(tools.web_search.execute).toBeUndefined();
  });

  it("always_ask tool retains description and parameters", async () => {
    const config = makeAgentConfig({
      tools: [{
        type: "agent_toolset_20260401",
        configs: [{ name: "bash", enabled: true, permission_policy: { type: "always_ask" } }],
      }],
    });
    const tools = await buildTools(config, new TestSandbox());
    expect(tools.bash.description).toBeTruthy();
    expect(tools.bash.parameters).toBeDefined();
  });
});

// ============================================================
// Fix 2: Memory tools injection into harness
// ============================================================
describe("Memory tools injection into harness", () => {
  it("memory tools merge correctly with built-in tools", async () => {
    const kv = makeMockKV();
    const builtInTools = await buildTools(makeAgentConfig(), new TestSandbox());
    const memTools = buildMemoryTools(["store_1"], kv);
    Object.assign(builtInTools, memTools);

    // Built-in tools still present
    expect(builtInTools.bash).toBeDefined();
    expect(builtInTools.read).toBeDefined();
    // Memory tools injected
    expect(builtInTools.memory_list).toBeDefined();
    expect(builtInTools.memory_read).toBeDefined();
    expect(builtInTools.memory_write).toBeDefined();
    expect(builtInTools.memory_search).toBeDefined();
    expect(builtInTools.memory_delete).toBeDefined();
  });

  it("memory tools are not injected when no store IDs", () => {
    const kv = makeMockKV();
    const memTools = buildMemoryTools([], kv);
    expect(Object.keys(memTools)).toHaveLength(0);
  });

  it("memory tools are operational after merge", async () => {
    const kv = makeMockKV();
    const builtInTools = await buildTools(makeAgentConfig(), new TestSandbox());
    const memTools = buildMemoryTools(["store_1"], kv);
    Object.assign(builtInTools, memTools);

    // Write a memory via the merged tools
    const writeResult = await builtInTools.memory_write.execute(
      { store_id: "store_1", path: "test/notes", content: "merged test" },
      TOOL_EXEC_OPTS
    );
    expect(writeResult).toContain("Created memory at test/notes");

    // Read it back via the merged tools
    const listResult = await builtInTools.memory_list.execute(
      { store_id: "store_1" },
      TOOL_EXEC_OPTS
    );
    const items = JSON.parse(listResult);
    expect(items.length).toBe(1);
    expect(items[0].path).toBe("test/notes");
  });
});

// ============================================================
// Fix 3: File mounting into sandbox
// ============================================================
describe("File mounting into sandbox", () => {
  it("writeFile is called for each file resource during mounting", async () => {
    const writtenFiles: Array<{ path: string; content: string }> = [];
    const spySandbox: SandboxExecutor = {
      exec: async () => "exit=0",
      readFile: async () => "",
      writeFile: async (path, content) => {
        writtenFiles.push({ path, content });
        return "ok";
      },
    };

    // Simulate the file mounting logic from session-do warmUpSandbox
    const kv = makeMockKV();
    const sessionId = "sess_test123";
    const fileId = "file_abc";

    // Store a file resource and its content
    await kv.put(
      `sesrsc:${sessionId}:res_1`,
      JSON.stringify({
        type: "file",
        file_id: fileId,
        mount_path: "/workspace/test.txt",
      })
    );
    await kv.put(`filecontent:${fileId}`, "Hello file content");

    // Run the mounting logic (mirrors session-do.ts warmUpSandbox)
    const resourceList = await kv.list({ prefix: `sesrsc:${sessionId}:` });
    for (const k of resourceList.keys) {
      const data = await kv.get(k.name);
      if (!data) continue;
      const res = JSON.parse(data);
      if (res.type === "file" && res.file_id) {
        const fileContent = await kv.get(`filecontent:${res.file_id}`);
        if (fileContent) {
          const mountPath = res.mount_path || `/workspace/${res.file_id}`;
          await spySandbox.writeFile(mountPath, fileContent);
        }
      }
    }

    expect(writtenFiles).toHaveLength(1);
    expect(writtenFiles[0].path).toBe("/workspace/test.txt");
    expect(writtenFiles[0].content).toBe("Hello file content");
  });

  it("uses default mount path when mount_path not specified", async () => {
    const writtenFiles: Array<{ path: string; content: string }> = [];
    const spySandbox: SandboxExecutor = {
      exec: async () => "exit=0",
      readFile: async () => "",
      writeFile: async (path, content) => {
        writtenFiles.push({ path, content });
        return "ok";
      },
    };

    const kv = makeMockKV();
    const sessionId = "sess_default_mount";
    const fileId = "file_xyz";

    await kv.put(
      `sesrsc:${sessionId}:res_2`,
      JSON.stringify({
        type: "file",
        file_id: fileId,
        // No mount_path specified
      })
    );
    await kv.put(`filecontent:${fileId}`, "Default path content");

    const resourceList = await kv.list({ prefix: `sesrsc:${sessionId}:` });
    for (const k of resourceList.keys) {
      const data = await kv.get(k.name);
      if (!data) continue;
      const res = JSON.parse(data);
      if (res.type === "file" && res.file_id) {
        const fileContent = await kv.get(`filecontent:${res.file_id}`);
        if (fileContent) {
          const mountPath = res.mount_path || `/workspace/${res.file_id}`;
          await spySandbox.writeFile(mountPath, fileContent);
        }
      }
    }

    expect(writtenFiles).toHaveLength(1);
    expect(writtenFiles[0].path).toBe(`/workspace/${fileId}`);
  });

  it("skips non-file resources during mounting", async () => {
    const writtenFiles: Array<{ path: string; content: string }> = [];
    const spySandbox: SandboxExecutor = {
      exec: async () => "exit=0",
      readFile: async () => "",
      writeFile: async (path, content) => {
        writtenFiles.push({ path, content });
        return "ok";
      },
    };

    const kv = makeMockKV();
    const sessionId = "sess_mixed";

    // memory_store resource (should be skipped)
    await kv.put(
      `sesrsc:${sessionId}:res_mem`,
      JSON.stringify({
        type: "memory_store",
        memory_store_id: "ms_123",
      })
    );
    // file resource (should be mounted)
    await kv.put(
      `sesrsc:${sessionId}:res_file`,
      JSON.stringify({
        type: "file",
        file_id: "file_real",
        mount_path: "/workspace/real.txt",
      })
    );
    await kv.put(`filecontent:file_real`, "Real file content");

    const resourceList = await kv.list({ prefix: `sesrsc:${sessionId}:` });
    for (const k of resourceList.keys) {
      const data = await kv.get(k.name);
      if (!data) continue;
      const res = JSON.parse(data);
      if (res.type === "file" && res.file_id) {
        const fileContent = await kv.get(`filecontent:${res.file_id}`);
        if (fileContent) {
          const mountPath = res.mount_path || `/workspace/${res.file_id}`;
          await spySandbox.writeFile(mountPath, fileContent);
        }
      }
    }

    // Only the file resource was mounted
    expect(writtenFiles).toHaveLength(1);
    expect(writtenFiles[0].path).toBe("/workspace/real.txt");
  });
});

// ============================================================
// Fix 4: Outbound Worker registration
// ============================================================
describe("Outbound Worker registration", () => {
  it("outbound function is importable and callable", async () => {
    const { outbound } = await import("../../src/outbound");
    expect(typeof outbound).toBe("function");
  });

  it("outboundByHost function is importable and callable", async () => {
    const { outboundByHost } = await import("../../src/outbound");
    expect(typeof outboundByHost).toBe("function");
  });

  it("outbound and outboundByHost are re-exported from index", async () => {
    // Verify the exports exist in the main entry point
    const index = await import("../../src/index");
    expect(typeof index.outbound).toBe("function");
    expect(typeof index.outboundByHost).toBe("function");
  });
});

// ============================================================
// Fix 5: Networking limited mode
// ============================================================
describe("Networking limited mode", () => {
  it("web_fetch rejects disallowed hosts when networking is limited", async () => {
    const sandbox = new TestSandbox();
    const tools = await buildTools(makeAgentConfig(), sandbox, {
      environmentConfig: {
        networking: {
          type: "limited",
          allowed_hosts: ["api.example.com", "docs.example.com"],
        },
      },
    });

    const result = await tools.web_fetch.execute(
      { url: "https://evil.com/data" },
      TOOL_EXEC_OPTS
    );
    expect(result).toContain("not allowed");
    expect(result).toContain("evil.com");
  });

  it("web_fetch allows requests to allowed hosts", async () => {
    const sandbox = new TestSandbox();
    const tools = await buildTools(makeAgentConfig(), sandbox, {
      environmentConfig: {
        networking: {
          type: "limited",
          allowed_hosts: ["api.example.com"],
        },
      },
    });

    const result = await tools.web_fetch.execute(
      { url: "https://api.example.com/data" },
      TOOL_EXEC_OPTS
    );
    // TestSandbox returns a stub response, not an error
    expect(result).not.toContain("not allowed");
    expect(result).toContain("exit=0");
  });

  it("web_fetch allows all hosts when networking is unrestricted", async () => {
    const sandbox = new TestSandbox();
    const tools = await buildTools(makeAgentConfig(), sandbox, {
      environmentConfig: {
        networking: { type: "unrestricted" },
      },
    });

    const result = await tools.web_fetch.execute(
      { url: "https://anything.com/data" },
      TOOL_EXEC_OPTS
    );
    expect(result).not.toContain("not allowed");
    expect(result).toContain("exit=0");
  });

  it("web_fetch allows subdomain matching for allowed hosts", async () => {
    const sandbox = new TestSandbox();
    const tools = await buildTools(makeAgentConfig(), sandbox, {
      environmentConfig: {
        networking: {
          type: "limited",
          allowed_hosts: ["example.com"],
        },
      },
    });

    const result = await tools.web_fetch.execute(
      { url: "https://sub.example.com/data" },
      TOOL_EXEC_OPTS
    );
    expect(result).not.toContain("not allowed");
    expect(result).toContain("exit=0");
  });

  it("web_fetch rejects invalid URLs when networking is limited", async () => {
    const sandbox = new TestSandbox();
    const tools = await buildTools(makeAgentConfig(), sandbox, {
      environmentConfig: {
        networking: {
          type: "limited",
          allowed_hosts: ["api.example.com"],
        },
      },
    });

    const result = await tools.web_fetch.execute(
      { url: "not-a-valid-url" },
      TOOL_EXEC_OPTS
    );
    expect(result).toContain("Invalid URL");
  });

  it("web_fetch works normally when no environmentConfig provided", async () => {
    const sandbox = new TestSandbox();
    const tools = await buildTools(makeAgentConfig(), sandbox);

    const result = await tools.web_fetch.execute(
      { url: "https://anywhere.com/data" },
      TOOL_EXEC_OPTS
    );
    expect(result).not.toContain("not allowed");
    expect(result).toContain("exit=0");
  });

  it("web_fetch lists allowed hosts in error message", async () => {
    const sandbox = new TestSandbox();
    const tools = await buildTools(makeAgentConfig(), sandbox, {
      environmentConfig: {
        networking: {
          type: "limited",
          allowed_hosts: ["safe.com", "trusted.org"],
        },
      },
    });

    const result = await tools.web_fetch.execute(
      { url: "https://blocked.net/page" },
      TOOL_EXEC_OPTS
    );
    expect(result).toContain("safe.com");
    expect(result).toContain("trusted.org");
  });
});
