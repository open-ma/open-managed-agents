import { tool } from "ai";
import { z } from "zod";
import { anthropic } from "@ai-sdk/anthropic";
import type { AgentConfig, ToolsetConfig, CustomToolConfig } from "@open-managed-agents/shared";
import type { SandboxExecutor, ProcessHandle } from "./interface";
import { nanoid } from "nanoid";

const ALL_TOOLS = ["bash", "read", "write", "edit", "glob", "grep", "web_fetch", "web_search"];
const MAX_TOOL_RESULT_CHARS = 50000;
const DEFAULT_BASH_TIMEOUT = 120000;  // 2 minutes (CC default)
const MAX_BASH_TIMEOUT = 600000;      // 10 minutes (CC max)

/**
 * Poll a started process with CC-aligned timeout strategies:
 * - Completes before timeout → return result
 * - Timeout + auto-backgroundable → keep running, redirect output to file, return path
 * - Timeout + not auto-backgroundable → SIGTERM kill, return partial + "timed out"
 */
async function pollWithStrategies(
  proc: ProcessHandle,
  command: string,
  timeoutMs: number,
  isAutoBackgroundable: (cmd: string) => boolean,
  sandbox: SandboxExecutor,
  tasksDir: string,
  env?: { watchBackgroundTask?: (taskId: string, pid: string, outputFile: string, proc: ProcessHandle | null) => void },
): Promise<string> {
  return new Promise<string>((resolve) => {
    let settled = false;

    // Timeout handler — decides strategy 2 vs 3
    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;

      let partial = "";
      try {
        const logs = await proc.getLogs();
        partial = (logs.stdout || "") + (logs.stderr ? "\nstderr: " + logs.stderr : "");
      } catch {}

      if (isAutoBackgroundable(command)) {
        // Strategy 2: auto-background — process keeps running
        // Write partial output to file so agent can read it with read tool
        const taskId = `task_${nanoid(12)}`;
        const outFile = `${tasksDir}/${taskId}.out`;
        try {
          await sandbox.exec(`mkdir -p ${tasksDir}`, 5000);
          await sandbox.writeFile(outFile, partial);
        } catch {}
        // Register watcher for completion notification
        env?.watchBackgroundTask?.(taskId, String(proc.pid), outFile, proc);
        resolve(truncateResult(
          `exit=0\nCommand auto-backgrounded after ${Math.round(timeoutMs / 1000)}s (pid: ${proc.pid})\nPartial output: ${outFile}`.trim()
        ));
      } else {
        // Strategy 3: kill — SIGTERM
        try { await proc.kill("SIGTERM"); } catch {}
        resolve(truncateResult(
          `exit=143\nCommand timed out after ${Math.round(timeoutMs / 1000)}s\n${partial}`.trim()
        ));
      }
    }, timeoutMs);

    // Poll for normal completion
    const poll = async () => {
      while (!settled) {
        try {
          const status = await proc.getStatus();
          if (status === "completed" || status === "error" || status === "killed") {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const logs = await proc.getLogs();
            let out = logs.stdout || "";
            if (logs.stderr) out += (out ? "\n" : "") + "stderr: " + logs.stderr;
            const exitCode = status === "error" ? 1 : status === "killed" ? 137 : 0;
            resolve(truncateResult(`exit=${exitCode}\n${out}`));
            return;
          }
        } catch {}
        await new Promise(r => setTimeout(r, 500));
      }
    };
    poll().catch(() => {
      if (!settled) { settled = true; clearTimeout(timer); resolve("exit=1\nProcess polling failed"); }
    });
  });
}

/**
 * Wrap a tool execute function so errors are returned as strings to the LLM
 * instead of crashing the entire harness (matching Claude Code's behavior).
 * The LLM sees the error and can retry, try a different approach, or inform the user.
 */
function safe<T>(fn: (args: T) => Promise<string>): (args: T) => Promise<string> {
  return async (args: T) => {
    try {
      const result = await fn(args);
      // Handle empty results (CC pattern: prevent model stop sequence issues)
      if (!result || result.trim() === "") return "(completed with no output)";
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Truncate error messages to avoid context overflow (CC caps at 10K)
      const truncated = msg.length > 10000
        ? msg.slice(0, 5000) + `\n[${msg.length - 10000} characters truncated]\n` + msg.slice(-5000)
        : msg;
      return `Error: ${truncated}`;
    }
  };
}

/**
 * Truncate tool results that exceed the maximum size.
 * CC persists to disk; we truncate with preview since we don't have
 * local filesystem access from the harness layer.
 */
function truncateResult(result: string): string {
  if (result.length > MAX_TOOL_RESULT_CHARS) {
    return result.slice(0, MAX_TOOL_RESULT_CHARS) + `\n...(truncated, total ${result.length} chars)`;
  }
  return result;
}

/**
 * Convert a JSON Schema properties object to a Zod schema.
 * Supports basic types: string, number, integer, boolean, object, array, enum.
 * Falls back to z.unknown() for unsupported types.
 */
function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  const required = (schema.required as string[]) || [];

  if (!properties || typeof properties !== "object") {
    return z.record(z.unknown());
  }

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(properties)) {
    let field = jsonSchemaPropertyToZod(prop);
    if (prop.description && typeof prop.description === "string") {
      field = (field as z.ZodString).describe(prop.description);
    }
    if (!required.includes(key)) {
      field = field.optional();
    }
    shape[key] = field;
  }

  return z.object(shape);
}

function jsonSchemaPropertyToZod(prop: Record<string, unknown>): z.ZodTypeAny {
  const type = prop.type as string | undefined;

  // Handle enum
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    return z.enum(prop.enum as [string, ...string[]]);
  }

  switch (type) {
    case "string":
      return z.string();
    case "number":
    case "integer":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array": {
      const items = prop.items as Record<string, unknown> | undefined;
      if (items) {
        return z.array(jsonSchemaPropertyToZod(items));
      }
      return z.array(z.unknown());
    }
    case "object": {
      if (prop.properties) {
        return jsonSchemaToZod(prop as Record<string, unknown>);
      }
      return z.record(z.unknown());
    }
    default:
      return z.unknown();
  }
}

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
    watchBackgroundTask?: (taskId: string, pid: string, outputFile: string, proc: ProcessHandle | null) => void;
  }
): Promise<Record<string, any>> {
  const enabled = getEnabledTools(agentConfig.tools);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = {};

  if (enabled.has("bash")) {
    // CC-aligned: only "sleep" is disallowed for auto-backgrounding
    const DISALLOWED_AUTO_BACKGROUND = ["sleep"];
    const isAutoBackgroundable = (cmd: string) => {
      const base = cmd.trim().split(/\s/)[0] || "";
      return !DISALLOWED_AUTO_BACKGROUND.includes(base);
    };
    const TASKS_DIR = "/tmp/tasks";

    tools.bash = tool({
      description:
        "Execute a bash command in the sandbox. Returns exit code + stdout/stderr. " +
        "For long-running commands (builds, installs, servers), set run_in_background=true " +
        "to get a task ID immediately. Output is written to a file — use the read tool to check progress.",
      parameters: z.object({
        command: z.string().describe("The bash command to execute"),
        timeout: z
          .number()
          .optional()
          .describe("Timeout in milliseconds (default 120000, max 600000)"),
        run_in_background: z
          .boolean()
          .optional()
          .describe("Run in background, returns immediately. Output written to file. Use read tool to check progress."),
      }),
      execute: safe(async ({ command, timeout, run_in_background }) => {
        const timeoutMs = Math.min(timeout || DEFAULT_BASH_TIMEOUT, MAX_BASH_TIMEOUT);

        // Strategy 1: agent explicitly backgrounds
        if (run_in_background) {
          const taskId = `task_${nanoid(12)}`;
          const outFile = `${TASKS_DIR}/${taskId}.out`;

          // Use startProcess for proper lifecycle management (no orphan kills)
          if (sandbox.startProcess) {
            await sandbox.exec(`mkdir -p ${TASKS_DIR}`, 5000);
            const proc = await sandbox.startProcess(`bash -c '(${command.replace(/'/g, "'\\''")}) > ${outFile} 2>&1'`);
            if (proc) {
              env?.watchBackgroundTask?.(taskId, String(proc.pid), outFile, proc);
              return `Background task started (pid: ${proc.pid})\nOutput: ${outFile}`;
            }
          }

          // Fallback: exec + & (test env without startProcess)
          const wrapped = `mkdir -p ${TASKS_DIR} && ${command} > ${outFile} 2>&1 &\necho "pid=$!"`;
          const result = await sandbox.exec(wrapped, 10000);
          const pidMatch = result.match(/pid=(\d+)/);
          const pid = pidMatch ? pidMatch[1] : "unknown";
          env?.watchBackgroundTask?.(taskId, pid, outFile, null);
          return `Background task started (pid: ${pid})\nOutput: ${outFile}`;
        }

        // If startProcess available, use it for strategies 2/3
        if (sandbox.startProcess) {
          const proc = await sandbox.startProcess(command);
          if (proc) {
            return await pollWithStrategies(proc, command, timeoutMs, isAutoBackgroundable, sandbox, TASKS_DIR, env);
          }
        }

        // Fallback: simple exec (test env, no startProcess)
        return truncateResult(await sandbox.exec(command, timeoutMs));
      }),
    });
  }

  if (enabled.has("read")) {
    tools.read = tool({
      description: "Read a file from the sandbox filesystem.",
      parameters: z.object({
        file_path: z.string().describe("The absolute file path to read, e.g. /workspace/index.html"),
      }).passthrough(),
      execute: safe(async (args: any) => {
        const p = args.file_path || args.path || args.filename;
        if (!p) return "Error: file_path is required";
        return truncateResult(await sandbox.readFile(p));
      }),
    });
  }

  if (enabled.has("write")) {
    tools.write = tool({
      description:
        "Write content to a file in the sandbox. Creates parent directories automatically.",
      parameters: z.object({
        file_path: z.string().describe("The absolute file path to write to, e.g. /workspace/index.html"),
        content: z.string().describe("The complete file content to write"),
      }).passthrough(),
      execute: safe(async (args: any) => {
        const p = args.file_path || args.path || args.filename;
        if (!p) return "Error: file_path is required";
        return sandbox.writeFile(p, args.content);
      }),
    });
  }

  if (enabled.has("edit")) {
    tools.edit = tool({
      description:
        "Edit a file by replacing an exact string match. Use for surgical edits without rewriting the whole file.",
      parameters: z.object({
        file_path: z.string().describe("The absolute file path to edit"),
        old_string: z.string().describe("Exact string to find and replace"),
        new_string: z.string().describe("Replacement string"),
      }).passthrough(),
      execute: safe(async (args: any) => {
        const p = args.file_path || args.path || args.filename;
        if (!p) return "Error: file_path is required";
        const content = await sandbox.readFile(p);
        if (!content.includes(args.old_string)) {
          return "Error: old_string not found in file";
        }
        const updated = content.replace(args.old_string, args.new_string);
        return sandbox.writeFile(p, updated);
      }),
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
      execute: safe(async ({ pattern, path }) => {
        const dir = path || "/workspace";
        return truncateResult(await sandbox.exec(
          `bash -c 'shopt -s globstar nullglob && cd "${dir}" && printf "%s\\n" ${pattern} | head -100'`
        ));
      }),
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
      execute: safe(async ({ pattern, path, include }) => {
        const dir = path || "/workspace";
        const includeFlag = include ? `--include='${include}'` : "";
        return truncateResult(await sandbox.exec(
          `grep -rn ${includeFlag} '${pattern.replace(/'/g, "'\\''")}' ${dir} 2>/dev/null | head -100`
        ));
      }),
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
      execute: safe(async ({ url, max_length }) => {
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
        return truncateResult(await sandbox.exec(
          `curl -sL -m 30 '${url.replace(/'/g, "'\\''")}' | head -c ${max_length || 50000}`,
          35000
        ));
      }),
    });
  }

  // --- Web search ---
  // Default: DuckDuckGo (free, no config). Override with explicit tool types:
  //   "web_search_20250305" → Anthropic built-in server-side (Claude only)
  //   "web_search_tavily"   → Tavily API (needs TAVILY_API_KEY)
  const toolTypes = new Set((agentConfig.tools || []).map(t => t.type));

  if (toolTypes.has("web_search_20250305")) {
    tools.web_search = anthropic.tools.webSearch_20250305();
  } else if (toolTypes.has("web_search_ddg") || enabled.has("web_search")) {
    // DuckDuckGo — default web search, free, no API key
    tools.web_search = tool({
      description:
        "Search the web using DuckDuckGo. Returns titles, URLs, and descriptions.",
      parameters: z.object({
        query: z.string().describe("Search query"),
        max_results: z.number().optional().describe("Max results (default 5)"),
      }),
      execute: safe(async ({ query, max_results }) => {
        const count = max_results || 5;
        // Step 1: Get VQD token from DuckDuckGo
        const vqdRes = await fetch(`https://duckduckgo.com/?${new URLSearchParams({ q: query, ia: "web" })}`);
        if (!vqdRes.ok) return `DuckDuckGo error: ${vqdRes.status}`;
        const vqdText = await vqdRes.text();
        const vqd = /vqd=['"](\d+-\d+(?:-\d+)?)['"]/?.exec(vqdText)?.[1];
        if (!vqd) return "DuckDuckGo: failed to get search token";

        // Step 2: Fetch search results
        const params = new URLSearchParams({
          q: query, l: "en-us", kl: "wt-wt", s: "0", dl: "en",
          ct: "US", ss_mkt: "us", vqd, sp: "1", bpa: "1",
        });
        const searchRes = await fetch(`https://links.duckduckgo.com/d.js?${params}`);
        if (!searchRes.ok) return `DuckDuckGo search error: ${searchRes.status}`;
        const body = await searchRes.text();

        if (body.includes("DDG.deep.anomalyDetectionBlock"))
          return "DuckDuckGo rate limited. Try again in a moment.";

        // Step 3: Parse results from JSONP-like response
        const match = /DDG\.pageLayout\.load\('d',(\[.+?\])\);DDG\.duckbar\.load/.exec(body);
        if (!match) return "DuckDuckGo: no results found";

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const raw = JSON.parse(match[1].replace(/\t/g, "    ")) as any[];
        const results = raw
          .filter((r) => r.u && !("n" in r))
          .slice(0, count)
          .map((r) => ({
            title: r.t,
            url: r.u,
            description: (r.a || "").replace(/<\/?b>/g, ""),
          }));

        return JSON.stringify(results);
      }),
    });
  }

  if (toolTypes.has("web_search_tavily")) {
    const tavilyKey = env?.TAVILY_API_KEY;
    tools.web_search = tool({
      description:
        "Search the web for information. Returns relevant search results.",
      parameters: z.object({
        query: z.string().describe("Search query"),
        max_results: z.number().optional().describe("Max results (default 5)"),
      }),
      execute: safe(async ({ query, max_results }) => {
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
      }),
    });
  }

  // Custom tools — convert JSON Schema to Zod for proper parameter definitions
  for (const t of agentConfig.tools) {
    if (t.type === "custom") {
      const ct = t as CustomToolConfig;
      const params = ct.input_schema && typeof ct.input_schema === "object" && Object.keys(ct.input_schema).length > 0
        ? jsonSchemaToZod(ct.input_schema)
        : z.object({});
      tools[ct.name] = tool({
        description: ct.description,
        parameters: params,
        // No execute — custom tools are handled by the client
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
        execute: safe(async () => {
          // JSON-RPC request to list tools, routed through sandbox network
          const rpcBody = JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: {},
          });
          return truncateResult(await sandbox.exec(
            `curl -sS -X POST '${server.url.replace(/'/g, "'\\''")}' ` +
            `-H 'Content-Type: application/json' ` +
            `-d '${rpcBody.replace(/'/g, "'\\''")}'`,
            15000
          ));
        }),
      });

      // Create a tool that calls any tool on this MCP server
      tools[`mcp_${server.name}_call`] = tool({
        description: `Call a tool on MCP server "${server.name}". First use mcp_${server.name}_list_tools to see available tools and their input schemas.`,
        parameters: z.object({
          tool_name: z.string().describe("Name of the MCP tool to call"),
          arguments: z.record(z.unknown()).optional().describe("Tool arguments as JSON object"),
        }),
        execute: safe(async ({ tool_name, arguments: args }) => {
          const rpcBody = JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: tool_name, arguments: args || {} },
          });
          return truncateResult(await sandbox.exec(
            `curl -sS -X POST '${server.url.replace(/'/g, "'\\''")}' ` +
            `-H 'Content-Type: application/json' ` +
            `-d '${rpcBody.replace(/'/g, "'\\''")}'`,
            30000
          ));
        }),
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
        execute: safe(async ({ message }) => {
          if (!env?.delegateToAgent) {
            return "Multi-agent delegation not available: no thread executor configured";
          }
          try {
            return await env.delegateToAgent(ca.id, message);
          } catch (e) {
            return `Sub-agent error: ${e instanceof Error ? e.message : String(e)}`;
          }
        }),
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
  kv: KVNamespace,
  ai?: Ai,
  vectorize?: VectorizeIndex,
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
    execute: safe(async ({ store_id, prefix }) => {
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
    }),
  });

  tools.memory_read = tool({
    description: "Read the full content of a specific memory.",
    parameters: z.object({
      store_id: z.string(),
      memory_id: z.string(),
    }),
    execute: safe(async ({ store_id, memory_id }) => {
      const data = await kv.get(`mem:${store_id}:${memory_id}`);
      if (!data) return "Error: memory not found";
      const mem = JSON.parse(data);
      return mem.content || "";
    }),
  });

  tools.memory_write = tool({
    description:
      "Write or update a memory. Use to persist learnings, context, or state across sessions.",
    parameters: z.object({
      store_id: z.string(),
      path: z.string().describe("Logical path, e.g. 'project/architecture'"),
      content: z.string(),
    }),
    execute: safe(async ({ store_id, path, content }) => {
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
    }),
  });

  tools.memory_search = tool({
    description: "Search memories by semantic similarity or substring match. Returns matching paths and snippets.",
    parameters: z.object({
      store_id: z.string(),
      query: z.string(),
    }),
    execute: safe(async ({ store_id, query }) => {
      // Try semantic search via Vectorize first
      if (ai && vectorize) {
        try {
          const embedding = await ai.run("@cf/google/embedding-gemma" as any, {
            text: [query],
          }) as { data: number[][] };
          if (embedding.data?.[0]) {
            const results = await vectorize.query(embedding.data[0], {
              topK: 10,
              filter: { store_id },
              returnMetadata: "all",
            });
            if (results.matches?.length) {
              const matches = await Promise.all(
                results.matches.map(async (m) => {
                  const memId = (m.metadata as any)?.memory_id;
                  const path = (m.metadata as any)?.path || "";
                  let snippet = "";
                  if (memId) {
                    const data = await kv.get(`mem:${store_id}:${memId}`);
                    if (data) snippet = JSON.parse(data).content?.slice(0, 200) || "";
                  }
                  return { path, snippet, score: m.score };
                })
              );
              return JSON.stringify(matches);
            }
          }
        } catch {
          // Fall through to substring search
        }
      }

      // Fallback: substring search
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
    }),
  });

  tools.memory_edit = tool({
    description: "Edit an existing memory by ID. Can update content and/or path (rename). Supports optimistic concurrency via expected_content_sha256.",
    parameters: z.object({
      store_id: z.string(),
      memory_id: z.string(),
      content: z.string().optional(),
      path: z.string().optional(),
      expected_content_sha256: z.string().optional(),
    }),
    execute: safe(async ({ store_id, memory_id, content, path, expected_content_sha256 }) => {
      const data = await kv.get(`mem:${store_id}:${memory_id}`);
      if (!data) return "Error: Memory not found";
      const mem = JSON.parse(data);

      if (expected_content_sha256 && mem.content_sha256 !== expected_content_sha256) {
        return "Error: Content has been modified (sha256 mismatch)";
      }

      if (path !== undefined) mem.path = path;
      if (content !== undefined) {
        mem.content = content;
        mem.size_bytes = new TextEncoder().encode(content).length;
        // Recompute hash
        const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
        mem.content_sha256 = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
      }
      mem.updated_at = new Date().toISOString();

      await kv.put(`mem:${store_id}:${memory_id}`, JSON.stringify(mem));
      return JSON.stringify({ id: mem.id, path: mem.path, size_bytes: mem.size_bytes });
    }),
  });

  tools.memory_delete = tool({
    description: "Delete a memory from a store.",
    parameters: z.object({
      store_id: z.string(),
      memory_id: z.string(),
    }),
    execute: safe(async ({ store_id, memory_id }) => {
      await kv.delete(`mem:${store_id}:${memory_id}`);
      return "Deleted";
    }),
  });

  return tools;
}
