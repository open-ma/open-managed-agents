/**
 * Local provider chaos lab.
 *
 * This is intentionally an opt-in, Node-only runner. It starts a temporary
 * OpenMA main-node process, points its model traffic at a deterministic local
 * Anthropic-compatible server, and exercises the configured SandboxPort
 * adapter (Daytona, LiteBox, or BoxRun) through the public session API.
 *
 * The lab does not emulate a provider. A configured provider is called for
 * real; only the LLM is local and deterministic. This makes it useful for
 * adapter conformance and crash/restart drills without accidentally spending
 * model credits. Provider credentials are inherited by the child process but
 * never printed.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import net from "node:net";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SUPPORTED_PROVIDERS = new Set(["daytona", "litebox", "boxrun"]);
const SECRET_ENV = /(key|token|secret|password|credential)/i;

/**
 * Resolve and validate the provider for this lab. The ordinary local
 * subprocess provider is deliberately excluded: this runner exists to make
 * configured external/provider adapters observable.
 */
export function parseProviderConfig(env = process.env) {
  const raw = env.OMA_CHAOS_PROVIDER ?? env.SANDBOX_PROVIDER;
  const provider = (raw ?? "").trim().toLowerCase().replace(/^boxlite$/, "litebox");
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw new Error(
      `OMA_CHAOS_PROVIDER must be one of daytona, litebox, boxrun (received ${raw ?? "<unset>"})`,
    );
  }

  if (provider === "daytona" && !env.DAYTONA_API_KEY) {
    throw new Error(
      "Daytona chaos requires DAYTONA_API_KEY; refusing to start without an explicit provider credential",
    );
  }
  if (provider === "boxrun" && !env.BOXRUN_URL) {
    throw new Error(
      "BoxRun chaos requires BOXRUN_URL; refusing to start without an explicit provider endpoint",
    );
  }

  return {
    provider,
    ...(provider === "daytona" && { apiUrl: env.DAYTONA_API_URL }),
    ...(provider === "boxrun" && { baseUrl: env.BOXRUN_URL }),
  };
}

/** Build the child process environment with isolated durable state. */
export function buildClusterEnv(baseEnv, options) {
  const root = resolve(options.root);
  const provider = options.provider.toLowerCase().replace(/^boxlite$/, "litebox");
  return {
    ...baseEnv,
    HOST: "127.0.0.1",
    PORT: String(options.port),
    AUTH_DISABLED: "1",
    API_KEY: "openma-chaos-api-key",
    DATABASE_PATH: join(root, "oma.db"),
    AUTH_DATABASE_PATH: join(root, "auth.db"),
    SANDBOX_WORKDIR: join(root, "sandboxes"),
    MEMORY_BLOB_DIR: join(root, "memory-blobs"),
    SESSION_OUTPUTS_DIR: join(root, "session-outputs"),
    FILES_BLOB_DIR: join(root, "files-blobs"),
    ANTHROPIC_API_KEY: "openma-chaos-local-key",
    ANTHROPIC_BASE_URL: options.llmBaseUrl.replace(/\/$/, ""),
    DREAM_CURATOR_MODE: "dedup",
    SANDBOX_PROVIDER: provider,
  };
}

/** Return a safe-to-print copy of an environment. */
export function redactEnvironment(env) {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      SECRET_ENV.test(key) ? "<redacted>" : value,
    ]),
  );
}

/**
 * Ordered fault plan. `provider-kill` is only present when an operator gives
 * an explicit kill URL; no destructive provider action is inferred.
 */
export function buildChaosPlan(provider, options = {}) {
  const plan = [
    {
      id: "healthy-turn",
      description: `${provider} adapter creates a sandbox and completes a turn`,
      fault: null,
    },
    {
      id: "crash-in-flight",
      description: "kill OpenMA while the model request is deliberately delayed",
      fault: "main-process-kill",
    },
    {
      id: "recovered-turn",
      description: "restart OpenMA with the same SQLite/event-log and complete a turn",
      fault: null,
    },
  ];
  if (options.providerKill) {
    plan.push({
      id: "provider-kill",
      description: `invoke the operator-supplied ${provider} kill endpoint`,
      fault: "provider-delete",
      optional: true,
    });
  }
  return plan;
}

function jsonResponse(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

function anthropicMessage(model, text, inputTokens = 12, outputTokens = 2) {
  return {
    id: "msg_openma_chaos",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

/**
 * Deterministic Anthropic Messages fixture. It supports both JSON and SSE,
 * delayed requests, one-shot HTTP failures, and request accounting. The
 * runner uses the delay to create a reliable in-flight crash window.
 */
export async function createMockLlmServer(options = {}) {
  const state = {
    delayMs: Number(options.delayMs ?? 0),
    delayNext: false,
    errorNext: null,
    toolRoundTrip: options.toolRoundTrip === true,
    requests: 0,
    aborted: 0,
  };

  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      jsonResponse(res, 200, { ok: true, requests: state.requests });
      return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      jsonResponse(res, 200, {
        data: [{ type: "model", id: "claude-chaos-local", display_name: "OpenMA chaos fixture" }],
        has_more: false,
      });
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/messages") {
      jsonResponse(res, 404, { type: "error", error: { type: "not_found", message: "not found" } });
      return;
    }

    state.requests += 1;
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    await new Promise((resolveRequest) => req.on("end", resolveRequest));
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch { /* malformed requests still get a protocol error */ }

    req.on("aborted", () => { state.aborted += 1; });
    const status = state.errorNext;
    state.errorNext = null;
    const delayMs = state.delayNext ? state.delayMs : 0;
    state.delayNext = false;
    if (delayMs > 0) await sleep(delayMs);
    if (res.destroyed) return;
    if (status) {
      jsonResponse(res, status, { type: "error", error: { type: "overloaded_error", message: "chaos fixture fault" } });
      return;
    }

    const model = typeof body.model === "string" ? body.model : "claude-chaos-local";
    const hasToolResult = /tool[_-]result/i.test(JSON.stringify(body.messages ?? []));
    const useTool = state.toolRoundTrip && !hasToolResult;
    const toolInput = { command: "printf CHAOS_SANDBOX_OK" };
    const message = useTool
      ? {
          ...anthropicMessage(model, ""),
          content: [{ type: "tool_use", id: "toolu_chaos", name: "bash", input: toolInput }],
          stop_reason: "tool_use",
        }
      : anthropicMessage(model, "CHAOS_OK");
    if (body.stream === true) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const send = (event, payload) => {
        if (!res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      };
      send("message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: message.usage } });
      if (useTool) {
        send("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_chaos", name: "bash", input: {} },
        });
        send("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(toolInput) },
        });
      } else {
        send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "CHAOS_OK" } });
      }
      send("content_block_stop", { type: "content_block_stop", index: 0 });
      send("message_delta", { type: "message_delta", delta: { stop_reason: useTool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: message.usage.output_tokens } });
      send("message_stop", { type: "message_stop" });
      res.end();
      return;
    }
    jsonResponse(res, 200, message);
  });

  await new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveServer);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object", "mock LLM did not bind");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    state,
    setFault(fault = {}) {
      if (fault.delayMs !== undefined) state.delayMs = Number(fault.delayMs);
      state.delayNext = fault.delayNext === true;
      state.errorNext = fault.status ?? null;
    },
    async close() {
      await new Promise((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePort);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

function spawnMainNode(env) {
  const child = spawn("pnpm", ["--filter", "@open-managed-agents/main-node", "start"], {
    cwd: REPO_ROOT,
    env,
    detached: process.platform !== "win32",
    stdio: "inherit",
  });
  const exited = new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  return { child, exited };
}

async function waitForHealth(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_500) });
      if (response.ok) return await response.json();
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`OpenMA health check timed out after ${timeoutMs}ms: ${lastError}`);
}

async function requestJson(baseUrl, path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "x-api-key": "openma-chaos-api-key",
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} failed (${response.status}): ${text.slice(0, 500)}`);
  }
  return body;
}

async function waitForEvents(baseUrl, sessionId, predicate, timeoutMs, afterSeq = -1) {
  const deadline = Date.now() + timeoutMs;
  let latest = [];
  while (Date.now() < deadline) {
    const page = await requestJson(
      baseUrl,
      `/v1/oma/sessions/${encodeURIComponent(sessionId)}/events?limit=500`,
      { headers: { accept: "application/json" } },
    );
    latest = Array.isArray(page?.data) ? page.data : [];
    const relevant = latest.filter((event) => Number(event.seq ?? -1) > afterSeq);
    if (predicate(relevant, latest)) return { relevant, all: latest };
    await sleep(300);
  }
  throw new Error(`Timed out waiting for session events; observed ${latest.map((e) => e.type).join(", ")}`);
}

async function waitForSessionStatus(baseUrl, sessionId, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let observed = "unknown";
  while (Date.now() < deadline) {
    const session = await requestJson(
      baseUrl,
      `/v1/oma/sessions/${encodeURIComponent(sessionId)}`,
      { headers: { accept: "application/json" } },
    );
    observed = session?.status ?? "unknown";
    if (observed === expected) return session;
    await sleep(300);
  }
  throw new Error(`Timed out waiting for session ${sessionId} status=${expected}; observed ${observed}`);
}

async function stopChild(runtime, signal = "SIGTERM") {
  if (!runtime || runtime.child.exitCode !== null) return await runtime?.exited;
  // `pnpm start` is a wrapper around tsx. Kill the whole detached process
  // group or the tsx child would survive the drill and continue writing the
  // same event log after the supposed crash.
  if (process.platform !== "win32" && runtime.child.pid) {
    try { process.kill(-runtime.child.pid, signal); } catch { runtime.child.kill(signal); }
  } else {
    runtime.child.kill(signal);
  }
  const timeout = sleep(10_000).then(() => ({ timeout: true }));
  return Promise.race([runtime.exited, timeout]);
}

async function invokeProviderKill(env, provider) {
  const endpoint = env.OMA_CHAOS_PROVIDER_KILL_URL;
  if (!endpoint) return { skipped: true, reason: "OMA_CHAOS_PROVIDER_KILL_URL is not set" };
  const response = await fetch(endpoint, {
    method: env.OMA_CHAOS_PROVIDER_KILL_METHOD ?? "DELETE",
    headers: env.OMA_CHAOS_PROVIDER_KILL_TOKEN
      ? { authorization: `Bearer ${env.OMA_CHAOS_PROVIDER_KILL_TOKEN}` }
      : undefined,
  });
  if (!response.ok) {
    throw new Error(`${provider} kill endpoint returned HTTP ${response.status}`);
  }
  return { skipped: false, status: response.status };
}

/** Run the complete local lab. Returns a JSON-safe report for CI/logging. */
export async function runProviderChaos(options = {}) {
  const inherited = options.env ?? process.env;
  const config = parseProviderConfig(inherited);
  const root = options.root ?? await mkdtemp(join(tmpdir(), "openma-provider-chaos-"));
  const keepData = options.keepData ?? inherited.OMA_CHAOS_KEEP_DATA === "1";
  const healthTimeoutMs = Number(options.healthTimeoutMs ?? inherited.OMA_CHAOS_HEALTH_TIMEOUT_MS ?? 60_000);
  const turnTimeoutMs = Number(options.turnTimeoutMs ?? inherited.OMA_CHAOS_TURN_TIMEOUT_MS ?? 60_000);
  const basePort = Number(options.port ?? inherited.OMA_CHAOS_PORT ?? await getFreePort());
  const llm = await createMockLlmServer({
    delayMs: Number(inherited.OMA_CHAOS_LLM_DELAY_MS ?? 15_000),
    toolRoundTrip: true,
  });
  const baseUrl = `http://127.0.0.1:${basePort}`;
  const childEnv = buildClusterEnv(inherited, {
    root,
    port: basePort,
    provider: config.provider,
    llmBaseUrl: llm.baseUrl,
  });
  const report = {
    provider: config.provider,
    root,
    baseUrl,
    llmBaseUrl: llm.baseUrl,
    steps: [],
    providerKill: null,
  };
  let runtime = null;
  let agentId;
  let environmentId;
  let sessionId;

  try {
    report.steps.push({ id: "healthy-turn", status: "running" });
    runtime = spawnMainNode(childEnv);
    await waitForHealth(baseUrl, healthTimeoutMs);

    const agent = await requestJson(baseUrl, "/v1/oma/agents", {
      method: "POST",
      body: JSON.stringify({
        name: `provider-chaos-${config.provider}`,
        model: "claude-chaos-local",
        system: "Reply with the exact marker returned by the local fixture.",
        harness: "default",
        tools: [],
      }),
    });
    agentId = agent.id;
    const environment = await requestJson(baseUrl, "/v1/oma/environments", {
      method: "POST",
      body: JSON.stringify({ name: `provider-chaos-${config.provider}`, config: { type: "cloud" } }),
    });
    environmentId = environment.id;
    const session = await requestJson(baseUrl, "/v1/oma/sessions", {
      method: "POST",
      body: JSON.stringify({ agent: agentId, environment_id: environmentId, title: "provider chaos" }),
    });
    sessionId = session.id;

    llm.setFault({ delayMs: 0 });
    await requestJson(baseUrl, `/v1/oma/sessions/${encodeURIComponent(sessionId)}/events`, {
      method: "POST",
      body: JSON.stringify({ events: [{ type: "user.message", content: [{ type: "text", text: "healthy" }] }] }),
    });
    const healthy = await waitForEvents(
      baseUrl,
      sessionId,
      (relevant) => relevant.some((event) => event.type === "agent.message"),
      turnTimeoutMs,
    );
    await waitForSessionStatus(baseUrl, sessionId, "idle", turnTimeoutMs);
    assert.ok(
      healthy.relevant.some((event) => event.type === "agent.tool_use") &&
        healthy.relevant.some((event) => event.type === "agent.tool_result"),
      "healthy turn did not execute the fixture's sandbox tool round trip",
    );
    assert.ok(JSON.stringify(healthy.relevant).includes("CHAOS_OK"), "healthy turn did not contain fixture marker");
    report.steps[0] = { id: "healthy-turn", status: "passed", eventTypes: healthy.relevant.map((event) => event.type) };

    const beforeCrash = healthy.all.reduce((max, event) => Math.max(max, Number(event.seq ?? -1)), -1);
    report.steps.push({ id: "crash-in-flight", status: "running" });
    llm.setFault({ delayMs: Number(inherited.OMA_CHAOS_LLM_DELAY_MS ?? 15_000), delayNext: true });
    await requestJson(baseUrl, `/v1/oma/sessions/${encodeURIComponent(sessionId)}/events`, {
      method: "POST",
      body: JSON.stringify({ events: [{ type: "user.message", content: [{ type: "text", text: "crash while model is pending" }] }] }),
    });
    await waitForSessionStatus(baseUrl, sessionId, "running", Math.min(15_000, turnTimeoutMs));
    const killed = await stopChild(runtime, "SIGKILL");
    runtime = null;
    report.steps[1] = {
      id: "crash-in-flight",
      status: "passed",
      process: killed,
      fixtureAbortedRequests: llm.state.aborted,
    };

    report.steps.push({ id: "recovered-turn", status: "running" });
    runtime = spawnMainNode(childEnv);
    await waitForHealth(baseUrl, healthTimeoutMs);
    await waitForSessionStatus(baseUrl, sessionId, "idle", turnTimeoutMs);
    const afterRestart = await waitForEvents(
      baseUrl,
      sessionId,
      () => true,
      2_000,
      beforeCrash,
    );
    const recoverySeq = afterRestart.all.reduce((max, event) => Math.max(max, Number(event.seq ?? -1)), -1);
    llm.setFault({ delayMs: 0 });
    await requestJson(baseUrl, `/v1/oma/sessions/${encodeURIComponent(sessionId)}/events`, {
      method: "POST",
      body: JSON.stringify({ events: [{ type: "user.message", content: [{ type: "text", text: "recovered" }] }] }),
    });
    const recovered = await waitForEvents(
      baseUrl,
      sessionId,
      (relevant) => relevant.some((event) => event.type === "agent.message"),
      turnTimeoutMs,
      recoverySeq,
    );
    await waitForSessionStatus(baseUrl, sessionId, "idle", turnTimeoutMs);
    assert.ok(JSON.stringify(recovered.relevant).includes("CHAOS_OK"), "recovered turn did not contain fixture marker");
    report.steps[2] = {
      id: "recovered-turn",
      status: "passed",
      eventTypes: recovered.relevant.map((event) => event.type),
      orphanRecoveryEvents: afterRestart.relevant.map((event) => event.type),
    };

    if (inherited.OMA_CHAOS_PROVIDER_KILL_URL) {
      report.steps.push({ id: "provider-kill", status: "running", optional: true });
      report.providerKill = await invokeProviderKill(inherited, config.provider);
      report.steps.at(-1).status = "passed";
    } else {
      report.providerKill = { skipped: true, reason: "no explicit provider kill URL" };
    }
    return report;
  } finally {
    await stopChild(runtime, "SIGTERM");
    await llm.close().catch(() => {});
    if (!keepData && !options.root) {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function main() {
  try {
    const report = await runProviderChaos();
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) await main();
