#!/usr/bin/env node

/**
 * Keyless, process-level certification of the public Node interfaces.
 *
 * The OpenMA server, isolated LiteBox sandbox, SDK, CLI and browser console are
 * all real. Only the upstream Anthropic endpoint is replaced with the
 * deterministic protocol fixture used by the provider chaos lab.
 */

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import { createMockLlmServer } from "./provider-chaos-cluster.mjs";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API_KEY = "openma-local-release-api-key";

export function buildLocalReleasePlan() {
  return [
    { id: "console-build", interface: "console" },
    { id: "main-node-start", interface: "node" },
    { id: "managed-agents-sdk", interface: "sdk" },
    { id: "managed-inputs-mcp", interface: "sdk+sandbox+mcp" },
    { id: "cli-projection", interface: "cli" },
    { id: "console-browser", interface: "console" },
  ];
}

/** Select product lanes without dropping their build/server prerequisites. */
export function selectLocalReleaseSteps(value) {
  const all = buildLocalReleasePlan().map(({ id }) => id);
  const requested = String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (requested.length === 0) return all;

  const known = new Set(all);
  for (const id of requested) {
    if (!known.has(id)) throw new Error(`Unknown local release lane: ${id}`);
  }
  const selected = new Set(["console-build", "main-node-start", ...requested]);
  return all.filter((id) => selected.has(id));
}

/**
 * Project a host-loopback fixture URL into the address space of the selected
 * local sandbox. BoxLite deliberately exposes host loopback through its own
 * DNS alias; 127.0.0.1 inside the VM is the VM itself.
 */
export function projectHostFixtureUrlForSandbox(value, provider) {
  if (provider !== "litebox" && provider !== "boxlite") return value;
  const url = new URL(value);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]") {
    url.hostname = "host.boxlite.internal";
  }
  return url.toString();
}

export function buildLocalReleaseEnvironment(baseEnv, options) {
  const root = resolve(options.root);
  return {
    ...baseEnv,
    HOST: "127.0.0.1",
    PORT: String(options.port),
    AUTH_DISABLED: "1",
    API_KEY: options.apiKey,
    PLATFORM_ROOT_SECRET: "openma-local-release-root-secret-32-bytes-minimum",
    DATABASE_PATH: join(root, "oma.db"),
    AUTH_DATABASE_PATH: join(root, "auth.db"),
    SANDBOX_WORKDIR: join(root, "sandboxes"),
    MEMORY_BLOB_DIR: join(root, "memory-blobs"),
    SESSION_OUTPUTS_DIR: join(root, "session-outputs"),
    FILES_BLOB_DIR: join(root, "files-blobs"),
    ANTHROPIC_API_KEY: "openma-local-release-model-key",
    ANTHROPIC_BASE_URL: options.llmBaseUrl.replace(/\/$/, ""),
    SANDBOX_PROVIDER: "litebox",
    SANDBOX_IMAGE: "node:22-bookworm",
    DREAM_CURATOR_MODE: "dedup",
    CONSOLE_DIR: join(options.repoRoot, "apps", "console", "dist"),
  };
}

export function hasMountedSkillReminder(requestBodies) {
  return requestBodies.some((body) =>
    String(JSON.stringify(body?.system) ?? "").includes(
      "/workspace/.openma/skills/",
    ));
}

export async function runLocalReleaseCertification(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const root = options.root ?? await mkdtemp(join(tmpdir(), "openma-local-release-"));
  const ownRoot = options.root === undefined;
  const port = options.port ?? await getFreePort();
  const llm = await createMockLlmServer({ responseText: "E2E_OK" });
  const repository = await createGitHttpFixture(root);
  const mcp = await createMcpHttpFixture();
  const inputLlm = await createMockLlmServer({
    responseText: "ALL_INPUTS_OK",
    toolPlan: [
      {
        name: "bash",
        input: {
          command: [
            "set -eu",
            'test "$(cat inputs/attached.txt)" = "FILE_INPUT_OK"',
            'skill_file="$(find .openma/skills -name SKILL.md -type f | head -n 1)"',
            'test -n "$skill_file"',
            'grep -q "SKILL_INPUT_OK" "$skill_file"',
            'test "$(cat "$OMA_MEMORY_CERTIFICATION_MEMORY/notes/input.txt")" = "MEMORY_INPUT_OK"',
            'printf "MEMORY_UPDATED_OK" > "$OMA_MEMORY_CERTIFICATION_MEMORY/notes/input.txt"',
            'printf "MEMORY_CREATED_OK" > "$OMA_MEMORY_CERTIFICATION_MEMORY/notes/created.txt"',
            'mv "$OMA_MEMORY_CERTIFICATION_MEMORY/notes/rename-source.txt" "$OMA_MEMORY_CERTIFICATION_MEMORY/notes/renamed.txt"',
            'rm "$OMA_MEMORY_CERTIFICATION_MEMORY/notes/delete.txt"',
            'test "$(cat repository/repo-marker.txt)" = "REPO_REVISION_OK"',
            `test "$(git -C repository rev-parse HEAD)" = "${repository.commitSha}"`,
            'printf "OUTPUT_OK" > "$OMA_OUTPUTS_DIR/certification.txt"',
            "printf FILES_REPO_SKILL_MEMORY_OUTPUT_OK",
          ].join("; "),
        },
        expectedResult: "FILES_REPO_SKILL_MEMORY_OUTPUT_OK",
      },
      {
        name: "mcp__certification__echo",
        input: { value: "MCP_INPUT_OK" },
        expectedResult: "MCP_PROXY_OK",
      },
    ],
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const selectedSteps = new Set(
    selectLocalReleaseSteps(options.only ?? process.env.OMA_LOCAL_RELEASE_ONLY),
  );
  const environment = buildLocalReleaseEnvironment(options.env ?? process.env, {
    root,
    port,
    llmBaseUrl: llm.baseUrl,
    apiKey: API_KEY,
    repoRoot,
  });
  const report = {
    ok: false,
    base_url: baseUrl,
    llm: "deterministic-anthropic-compatible",
    sandbox: environment.SANDBOX_PROVIDER,
    steps: buildLocalReleasePlan().map((step) => ({ ...step, status: "pending" })),
    cleanup: { process: "pending", fixtures: "pending", filesystem: "pending" },
  };
  let runtime;
  let operationError;
  let cleanupError;

  try {
    await runStep(report, "console-build", () => runCommand(
      "pnpm",
      ["build:console"],
      { cwd: repoRoot, env: environment, timeout: 180_000 },
    ));

    await runStep(report, "main-node-start", async () => {
      runtime = spawnMainNode(repoRoot, environment);
      await waitForHealth(baseUrl, 60_000, runtime);
    });

    const e2eEnvironment = {
      ...environment,
      OMA_E2E_BASE_URL: baseUrl,
      OMA_E2E_API_KEY: API_KEY,
      OMA_E2E_AUTH_DISABLED: "1",
      OMA_E2E_RUN_TURN: "1",
      OMA_E2E_MOCK_MODEL_BASE_URL: llm.baseUrl,
      OMA_E2E_INPUT_MODEL_BASE_URL: inputLlm.baseUrl,
      OMA_E2E_MCP_URL: mcp.url,
      OMA_E2E_REPO_URL: projectHostFixtureUrlForSandbox(
        repository.url,
        environment.SANDBOX_PROVIDER,
      ),
      OMA_E2E_REPO_SHA: repository.commitSha,
      OMA_E2E_REPO_TOKEN: repository.token,
    };
    if (selectedSteps.has("managed-agents-sdk")) {
      await runStep(report, "managed-agents-sdk", () => runCommand(
        process.execPath,
        ["test/e2e/managed-agents-sdk.mjs"],
        { cwd: repoRoot, env: e2eEnvironment, timeout: 240_000 },
      ));
    } else markStepSkipped(report, "managed-agents-sdk");

    if (selectedSteps.has("managed-inputs-mcp")) {
      await runStep(report, "managed-inputs-mcp", () => runCommand(
        process.execPath,
        ["test/e2e/managed-inputs-mcp.mjs"],
        { cwd: repoRoot, env: e2eEnvironment, timeout: 240_000 },
      ));
      assert.equal(mcp.state.unauthorized, 0, "MCP proxy sent a request without the Vault bearer");
      assert.equal(mcp.state.calls, 1, "MCP tool must be called exactly once");
      assert.equal(repository.state.unauthorized, 0, "Git clone did not use its Session-scoped credential");
      assert.ok(
        hasMountedSkillReminder(inputLlm.state.requestBodies),
        "model request did not describe the mounted custom Skill",
      );
      assert.deepEqual(mcp.state.counts, {
        "server/discover": 1,
        initialize: 1,
        "notifications/initialized": 1,
        "tools/list": 1,
        "tools/call": 1,
        DELETE: 1,
      });
      assert.ok(repository.state.requests > 0, "Git fixture received no clone traffic");
      await waitForEmptyDirectory(join(root, "sandboxes"), 5_000);
    } else markStepSkipped(report, "managed-inputs-mcp");

    if (selectedSteps.has("cli-projection")) {
      await runStep(report, "cli-projection", () => runCommand(
        "pnpm",
        ["--filter", "@openma/cli", "exec", "tsx", "src/index.ts", "agents", "list", "--json"],
        {
          cwd: repoRoot,
          env: { ...e2eEnvironment, OMA_BASE_URL: baseUrl, OMA_API_KEY: API_KEY },
          timeout: 60_000,
        },
      ));
    } else markStepSkipped(report, "cli-projection");

    if (selectedSteps.has("console-browser")) {
      await runStep(report, "console-browser", () => runCommand(
        "pnpm",
        ["exec", "playwright", "test", "test/e2e/deployed-console.spec.ts", "--config=playwright.config.ts"],
        { cwd: repoRoot, env: e2eEnvironment, timeout: 240_000 },
      ));
    } else markStepSkipped(report, "console-browser");
    report.ok = true;
  } catch (error) {
    operationError = error;
  } finally {
    try {
      await stopChild(runtime);
      report.cleanup.process = "passed";
    } catch (error) {
      cleanupError = error;
      report.cleanup.process = "failed";
    }
    const fixtureCleanup = await Promise.allSettled([
      llm.close(),
      inputLlm.close(),
      mcp.close(),
      repository.close(),
    ]);
    const fixtureErrors = fixtureCleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (fixtureErrors.length === 0) {
      report.cleanup.fixtures = "passed";
    } else {
      const error = new AggregateError(fixtureErrors, "local release fixture cleanup failed");
      cleanupError = cleanupError
        ? new AggregateError([cleanupError, error], "local release cleanup failed")
        : error;
      report.cleanup.fixtures = "failed";
    }
    if (ownRoot) {
      try {
        await rm(root, { recursive: true, force: true });
        report.cleanup.filesystem = "passed";
      } catch (error) {
        cleanupError = cleanupError
          ? new AggregateError([cleanupError, error], "local release cleanup failed")
          : error;
        report.cleanup.filesystem = "failed";
      }
    } else {
      report.cleanup.filesystem = "caller-owned";
    }
  }

  if (operationError && cleanupError) {
    throw new AggregateError([operationError, cleanupError], "local release and cleanup failed");
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  return report;
}

async function createGitHttpFixture(root) {
  const fixtureRoot = join(root, "git-fixture");
  const working = join(fixtureRoot, "working");
  const bare = join(fixtureRoot, "repository.git");
  await mkdir(working, { recursive: true });
  await runCommand("git", ["init", "--initial-branch=main", working], {
    cwd: root,
    env: process.env,
    timeout: 30_000,
  });
  await writeFile(join(working, "repo-marker.txt"), "REPO_REVISION_OK", "utf8");
  await runCommand("git", ["add", "repo-marker.txt"], {
    cwd: working,
    env: process.env,
    timeout: 30_000,
  });
  await runCommand(
    "git",
    ["-c", "user.name=OpenMA E2E", "-c", "user.email=e2e@openma.invalid", "commit", "-m", "expected revision"],
    { cwd: working, env: process.env, timeout: 30_000 },
  );
  const { stdout } = await runCommand("git", ["rev-parse", "HEAD"], {
    cwd: working,
    env: process.env,
    timeout: 30_000,
  });
  const commitSha = stdout.trim();
  await writeFile(join(working, "repo-marker.txt"), "WRONG_REVISION", "utf8");
  await runCommand("git", ["add", "repo-marker.txt"], {
    cwd: working,
    env: process.env,
    timeout: 30_000,
  });
  await runCommand(
    "git",
    ["-c", "user.name=OpenMA E2E", "-c", "user.email=e2e@openma.invalid", "commit", "-m", "newer revision"],
    { cwd: working, env: process.env, timeout: 30_000 },
  );
  await runCommand("git", ["clone", "--bare", working, bare], {
    cwd: fixtureRoot,
    env: process.env,
    timeout: 30_000,
  });
  await runCommand("git", ["--git-dir", bare, "update-server-info"], {
    cwd: fixtureRoot,
    env: process.env,
    timeout: 30_000,
  });

  const token = "openma-local-release-github-token";
  const expectedAuthorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  const state = { requests: 0, unauthorized: 0 };
  const server = createHttpServer(async (request, response) => {
    state.requests += 1;
    if (request.headers.authorization !== expectedAuthorization) {
      state.unauthorized += 1;
      response.writeHead(401, { "www-authenticate": "Basic realm=OpenMA" }).end("missing repository credential");
      return;
    }
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://fixture").pathname);
      const prefix = "/repository.git/";
      if (!pathname.startsWith(prefix)) {
        response.writeHead(404).end();
        return;
      }
      const file = resolve(bare, pathname.slice(prefix.length));
      const escaped = relative(bare, file);
      if (escaped === ".." || escaped.startsWith(`..${sep}`)) {
        response.writeHead(403).end();
        return;
      }
      const info = await stat(file);
      if (!info.isFile()) {
        response.writeHead(404).end();
        return;
      }
      const body = await readFile(file);
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": body.byteLength,
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  const address = await listenLocal(server);
  return {
    url: `http://127.0.0.1:${address.port}/repository.git`,
    commitSha,
    token,
    state,
    close: () => closeServer(server),
  };
}

async function createMcpHttpFixture() {
  const bearer = "openma-local-release-mcp-token";
  const sessionId = "openma-local-release-mcp-session";
  const state = { calls: 0, counts: {}, unauthorized: 0, requests: 0 };
  const server = createHttpServer(async (request, response) => {
    state.requests += 1;
    if (request.headers.authorization !== `Bearer ${bearer}`) {
      state.unauthorized += 1;
      response.writeHead(401).end("missing managed bearer");
      return;
    }
    if (request.method === "DELETE") {
      state.counts.DELETE = (state.counts.DELETE ?? 0) + 1;
      response.writeHead(200).end();
      return;
    }
    let raw = "";
    request.setEncoding("utf8");
    for await (const chunk of request) raw += chunk;
    let message;
    try {
      message = JSON.parse(raw || "{}");
    } catch {
      writeJsonRpc(response, null, undefined, { code: -32700, message: "Parse error" });
      return;
    }
    if (typeof message.method === "string") {
      state.counts[message.method] = (state.counts[message.method] ?? 0) + 1;
    }
    if (message.method === "server/discover") {
      writeJsonRpc(response, message.id, undefined, { code: -32601, message: "Method not found" });
      return;
    }
    if (message.method === "initialize") {
      writeJsonRpc(response, message.id, {
        protocolVersion: String(message.params?.protocolVersion ?? "2025-06-18"),
        capabilities: { tools: {} },
        serverInfo: { name: "openma-release-fixture", version: "1.0.0" },
      }, undefined, { "mcp-session-id": sessionId });
      return;
    }
    if (message.method === "notifications/initialized") {
      response.writeHead(202).end();
      return;
    }
    if (request.headers["mcp-session-id"] !== sessionId) {
      response.writeHead(404).end("unknown MCP session");
      return;
    }
    if (message.method === "tools/list") {
      writeJsonRpc(response, message.id, {
        tools: [{
          name: "echo",
          description: "Return the certification marker",
          inputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
        }],
      });
      return;
    }
    if (message.method === "tools/call") {
      assert.equal(message.params?.name, "echo");
      assert.equal(message.params?.arguments?.value, "MCP_INPUT_OK");
      state.calls += 1;
      writeJsonRpc(response, message.id, {
        content: [{ type: "text", text: "MCP_PROXY_OK" }],
        structuredContent: { marker: "MCP_PROXY_OK" },
      });
      return;
    }
    writeJsonRpc(response, message.id, undefined, { code: -32601, message: "Method not found" });
  });
  const address = await listenLocal(server);
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    state,
    close: () => closeServer(server),
  };
}

function writeJsonRpc(response, id, result, error, headers = {}) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: id ?? null,
    ...(error === undefined ? { result } : { error }),
  });
  response.writeHead(200, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  response.end(body);
}

async function listenLocal(server) {
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address;
}

async function closeServer(server) {
  await new Promise((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

async function waitForEmptyDirectory(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let entries = [];
  while (Date.now() < deadline) {
    try {
      entries = await readdir(path);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (entries.length === 0) return;
    await sleep(50);
  }
  throw new Error(`sandbox resources leaked after session cleanup: ${entries.join(", ")}`);
}

async function runStep(report, id, operation) {
  const step = report.steps.find((candidate) => candidate.id === id);
  assert.ok(step, `unknown local release step ${id}`);
  step.status = "running";
  const started = performance.now();
  try {
    const result = await operation();
    step.status = "passed";
    step.duration_ms = Math.max(0, Math.round(performance.now() - started));
    if (result?.stdout) step.stdout_tail = result.stdout.slice(-4_096);
  } catch (error) {
    step.status = "failed";
    step.duration_ms = Math.max(0, Math.round(performance.now() - started));
    throw error;
  }
}

function markStepSkipped(report, id) {
  const step = report.steps.find((candidate) => candidate.id === id);
  assert.ok(step, `unknown local release step ${id}`);
  step.status = "skipped";
  step.duration_ms = 0;
}

async function runCommand(command, args, options) {
  try {
    return await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    const stdout = String(error?.stdout ?? "").slice(-8_192);
    const stderr = String(error?.stderr ?? "").slice(-8_192);
    throw new Error(
      `${command} ${args.join(" ")} failed\n${stdout}\n${stderr}`.trim(),
      { cause: error },
    );
  }
}

function spawnMainNode(repoRoot, environment) {
  const child = spawn("pnpm", ["--filter", "@open-managed-agents/main-node", "start"], {
    cwd: repoRoot,
    env: environment,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-32_768); });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-32_768); });
  const exited = new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  return { child, exited, diagnostics: () => `${stdout}\n${stderr}`.trim() };
}

async function waitForHealth(baseUrl, timeoutMs, runtime) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    if (runtime.child.exitCode !== null) {
      throw new Error(`main-node exited before health check\n${runtime.diagnostics()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_500) });
      if (response.ok) {
        const body = await response.json();
        assert.equal(body.status, "ok");
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`main-node health timed out: ${lastError}\n${runtime.diagnostics()}`);
}

async function stopChild(runtime) {
  if (!runtime || runtime.child.exitCode !== null) return;
  if (process.platform !== "win32" && runtime.child.pid) {
    try { process.kill(-runtime.child.pid, "SIGTERM"); } catch { runtime.child.kill("SIGTERM"); }
  } else {
    runtime.child.kill("SIGTERM");
  }
  const result = await Promise.race([
    runtime.exited,
    sleep(10_000).then(() => ({ timeout: true })),
  ]);
  if (result?.timeout) throw new Error("main-node did not stop within 10 seconds");
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function main() {
  const report = await runLocalReleaseCertification();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
