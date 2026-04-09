import { tool } from "ai";
import { z } from "zod";
import type { AgentConfig, ToolsetConfig, CustomToolConfig } from "../types";
import type { SandboxExecutor } from "./interface";

const ALL_TOOLS = ["bash", "read", "write", "edit", "glob", "grep", "web_fetch", "web_search"];

/**
 * Resolve the permission policy for a given tool name from the agent config.
 * Checks per-tool config first, then falls back to default_config, then "always_allow".
 */
export function getToolPermission(agentConfig: AgentConfig, toolName: string): string {
  for (const t of agentConfig.tools) {
    if (t.type === "custom") continue;
    const ts = t as ToolsetConfig;
    // Per-tool config takes priority
    const cfg = ts.configs?.find(c => c.name === toolName);
    if (cfg?.permission_policy?.type) return cfg.permission_policy.type;
    // Fall back to default config
    if (ts.default_config?.permission_policy?.type) return ts.default_config.permission_policy.type;
  }
  return "always_allow";
}

function getEnabledTools(tools: AgentConfig["tools"]): Set<string> {
  const allTools = new Set(ALL_TOOLS);

  if (!tools || tools.length === 0) return allTools;

  for (const t of tools) {
    if (t.type === "custom") continue;

    const ts = t as ToolsetConfig;
    if (ts.configs) {
      const enabled = new Set<string>();
      const defaultEnabled = ts.default_config?.enabled ?? true;

      if (defaultEnabled) {
        for (const name of allTools) enabled.add(name);
      }

      for (const c of ts.configs) {
        if (c.enabled) enabled.add(c.name);
        else enabled.delete(c.name);
      }
      return enabled;
    }

    return allTools;
  }

  return allTools;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function buildTools(
  agentConfig: AgentConfig,
  sandbox: SandboxExecutor,
  env?: {
    ANTHROPIC_API_KEY?: string;
    ANTHROPIC_BASE_URL?: string;
    TAVILY_API_KEY?: string;
    delegateToAgent?: (agentId: string, message: string) => Promise<string>;
    environmentConfig?: { networking?: { type: string; allowed_hosts?: string[] } };
  }
): Promise<Record<string, any>> {
  const enabled = getEnabledTools(agentConfig.tools);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = {};

  if (enabled.has("bash")) {
    tools.bash = tool({
      description:
        "Execute a bash command in the sandbox. Returns exit code + stdout/stderr.",
      parameters: z.object({
        command: z.string().describe("The bash command to execute"),
        timeout: z
          .number()
          .optional()
          .describe("Timeout in milliseconds (default 30000)"),
      }),
      execute: async ({ command, timeout }) => sandbox.exec(command, timeout),
    });
  }

  if (enabled.has("read")) {
    tools.read = tool({
      description: "Read a file from the sandbox filesystem.",
      parameters: z.object({
        path: z.string().describe("Absolute path to the file to read"),
      }),
      execute: async ({ path }) => sandbox.readFile(path),
    });
  }

  if (enabled.has("write")) {
    tools.write = tool({
      description:
        "Write content to a file in the sandbox. Creates parent directories automatically.",
      parameters: z.object({
        path: z.string().describe("Absolute path to write to"),
        content: z.string().describe("File content to write"),
      }),
      execute: async ({ path, content }) => sandbox.writeFile(path, content),
    });
  }

  if (enabled.has("edit")) {
    tools.edit = tool({
      description:
        "Edit a file by replacing an exact string match. Use for surgical edits without rewriting the whole file.",
      parameters: z.object({
        path: z.string().describe("Absolute path to the file"),
        old_string: z.string().describe("Exact string to find and replace"),
        new_string: z.string().describe("Replacement string"),
      }),
      execute: async ({ path, old_string, new_string }) => {
        // Read → replace → write via sandbox exec
        const escaped_old = old_string.replace(/'/g, "'\\''");
        const escaped_new = new_string.replace(/'/g, "'\\''");
        return sandbox.exec(
          `python3 -c "
import sys
p = '${path.replace(/'/g, "\\'")}'
with open(p) as f: content = f.read()
old = '''${escaped_old}'''
new = '''${escaped_new}'''
if old not in content:
    print('Error: old_string not found in file', file=sys.stderr)
    sys.exit(1)
content = content.replace(old, new, 1)
with open(p, 'w') as f: f.write(content)
print('ok')
"`
        );
      },
    });
  }

  if (enabled.has("glob")) {
    tools.glob = tool({
      description:
        "Find files matching a glob pattern. Returns matching file paths.",
      parameters: z.object({
        pattern: z.string().describe('Glob pattern (e.g. "**/*.ts", "src/**/*.js")'),
        path: z
          .string()
          .optional()
          .describe("Directory to search in (default: /workspace)"),
      }),
      execute: async ({ pattern, path }) => {
        const dir = path || "/workspace";
        return sandbox.exec(`find ${dir} -path '${pattern}' -type f 2>/dev/null | head -100`);
      },
    });
  }

  if (enabled.has("grep")) {
    tools.grep = tool({
      description:
        "Search file contents using a regex pattern. Returns matching lines with file paths and line numbers.",
      parameters: z.object({
        pattern: z.string().describe("Regex pattern to search for"),
        path: z
          .string()
          .optional()
          .describe("File or directory to search (default: /workspace)"),
        include: z
          .string()
          .optional()
          .describe('File pattern to include (e.g. "*.ts")'),
      }),
      execute: async ({ pattern, path, include }) => {
        const dir = path || "/workspace";
        const includeFlag = include ? `--include='${include}'` : "";
        return sandbox.exec(
          `grep -rn ${includeFlag} '${pattern.replace(/'/g, "'\\''")}' ${dir} 2>/dev/null | head -100`
        );
      },
    });
  }

  if (enabled.has("web_fetch")) {
    tools.web_fetch = tool({
      description:
        "Fetch the content of a URL. Returns the text content of the page.",
      parameters: z.object({
        url: z.string().describe("URL to fetch"),
        max_length: z
          .number()
          .optional()
          .describe("Max response length in chars (default 50000)"),
      }),
      execute: async ({ url, max_length }) => {
        // Enforce networking restrictions when environment uses limited mode
        if (env?.environmentConfig?.networking?.type === "limited") {
          const allowedHosts = env.environmentConfig.networking.allowed_hosts || [];
          try {
            const parsedUrl = new URL(url);
            const isAllowed = allowedHosts.some(
              h => parsedUrl.hostname === h || parsedUrl.hostname.endsWith(`.${h}`)
            );
            if (!isAllowed) {
              return `Error: Host "${parsedUrl.hostname}" is not allowed. Allowed hosts: ${allowedHosts.join(", ")}`;
            }
          } catch {
            return "Error: Invalid URL";
          }
        }
        return sandbox.exec(
          `curl -sL -m 30 '${url.replace(/'/g, "'\\''")}' | head -c ${max_length || 50000}`,
          35000
        );
      },
    });
  }

  if (enabled.has("web_search")) {
    const tavilyKey = env?.TAVILY_API_KEY;
    tools.web_search = tool({
      description:
        "Search the web for information. Returns relevant search results.",
      parameters: z.object({
        query: z.string().describe("Search query"),
        max_results: z
          .number()
          .optional()
          .describe("Max results (default 5)"),
      }),
      execute: async ({ query, max_results }) => {
        if (!tavilyKey)
          return "web_search unavailable: TAVILY_API_KEY not configured";
        const res = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: tavilyKey,
            query,
            max_results: max_results || 5,
          }),
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = (await res.json()) as any;
        return JSON.stringify(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          data.results?.map((r: any) => ({
            title: r.title,
            url: r.url,
            snippet: r.content,
          })) || data
        );
      },
    });
  }

  // Custom tools — declared without execute so AI SDK returns them as pending tool calls
  for (const t of agentConfig.tools) {
    if (t.type === "custom") {
      const ct = t as CustomToolConfig;
      tools[ct.name] = tool({
        description: ct.description,
        parameters: z.object({}),
      });
    }
  }

  // MCP tools — MCP requests go through the sandbox network so that:
  // 1. Container networking rules (allow_mcp_servers) are enforced
  // 2. Outbound Worker can inject vault credentials transparently
  // We call MCP endpoints via sandbox.exec(curl) instead of Worker-side fetch.
  if (agentConfig.mcp_servers?.length) {
    for (const server of agentConfig.mcp_servers) {
      // Create a tool that lists available MCP tools from this server
      tools[`mcp_${server.name}_list_tools`] = tool({
        description: `List available tools from MCP server "${server.name}".`,
        parameters: z.object({}),
        execute: async () => {
          // JSON-RPC request to list tools, routed through sandbox network
          const rpcBody = JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: {},
          });
          return sandbox.exec(
            `curl -sS -X POST '${server.url.replace(/'/g, "'\\''")}' ` +
            `-H 'Content-Type: application/json' ` +
            `-d '${rpcBody.replace(/'/g, "'\\''")}'`,
            15000
          );
        },
      });

      // Create a tool that calls any tool on this MCP server
      tools[`mcp_${server.name}_call`] = tool({
        description: `Call a tool on MCP server "${server.name}". First use mcp_${server.name}_list_tools to see available tools and their input schemas.`,
        parameters: z.object({
          tool_name: z.string().describe("Name of the MCP tool to call"),
          arguments: z.record(z.unknown()).optional().describe("Tool arguments as JSON object"),
        }),
        execute: async ({ tool_name, arguments: args }) => {
          const rpcBody = JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: tool_name, arguments: args || {} },
          });
          return sandbox.exec(
            `curl -sS -X POST '${server.url.replace(/'/g, "'\\''")}' ` +
            `-H 'Content-Type: application/json' ` +
            `-d '${rpcBody.replace(/'/g, "'\\''")}'`,
            30000
          );
        },
      });
    }
  }

  // Multi-agent tools — create a call tool for each callable agent
  if (agentConfig.callable_agents?.length && env?.ANTHROPIC_API_KEY) {
    for (const ca of agentConfig.callable_agents) {
      const toolName = `call_agent_${ca.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;

      tools[toolName] = tool({
        description: `Delegate a task to sub-agent ${ca.id}. The sub-agent will process the message independently and return its response.`,
        parameters: z.object({
          message: z.string().describe("The task to delegate"),
        }),
        execute: async ({ message }) => {
          if (!env?.delegateToAgent) {
            return "Multi-agent delegation not available: no thread executor configured";
          }
          try {
            return await env.delegateToAgent(ca.id, message);
          } catch (e) {
            return `Sub-agent error: ${e instanceof Error ? e.message : String(e)}`;
          }
        },
      });
    }
  }

  // Strip execute from always_ask tools so AI SDK returns them as pending calls
  // requiring user confirmation before execution
  for (const [name, t] of Object.entries(tools)) {
    if (getToolPermission(agentConfig, name) === "always_ask") {
      tools[name] = tool({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        description: (t as any).description,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        parameters: (t as any).parameters,
        // No execute — AI SDK treats this as a pending tool call
      });
    }
  }

  return tools;
}

// Memory tools — operate directly on KV, no self-fetch
export function buildMemoryTools(
  storeIds: string[],
  kv: KVNamespace
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> {
  if (!storeIds.length || !kv) return {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = {};

  tools.memory_list = tool({
    description: "List memories in a store. Returns paths and metadata (no content).",
    parameters: z.object({
      store_id: z.string(),
      prefix: z.string().optional(),
    }),
    execute: async ({ store_id, prefix }) => {
      const list = await kv.list({ prefix: `mem:${store_id}:` });
      const items = await Promise.all(
        list.keys.map(async (k) => {
          const data = await kv.get(k.name);
          if (!data) return null;
          const mem = JSON.parse(data);
          if (prefix && !mem.path?.startsWith(prefix)) return null;
          return { id: mem.id, path: mem.path, size_bytes: mem.size_bytes, updated_at: mem.updated_at };
        })
      );
      return JSON.stringify(items.filter(Boolean));
    },
  });

  tools.memory_read = tool({
    description: "Read the full content of a specific memory.",
    parameters: z.object({
      store_id: z.string(),
      memory_id: z.string(),
    }),
    execute: async ({ store_id, memory_id }) => {
      const data = await kv.get(`mem:${store_id}:${memory_id}`);
      if (!data) return "Error: memory not found";
      const mem = JSON.parse(data);
      return mem.content || "";
    },
  });

  tools.memory_write = tool({
    description:
      "Write or update a memory. Use to persist learnings, context, or state across sessions.",
    parameters: z.object({
      store_id: z.string(),
      path: z.string().describe("Logical path, e.g. 'project/architecture'"),
      content: z.string(),
    }),
    execute: async ({ store_id, path, content }) => {
      // Check if memory with this path already exists (upsert by path)
      const list = await kv.list({ prefix: `mem:${store_id}:` });
      let existingId: string | null = null;
      for (const k of list.keys) {
        const data = await kv.get(k.name);
        if (data) {
          const mem = JSON.parse(data);
          if (mem.path === path) { existingId = mem.id; break; }
        }
      }

      const now = new Date().toISOString();
      const size_bytes = new TextEncoder().encode(content).length;

      if (existingId) {
        const data = await kv.get(`mem:${store_id}:${existingId}`);
        if (data) {
          const mem = JSON.parse(data);
          mem.content = content;
          mem.size_bytes = size_bytes;
          mem.updated_at = now;
          await kv.put(`mem:${store_id}:${existingId}`, JSON.stringify(mem));
          return `Updated memory at ${path}`;
        }
      }

      const id = `mem_${Date.now().toString(36)}`;
      const mem = { id, store_id, path, content, size_bytes, created_at: now };
      await kv.put(`mem:${store_id}:${id}`, JSON.stringify(mem));
      return `Created memory at ${path}`;
    },
  });

  tools.memory_search = tool({
    description: "Search memories by content substring match. Returns matching paths and snippets.",
    parameters: z.object({
      store_id: z.string(),
      query: z.string(),
    }),
    execute: async ({ store_id, query }) => {
      const list = await kv.list({ prefix: `mem:${store_id}:` });
      const matches: Array<{ path: string; snippet: string }> = [];
      const q = query.toLowerCase();

      for (const k of list.keys) {
        const data = await kv.get(k.name);
        if (!data) continue;
        const mem = JSON.parse(data);
        if (mem.content?.toLowerCase().includes(q)) {
          matches.push({ path: mem.path, snippet: mem.content.slice(0, 200) });
        }
      }
      return JSON.stringify(matches);
    },
  });

  tools.memory_delete = tool({
    description: "Delete a memory from a store.",
    parameters: z.object({
      store_id: z.string(),
      memory_id: z.string(),
    }),
    execute: async ({ store_id, memory_id }) => {
      await kv.delete(`mem:${store_id}:${memory_id}`);
      return "Deleted";
    },
  });

  return tools;
}
