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
        const seconds = Math.round(timeoutMs / 1000);
        resolve(truncateResult(
          [
            `Command exceeded the ${seconds}s timeout and was moved to the background.`,
            `  task_id: ${taskId}`,
            `  pid: ${proc.pid}`,
            `  output_path: ${outFile}`,
            ``,
            `Next steps:`,
            `  - Check progress: read(file_path="${outFile}")`,
            `  - Wait longer next time: re-invoke bash with timeout=<ms, max ${MAX_BASH_TIMEOUT}>`,
            `  - Stop it: bash(command="kill ${proc.pid}")`,
            ``,
            `Partial output so far:`,
            partial || "(no output yet)",
          ].join("\n").trim()
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
 *
 * Result type is `string | object`: most tools return text, but multimodal tools
 * (e.g. Read returning an image block) return structured objects that toModelOutput
 * converts for the AI SDK.
 */
type ToolResultValue = string | Record<string, unknown>;
function safe<T>(fn: (args: T) => Promise<ToolResultValue>): (args: T) => Promise<ToolResultValue> {
  return async (args: T) => {
    try {
      const result = await fn(args);
      // Handle empty string results (CC pattern: prevent model stop sequence issues)
      if (typeof result === "string" && result.trim() === "") return "(completed with no output)";
      return result;
    } catch (err) {
      let msg = err instanceof Error ? err.message : String(err);
      // Include stack trace for better debugging
      if (err instanceof Error && err.stack) {
        msg += "\n" + err.stack.split("\n").slice(1, 5).join("\n");
      }
      // Include cause if present
      if (err instanceof Error && err.cause) {
        msg += "\ncause: " + String(err.cause);
      }
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

/** Shell-quote an argument safely (POSIX single-quote escaping). */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** File extensions that Read returns as image content blocks. */
const IMAGE_EXTENSIONS: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * Convert a JSON Schema properties object to a Zod schema.
 * Supports basic types: string, number, integer, boolean, object, array, enum.
 * Falls back to z.unknown() for unsupported types.
 */
function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  const required = (schema.required as string[]) || [];

  if (!properties || typeof properties !== "object") {
    return z.record(z.string(), z.unknown());
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
      return z.record(z.string(), z.unknown());
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
      inputSchema: z.object({
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
              return [
                `Background task started.`,
                `  task_id: ${taskId}`,
                `  pid: ${proc.pid}`,
                `  output_path: ${outFile}`,
                ``,
                `Next steps:`,
                `  - Check progress: read(file_path="${outFile}")`,
                `  - Stop it: bash(command="kill ${proc.pid}")`,
              ].join("\n");
            }
          }

          // Fallback: exec + & (test env without startProcess)
          const wrapped = `mkdir -p ${TASKS_DIR} && ${command} > ${outFile} 2>&1 &\necho "pid=$!"`;
          const result = await sandbox.exec(wrapped, 10000);
          const pidMatch = result.match(/pid=(\d+)/);
          const pid = pidMatch ? pidMatch[1] : "unknown";
          env?.watchBackgroundTask?.(taskId, pid, outFile, null);
          return [
            `Background task started.`,
            `  task_id: ${taskId}`,
            `  pid: ${pid}`,
            `  output_path: ${outFile}`,
            ``,
            `Next steps:`,
            `  - Check progress: read(file_path="${outFile}")`,
            `  - Stop it: bash(command="kill ${pid}")`,
          ].join("\n");
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
      description:
        "Read a file from the sandbox filesystem. Supports text files (with optional " +
        "offset/limit for chunked reads), and image files (PNG, JPG, JPEG, GIF, WEBP) " +
        "which are returned as visual content for multimodal models. " +
        "By default reads the entire file. Use offset (1-based line number) and limit " +
        "(number of lines) to read large text files in chunks.",
      inputSchema: z.object({
        file_path: z.string().describe("The absolute file path to read, e.g. /workspace/index.html"),
        offset: z.number().optional().describe("1-based line number to start reading from (text only)"),
        limit: z.number().optional().describe("Number of lines to read (text only)"),
      }),
      execute: safe(async ({ file_path, offset, limit }) => {
        const ext = file_path.split(".").pop()?.toLowerCase() || "";
        const mediaType = IMAGE_EXTENSIONS[ext];

        if (mediaType) {
          // Image: base64-encode via shell and return as Anthropic-shape ImageBlock.
          // toModelOutput below converts this to AI SDK content shape for the model.
          // -w0 prevents line wrapping (GNU base64); fall back to tr -d '\n' if BSD.
          const raw = await sandbox.exec(
            `(base64 -w0 ${shellQuote(file_path)} 2>/dev/null || base64 ${shellQuote(file_path)} | tr -d '\\n')`,
          );
          const m = raw.match(/^exit=(-?\d+)\n([\s\S]*)$/);
          if (!m) return raw;
          const code = parseInt(m[1], 10);
          if (code !== 0) return `Error reading image (exit=${code}): ${m[2].slice(0, 200)}`;
          const data = m[2].trimEnd();
          if (!data) return "Error: image file is empty or unreadable";
          // Return as a marker object that toModelOutput recognizes.
          // default-loop also recognizes this shape and broadcasts a multimodal
          // agent.tool_result event so the trajectory preserves the image.
          return {
            type: "image" as const,
            source: { type: "base64" as const, media_type: mediaType, data },
          };
        }

        // Text path
        const content = await sandbox.readFile(file_path);
        if (offset === undefined && limit === undefined) {
          return truncateResult(content);
        }
        const lines = content.split("\n");
        const start = Math.max(0, (offset ?? 1) - 1);
        const end = limit !== undefined ? start + limit : lines.length;
        const slice = lines.slice(start, end);
        return truncateResult(
          slice.map((l, i) => `${start + i + 1}\t${l}`).join("\n") +
            (end < lines.length ? `\n...(file has ${lines.length} total lines)` : ""),
        );
      }),
      // AI SDK 6 hook: convert tool execute output to the shape the model receives.
      // For images, emit a `content` array with `file-data` parts (base64 + mediaType);
      // the @ai-sdk/anthropic provider translates this into a tool_result with an
      // image content block, which Claude (and any vision-capable model) renders natively.
      toModelOutput: ({ output }) => {
        if (
          output &&
          typeof output === "object" &&
          "type" in output &&
          (output as { type?: string }).type === "image"
        ) {
          const src = (output as unknown as { source: { data: string; media_type: string } }).source;
          return {
            type: "content",
            value: [{ type: "file-data", data: src.data, mediaType: src.media_type }],
          };
        }
        return { type: "text", value: typeof output === "string" ? output : JSON.stringify(output) };
      },
    });
  }

  if (enabled.has("write")) {
    tools.write = tool({
      description:
        "Write content to a file in the sandbox. Creates parent directories automatically. " +
        "Overwrites the file if it already exists.",
      inputSchema: z.object({
        file_path: z.string().describe("The absolute file path to write to, e.g. /workspace/index.html"),
        content: z.string().describe("The complete file content to write"),
      }),
      execute: safe(async ({ file_path, content }) => sandbox.writeFile(file_path, content)),
    });
  }

  if (enabled.has("edit")) {
    tools.edit = tool({
      description:
        "Performs exact string replacements in files. " +
        "old_string must be unique in the file unless replace_all is true. " +
        "Use replace_all when you want to rename a variable or replace every occurrence.",
      inputSchema: z.object({
        file_path: z.string().describe("The absolute file path to edit"),
        old_string: z.string().describe("Exact string to find and replace"),
        new_string: z.string().describe("Replacement string"),
        replace_all: z.boolean().optional().describe("Replace all occurrences (default false)"),
      }),
      execute: safe(async ({ file_path, old_string, new_string, replace_all }) => {
        const content = await sandbox.readFile(file_path);
        if (!content.includes(old_string)) {
          return "Error: old_string not found in file";
        }
        // Default behavior: require uniqueness (matches Anthropic Edit semantics)
        if (!replace_all) {
          const occurrences = content.split(old_string).length - 1;
          if (occurrences > 1) {
            return `Error: old_string appears ${occurrences} times in file. ` +
              `Provide more surrounding context to make it unique, or pass replace_all=true.`;
          }
        }
        const updated = replace_all
          ? content.split(old_string).join(new_string)
          : content.replace(old_string, new_string);
        return sandbox.writeFile(file_path, updated);
      }),
    });
  }

  if (enabled.has("glob")) {
    tools.glob = tool({
      description:
        "Fast file pattern matching tool. Supports glob patterns like \"**/*.js\" or \"src/**/*.ts\". " +
        "Returns matching file paths sorted by modification time (most recent first).",
      inputSchema: z.object({
        pattern: z.string().describe('Glob pattern (e.g. "**/*.ts", "src/**/*.js")'),
        path: z
          .string()
          .optional()
          .describe("Directory to search in (defaults to /workspace)"),
      }),
      execute: safe(async ({ pattern, path }) => {
        const dir = path || "/workspace";
        // Walk dir + match glob via bash, then sort by mtime desc, take head 250
        const cmd =
          `cd ${shellQuote(dir)} 2>/dev/null && ` +
          `bash -O globstar -O nullglob -c ${shellQuote(`for f in ${pattern}; do printf '%s\\t%s\\n' "$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo 0)" "$f"; done | sort -rn | head -n 250 | cut -f2-`)}`;
        const raw = await sandbox.exec(cmd);
        const m = raw.match(/^exit=(-?\d+)\n([\s\S]*)$/);
        if (!m) return raw;
        const code = parseInt(m[1], 10);
        const out = m[2].trimEnd();
        if (code !== 0) return truncateResult(`Error: glob exited with code ${code}\n${out}`);
        if (!out) return "No files matched the pattern";
        const files = out.split("\n").filter(Boolean);
        return truncateResult(`Found ${files.length} file${files.length === 1 ? "" : "s"}\n${files.join("\n")}`);
      }),
    });
  }

  if (enabled.has("grep")) {
    tools.grep = tool({
      description:
        "A powerful search tool built on ripgrep (falls back to grep if rg unavailable). " +
        "Supports full regex syntax, file type / glob filters, three output modes, multiline matching, and context lines. " +
        "Output modes: " +
        '"files_with_matches" (default) shows file paths; ' +
        '"content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit); ' +
        '"count" shows match counts per file.',
      inputSchema: z.object({
        pattern: z.string().describe("The regular expression pattern to search for in file contents"),
        path: z.string().optional().describe("File or directory to search (defaults to /workspace)"),
        output_mode: z
          .enum(["content", "files_with_matches", "count"])
          .optional()
          .describe('Output mode (default: "files_with_matches")'),
        glob: z.string().optional().describe('Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}")'),
        type: z.string().optional().describe("File type to search (rg --type, e.g. js, py, rust)"),
        "-i": z.boolean().optional().describe("Case insensitive search"),
        "-n": z.boolean().optional().describe('Show line numbers (defaults true for output_mode="content")'),
        "-A": z.number().optional().describe("Lines to show after each match (content mode)"),
        "-B": z.number().optional().describe("Lines to show before each match (content mode)"),
        "-C": z.number().optional().describe("Lines to show before AND after each match (content mode)"),
        multiline: z.boolean().optional().describe("Enable multiline mode (. matches newlines, patterns can span lines)"),
        head_limit: z.number().optional().describe("Limit output to first N lines/entries (default 250; pass 0 for unlimited)"),
      }),
      execute: safe(async (args) => {
        const pattern = args.pattern;
        const dir = args.path || "/workspace";
        const mode = args.output_mode || "files_with_matches";
        const headLimit = args.head_limit === 0 ? 0 : (args.head_limit ?? 250);
        const showLineNumbers = args["-n"] !== false && mode === "content";

        // Detect ripgrep availability once per session is fine; cheap probe.
        const rgProbe = await sandbox.exec(`command -v rg >/dev/null 2>&1 && echo rg || echo grep`).catch(() => "exit=0\ngrep");
        const useRg = /\brg\b/.test(rgProbe);

        // Build flags
        const flags: string[] = [];
        if (useRg) {
          if (mode === "files_with_matches") flags.push("-l");
          else if (mode === "count") flags.push("-c");
          else if (showLineNumbers) flags.push("-n");
          if (args["-i"]) flags.push("-i");
          if (args.multiline) flags.push("-U", "--multiline-dotall");
          if (args["-A"] !== undefined) flags.push(`-A${args["-A"]}`);
          if (args["-B"] !== undefined) flags.push(`-B${args["-B"]}`);
          if (args["-C"] !== undefined) flags.push(`-C${args["-C"]}`);
          if (args.glob) flags.push(`--glob=${shellQuote(args.glob)}`);
          if (args.type) flags.push(`--type=${shellQuote(args.type)}`);
        } else {
          // grep fallback
          if (mode === "files_with_matches") flags.push("-l");
          else if (mode === "count") flags.push("-c");
          else if (showLineNumbers) flags.push("-n");
          if (args["-i"]) flags.push("-i");
          if (args["-A"] !== undefined) flags.push(`-A${args["-A"]}`);
          if (args["-B"] !== undefined) flags.push(`-B${args["-B"]}`);
          if (args["-C"] !== undefined) flags.push(`-C${args["-C"]}`);
          if (args.glob) flags.push(`--include=${shellQuote(args.glob)}`);
          flags.push("-r"); // grep needs explicit recursive
        }

        const limitPipe = headLimit > 0 ? ` | head -n ${headLimit}` : "";
        const cmd = useRg
          ? `set -o pipefail; rg ${flags.join(" ")} ${shellQuote(pattern)} ${shellQuote(dir)}${limitPipe}`
          : `set -o pipefail; grep ${flags.join(" ")} ${shellQuote(pattern)} ${shellQuote(dir)}${limitPipe}`;

        const raw = await sandbox.exec(cmd);
        // raw format: "exit=N\n<stdout>"
        const m = raw.match(/^exit=(-?\d+)\n([\s\S]*)$/);
        if (!m) return raw;
        const code = parseInt(m[1], 10);
        const out = m[2].trimEnd();

        // Semantic translation aligned with Agent SDK Grep:
        //   exit 0  → matches found (rg/grep convention)
        //   exit 1  → no matches found (a normal "empty" result, NOT an error)
        //   exit 2+ → error (file not found, bad regex, IO)
        // SIGPIPE from `head` cutting off rg/grep early shows up as 141 — treat as success.
        if (code === 0 || code === 141) {
          if (!out) {
            // exit 0 with empty body is rare but possible (binary files, --quiet etc.)
            return mode === "count" ? "0\n" : "(matches found, but result body is empty)";
          }
          if (mode === "files_with_matches") {
            const files = out.split("\n").filter(Boolean);
            return truncateResult(`Found ${files.length} file${files.length === 1 ? "" : "s"}\n${files.join("\n")}`);
          }
          if (mode === "count") {
            // rg -c / grep -c output is "path:N" per file; sum total
            const lines = out.split("\n").filter(Boolean);
            let total = 0;
            for (const line of lines) {
              const cm = line.match(/:(\d+)$/);
              if (cm) total += parseInt(cm[1], 10);
            }
            return truncateResult(`${out}\n\nFound ${total} total occurrences across ${lines.length} file${lines.length === 1 ? "" : "s"}.`);
          }
          // content mode
          return truncateResult(out);
        }
        if (code === 1) {
          return "No matches found";
        }
        // Real error
        return truncateResult(`Error: grep exited with code ${code}\n${out}`);
      }),
    });
  }


  if (enabled.has("web_fetch")) {
    tools.web_fetch = tool({
      description:
        "Fetch the content of a URL. Returns the text content of the page.",
      inputSchema: z.object({
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
      inputSchema: z.object({
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
      inputSchema: z.object({
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
        inputSchema: params,
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
      const escapedUrl = server.url.replace(/'/g, "'\\''");
      const authHeader = server.authorization_token
        ? `-H 'Authorization: Bearer ${server.authorization_token.replace(/'/g, "'\\''")}'`
        : "";

      // Create a tool that lists available MCP tools from this server
      tools[`mcp_${server.name}_list_tools`] = tool({
        description: `List available tools from MCP server "${server.name}".`,
        inputSchema: z.object({}),
        execute: safe(async () => {
          const rpcBody = JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: {},
          });
          return truncateResult(await sandbox.exec(
            `curl -sS -X POST '${escapedUrl}' ` +
            `-H 'Content-Type: application/json' ` +
            `-H 'Accept: application/json, text/event-stream' ` +
            `${authHeader} ` +
            `-d '${rpcBody.replace(/'/g, "'\\''")}'`,
            15000
          ));
        }),
      });

      // Create a tool that calls any tool on this MCP server
      tools[`mcp_${server.name}_call`] = tool({
        description: `Call a tool on MCP server "${server.name}". First use mcp_${server.name}_list_tools to see available tools and their input schemas.`,
        inputSchema: z.object({
          tool_name: z.string().describe("Name of the MCP tool to call"),
          arguments: z.string().optional().describe("Tool arguments as JSON string"),
        }),
        execute: safe(async ({ tool_name, arguments: argsStr }) => {
          const args = argsStr ? JSON.parse(argsStr) : {};
          const rpcBody = JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: tool_name, arguments: args || {} },
          });
          return truncateResult(await sandbox.exec(
            `curl -sS -X POST '${escapedUrl}' ` +
            `-H 'Content-Type: application/json' ` +
            `-H 'Accept: application/json, text/event-stream' ` +
            `${authHeader} ` +
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
        inputSchema: z.object({
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
        inputSchema: (t as any).parameters || (t as any).inputSchema,
        // No execute — AI SDK treats this as a pending tool call
      });
    }
  }

  return tools;
}

// Memory tools — operate directly on KV, no self-fetch
/**
 * Build memory tools for a session. store_id is auto-bound (Anthropic-aligned).
 * Model never sees or needs to specify store_id.
 * For multi-store, first store is default; model uses path prefixes to organize.
 */
export function buildMemoryTools(
  storeIds: string[],
  kv: KVNamespace,
  ai?: Ai,
  vectorize?: VectorizeIndex,
): Record<string, any> {
  if (!storeIds.length || !kv) return {};
  const tools: Record<string, any> = {};
  const sid = storeIds[0]; // Auto-bind to first store (Anthropic: one store per session resource)

  // Backfill path→id index for memories created via REST API (which don't have mempath: entries)
  const ensurePathIndex = async (memId: string, path: string) => {
    const existing = await kv.get(`mempath:${sid}:${path}`);
    if (!existing) await kv.put(`mempath:${sid}:${path}`, memId);
  };

  tools.memory_list = tool({
    description: "List memories in the store. Returns paths and metadata (no content). Use path_prefix to filter.",
    inputSchema: z.object({
      path_prefix: z.string().optional().describe("Filter by path prefix, e.g. 'project/'"),
    }),
    execute: safe(async ({ path_prefix }: { path_prefix?: string }) => {
      const list = await kv.list({ prefix: `mem:${sid}:` });
      const items = await Promise.all(
        list.keys.map(async (k) => {
          const data = await kv.get(k.name);
          if (!data) return null;
          const mem = JSON.parse(data);
          if (path_prefix && !mem.path?.startsWith(path_prefix)) return null;
          // Backfill path index for memories created via REST API
          if (mem.id && mem.path) await ensurePathIndex(mem.id, mem.path);
          return { id: mem.id, path: mem.path, size_bytes: mem.size_bytes, updated_at: mem.updated_at };
        })
      );
      return JSON.stringify(items.filter(Boolean));
    }),
  });

  // Helper: resolve path → memory ID via index (strong consistency)
  const resolvePath = async (path: string): Promise<string | null> => {
    return await kv.get(`mempath:${sid}:${path}`);
  };

  tools.memory_read = tool({
    description: "Read the full content of a memory by path.",
    inputSchema: z.object({
      path: z.string().describe("Memory path to read"),
    }),
    execute: safe(async ({ path }: { path: string }) => {
      const memId = await resolvePath(path);
      if (!memId) return "Error: memory not found at path: " + path;
      const data = await kv.get(`mem:${sid}:${memId}`);
      if (!data) return "Error: memory data missing for path: " + path;
      return JSON.parse(data).content || "";
    }),
  });

  tools.memory_write = tool({
    description: "Write or update a memory at a path. Creates if not exists, updates if path matches.",
    inputSchema: z.object({
      path: z.string().describe("Memory path, e.g. 'notes/architecture.md'"),
      content: z.string().describe("Memory content"),
    }),
    execute: safe(async ({ path, content }: { path: string; content: string }) => {
      const now = new Date().toISOString();
      const size_bytes = new TextEncoder().encode(content).length;
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
      const content_sha256 = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");

      const existingId = await resolvePath(path);
      if (existingId) {
        const data = await kv.get(`mem:${sid}:${existingId}`);
        if (data) {
          const mem = JSON.parse(data);
          mem.content = content;
          mem.size_bytes = size_bytes;
          mem.content_sha256 = content_sha256;
          mem.updated_at = now;
          await kv.put(`mem:${sid}:${existingId}`, JSON.stringify(mem));
          return `Updated memory at ${path}`;
        }
      }

      const id = `mem_${Date.now().toString(36)}`;
      const mem = { id, store_id: sid, path, content, content_sha256, size_bytes, created_at: now };
      await kv.put(`mem:${sid}:${id}`, JSON.stringify(mem));
      await kv.put(`mempath:${sid}:${path}`, id); // path → id index
      return `Created memory at ${path}`;
    }),
  });

  tools.memory_search = tool({
    description: "Search memories by keyword. Returns matching paths and content snippets.",
    inputSchema: z.object({
      query: z.string().describe("Search query"),
    }),
    execute: safe(async ({ query }: { query: string }) => {
      // Try semantic search via Vectorize first
      if (ai && vectorize) {
        try {
          const embedding = await ai.run("@cf/google/embedding-gemma" as any, { text: [query] }) as { data: number[][] };
          if (embedding.data?.[0]) {
            const results = await vectorize.query(embedding.data[0], {
              topK: 10,
              filter: { store_id: sid },
              returnMetadata: "all",
            });
            if (results.matches?.length) {
              const matches = await Promise.all(
                results.matches.map(async (m) => {
                  const memId = (m.metadata as any)?.memory_id;
                  let snippet = "";
                  if (memId) {
                    const data = await kv.get(`mem:${sid}:${memId}`);
                    if (data) snippet = JSON.parse(data).content?.slice(0, 200) || "";
                  }
                  return { path: (m.metadata as any)?.path || "", snippet, score: m.score };
                })
              );
              return JSON.stringify(matches);
            }
          }
        } catch { /* Fall through to substring search */ }
      }

      // Fallback: substring search
      const list = await kv.list({ prefix: `mem:${sid}:` });
      const matches: Array<{ path: string; snippet: string }> = [];
      const q = query.toLowerCase();
      for (const k of list.keys) {
        const data = await kv.get(k.name);
        if (!data) continue;
        const mem = JSON.parse(data);
        if (mem.content?.toLowerCase().includes(q) || mem.path?.toLowerCase().includes(q)) {
          matches.push({ path: mem.path, snippet: mem.content.slice(0, 200) });
          if (mem.id && mem.path) await ensurePathIndex(mem.id, mem.path);
        }
      }
      return JSON.stringify(matches);
    }),
  });

  tools.memory_edit = tool({
    description: "Edit an existing memory. Safer than memory_write for concurrent updates — use expected_content_sha256 for optimistic locking.",
    inputSchema: z.object({
      path: z.string().describe("Path of the memory to edit"),
      content: z.string().describe("New content"),
      expected_content_sha256: z.string().optional().describe("Expected SHA-256 of current content for concurrency check"),
    }),
    execute: safe(async ({ path, content, expected_content_sha256 }: { path: string; content: string; expected_content_sha256?: string }) => {
      const memId = await resolvePath(path);
      if (!memId) return "Error: memory not found at path: " + path;
      const data = await kv.get(`mem:${sid}:${memId}`);
      if (!data) return "Error: memory data missing for path: " + path;
      const mem = JSON.parse(data);
      if (expected_content_sha256 && mem.content_sha256 !== expected_content_sha256) {
        return "Error: content has been modified since last read (sha256 mismatch). Re-read and retry.";
      }
      mem.content = content;
      mem.size_bytes = new TextEncoder().encode(content).length;
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
      mem.content_sha256 = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
      mem.updated_at = new Date().toISOString();
      await kv.put(`mem:${sid}:${memId}`, JSON.stringify(mem));
      return `Edited memory at ${path}`;
    }),
  });

  tools.memory_delete = tool({
    description: "Delete a memory by path.",
    inputSchema: z.object({
      path: z.string().describe("Memory path to delete"),
    }),
    execute: safe(async ({ path }: { path: string }) => {
      const memId = await resolvePath(path);
      if (!memId) return "Error: memory not found at path: " + path;
      await kv.delete(`mem:${sid}:${memId}`);
      await kv.delete(`mempath:${sid}:${path}`);
      return `Deleted memory at ${path}`;
    }),
  });

  return tools;
}
