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
// What "good" looks like:
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
} from "@open-managed-agents/shared";

// ---- env ----
// Two auth modes:
//   1. ANTHROPIC_API_KEY (sk-ant-...) → standard x-api-key against api.anthropic.com
//   2. PROBE_AUTH_TOKEN + PROBE_BASE_URL → bearer auth against a custom proxy
//
// We deliberately ignore inherited ANTHROPIC_AUTH_TOKEN/BASE_URL because
// Claude Code's defaults point at platform-api.xaminim.com, which speaks a
// different protocol than Anthropic's Messages API and returns "Invalid
// JSON response" on direct ai-sdk calls. To probe through that proxy,
// re-export them as PROBE_* explicitly.
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

// Empty — direct providers (api.minimaxi.com, api.anthropic.com) don't
// require any X-Sub-Module or X-From routing headers. Only the company
// proxy (platform-api.xaminim.com) does.
const PROBE_HEADERS: Record<string, string> = {};

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

// ---- runtime ----
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

// ---- ctx ----
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
  } as Record<string, unknown>,
};

const SYSTEM_AUTHENTICATED_GUIDANCE =
  "For commands that may require authentication, prefer issuing a single command instead of a chained shell command. If an authenticated chained command fails, retry with a simpler single-command form.";
const systemPrompt = `${agent.system}\n\n${SYSTEM_AUTHENTICATED_GUIDANCE}`;

const baseCtx: Omit<HarnessContext, "userMessage"> = {
  agent: agent as AgentConfig,
  tools,
  model,
  systemPrompt,
  rawSystemPrompt: agent.system!,
  platformReminders,
  env: {
    ANTHROPIC_API_KEY: apiKey ?? probeToken ?? "",
  } as any,
  runtime,
};

// ---- run ----
// Tool-driving questions: each prompt explicitly forces a bash or
// mcp_github_call invocation so the ~5KB stub outputs accumulate fast and
// we hit the 0.10 trigger fraction before turn 16.
const QUESTIONS = [
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

async function main() {
  const harness = new DefaultHarness();

  console.log(`Model: ${(model as any).modelId}`);
  console.log(`System prompt: ${systemPrompt.length} chars`);
  console.log(`Tools: ${Object.keys(tools).join(", ")}`);
  console.log(`Skill reminders: ${platformReminders.length}`);
  console.log("---");

  // session-init: write skill/memory reminders into history (cached prefix)
  await harness.onSessionInit?.(baseCtx as HarnessContext, runtime);

  let totalIn = 0, totalOut = 0, totalRead = 0, totalCreate = 0;

  for (let i = 0; i < QUESTIONS.length; i++) {
    const userEvent: SessionEvent = {
      type: "user.message",
      content: [{ type: "text", text: QUESTIONS[i] }],
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

    const tools_used = eventLog
      .filter((e) => e.type === "agent.tool_use" || e.type === "agent.mcp_tool_use" || e.type === "agent.custom_tool_use")
      .length;
    const compactions = eventLog.filter((e) => e.type === "agent.thread_context_compacted");

    console.log(
      `Turn ${i + 1} (${elapsed}ms): in=${inp} out=${out} cache_read=${cacheRead} cache_create=${cacheCreate}  tools_called_so_far=${tools_used} compactions=${compactions.length}`,
    );
  }

  console.log("---");
  console.log(`TOTAL: in=${totalIn} out=${totalOut} cache_read=${totalRead} cache_create=${totalCreate}`);
  const reuseRatio = totalIn > 0 ? (totalRead / totalIn).toFixed(2) : "n/a";
  console.log(`Cache reuse ratio: ${reuseRatio} (cache_read / input_tokens — higher is better)`);
  console.log(`Total events captured: ${eventLog.length}`);

  // Quick verdict
  if (totalRead === 0) {
    console.log("\nVERDICT: cache_read stayed 0 across all turns. The prefix is drifting somewhere.");
  } else if (totalRead > totalCreate) {
    console.log("\nVERDICT: cache reuse > cache writes. Cache is working.");
  } else {
    console.log("\nVERDICT: some cache reuse but lower than write. Could be a short prefix; try more turns.");
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
