import { tool, generateText } from "ai";
import { experimental_createMCPClient } from "@ai-sdk/mcp";
import { z } from "zod";
import { anthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import type { AgentConfig, ToolsetConfig, CustomToolConfig, SessionEvent } from "@open-managed-agents/shared";
import type { ToMarkdownProvider } from "@open-managed-agents/markdown";
import type { SandboxExecutor, ProcessHandle } from "./interface";
import { nanoid } from "nanoid";
// Browser tools are lazy-imported below — they pull in @cloudflare/playwright
// which is workerd-only. Type-only import is fine (erased at runtime).
import type { BrowserSession } from "./browser-tools";

// Source of truth for which tool names are part of the agent_toolset_20260401
// built-in suite. Used by buildTools() below to decide which tool entries to
// include AND by harness/default-loop.ts to classify tool-use events as
// `agent.tool_use` (built-in) vs `agent.custom_tool_use`. Keep this in sync
// with the actual `tools.<name> = tool({...})` registrations below — the
// classification list and the registration list MUST be the same set, or
// downstream consumers (Console UI, SDK event filters, billing) will see
// mis-typed events.
/** Tools enabled by default when an agent has no explicit tools config.
 *  Excludes opt-in tools that bias the LLM away from cheaper alternatives
 *  — see OPT_IN_TOOLS below. */
export const DEFAULT_TOOLS = ["bash", "read", "write", "edit", "glob", "grep", "web_fetch", "web_search", "schedule", "cancel_schedule", "list_schedules"];

/** Tools recognised but NOT registered by default — agents must opt in
 *  via tools config (`{ name: "browser", enabled: true }`).
 *  - `browser`: heavy multi-step session (navigate / click / screenshot).
 *    Available web_fetch + web_search satisfy 95% of read-only research;
 *    the LLM otherwise tends to reach for browser even for simple lookups
 *    because the description sounds more "agentic". Make it opt-in so the
 *    default tool list nudges toward the cheaper path. */
export const OPT_IN_TOOLS = ["browser"];

/** Backwards-compat union — used as the recognised-tool-name set for
 *  validation. New callers should prefer DEFAULT_TOOLS or OPT_IN_TOOLS. */
export const ALL_TOOLS = [...DEFAULT_TOOLS, ...OPT_IN_TOOLS];
const MAX_TOOL_RESULT_CHARS = 50000;
const DEFAULT_BASH_TIMEOUT = 120000;  // 2 minutes (CC default)
const MAX_BASH_TIMEOUT = 600000;      // 10 minutes (CC max)
// Cap MCP client init + tools/list. Without this, a hung upstream
// (server reachable but never replies to tools/list) blocks buildTools
// for the whole turn, and finalize-stale eventually clears the turn
// with `flushed 0 tool_uses` and no error log — opaque to debug.
// 15s is generous: a healthy server replies in <1s.
const MCP_SETUP_TIMEOUT_MS = 15_000;

// System prompt for the auxiliary model when summarizing web pages fetched
// by web_fetch. Designed for the OMA agent loop: the summary lands directly
// in the agent's tool-result context window, so it has to carry whatever the
// agent might need next without forcing a re-read of the raw markdown.
const WEB_SUMMARIZE_SYSTEM_PROMPT = `Compress the page below into a digest for an autonomous agent that fetched this URL while researching something. Assume the agent will not re-read the original.

Keep:
- Every concrete fact (numbers, dates, named entities, identifiers, statuses, geographic regions, units)
- Tables and lists in their original layout — do not narrativize them
- Outbound links that look like data sources (don't paraphrase URLs)
- Quoted material relevant to the page's topic, verbatim

Drop:
- Site chrome (nav, ads, footers, cookie banners, legal disclaimers, "share this article")
- Restated headers, repeated boilerplate, meta-commentary about the page itself
- Marketing copy that adds no information

Format: short markdown. Headings only when the original had them. No introduction. No "this page describes…" — just the content.

If the page is an error/404/login wall/empty result, output exactly one line stating that and stop.`;



/**
 * Poll a started process. SIGTERM on timeout, return partial output.
 *
 * Auto-background-on-timeout was REMOVED 2026-05-13 — see commit msg.
 * The bash tool no longer surfaces a `run_in_background` flag either.
 * Net effect: every bash call has bounded duration; agent always sees
 * either a clean exit or a "timed out, here's partial" string. No
 * synthetic notifications ever inject into the conversation.
 *
 * If/when we re-enable backgrounding, the missing piece is robust
 * cleanup of completion notifications + R2 mount lifecycle (the two
 * bugs that motivated this disable).
 */
async function pollWithStrategies(
  proc: ProcessHandle,
  command: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve) => {
    let settled = false;

    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;

      let partial = "";
      try {
        const logs = await proc.getLogs();
        partial = (logs.stdout || "") + (logs.stderr ? "\nstderr: " + logs.stderr : "");
      } catch {}

      try { await proc.kill("SIGTERM"); } catch {}
      resolve(truncateResult(
        `exit=143\nCommand timed out after ${Math.round(timeoutMs / 1000)}s\n${partial}`.trim()
      ));
    }, timeoutMs);

    // Poll for normal completion
    const poll = async () => {
      while (!settled) {
        try {
          const status = await proc.getStatus();
          // SDK ProcessStatus union (sandbox-Bb3n0SeC.d.ts:655):
          //   'starting' | 'running' | 'completed' | 'failed' | 'killed' | 'error'
          // All four non-{starting, running} states are terminal — proc.getLogs()
          // has the final output and exitCode is set.
          //
          // Pre-fix this only checked completed/error/killed; 'failed' (any
          // non-zero exit, e.g. `git commit` with no identity → exit 128,
          // npm install missing pkg → exit 1) was NOT in the set, so the
          // poll loop kept looping until the bash timeout fired. Result:
          // every error case returned `exit=143 / Command timed out after
          // 120s` after a 2-minute hang, even when the underlying command
          // had exited cleanly within milliseconds. Caught 2026-05-13
          // testing `git commit` (Author identity unknown).
          if (
            status === "completed"
            || status === "failed"
            || status === "killed"
            || status === "error"
          ) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const logs = await proc.getLogs();
            let out = logs.stdout || "";
            if (logs.stderr) out += (out ? "\n" : "") + "stderr: " + logs.stderr;
            // Prefer SDK-reported exitCode (carries the real signal — 1
            // for npm error, 128 for git, etc.). Fall back to status-based
            // shorthand only when the SDK didn't surface a code.
            const sdkExit = (proc as { exitCode?: number }).exitCode;
            const exitCode =
              typeof sdkExit === "number"
                ? sdkExit
                : status === "killed" ? 137
                : (status === "error" || status === "failed") ? 1
                : 0;
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

/** File extensions that Read returns as IMAGE content blocks (Claude/GPT-4o/Grok native). */
const IMAGE_EXTENSIONS: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** File extensions that Read returns as DOCUMENT content blocks (PDF only — Claude native). */
const DOCUMENT_EXTENSIONS: Record<string, string> = {
  pdf: "application/pdf",
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
  // Default = DEFAULT_TOOLS only. OPT_IN_TOOLS (browser) require an
  // explicit per-tool { enabled: true } in the agent's tools config.
  const defaultSet = new Set(DEFAULT_TOOLS);

  if (!tools || tools.length === 0) return defaultSet;

  for (const t of tools) {
    if (t.type === "custom") continue;

    const ts = t as ToolsetConfig;
    if (ts.configs) {
      const enabled = new Set<string>();
      const defaultEnabled = ts.default_config?.enabled ?? true;

      // "default_config.enabled = true" turns on the DEFAULT set —
      // still NOT opt-in tools. To get browser, the agent must have
      // an explicit `{ name: "browser", enabled: true }` in configs.
      if (defaultEnabled) {
        for (const name of defaultSet) enabled.add(name);
      }

      for (const c of ts.configs) {
        if (c.enabled) enabled.add(c.name);
        else enabled.delete(c.name);
      }
      return enabled;
    }

    return defaultSet;
  }

  return defaultSet;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function buildTools(
  agentConfig: AgentConfig,
  sandbox: SandboxExecutor,
  env?: {
    ANTHROPIC_API_KEY?: string;
    ANTHROPIC_BASE_URL?: string;
    TAVILY_API_KEY?: string;
    /** Markdown converter for web_fetch (HTML/PDF/DOCX → markdown). On
     *  Cloudflare it wraps env.AI.toMarkdown(); on Node it's
     *  turndown/pdf-parse/mammoth. Optional — when absent the tool falls
     *  back to raw curl + a warning to the model. */
    toMarkdown?: ToMarkdownProvider;
    delegateToAgent?: (agentId: string, message: string) => Promise<string>;
    environmentConfig?: { networking?: { type: string; allowed_hosts?: string[] } };
    /** MCP routing context — wired from SessionDO. AI SDK's MCP HTTP
     *  transport gets a custom `fetch` that calls
     *  `env.mcpBinding.fetch(req)` with three metadata headers stamped
     *  (`x-oma-tenant`, `x-oma-session`, `x-oma-mcp-server`); main worker
     *  resolves the vault credential, swaps Authorization, and forwards
     *  to the upstream URL the SDK already knew. Body, response status,
     *  response headers (incl. rotated `Mcp-Session-Id`) all stream
     *  through unchanged so the SDK owns the protocol details. Vault
     *  credentials remain main-only — agent worker sees only the
     *  Response. Omitting any of the three (binding, tenantId, sessionId)
     *  silently disables MCP tool registration — the loop below logs
     *  nothing because in legacy callsites this is the expected "no MCP"
     *  path. */
    mcpBinding?: { fetch: (request: Request) => Promise<Response> };
    tenantId?: string;
    sessionId?: string;
    watchBackgroundTask?: (taskId: string, pid: string, outputFile: string, proc: ProcessHandle | null) => void;
    browser?: BrowserSession;
    /** Pre-resolved auxiliary model — when present, web_fetch summarizes
     *  large pages and offloads raw markdown to /workspace/.web/.
     *  Falsy (default) = no aux work; web_fetch returns raw markdown. */
    auxModel?: LanguageModel;
    /** Identifier metadata for the aux model — written into aux.model_call
     *  trajectory events so cost dashboards can attribute usage. */
    auxModelInfo?: { model_id: string };
    /** Emit a SessionEvent into the trajectory stream. Used to record
     *  aux.model_call events from inside tool execution. */
    broadcastEvent?: (event: SessionEvent) => void;
    /** Schedule a future wake-up of the current session. Backed by the
     *  agents framework's durable scheduler in SessionDO. Exactly one of
     *  delay_seconds | at | cron must be supplied. */
    scheduleWakeup?: (args: {
      delay_seconds?: number;
      at?: string;
      cron?: string;
      prompt: string;
    }) => Promise<{ id: string; fire_at?: string; cron?: string; kind: "one_shot" | "cron" }>;
    /** Cancel a previously scheduled wakeup by id. */
    cancelWakeup?: (id: string) => Promise<{ cancelled: boolean }>;
    /** List pending wakeup schedules for THIS session. Filters out the
     *  framework's internal recoverEventQueue / pollBackgroundTasks rows. */
    listWakeups?: () => Array<{
      id: string;
      fire_at?: string;
      cron?: string;
      prompt: string;
      kind: "one_shot" | "cron";
    }>;
  }
): Promise<Record<string, any>> {
  const enabled = getEnabledTools(agentConfig.tools);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = {};

  // Browser tools (Cloudflare Browser Rendering binding). Requires both an
  // active session passed in AND the agent to opt in to "browser" in its toolset.
  // Lazy-imported because @cloudflare/playwright is workerd-only and pulling
  // it at module-load time would block Node consumers from importing
  // this file at all.
  if (env?.browser && enabled.has("browser")) {
    const { buildBrowserTools } = await import("./browser-tools");
    Object.assign(tools, buildBrowserTools(env.browser));
  }

  if (enabled.has("bash")) {
    tools.bash = tool({
      description:
        "Execute a bash command in the sandbox. Returns exit code + stdout/stderr. " +
        "Bounded by `timeout` (default 120s, max 600s) — on timeout the process is " +
        "SIGTERM'd and any partial output is returned. For long-running work, run the " +
        "command yourself with `nohup ... &` writing to a file, then poll the file with " +
        "the read tool across turns.",
      inputSchema: z.object({
        command: z.string().describe("The bash command to execute"),
        timeout: z
          .number()
          .optional()
          .describe("Timeout in milliseconds (default 120000, max 600000)"),
      }),
      execute: safe(async ({ command, timeout }) => {
        const timeoutMs = Math.min(timeout || DEFAULT_BASH_TIMEOUT, MAX_BASH_TIMEOUT);

        // Auto-background-on-timeout was REMOVED 2026-05-13. The
        // explicit `run_in_background` flag is gone too. Both surfaced
        // a synthetic <task_notification> as user.message via
        // pollBackgroundTasks → drainEventQueue, which (a) duplicated
        // the agent's prior reply when the model treated the
        // notification as a new user turn, (b) rendered as a confusing
        // red "You" bubble in console, and (c) returned stale partial
        // output because the snapshot was taken at backgrounding time
        // and never refreshed. Hard SIGTERM is the universal contract
        // now — bounded duration, no notification surface.
        if (sandbox.startProcess) {
          const proc = await sandbox.startProcess(command);
          if (proc) {
            return await pollWithStrategies(proc, command, timeoutMs);
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
        "offset/limit for chunked reads), image files (PNG, JPG, JPEG, GIF, WEBP), and " +
        "PDF documents — all returned as visual/document content blocks for multimodal models. " +
        "By default reads the entire file. Use offset (1-based line number) and limit " +
        "(number of lines) to read large text files in chunks.",
      inputSchema: z.object({
        file_path: z.string().describe("The absolute file path to read, e.g. /workspace/index.html"),
        offset: z.number().optional().describe("1-based line number to start reading from (text only)"),
        limit: z.number().optional().describe("Number of lines to read (text only)"),
      }),
      execute: safe(async ({ file_path, offset, limit }) => {
        const ext = file_path.split(".").pop()?.toLowerCase() || "";
        const imageMedia = IMAGE_EXTENSIONS[ext];
        const docMedia = DOCUMENT_EXTENSIONS[ext];

        if (imageMedia || docMedia) {
          // Binary file (image or PDF): base64-encode via shell, return as
          // Anthropic-shape ContentBlock (image or document). toModelOutput below
          // converts to AI SDK content shape for the model.
          const raw = await sandbox.exec(
            `(base64 -w0 ${shellQuote(file_path)} 2>/dev/null || base64 ${shellQuote(file_path)} | tr -d '\\n')`,
          );
          const m = raw.match(/^exit=(-?\d+)\n([\s\S]*)$/);
          if (!m) return raw;
          const code = parseInt(m[1], 10);
          if (code !== 0) return `Error reading file (exit=${code}): ${m[2].slice(0, 200)}`;
          const data = m[2].trimEnd();
          if (!data) return "Error: file is empty or unreadable";

          if (imageMedia) {
            return {
              type: "image" as const,
              source: { type: "base64" as const, media_type: imageMedia, data },
            };
          }
          // PDF/document
          return {
            type: "document" as const,
            source: { type: "base64" as const, media_type: docMedia!, data },
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
      // For images/documents, emit a `content` array with `file-data` parts;
      // the @ai-sdk/anthropic provider translates this into a tool_result with the
      // appropriate image/document content block.
      toModelOutput: ({ output }) => {
        if (output && typeof output === "object" && "type" in output) {
          const t = (output as { type?: string }).type;
          if (t === "image" || t === "document") {
            const src = (output as unknown as { source: { data: string; media_type: string } }).source;
            return {
              type: "content",
              value: [{ type: "file-data", data: src.data, mediaType: src.media_type }],
            };
          }
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
        "Fetch a URL and return clean markdown — strips boilerplate (nav/ads/scripts), " +
        "preserves headings and links. Use this as the default way to read web pages; " +
        "fall back to browser_* tools only if you need to interact (click, fill forms) " +
        "or if the page is JS-rendered (SPA) and returns empty markdown. Large pages " +
        "may be auto-summarized when an aux model is configured on the agent — the " +
        "full raw markdown is then saved to /workspace/.web/, readable via the `read` " +
        "tool when you need detail beyond the summary.",
      inputSchema: z.object({
        url: z.string().describe("URL to fetch"),
        max_length: z
          .number()
          .optional()
          .describe("Truncate returned markdown to this many chars (default 50000)"),
      }),
      execute: safe(async ({ url, max_length }) => {
        // Networking restriction enforcement (limited mode)
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

        const cap = max_length || 50000;
        const truncate = (s: string) => (s.length > cap ? s.slice(0, cap) + `\n\n…[truncated to ${cap} chars]` : s);

        // ── Step 1: Fetch URL → blob → markdown converter ──
        // CF: Workers AI's toMarkdown converts HTML/PDF/DOCX/etc. without
        // an external service. Node (self-host): turndown / pdf-parse /
        // mammoth. Either way, the tool calls a portable
        // ToMarkdownProvider port — runtime detail lives in the adapter.
        let markdown: string | null = null;
        let isRaw = false;
        if (env?.toMarkdown) {
          try {
            const r = await fetch(url, {
              headers: {
                "User-Agent": "OMA-Agent/1.0 (+web_fetch)",
                Accept: "text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8",
              },
              redirect: "follow",
              signal: AbortSignal.timeout(20_000),
            });
            if (r.ok) {
              const buf = await r.arrayBuffer();
              const ct = r.headers.get("content-type") || "text/html";
              const name = (() => {
                try {
                  const path = new URL(r.url).pathname;
                  const last = path.split("/").filter(Boolean).pop() || "page";
                  return last.includes(".") ? last : `${last}.html`;
                } catch { return "page.html"; }
              })();
              const conv = await env.toMarkdown([{ name, blob: new Blob([buf], { type: ct }) }]);
              const result = Array.isArray(conv) ? conv[0] : conv;
              if (result && result.format === "markdown" && typeof result.data === "string") {
                markdown = result.data;
              } else {
                const errMsg = result?.error || "toMarkdown returned non-markdown result";
                console.warn(`[web_fetch] toMarkdown failed for ${url}: ${errMsg}`);
              }
            } else {
              console.warn(`[web_fetch] origin returned HTTP ${r.status} for ${url}`);
            }
          } catch (err) {
            const e = err as Error & { cause?: unknown };
            console.warn(
              `[web_fetch] toMarkdown threw for ${url}: ${e.message}` +
                (e.cause ? ` (cause: ${JSON.stringify(e.cause)})` : ""),
            );
          }
        }
        if (markdown === null) {
          // Fallback: raw curl from sandbox (last-resort, model gets warning)
          const raw = await sandbox.exec(
            `curl -sL -m 30 '${url.replace(/'/g, "'\\''")}' | head -c ${cap}`,
            35000,
          );
          markdown = `[NOTE: markdown extraction unavailable for this URL — returning raw response. Look for the actual content between HTML tags.]\n\n${truncateResult(raw)}`;
          isRaw = true;
        }

        // ── Step 2: Aux summarization + offload (when configured) ──
        // Only summarize clean markdown (skip raw HTML fallback to avoid
        // confusing the summarizer). Skip small content (already concise).
        const SUMMARY_THRESHOLD = 5000;
        if (env?.auxModel && env?.auxModelInfo && !isRaw && markdown.length > SUMMARY_THRESHOLD) {
          const t0 = Date.now();
          // Sandbox-side cache key: sha-256(url) → /workspace/.web/<hex>.md
          const sha = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
          const hex = Array.from(new Uint8Array(sha)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
          const rawPath = `/workspace/.web/${hex}.md`;
          try {
            await sandbox.exec(`mkdir -p /workspace/.web`, 5000).catch(() => "");
            await sandbox.writeFile(rawPath, markdown);
          } catch (writeErr) {
            console.warn(`[web_fetch] failed to offload raw markdown for ${url}: ${(writeErr as Error).message}`);
          }
          try {
            const summarizeResult = await generateText({
              model: env.auxModel,
              system: WEB_SUMMARIZE_SYSTEM_PROMPT,
              prompt: `URL: ${url}\n\nPAGE CONTENT (markdown):\n\n${markdown}`,
              maxOutputTokens: 1500,
              temperature: 0.1,
              abortSignal: AbortSignal.timeout(60_000),
            });
            const summary = (summarizeResult.text || "").trim();
            if (summary.length === 0) throw new Error("aux model returned empty summary");
            const usage = summarizeResult.usage || {};
            const inputTokens = (usage as { inputTokens?: number; promptTokens?: number }).inputTokens
              ?? (usage as { promptTokens?: number }).promptTokens
              ?? 0;
            const outputTokens = (usage as { outputTokens?: number; completionTokens?: number }).outputTokens
              ?? (usage as { completionTokens?: number }).completionTokens
              ?? 0;
            env.broadcastEvent?.({
              type: "aux.model_call",
              id: `sevt-${nanoid(12)}`,
              processed_at: new Date().toISOString(),
              model_id: env.auxModelInfo.model_id,
              task: "web_summarize",
              duration_ms: Date.now() - t0,
              tokens: { input: inputTokens, output: outputTokens },
              status: "ok",
            });
            const compressionPct = Math.round((summary.length / markdown.length) * 100);
            return JSON.stringify({
              url,
              content: summary,
              _meta: {
                extractor: env.auxModelInfo.model_id,
                compression: `${markdown.length} → ${summary.length} chars (${compressionPct}%)`,
                raw_at: rawPath,
                hint: `Use \`read ${rawPath}\` (with offset/limit) to see full original markdown if the summary is missing detail.`,
              },
            }, null, 2);
          } catch (auxErr) {
            const errMsg = (auxErr as Error).message;
            console.warn(`[web_fetch] aux summarization failed for ${url}: ${errMsg}`);
            env.broadcastEvent?.({
              type: "aux.model_call",
              id: `sevt-${nanoid(12)}`,
              processed_at: new Date().toISOString(),
              model_id: env.auxModelInfo.model_id,
              task: "web_summarize",
              duration_ms: Date.now() - t0,
              tokens: { input: 0, output: 0 },
              status: "failed",
              error: errMsg,
            });
            return JSON.stringify({
              url,
              content: truncate(markdown),
              _meta: {
                summary_failed: true,
                summary_error: errMsg,
              },
            }, null, 2);
          }
        }

        // ── Step 3: No aux configured (or content too small) — return raw ──
        return truncate(markdown);
      }),
    });
  }

  // --- Schedule (self-wakeup) ---
  // Lets an agent pause-and-resume itself without holding a sandbox open:
  // schedule a future user.message + drainEventQueue, backed by the agents
  // framework's durable scheduler on SessionDO. Reminder flows, follow-ups,
  // periodic monitors. Cron schedules recur until cancel_schedule.
  if (env?.scheduleWakeup && enabled.has("schedule")) {
    tools.schedule = tool({
      description:
        "Schedule THIS session to wake up later. Provide exactly one of delay_seconds, at (ISO-8601 timestamp), or cron (5-field cron). " +
        "When the timer fires, `prompt` is injected as a user message and the agent loop resumes from there. " +
        "Use for reminders (\"check the build in 10 minutes\"), follow-ups, or periodic monitors. " +
        "Cron schedules repeat until cancelled via cancel_schedule. Returns the schedule id. " +
        "Each session has a cap of 20 pending wakeups (cron schedules count as one slot regardless of recurrences) — " +
        "if the cap is reached, list_schedules to see what's queued and cancel_schedule any you no longer need.",
      inputSchema: z
        .object({
          delay_seconds: z
            .number()
            .int()
            .min(5)
            .max(7 * 24 * 3600)
            .optional()
            .describe("Wake up after this many seconds (5 .. 7d)."),
          at: z
            .string()
            .datetime()
            .optional()
            .describe("Wake up at this ISO-8601 timestamp (UTC, e.g. 2026-04-28T09:00:00Z)."),
          cron: z
            .string()
            .min(9)
            .max(120)
            .optional()
            .describe("Recurring schedule, 5-field cron (e.g. \"0 9 * * *\" = 9am daily)."),
          prompt: z
            .string()
            .min(1)
            .max(4000)
            .describe("Message injected on wakeup — tell future-you why."),
        })
        .refine(
          (v) => [v.delay_seconds, v.at, v.cron].filter((x) => x != null).length === 1,
          "Provide exactly one of delay_seconds | at | cron",
        ),
      execute: safe(async (args) => env.scheduleWakeup!(args)),
    });
  }

  if (env?.cancelWakeup && enabled.has("cancel_schedule")) {
    tools.cancel_schedule = tool({
      description:
        "Cancel a previously scheduled wakeup by id. Returns { cancelled: true } if a wakeup row was removed, " +
        "or false if the id is unknown / already fired / not a wakeup schedule.",
      inputSchema: z.object({
        id: z.string().min(1).describe("Schedule id returned by the schedule tool"),
      }),
      execute: safe(async ({ id }) => env.cancelWakeup!(id)),
    });
  }

  if (env?.listWakeups && enabled.has("list_schedules")) {
    tools.list_schedules = tool({
      description:
        "List all pending wakeup schedules for THIS session: id, fire_at, cron (if recurring), prompt, kind.",
      inputSchema: z.object({}),
      execute: safe(async () => ({ schedules: env.listWakeups!() })),
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

  // MCP tools — first-class via AI SDK MCP client. The agent worker hands
  // the SDK's built-in HTTP transport a custom `fetch` that calls
  // `env.mcpBinding.fetch(req)` after stamping three metadata headers
  // (`x-oma-tenant`, `x-oma-session`, `x-oma-mcp-server`). Main worker
  // resolves the vault credential by serverName, swaps in the upstream
  // bearer, and forwards to the URL the SDK already targeted. Body /
  // status / response headers (incl. rotated `Mcp-Session-Id`) stream
  // through both ways unchanged, so the SDK owns the Streamable-HTTP
  // protocol — session ids, SSE response framing, retries — and a
  // server-side spec change can't silently break us the way the prior
  // hand-rolled BindingMCPTransport did (Notion's tools/list never
  // returned, hanging the whole turn until our 15s setup-timeout fired).
  // Each remote tool surfaces as `mcp__<server>__<tool>` — same prefix
  // the local-runtime ACP path produces.
  //
  // Auth + vault injection happen **inside main, not here**. Agent worker
  // never sees the credential — the request leaves with no Authorization
  // header (or a placeholder) and main rewrites it. Mirrors the original
  // mcpForward design's "credentials only in main" property; only the
  // wire-format moved from a structured RPC body-buffered call to a
  // streaming Request/Response service-binding call.
  //
  // Network policy ("model can only call declared mcp_servers"): enforced
  // at the tool-registration layer below — only declared servers get
  // registered, and the model has no other tool that takes an arbitrary URL.
  if (agentConfig.mcp_servers?.length) {
    if (!env?.mcpBinding || !env?.tenantId || !env?.sessionId) {
      // Wiring missing — buildTools called from a context that didn't
      // thread the binding through (legacy path or test harness). Skip MCP
      // setup silently rather than crash; the model just won't see the
      // tools and will report "I don't have that available". Caller logs
      // are responsible for surfacing this misconfiguration in real
      // deployments — see SessionDO callsites which always thread it.
    } else {
      const mcpBinding = env.mcpBinding;
      const tenantId = env.tenantId;
      const sessionId = env.sessionId;
      for (const server of agentConfig.mcp_servers) {
        if (!server.url) {
          // stdio MCP whose sandbox-side spawn hasn't recorded a URL yet
          // (warmup hasn't run, or spawn failed). Skip silently — re-attempt
          // when the next buildTools fires after warmup.
          continue;
        }
        const serverName = server.name;
        let timeoutHandle!: ReturnType<typeof setTimeout>;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error(`MCP setup timed out after ${MCP_SETUP_TIMEOUT_MS}ms`)),
            MCP_SETUP_TIMEOUT_MS,
          );
        });
        // Custom fetch the SDK calls for every MCP request. We stamp
        // routing metadata and hand the Request to main; main does the
        // credential injection + upstream fetch and returns the Response
        // verbatim (streaming).
        const proxyFetch: typeof globalThis.fetch = (input, init) => {
          const req = new Request(input, init);
          req.headers.set("x-oma-tenant", tenantId);
          req.headers.set("x-oma-session", sessionId);
          req.headers.set("x-oma-mcp-server", serverName);
          return mcpBinding.fetch(req);
        };
        try {
          const mcpClient = await Promise.race([
            experimental_createMCPClient({
              transport: {
                type: "http",
                url: server.url,
                fetch: proxyFetch,
              },
              name: "oma-cloud-agent",
            }),
            timeoutPromise,
          ]);
          const remoteTools = await Promise.race([
            mcpClient.tools(),
            timeoutPromise,
          ]);
          for (const [toolName, t] of Object.entries(remoteTools)) {
            tools[`mcp__${server.name}__${toolName}`] = t;
          }
        } catch (err) {
          // Connection / handshake / tools/list failure for one server
          // (e.g. main worker unreachable, vault credential missing,
          // upstream MCP server down, our timeout fired). Log + skip so
          // a single misconfiguration doesn't take the whole turn down.
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `[mcp] cloud MCP setup failed for "${server.name}" (${server.url}): ${msg}`,
          );
        } finally {
          clearTimeout(timeoutHandle);
        }
      }
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

  // Built-in general sub-agent tool — opt-in via
  // agentConfig.enable_general_subagent. Reserved id "general" routes
  // to a synthesized config in runSubAgent (apps/agent/src/runtime/
  // session-do.ts), so the user doesn't need to pre-create + add a
  // sub-agent to the callable_agents roster. Inherits this agent's
  // model + sandbox; runs with a generic system prompt and a safe
  // built-in toolset (no schedule, no further delegate, no MCP).
  if (agentConfig.enable_general_subagent && env?.delegateToAgent) {
    tools.general_subagent = tool({
      description:
        "Delegate a focused, well-scoped sub-task to a fresh general sub-agent. " +
        "The sub-agent runs in an isolated thread with its own conversation history " +
        "and returns a single text response when done. Use for: research, code " +
        "exploration, file scanning, batch operations — anything you want a clean " +
        "context for. The sub-agent shares this agent's sandbox + model but cannot " +
        "delegate further or use MCP tools.",
      inputSchema: z.object({
        task: z
          .string()
          .describe(
            "The task description for the sub-agent. Be specific about what to " +
              "produce — the sub-agent gets only this string and returns text.",
          ),
      }),
      execute: safe(async ({ task }) => {
        if (!env?.delegateToAgent) {
          return "general sub-agent unavailable: no thread executor configured";
        }
        try {
          return await env.delegateToAgent("general", task);
        } catch (e) {
          return `general sub-agent error: ${e instanceof Error ? e.message : String(e)}`;
        }
      }),
    });
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

// Memory store integration: per the Anthropic Managed Agents Memory contract
// (https://platform.claude.com/docs/en/managed-agents/memory), agents do NOT
// get bespoke memory_* tools. Each attached store is mounted as a directory
// under /mnt/memory/<store_name>/ in the sandbox, and the agent reads/writes
// it with the standard file tools above (bash/read/write/edit/glob/grep).
// The mount itself is set up in apps/agent/src/runtime/resource-mounter.ts.
// Audit / version rows are produced asynchronously via R2 Event Notifications
// → Queue → consumer at apps/main/src/queue/memory-events.ts.
