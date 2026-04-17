import type { SSEEvent } from "./types.js";

// ---- Config ----

const API_URL = process.env.OMA_API_URL || "http://localhost:8787";
const API_KEY = process.env.OMA_API_KEY || "test-key";

const headers: Record<string, string> = {
  "x-api-key": API_KEY,
  "Content-Type": "application/json",
};

// ---- HTTP helpers ----

async function api(path: string, init?: RequestInit): Promise<Response> {
  const url = `${API_URL}${path}`;
  const controller = new AbortController();
  const timeoutMs = init?.method === "POST" ? 120_000 : 30_000; // POST needs more time (container cold start)
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      headers: { ...headers, ...init?.headers },
      signal: controller.signal,
    });
    if (!res.ok && res.status !== 409) {
      const body = await res.text().catch(() => "");
      throw new Error(`API ${init?.method || "GET"} ${path} → ${res.status}: ${body.slice(0, 500)}`);
    }
    return res;
  } catch (err: any) {
    if (err.name === "AbortError") {
      throw new Error(`API ${init?.method || "GET"} ${path} → timeout (30s)`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function post(path: string, body: unknown): Promise<any> {
  const res = await api(path, { method: "POST", body: JSON.stringify(body) });
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Failed to parse POST ${path} response: ${text.slice(0, 500)}`);
  }
}

async function get(path: string): Promise<any> {
  const res = await api(path);
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Failed to parse GET ${path} response: ${text.slice(0, 500)}`);
  }
}

async function del(path: string): Promise<void> {
  await api(path, { method: "DELETE" });
}

// ---- Agent CRUD ----

export async function createAgent(config: {
  name: string;
  system: string;
  model?: string;
  tools: unknown[];
  callable_agents?: unknown[];
}): Promise<string> {
  const data = await post("/v1/agents", {
    name: config.name,
    model: config.model || "claude-sonnet-4-6",
    system: config.system,
    tools: config.tools,
    callable_agents: config.callable_agents,
  });
  return data.id;
}

export async function deleteAgent(agentId: string): Promise<void> {
  await del(`/v1/agents/${agentId}`).catch(() => {});
}

// ---- Environment ----

let sharedEnvId: string | null = null;

export async function getOrCreateEnvironment(): Promise<string> {
  if (sharedEnvId) return sharedEnvId;

  const list = await get("/v1/environments");
  const envs = list.data || [];

  // Prefer a ready environment with sandbox-default binding (known to work)
  const defaultSandbox = envs.find(
    (e: any) => e.status === "ready" && e.sandbox_worker_name === "sandbox-default",
  );
  if (defaultSandbox) {
    sharedEnvId = defaultSandbox.id;
    console.log(`  Using environment: ${defaultSandbox.id} (${defaultSandbox.name})`);
    return sharedEnvId!;
  }

  // Fall back to any ready environment
  const ready = envs.find((e: any) => e.status === "ready");
  if (ready) {
    sharedEnvId = ready.id;
    console.log(`  Using environment: ${ready.id} (${ready.name})`);
    return sharedEnvId!;
  }

  const data = await post("/v1/environments", {
    name: `eval-default-${Date.now()}`,
    config: { type: "cloud", networking: { type: "unrestricted" } },
  });
  sharedEnvId = data.id;
  console.log(`  Created environment: ${data.id} (will need build-complete callback)`);
  return sharedEnvId!;
}

// ---- Session CRUD ----

export async function createSession(agentId: string, envId: string): Promise<string> {
  const data = await post("/v1/sessions", {
    agent: agentId,
    environment_id: envId,
    title: `eval-${Date.now()}`,
  });
  const sessionId = data.id;

  // Pre-warm: send a trivial message to trigger container startup
  // This ensures subsequent eval messages don't hit cold start
  console.log(`    [warmup] Pre-warming sandbox...`);
  try {
    await postMessage(sessionId, "echo hello");
    const events = await waitForIdle(sessionId, 180_000); // 3 min max for cold start
    const hasError = events.some((e) => e.type === "session.error");
    if (hasError) {
      const errEvent = events.find((e) => e.type === "session.error");
      console.log(`    [warmup] Warning: warmup had error: ${JSON.stringify(errEvent).slice(0, 200)}`);
    } else {
      console.log(`    [warmup] Sandbox ready.`);
    }
  } catch (err: any) {
    console.log(`    [warmup] Warning: warmup failed: ${err.message?.slice(0, 100)}`);
  }

  return sessionId;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await del(`/v1/sessions/${sessionId}`).catch(() => {});
}

// ---- Message posting ----

export async function postMessage(sessionId: string, text: string): Promise<void> {
  // POST may take a long time (container cold start + LLM inference).
  // Use a generous timeout — the server responds only after the full turn completes.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300_000); // 5 min
  try {
    const url = `${API_URL}/v1/sessions/${sessionId}/events`;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        events: [
          {
            type: "user.message",
            content: [{ type: "text", text }],
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`POST events → ${res.status}: ${body.slice(0, 300)}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

// ---- Event collection ----

export async function getEvents(sessionId: string, afterSeq?: number): Promise<SSEEvent[]> {
  let path = `/v1/sessions/${sessionId}/events?limit=1000&order=asc`;
  if (afterSeq !== undefined) path += `&after_seq=${afterSeq}`;
  const res = await api(path);
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Failed to parse events response: ${text.slice(0, 500)}`);
  }
  return (data.data || []).map((e: any) => {
    const parsed = typeof e.data === "string" ? JSON.parse(e.data) : e.data || e;
    return { ...parsed, _seq: e.seq };
  });
}

// ---- Wait for idle ----

export async function waitForIdle(
  sessionId: string,
  timeoutMs: number = 600_000,
  pollIntervalMs: number = 3_000,
  afterSeq: number = 0,
): Promise<SSEEvent[]> {
  const start = Date.now();
  let lastSeq = afterSeq;
  const allEvents: SSEEvent[] = [];

  while (Date.now() - start < timeoutMs) {
    let events: SSEEvent[];
    try {
      events = await getEvents(sessionId, lastSeq);
    } catch (err: any) {
      // Transient fetch errors — retry after interval
      console.log(`    [poll] fetch error (retrying): ${err.message?.slice(0, 100)}`);
      await sleep(pollIntervalMs);
      continue;
    }

    for (const e of events) {
      allEvents.push(e);
      if ((e as any)._seq) lastSeq = (e as any)._seq;
    }

    // Check for terminal states
    const hasIdle = events.some((e) => e.type === "session.status_idle");
    const hasError = events.some((e) => e.type === "session.error");
    const hasTerminated = events.some((e) => e.type === "session.status_terminated");

    if (hasIdle || hasError || hasTerminated) {
      return allEvents;
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(`Timeout waiting for session ${sessionId} to become idle (${timeoutMs}ms)`);
}

// ---- Convenience: send message and wait ----

export async function sendAndWait(
  sessionId: string,
  message: string,
  timeoutMs?: number,
): Promise<SSEEvent[]> {
  // Snapshot current event count so we only look at NEW events after our message
  let beforeEvents: SSEEvent[] = [];
  try {
    beforeEvents = await getEvents(sessionId);
  } catch {}
  const lastSeqBefore = beforeEvents.length > 0
    ? Math.max(...beforeEvents.map((e) => (e as any)._seq || 0))
    : 0;

  // Fire the POST but don't wait for it to complete
  const postPromise = postMessage(sessionId, message).catch((err) => {
    console.log(`    [post] POST returned error (may still be processing): ${err.message?.slice(0, 100)}`);
  });

  // Give the server a moment to accept the event
  await sleep(2000);

  // Poll for idle/error/terminated — only looking at events AFTER our message
  const events = await waitForIdle(sessionId, timeoutMs || 600_000, 3_000, lastSeqBefore);

  await postPromise;
  return events;
}

// ---- Setup files via agent ----

export async function setupFiles(
  sessionId: string,
  files: Array<{ path: string; content: string }>,
): Promise<void> {
  if (files.length === 0) return;

  // Build a message asking the agent to create files
  const fileInstructions = files
    .map(
      (f) =>
        `Create the file ${f.path} with exactly this content:\n\`\`\`\n${f.content}\n\`\`\``,
    )
    .join("\n\n");

  const message = `Create the following files exactly as specified. Do not modify the content. Do not add any extra files.\n\n${fileInstructions}`;

  await sendAndWait(sessionId, message);
}

// ---- Cleanup helper ----

export interface CleanupHandle {
  agentIds: string[];
  sessionIds: string[];
}

export async function cleanup(handle: CleanupHandle): Promise<void> {
  for (const sid of handle.sessionIds) {
    await deleteSession(sid);
  }
  for (const aid of handle.agentIds) {
    await deleteAgent(aid);
  }
}

// ---- Eval Judge (Layer 2) — independent LLM judgment, NOT platform outcome ----

const JUDGE_API_URL = process.env.OMA_JUDGE_API_URL || "https://api.minimaxi.com/anthropic/v1";
const JUDGE_API_KEY = process.env.OMA_JUDGE_API_KEY || process.env.OMA_API_KEY || "";
const JUDGE_MODEL = process.env.OMA_JUDGE_MODEL || "MiniMax-M2.7";

export async function judge(
  events: SSEEvent[],
  rubric: string,
): Promise<{ result: "pass" | "fail"; reasoning: string }> {
  // Build transcript from session events
  const transcript = events
    .filter((e) =>
      ["agent.tool_use", "agent.tool_result", "agent.message", "session.error"].includes(e.type),
    )
    .map((e) => {
      if (e.type === "agent.tool_use")
        return `[tool] ${e.name}(${JSON.stringify(e.input).slice(0, 300)})`;
      if (e.type === "agent.tool_result")
        return `[result] ${String(e.content).slice(0, 500)}`;
      if (e.type === "agent.message") {
        const text = Array.isArray(e.content)
          ? (e.content as any[])
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text)
              .join("")
          : String(e.content);
        return `[agent] ${text.slice(0, 300)}`;
      }
      if (e.type === "session.error") return `[error] ${(e as any).error}`;
      return "";
    })
    .filter(Boolean)
    .join("\n");

  const prompt = `You are a test suite judge evaluating whether an AI agent completed a task correctly.

## Rubric
${rubric}

## Session Transcript
${transcript}

## Instructions
Evaluate whether ALL rubric criteria are satisfied. Respond with ONLY a JSON object, no other text:
{"result": "pass", "reasoning": "..."}
or
{"result": "fail", "reasoning": "..."}`;

  try {
    const res = await fetch(`${JUDGE_API_URL}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": JUDGE_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = (await res.json()) as any;
    const text = data.content?.[0]?.text || "";
    const match = text.match(/\{[\s\S]*?\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return {
        result: parsed.result === "pass" ? "pass" : "fail",
        reasoning: parsed.reasoning || "",
      };
    }
    return { result: "fail", reasoning: `Could not parse judge response: ${text.slice(0, 200)}` };
  } catch (err: any) {
    return { result: "fail", reasoning: `Judge call failed: ${err.message?.slice(0, 100)}` };
  }
}

// ---- Utility ----

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { API_URL, API_KEY };
