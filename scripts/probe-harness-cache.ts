// End-to-end harness probe: drive a multi-turn conversation through the
// real DefaultHarness (NOT bypassing it), with a fake MCP tool, a built-in
// bash tool stub, and skill `<system-reminder>` injection via onSessionInit.
//
// Captures every event the harness broadcasts. Each turn we report:
//   • span.model_request_end → cache_read / cache_create
//   • running totals across turns
//
// Run from repo root:
//   ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/probe-harness-cache.ts
//
// Modes (PROBE_MODE env var; default = text):
//   text       — current behavior: bash + mcp tool stubs only.
//   sub-agent  — adds a `call_agent_researcher` stub that injects
//                thread-tagged sub-session events (agent.message,
//                agent.tool_use, agent.tool_result) into the parent's
//                runtime BEFORE returning the response text. Faithfully
//                simulates SessionDO.runSubAgent: the parent's getEvents()
//                ends up with sub-session internal events, which derive()
//                walks unless the bijection filters them out.
//                Verdict signal: if cache_read drops to 0 on the turn
//                AFTER each call_agent_* return, the sub-session events
//                are polluting the parent's prefix.
//   multimodal — every other tool result is an `agent.tool_result` whose
//                content is a `ContentBlock[]` containing one TextBlock
//                and one base64 PNG image. Same probe loop; the goal is
//                that image bytes round-trip exactly through
//                normalizeToolOutputForWire ↔ wireContentToToolOutput so
//                cache_read keeps growing turn over turn.
//                Also exercises the cacheControl-on-image-tail edge case:
//                the last message of some turns ends with a tool_result
//                whose final block is an image.
//   all        — runs text → sub-agent → multimodal sequentially with
//                a fresh DefaultHarness + InMemoryHistory between each
//                so the per-mode totals are independent.
//
// Compaction strategy (PROBE_COMPACTION_STRATEGY env var; default = "summarize"):
//   summarize       — original strategy that reuses main agent's prefix
//                     (system + tools) on the summarize call. Cache-aware
//                     in design, but ai-sdk strips tools when toolChoice="none"
//                     so cache_read on the summarize call ends up at 0%.
//   cc-style        — Claude-Code-inspired isolated summarize call. Own
//                     short system, empty tools, no toolChoice, images
//                     stripped. Pays full input price on summarize but is
//                     robust across providers (no toolChoice quirks).
//   opencode-style  — OpenCode-inspired isolated summarize call. Same
//                     structure as cc-style with a Goal/Instructions/
//                     Discoveries/Accomplished/Files template instead of
//                     a free-form summary.
//
// What "good" looks like (per mode):
//   Turn 1: cache_create > 0  (writes the prefix)
//           cache_read   = 0
//   Turn 2: cache_create small  (just the new tail)
//           cache_read >= system_prompt_size + skill_reminder_size + tools
//   Turn 3+: cache_read keeps growing as more turns enter the cached prefix
//
// If cache_read stays 0: prefix bytes are drifting between turns. Likely
// suspects (in order): system field changed, tool order changed, or some
// content went through nondeterministic JSON.stringify.

import { tool } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { DefaultHarness } from "../apps/agent/src/harness/default-loop";
import { InMemoryHistory } from "../apps/agent/src/runtime/history";
import type { HarnessContext, HarnessRuntime } from "../apps/agent/src/harness/interface";
import type {
  SessionEvent,
  SpanModelRequestEndEvent,
  AgentConfig,
  ContentBlock,
} from "@open-managed-agents/shared";

// ---- mode ----
type ProbeMode = "text" | "sub-agent" | "multimodal" | "all";
const RAW_MODE = (process.env.PROBE_MODE ?? "text").toLowerCase();
if (!["text", "sub-agent", "multimodal", "all"].includes(RAW_MODE)) {
  console.error(`Unknown PROBE_MODE=${RAW_MODE}. Choose: text | sub-agent | multimodal | all`);
  process.exit(1);
}
const MODE = RAW_MODE as ProbeMode;

// ---- env ----
// Two auth modes:
//   1. ANTHROPIC_API_KEY (sk-ant-...) → standard x-api-key against api.anthropic.com
//   2. PROBE_AUTH_TOKEN + PROBE_BASE_URL → bearer auth against any
//      Anthropic-Messages-compatible endpoint
//
// We deliberately ignore inherited ANTHROPIC_AUTH_TOKEN/BASE_URL because
// some local setups point at a proxy that doesn't speak Anthropic's
// Messages API directly (returns "Invalid JSON response" on raw ai-sdk
// calls). To probe through that kind of endpoint, re-export the auth as
// PROBE_AUTH_TOKEN + PROBE_BASE_URL explicitly.
const apiKey = process.env.ANTHROPIC_API_KEY;
const probeToken = process.env.PROBE_AUTH_TOKEN;
const probeBase = process.env.PROBE_BASE_URL;

if (!apiKey && !probeToken) {
  console.error(
    "Set ANTHROPIC_API_KEY (sk-ant-...) for the standard endpoint, or PROBE_AUTH_TOKEN + PROBE_BASE_URL for a custom proxy.",
  );
  process.exit(1);
}
if (probeToken && !probeBase) {
  console.error("PROBE_AUTH_TOKEN set but PROBE_BASE_URL missing.");
  process.exit(1);
}

function parseHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    const out: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return Object.keys(out).length ? out : undefined;
  }
}

// Routing headers for the proxy. Empty by default — direct providers
// (api.anthropic.com and most Messages-API-compatible endpoints) don't
// require routing headers. Set PROBE_HEADERS env var (JSON object or
// `Header: Value\nHeader2: Value2` lines) to inject — required by some
// internal proxies that route on custom headers.
const PROBE_HEADERS: Record<string, string> = parseHeaders(process.env.PROBE_HEADERS) ?? {};

let reqIdx = 0;
const debugFetch: typeof fetch = async (input, init) => {
  // No beta stripping — testing whether X-From routes around the cache
  // bypass that hits when X-Sub-Module:claude-code-internal sees any beta.
  let cleanInit = init;
  if (cleanInit?.body && process.env.PROBE_DUMP_BODY === "1") {
    try {
      const body = typeof cleanInit.body === "string" ? cleanInit.body : "";
      const fs = await import("fs");
      fs.writeFileSync(`/tmp/probe-body-${reqIdx++}.json`, body);
    } catch {}
  }
  // No header stripping — opt out via providerOptions.anthropic.structuredOutputMode
  // = "jsonTool" passed to generateText below. ai-sdk only adds the
  // structured-outputs beta when supportsStructuredOutput && mode==="auto".
  if (cleanInit?.body && process.env.PROBE_DUMP === "1") {
    try {
      const body = typeof init.body === "string" ? init.body : "";
      const parsed = JSON.parse(body);
      const hash = (v: any) => {
        const s = JSON.stringify(v);
        let h = 0;
        for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
        return `len=${s.length} h=${h.toString(16)}`;
      };
      const slim = {
        system: hash(parsed.system),
        tools: hash(parsed.tools),
        msg_count: parsed.messages?.length,
        msg_hashes: parsed.messages?.map((m: any, i: number) => `${i}:${m.role}:${hash(m).split(" ")[1]}`),
      };
      console.log("\n[REQ]", JSON.stringify(slim));
      console.log("[URL]", typeof input === "string" ? input : (input as URL).toString());
      console.log("[HEADERS]", JSON.stringify(cleanInit.headers));
    } catch {}
  }
  return fetch(input, cleanInit);
};

const anthropic = createAnthropic(
  apiKey
    ? { apiKey, fetch: debugFetch, supportsNativeStructuredOutput: false } as any
    : {
        authToken: probeToken!,
        baseURL: probeBase,
        headers: PROBE_HEADERS,
        fetch: debugFetch,
        supportsNativeStructuredOutput: false,
      } as any,
);
const model = anthropic(process.env.PROBE_MODEL ?? "claude-sonnet-4-6");

// ---- tools (real shape, fake execution) ----
// Stub outputs are deliberately large (~5KB each). With CC-style defaults
// (min 10K-token tail, 40K max) the probe needs real volume in tool results
// to hit the trigger threshold within 16 turns.
const FAKE_FILE_LISTING = Array.from({ length: 100 }, (_, i) =>
  `-rw-r--r--  1 user  staff  ${(i * 137) % 9999}  Apr 22 ${(i % 23) + 1}:${(i * 7) % 60} module-${i.toString().padStart(3, "0")}.ts`,
).join("\n");

const FAKE_GREP_OUTPUT = Array.from({ length: 80 }, (_, i) =>
  `src/handlers/route-${i}.ts:${(i * 31) % 500 + 10}:  export async function handle${i}(req: Request, ctx: Context): Promise<Response> {`,
).join("\n");

const FAKE_GH_ISSUE_LIST = JSON.stringify(
  Array.from({ length: 30 }, (_, i) => ({
    number: 1000 + i,
    title: `Issue #${1000 + i}: investigate ${["latency", "memory leak", "cache miss", "auth bug"][i % 4]} in ${["worker", "do", "router", "queue"][i % 4]}`,
    state: "open",
    labels: ["bug", "p1", "needs-repro"],
    body: `Customer reports degraded performance in ${["us-east", "eu-west", "ap-south"][i % 3]} region starting around ${i + 1} days ago. Repro steps: spin up a fresh deploy, send 100 RPS for 5 min, observe p99 latency climb past 800ms. Expected: stays under 200ms. Logs attached.`,
  })),
  null,
  2,
);

// `bash` mimics a built-in tool. Returns ~5KB of canned output.
const bash = tool({
  description: "Execute a shell command (probe stub — returns canned output).",
  inputSchema: z.object({ command: z.string().describe("the shell command to run") }),
  execute: async ({ command }) => {
    if (/grep|rg|find/i.test(command)) {
      return `$ ${command}\n${FAKE_GREP_OUTPUT}\n\n[probe stub: 80 matches in 12 files]`;
    }
    return `$ ${command}\n${FAKE_FILE_LISTING}\n\n[probe stub: 100 entries]`;
  },
});

// `mcp_github_call` mimics an MCP-routed tool. Returns ~3KB JSON payload.
const mcpGithubCall = tool({
  description: "Call a GitHub MCP method (probe stub).",
  inputSchema: z.object({
    method: z.string().describe("the MCP method name (e.g. list_issues, get_pr)"),
    args: z.record(z.string(), z.any()).optional(),
  }),
  execute: async ({ method }) => {
    return JSON.stringify({ ok: true, method, fake: true, data: FAKE_GH_ISSUE_LIST });
  },
});

const tools = { bash, mcp_github_call: mcpGithubCall };

// ---- multimodal fixture ----
// Smallest valid PNG: 1x1 transparent pixel. Constant bytes — used as the
// image payload in multimodal-mode tool results so cache reuse across turns
// requires byte-perfect round-trip through normalize/wireContent.
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";

// ---- sub-agent fixture ----
// Stub `call_agent_researcher` that simulates SessionDO.runSubAgent: tags a
// sequence of sub-session events into the parent's runtime BEFORE returning.
// If the parent's eventsToMessages walks tagged events, every call here will
// add an unrelated assistant turn + tool round-trip to the parent's prefix
// → cache_read collapses on the next turn.
//
// `runtime` is bound at construction time so the tool can broadcast directly.
function makeCallAgentTool(rt: HarnessRuntime, threadCounter: { n: number }) {
  return tool({
    description:
      "Delegate a research question to the researcher sub-agent (probe stub).",
    inputSchema: z.object({
      message: z.string().describe("question to send to the sub-agent"),
    }),
    execute: async ({ message }) => {
      const threadId = `thread_probe_${threadCounter.n++}`;
      const tag = (e: SessionEvent) => ({ ...e, session_thread_id: threadId } as SessionEvent);
      // Mirrors SessionDO.runSubAgent (apps/agent/src/runtime/session-do.ts:1414):
      // sub-agent's broadcasts append a tagged copy of the same event into the
      // parent's history. Each event is the same `type` as a normal event —
      // only the extra `session_thread_id` field distinguishes it.
      rt.broadcast(tag({
        type: "session.thread_created",
        session_thread_id: threadId,
        agent_id: "researcher",
        agent_name: "researcher",
      } as any));
      rt.broadcast(tag({
        type: "agent.message",
        content: [{ type: "text", text: `[sub-agent] working on: ${message.slice(0, 80)}` }],
      }));
      rt.broadcast(tag({
        type: "agent.tool_use",
        id: `${threadId}_tc_grep`,
        name: "grep",
        input: { pattern: "TODO", path: "src/" },
      } as any));
      rt.broadcast(tag({
        type: "agent.tool_result",
        tool_use_id: `${threadId}_tc_grep`,
        content: FAKE_GREP_OUTPUT,
      } as any));
      rt.broadcast(tag({
        type: "agent.message",
        content: [{ type: "text", text: `[sub-agent] done. Found ${80} matches across files.` }],
      }));
      rt.broadcast(tag({
        type: "session.thread_idle",
        session_thread_id: threadId,
      } as any));
      // Return the response text — what the parent sees as the tool result.
      return `Researcher returned: 80 matches across the handlers tree (sample matches in trace).`;
    },
  });
}

// ---- multimodal fixture ----
// Tool stub that returns a `ContentBlock[]` with a text block + a base64 PNG.
// Built once per mode so the bytes are stable across turns. Default-loop's
// normalizeToolOutputForWire detects the pre-shaped ContentBlock[] and
// passes it through verbatim → wireContentToToolOutput on derive must
// reconstruct the same bytes for cache reuse.
function makeImageTool() {
  const imageBlock: ContentBlock = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: PNG_1X1_BASE64 },
  };
  return tool({
    description: "Render a chart and return [text-summary, image] (probe stub).",
    inputSchema: z.object({ caption: z.string().describe("short caption for the chart") }),
    // ai-sdk's strict typing forbids ContentBlock[] in `execute`'s declared
    // return; cast to any since default-loop normalizes via the wire shape.
    execute: async ({ caption }) =>
      [
        { type: "text", text: `Chart caption: ${caption}. Rendered 1x1 PNG below.` },
        imageBlock,
      ] as any,
  });
}

// ---- platformReminders (simulate skill metadata + memory) ----
const platformReminders = [
  {
    source: "skill:web-research",
    text: "When asked about current events, prefer the web_search tool over guessing. Always cite the URL you got the answer from.",
  },
  {
    source: "skill:github-ops",
    text: "Use mcp_github_call for any GitHub queries (issues, PRs, repo metadata). Do not invent issue numbers.",
  },
  {
    source: "memory:user_prefs",
    text: "User prefers responses under 3 sentences unless they explicitly ask for detail.",
  },
];

// ---- agent + systemPrompt (shared across modes; baked into cached prefix) ----
const agent: Partial<AgentConfig> = {
  id: "probe",
  name: "probe-agent",
  model: "claude-sonnet-4-6" as any,
  // ~80K char (~20K tokens) system prompt — close to real OMA agents.
  system: "You are a probe agent. Answer briefly. " +
    ("Be exhaustive in your reasoning. Be specific. Cite tools. Provide examples. ".repeat(1100)),
  // Probe knob: low trigger fraction so we actually hit shouldCompact()
  // within a 16-turn run. Real prod uses default 0.75. Tail params are CC
  // defaults (10K min / 40K max / 5 min msgs); override via metadata if you
  // want to probe with different numbers. 0.04 of 1M ctx = ~40K trigger,
  // which the bigger tool-stub outputs cross around turn 7-8.
  metadata: {
    compaction_trigger_fraction: process.env.PROBE_COMPACTION_TRIGGER
      ? Number(process.env.PROBE_COMPACTION_TRIGGER)
      : 0.04,
    // PROBE_COMPACTION_STRATEGY = "summarize" (default) | "cc-style"
    // | "opencode-style". DefaultHarness reads this from agent.metadata
    // and resolves the matching strategy class. Use this knob to A/B
    // the legacy cache-prefix-sharing strategy against the isolated
    // CC/OpenCode-style strategies.
    ...(process.env.PROBE_COMPACTION_STRATEGY
      ? { compaction_strategy: process.env.PROBE_COMPACTION_STRATEGY }
      : {}),
  } as Record<string, unknown>,
};

const SYSTEM_AUTHENTICATED_GUIDANCE =
  "For commands that may require authentication, prefer issuing a single command instead of a chained shell command. If an authenticated chained command fails, retry with a simpler single-command form.";
const systemPrompt = `${agent.system}\n\n${SYSTEM_AUTHENTICATED_GUIDANCE}`;

// ---- runtime + ctx (per mode) ----
// Each mode gets a fresh history, runtime, and tool set so the per-mode
// cache stats are independent. Module-level state used to be unique;
// supporting "all" mode forced extracting this into a builder.
function buildRunFor(mode: Exclude<ProbeMode, "all">) {
  const history = new InMemoryHistory();
  const eventLog: SessionEvent[] = [];
  const runtime: HarnessRuntime = {
    history: history as any,
    sandbox: {
      exec: async (cmd: string) => `[probe stub exec] ${cmd}`,
      readFile: async () => "",
      writeFile: async () => "",
    } as any,
    broadcast: (event: SessionEvent) => {
      history.append(event);
      eventLog.push(event);
    },
    reportUsage: async () => {},
    pendingConfirmations: [],
  };

  const threadCounter = { n: 0 };
  const modeTools: Record<string, any> = { bash, mcp_github_call: mcpGithubCall };
  if (mode === "sub-agent") {
    modeTools.call_agent_researcher = makeCallAgentTool(runtime, threadCounter);
  }
  if (mode === "multimodal") {
    modeTools.render_chart = makeImageTool();
  }

  const baseCtx: Omit<HarnessContext, "userMessage"> = {
    agent: agent as AgentConfig,
    tools: modeTools,
    model,
    systemPrompt,
    rawSystemPrompt: agent.system!,
    platformReminders,
    env: {
      ANTHROPIC_API_KEY: apiKey ?? probeToken ?? "",
    } as any,
    runtime,
  };

  return { history, eventLog, runtime, modeTools, baseCtx };
}

// ---- prompts (per mode) ----
// Tool-driving questions: each prompt explicitly forces a bash or
// mcp_github_call invocation so the ~5KB stub outputs accumulate fast and
// we hit the 0.10 trigger fraction before turn 16.
const QUESTIONS_TEXT = [
  "Run `ls -la src/` and tell me what you see in one sentence.",
  "Now grep for 'export async function handle' under src/handlers and report the top 3 matches.",
  "Use mcp_github_call to list_issues; then summarize the most common label in one sentence.",
  "Run `find . -name '*.ts'` and pick one filename that looks interesting — just one.",
  "Grep for 'import' in src/ and tell me how many imports total (one number).",
  "Use mcp_github_call to get_repo_meta; then say one thing about the repo in a sentence.",
  "Run `ls /etc` and pick one config file name.",
  "Now grep for 'TODO' under src/ and report the count.",
  "Use mcp_github_call to list_prs; tell me one PR title.",
  "Run `find /var/log -type f` and pick one log file.",
  "Grep for 'class ' in src/ and tell me one class name.",
  "Use mcp_github_call to list_issues for label=bug; tell me the issue count in one sentence.",
  "Run `ls /usr/local/bin` and pick one binary.",
  "Grep for 'function' under src/handlers and report top 3.",
  "Use mcp_github_call to get_workflow_runs; one sentence on status.",
  "Final summary: which tool did you use most, in one sentence.",
];

// Sub-agent mode: alternate normal tool calls with `call_agent_researcher`
// so we can compare cache_read on turns AFTER a sub-agent return vs
// turns AFTER a normal tool. If the parent's prefix gets polluted by
// sub-session events, cache_read will reset on every post-call_agent turn.
const QUESTIONS_SUBAGENT = [
  "Run `ls -la src/` and tell me what you see in one sentence.",
  "Use call_agent_researcher to investigate `TODO usage in src/`. Then in one sentence relay what they said.",
  "Now grep for 'export async function handle' under src/handlers; top 3 matches.",
  "Use call_agent_researcher to look up `routes registered in src/handlers/`. One-sentence relay.",
  "Use mcp_github_call to list_issues; the most common label in one sentence.",
  "Use call_agent_researcher to summarize `auth bug history`. One-sentence relay.",
  "Run `find . -name '*.ts'` and pick one interesting filename.",
  "Use call_agent_researcher to look at `class definitions in src/`. One sentence.",
  "Grep for 'import' in src/ and tell me how many imports total (one number).",
  "Use call_agent_researcher to research `latency reports`. One sentence.",
  "Use mcp_github_call to list_prs; one PR title.",
  "Use call_agent_researcher to scan `error handling patterns`. One sentence.",
  "Run `ls /etc` and pick one config file name.",
  "Use call_agent_researcher to look at `TODO under src/handlers/`. One sentence.",
  "Grep for 'function' under src/handlers and report top 3.",
  "Final summary: which tool did you use most often?",
];

// Multimodal mode: drive `render_chart` on alternating turns so half the
// turns end with a tool_result whose final block is a base64 image.
// Tests both: image-byte preservation (between turns) AND cache_control
// landing on a tail block that happens to be an image.
const QUESTIONS_MULTIMODAL = [
  "Run `ls -la src/` and tell me what you see in one sentence.",
  "Use render_chart with caption `latency p99 over 7d` and tell me one observation.",
  "Now grep for 'export async function handle' under src/handlers; top 3 matches.",
  "Use render_chart with caption `error rate vs deploy times` and one observation.",
  "Use mcp_github_call to list_issues; the most common label in one sentence.",
  "Use render_chart with caption `RPS by region` and tell me one observation.",
  "Run `find . -name '*.ts'` and pick one interesting filename.",
  "Use render_chart with caption `memory usage over hours` and one observation.",
  "Grep for 'import' in src/ and tell me how many imports total (one number).",
  "Use render_chart with caption `queue depth weekly` and one observation.",
  "Use mcp_github_call to list_prs; one PR title.",
  "Use render_chart with caption `cold-start ms by hour` and one observation.",
  "Run `ls /etc` and pick one config file name.",
  "Use render_chart with caption `cache hit ratio by route` and one observation.",
  "Grep for 'function' under src/handlers and report top 3.",
  "Final summary: what was the most informative chart, in one sentence.",
];

function questionsFor(mode: Exclude<ProbeMode, "all">): string[] {
  if (mode === "sub-agent") return QUESTIONS_SUBAGENT;
  if (mode === "multimodal") return QUESTIONS_MULTIMODAL;
  return QUESTIONS_TEXT;
}

// ---- per-mode runner ----
async function runMode(mode: Exclude<ProbeMode, "all">) {
  const { history, eventLog, runtime, modeTools, baseCtx } = buildRunFor(mode);
  const harness = new DefaultHarness();
  const questions = questionsFor(mode);

  console.log(`\n=== mode=${mode} ===`);
  console.log(`Model: ${(model as any).modelId}`);
  console.log(`System prompt: ${systemPrompt.length} chars`);
  console.log(`Tools: ${Object.keys(modeTools).join(", ")}`);
  console.log(`Skill reminders: ${platformReminders.length}`);
  console.log(`Compaction strategy: ${process.env.PROBE_COMPACTION_STRATEGY ?? "summarize (default)"}`);
  console.log("---");

  // session-init: write skill/memory reminders into history (cached prefix)
  await harness.onSessionInit?.(baseCtx as HarnessContext, runtime);

  let totalIn = 0, totalOut = 0, totalRead = 0, totalCreate = 0;
  // Per-turn tool/sub-agent markers — we annotate each turn with what kind
  // of return preceded it, so post-call_agent_* and post-image turns are
  // visually distinguishable in the per-turn cache log.
  const turnMarker = (ev: SessionEvent | undefined): string => {
    if (!ev) return "";
    if (ev.type === "agent.tool_use" && (ev as any).name?.startsWith?.("call_agent_")) {
      return " [post-call_agent]";
    }
    if (ev.type === "agent.tool_result") {
      const c = (ev as any).content;
      if (Array.isArray(c) && c.some((b: any) => b?.type === "image")) {
        return " [post-image-result]";
      }
    }
    return "";
  };

  for (let i = 0; i < questions.length; i++) {
    const userEvent: SessionEvent = {
      type: "user.message",
      content: [{ type: "text", text: questions[i] }],
    };
    history.append(userEvent);
    eventLog.push(userEvent);

    const t0 = Date.now();
    try {
      await harness.run({ ...baseCtx, userMessage: userEvent } as HarnessContext);
    } catch (err) {
      console.error(`turn ${i + 1} failed:`, (err as Error).message);
      break;
    }
    const elapsed = Date.now() - t0;

    // Find the latest span.model_request_end in the captured event log
    const lastSpan = [...eventLog]
      .reverse()
      .find((e) => e.type === "span.model_request_end") as SpanModelRequestEndEvent | undefined;
    const u = lastSpan?.model_usage;
    const inp = u?.input_tokens ?? 0;
    const out = u?.output_tokens ?? 0;
    const cacheRead = u?.cache_read_input_tokens ?? 0;
    const cacheCreate = u?.cache_creation_input_tokens ?? 0;
    totalIn += inp; totalOut += out; totalRead += cacheRead; totalCreate += cacheCreate;

    // Look one event back for the LAST tool-related event in this turn.
    const lastTurnEvent = [...eventLog].reverse().find(
      (e) => e.type === "agent.tool_use" || e.type === "agent.tool_result" || e.type === "agent.mcp_tool_result",
    );

    const tools_used = eventLog
      .filter((e) => e.type === "agent.tool_use" || e.type === "agent.mcp_tool_use" || e.type === "agent.custom_tool_use")
      .length;
    const compactions = eventLog.filter((e) => e.type === "agent.thread_context_compacted");
    const subThreadEvents = eventLog.filter((e) => (e as any).session_thread_id != null);

    console.log(
      `Turn ${i + 1} (${elapsed}ms): in=${inp} out=${out} cache_read=${cacheRead} cache_create=${cacheCreate}` +
      `  tools_called_so_far=${tools_used} sub_thread_evts=${subThreadEvents.length} compactions=${compactions.length}` +
      turnMarker(lastTurnEvent),
    );
  }

  console.log("---");
  console.log(`TOTAL[${mode}]: in=${totalIn} out=${totalOut} cache_read=${totalRead} cache_create=${totalCreate}`);
  const reuseRatio = totalIn + totalRead > 0 ? (totalRead / (totalIn + totalRead)).toFixed(2) : "n/a";
  console.log(`Cache reuse ratio: ${reuseRatio} (cache_read / (input_tokens + cache_read) — higher is better)`);
  console.log(`Total events captured: ${eventLog.length}`);

  // Quick verdict
  if (totalRead === 0) {
    console.log("\nVERDICT: cache_read stayed 0 across all turns. The prefix is drifting somewhere.");
  } else if (totalRead > totalCreate) {
    console.log("\nVERDICT: cache reuse > cache writes. Cache is working.");
  } else {
    console.log("\nVERDICT: some cache reuse but lower than write. Could be a short prefix; try more turns.");
  }

  // Mode-specific extra checks
  if (mode === "sub-agent") {
    // Identify the per-turn cache_read on the turn AFTER each call_agent_*.
    // If the parent's prefix gets polluted by sub-session events, those
    // post-call_agent turns will have cache_read collapse to ~0 while
    // non-sub-agent turns keep growing.
    const spanEvents = eventLog.filter((e) => e.type === "span.model_request_end") as SpanModelRequestEndEvent[];
    const callAgentEvents = eventLog.filter(
      (e) => e.type === "agent.tool_use" && (e as any).name?.startsWith?.("call_agent_"),
    );
    console.log(`\nSub-agent diagnostics:`);
    console.log(`  call_agent_* invocations: ${callAgentEvents.length}`);
    console.log(`  total tagged sub-session events injected: ${eventLog.filter((e) => (e as any).session_thread_id != null).length}`);
    if (spanEvents.length >= 2) {
      const last = spanEvents[spanEvents.length - 1].model_usage;
      const first = spanEvents[0].model_usage;
      console.log(`  first turn cache_read: ${first?.cache_read_input_tokens ?? 0}`);
      console.log(`  last turn cache_read:  ${last?.cache_read_input_tokens ?? 0}`);
      const lastReadIsZero = (last?.cache_read_input_tokens ?? 0) === 0;
      if (lastReadIsZero && callAgentEvents.length > 0) {
        console.log(`  WARNING: cache_read=0 on the last turn after sub-agent activity — check whether tagged events are polluting the parent's prefix.`);
      }
    }
  }

  if (mode === "multimodal") {
    const imageResults = eventLog.filter(
      (e) => e.type === "agent.tool_result" && Array.isArray((e as any).content) && (e as any).content.some((b: any) => b?.type === "image"),
    );
    console.log(`\nMultimodal diagnostics:`);
    console.log(`  image-bearing tool_result events: ${imageResults.length}`);
    console.log(`  PNG payload bytes per image: ${PNG_1X1_BASE64.length} chars (base64)`);
    if (imageResults.length === 0) {
      console.log(`  NOTE: model never invoked render_chart — probe didn't exercise image path. Try forcing it via prompt.`);
    }
  }

  // Compaction summary
  const compEvents = eventLog.filter((e) => e.type === "agent.thread_context_compacted") as Array<any>;
  if (compEvents.length > 0) {
    console.log(`\nCompactions fired: ${compEvents.length}`);
    for (let i = 0; i < compEvents.length; i++) {
      const c = compEvents[i];
      const summaryText = c.summary?.map((b: any) => b.type === "text" ? b.text : "").join(" ") || "";
      console.log(`  #${i + 1} pre_tokens=${c.pre_tokens}  msgs ${c.original_message_count}→${c.compacted_message_count}  summary_len=${summaryText.length} chars`);
      console.log(`     summary[0..200]: ${summaryText.slice(0, 200)}${summaryText.length > 200 ? "…" : ""}`);

      // Find the dedicated summarize-span event for this compaction.
      // The strategy broadcasts span.compaction_summarize_end right before
      // it returns the result; that result is then turned into the
      // boundary event we're inspecting now. So the latest
      // compaction_summarize_end before this compaction event is ours.
      const compIdx = eventLog.indexOf(c);
      let summarizeSpan: any;
      for (let j = compIdx - 1; j >= 0; j--) {
        if (eventLog[j].type === "span.compaction_summarize_end") {
          summarizeSpan = eventLog[j];
          break;
        }
      }
      if (summarizeSpan?.model_usage) {
        const u = summarizeSpan.model_usage;
        const totalIn = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        const reuse = totalIn > 0 ? ((u.cache_read_input_tokens ?? 0) / totalIn).toFixed(2) : "n/a";
        console.log(`     summarize call: in=${u.input_tokens ?? 0} out=${u.output_tokens ?? 0} cache_read=${u.cache_read_input_tokens ?? 0} cache_create=${u.cache_creation_input_tokens ?? 0} reuse=${reuse} finish=${summarizeSpan.finish_reason} text_len=${summarizeSpan.final_text_length}`);
      } else {
        console.log(`     summarize call: no span event found`);
      }
    }
  } else {
    console.log("\nNo compactions fired (didn't cross trigger threshold).");
  }
}

async function main() {
  const modes: Array<Exclude<ProbeMode, "all">> =
    MODE === "all" ? ["text", "sub-agent", "multimodal"] : [MODE];
  for (const m of modes) {
    await runMode(m);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
