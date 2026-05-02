import type { SSEEvent } from "./types.js";

// ---- Config ----

const API_URL = process.env.OMA_API_URL || "http://localhost:8787";
const API_KEY = process.env.OMA_API_KEY || "test-key";

const headers: Record<string, string> = {
  "x-api-key": API_KEY,
  "Content-Type": "application/json",
};

// ---- HTTP helpers ----

const API_MAX_RETRIES = 10;
const API_BASE_DELAY = 2000;

function isTransientApiError(err: any, status?: number): boolean {
  if (status !== undefined) {
    return status === 429 || status === 529 || (status >= 500 && status < 600);
  }
  const msg = (err?.message || String(err) || "").toLowerCase();
  return /timeout|abort|econnreset|fetch failed|network|socket hang up/.test(msg);
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  const url = `${API_URL}${path}`;
  const method = init?.method || "GET";
  // POST mutates → wait long enough for slow start; GET is read-only +
  // idempotent (events / status / trajectory), so a long timeout has no
  // downside, and prod cold-cache GETs commonly take 30-60 s. Bumped from
  // 30 s after pilot wall time was inflated by repeat 30s timeouts +
  // exponential backoff on otherwise-healthy /events polls.
  const timeoutMs = method === "POST" ? 120_000 : 90_000;
  let lastErr: any;

  for (let attempt = 0; attempt <= API_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...init,
        headers: { ...headers, ...init?.headers },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok && res.status !== 409) {
        const body = await res.text().catch(() => "");
        const err = new Error(`API ${method} ${path} → ${res.status}: ${body.slice(0, 500)}`) as Error & { status?: number };
        err.status = res.status;
        if (isTransientApiError(err, res.status) && attempt < API_MAX_RETRIES) {
          lastErr = err;
        } else {
          throw err;
        }
      } else {
        return res;
      }
    } catch (err: any) {
      clearTimeout(timeout);
      const isTimeout = err.name === "AbortError";
      const wrapped = isTimeout
        ? new Error(`API ${method} ${path} → timeout (${timeoutMs}ms)`)
        : err;
      if (!isTransientApiError(wrapped, (err as any).status) || attempt >= API_MAX_RETRIES) throw wrapped;
      lastErr = wrapped;
    }

    const delay = Math.min(30_000, API_BASE_DELAY * Math.pow(2, attempt) * (0.75 + Math.random() * 0.5));
    console.log(`    [api:retry] ${method} ${path} attempt ${attempt + 1}/${API_MAX_RETRIES + 1} failed: ${(lastErr?.message || "").slice(0, 150)}; waiting ${Math.round(delay)}ms`);
    await new Promise(r => setTimeout(r, delay));
  }
  throw lastErr;
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
  mcp_servers?: unknown[];
  aux_model?: string;
}): Promise<string> {
  const data = await post("/v1/agents", {
    name: config.name,
    model: config.model || "claude-sonnet-4-6",
    system: config.system,
    tools: config.tools,
    callable_agents: config.callable_agents,
    mcp_servers: config.mcp_servers,
    aux_model: config.aux_model,
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
  return postBlocks(sessionId, [{ type: "text", text }]);
}

/**
 * Post a user.message containing arbitrary ContentBlock[] (text + document +
 * image). Lets tests exercise file_id references and multimodal payloads.
 */
export async function postBlocks(sessionId: string, content: unknown[]): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300_000);
  try {
    const url = `${API_URL}/v1/sessions/${sessionId}/events`;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        events: [{ type: "user.message", content }],
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

/**
 * Upload a file via POST /v1/files (JSON body). Returns the new file_id.
 * Used by EvalTask.setupUploads.
 */
export async function uploadFile(
  filename: string,
  content: string,
  media_type: string,
  encoding: "base64" | "utf8" = "base64",
): Promise<string> {
  const data = await post("/v1/files", {
    filename,
    content,
    media_type,
    encoding,
  });
  if (!data.id) throw new Error(`upload: no id in response: ${JSON.stringify(data).slice(0, 200)}`);
  return data.id as string;
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
  return sendBlocksAndWait(sessionId, [{ type: "text", text: message }], timeoutMs);
}

export async function sendBlocksAndWait(
  sessionId: string,
  content: unknown[],
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

  const postPromise = postBlocks(sessionId, content).catch((err) => {
    console.log(`    [post] POST returned error (may still be processing): ${err.message?.slice(0, 100)}`);
  });

  await sleep(2000);

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

const JUDGE_API_URL = process.env.OMA_JUDGE_API_URL || "https://api.example.com/anthropic/v1";
const JUDGE_API_KEY = process.env.OMA_JUDGE_API_KEY || process.env.OMA_API_KEY || "";
const JUDGE_MODEL = process.env.OMA_JUDGE_MODEL || "MiniMax-M2.7";
const JUDGE_MAX_RETRIES = 10;
const JUDGE_BASE_DELAY = 2000;
const JUDGE_TIMEOUT_MS = 60_000;

/** Wrapped fetch + parse with retry. Returns null only after all attempts exhausted. */
async function callJudgeWithRetry(prompt: string): Promise<string | null> {
  let lastErr = "";
  for (let attempt = 0; attempt <= JUDGE_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JUDGE_TIMEOUT_MS);
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
          messages: [{ role: "user", content: prompt }],
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        lastErr = `HTTP ${res.status}: ${body.slice(0, 200)}`;
        const transient = res.status === 429 || res.status === 529 || (res.status >= 500 && res.status < 600);
        if (!transient) return null;
      } else {
        const data = (await res.json()) as any;
        // Thinking models return [{thinking}, {text}] — must filter to text blocks
        const blocks = Array.isArray(data?.content) ? data.content : [];
        const text = blocks
          .filter((b: any) => b?.type === "text")
          .map((b: any) => b?.text || "")
          .join("")
          .trim();
        if (text) return text;
        lastErr = `empty response body (model=${data?.model || "?"} stop=${data?.stop_reason || "?"} blocks=${blocks.map((b: any) => b?.type).join(",") || "[]"})`;
      }
    } catch (err: any) {
      clearTimeout(timer);
      lastErr = err?.name === "AbortError" ? `timeout (${JUDGE_TIMEOUT_MS}ms)` : (err?.message || String(err));
    }

    if (attempt >= JUDGE_MAX_RETRIES) break;
    const delay = Math.min(30_000, JUDGE_BASE_DELAY * Math.pow(2, attempt) * (0.75 + Math.random() * 0.5));
    console.log(`    [judge:retry] attempt ${attempt + 1}/${JUDGE_MAX_RETRIES + 1} failed: ${lastErr.slice(0, 150)}; waiting ${Math.round(delay)}ms`);
    await new Promise(r => setTimeout(r, delay));
  }
  console.log(`    [judge:retry] exhausted ${JUDGE_MAX_RETRIES + 1} attempts: ${lastErr.slice(0, 200)}`);
  return null;
}

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
    const text = await callJudgeWithRetry(prompt);
    if (text === null) {
      return { result: "fail", reasoning: "Judge call failed after retries" };
    }
    // Retry on parse failure too — LLM sometimes wraps JSON in prose
    let parseAttempts = 3;
    let lastText = text;
    while (parseAttempts > 0) {
      const match = lastText.match(/\{[\s\S]*?\}/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          return {
            result: parsed.result === "pass" ? "pass" : "fail",
            reasoning: parsed.reasoning || "",
          };
        } catch {
          // fall through to retry
        }
      }
      parseAttempts--;
      if (parseAttempts === 0) break;
      console.log(`    [judge:parse-retry] response not parseable, re-asking (${parseAttempts} parse attempts left)`);
      const retryText = await callJudgeWithRetry(prompt + "\n\nIMPORTANT: respond with ONLY valid JSON, no prose.");
      if (retryText === null) break;
      lastText = retryText;
    }
    return { result: "fail", reasoning: `Could not parse judge response after retries: ${lastText.slice(0, 200)}` };
  } catch (err: any) {
    return { result: "fail", reasoning: `Judge call failed: ${err.message?.slice(0, 100)}` };
  }
}

// ---- Utility ----

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { API_URL, API_KEY };
