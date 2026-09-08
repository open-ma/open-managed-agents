import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import { createNodeManagedRuntime } from "../src/index";

describe("whole-brain ACP harness in Docker", () => {
  const roots: string[] = [];
  const servers: Server[] = [];

  afterAll(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    })));
    await Promise.all(roots.map((root) => rm(root, { force: true, recursive: true })));
  });

  it("runs the packaged supervisor against HTTP and resumes after a fenced host crash", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "oma-production-acp-docker-"));
    roots.push(rootDir);
    const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const scope = {
      workspaceId: "workspace_production_acp",
      environmentId: "environment_production_acp",
      sessionId: `session_production_acp_${Date.now()}`,
      workId: `work_production_acp_${Date.now()}`,
    };
    const runtimeEvents: Array<Record<string, unknown>> = [];
    const requestAuthorizations: Array<string | null> = [];
    let firstTurnCompleted = false;
    let secondGeneration = false;
    const session = {
      id: scope.sessionId,
      environment_id: scope.environmentId,
      archived_at: null,
      status: "running",
      agent: {
        id: "agent_production_acp",
        version: 3,
        model: { id: "deepseek-chat", speed: "fast", effort: "low" },
        mcp_servers: [{
          type: "url",
          name: "github",
          url: "https://upstream-secret.invalid/mcp",
        }],
        skills: [],
        system: "Production supervisor system prompt.",
        tools: [],
      },
    };
    const turn = (id: string, text: string, processedAt: string) => ({
      id,
      type: "user.message",
      processed_at: processedAt,
      content: [{ type: "text", text }],
    });
    const server = createServer(async (incoming, outgoing) => {
      const body: Buffer[] = [];
      for await (const chunk of incoming) body.push(Buffer.from(chunk));
      requestAuthorizations.push(
        typeof incoming.headers.authorization === "string"
          ? incoming.headers.authorization
          : null,
      );
      const url = new URL(incoming.url ?? "/", `http://${incoming.headers.host}`);
      const sendJson = (value: unknown, status = 200) => {
        outgoing.statusCode = status;
        outgoing.setHeader("content-type", "application/json");
        outgoing.end(JSON.stringify(value));
      };
      if (incoming.method === "GET" && url.pathname === `/v1/sessions/${scope.sessionId}`) {
        sendJson(session);
        return;
      }
      if (incoming.method === "GET" && url.pathname === `/v1/sessions/${scope.sessionId}/events`) {
        const first = turn("turn_production_1", "first", "2026-09-08T01:00:00.000Z");
        const idle = {
          id: "idle_production_1",
          type: "session.status_idle",
          processed_at: "2026-09-08T01:00:01.000Z",
        };
        sendJson({
          data: secondGeneration
            ? [
                first,
                idle,
                turn("turn_production_2", "second", "2026-09-08T01:00:02.000Z"),
                {
                  id: "terminated_production",
                  type: "session.status_terminated",
                  processed_at: "2026-09-08T01:00:03.000Z",
                },
              ]
            : [first, ...(firstTurnCompleted ? [idle] : [])],
          next_page: null,
        });
        return;
      }
      if (
        incoming.method === "POST"
        && url.pathname === `/v1/oma/sessions/${scope.sessionId}/runtime-events`
      ) {
        const payload = JSON.parse(Buffer.concat(body).toString("utf8")) as {
          events: Array<Record<string, unknown>>;
        };
        runtimeEvents.push(...payload.events);
        if (payload.events.some((event) =>
          event.type === "session.status_idle"
        )) firstTurnCompleted = true;
        sendJson({ recorded: payload.events.length });
        return;
      }
      sendJson({ error: `unexpected ${incoming.method} ${url.pathname}` }, 404);
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "0.0.0.0", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected TCP server");
    const sandboxBaseUrl = `http://host.docker.internal:${address.port}`;
    const sessionsToken = "scoped-production-token";
    const workSecret = Buffer.from(JSON.stringify({
      sessions_token: sessionsToken,
      api_base_url: sandboxBaseUrl,
    })).toString("base64url");

    const agentSource = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
let mode = "uninitialized";
input.on("line", (line) => {
  const request = JSON.parse(line);
  const result = (value) => send({ jsonrpc: "2.0", id: request.id, result: value });
  switch (request.method) {
    case "initialize":
      result({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {}, resume: {} } } });
      break;
    case "session/new": {
      mode = "new";
      if (process.env.ANTHROPIC_WORK_SECRET || process.env.ANTHROPIC_ENVIRONMENT_KEY) {
        throw new Error("control-plane credential reached ACP child");
      }
      const instructions = fs.readFileSync("/workspace/AGENTS.md", "utf8");
      fs.writeFileSync("/workspace/production-observation.json", JSON.stringify({
        instructions,
        mcpServers: request.params.mcpServers,
        meta: request.params._meta,
      }));
      result({ sessionId: "native-production-session" });
      break;
    }
    case "session/resume": {
      const transcript = path.join(process.env.CODEX_HOME, "sessions", "turn.jsonl");
      if (!fs.existsSync(transcript)) throw new Error("native transcript was not restored");
      mode = "resume:" + request.params.sessionId;
      result({});
      break;
    }
    case "session/prompt": {
      const text = request.params.prompt.map((block) => block.text || "").join("");
      fs.mkdirSync(path.join(process.env.CODEX_HOME, "sessions"), { recursive: true });
      fs.writeFileSync(path.join(process.env.CODEX_HOME, "sessions", "turn.jsonl"), text + "\n");
      fs.mkdirSync(process.env.OUTPUT_PATH, { recursive: true });
      fs.writeFileSync(path.join(process.env.OUTPUT_PATH, "production.txt"), mode + ":" + text);
      send({ jsonrpc: "2.0", method: "session/update", params: {
        sessionId: request.params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: mode + ":" + text } },
      }});
      result({ stopReason: "end_turn", usage: {
        totalTokens: 100,
        inputTokens: mode === "new" ? 95 : 20,
        outputTokens: 5,
        cachedReadTokens: mode === "new" ? 0 : 75,
        cachedWriteTokens: 0,
      }});
      break;
    }
    case "session/close":
    case "session/cancel":
      result({});
      break;
    default:
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
  }
});
`;
    const agentPath = join(rootDir, "production-acp-agent.cjs");
    const wrapperPath = join(rootDir, "codex-acp");
    const supervisorBundle = join(rootDir, "openma-acp-supervisor.mjs");
    await writeFile(agentPath, agentSource);
    await writeFile(wrapperPath, `#!/bin/sh\nexec /usr/local/bin/node /opt/openma-fixture/production-acp-agent.cjs\n`);
    await chmod(wrapperPath, 0o755);
    await promisify(execFile)(join(repositoryRoot, "node_modules/.bin/esbuild"), [
      join(repositoryRoot, "packages/harness-runtime-acp/src/node-cli.ts"),
      "--bundle",
      "--format=esm",
      "--platform=node",
      "--target=node24",
      `--outfile=${supervisorBundle}`,
    ]);

    const sql = await createBetterSqlite3SqlClient(":memory:");
    const runtime = await createNodeManagedRuntime({
      rootDir,
      sql,
      initializeFenceSchema: true,
      ownerId: "production-acp-docker-host",
      leaseTtlMs: 10_000,
      heartbeatIntervalMs: 100,
      image: process.env.OMA_RUNTIME_NODE_IMAGE ?? "node:24-alpine",
      additionalMounts: [{
        source: rootDir,
        destination: "/opt/openma-fixture",
        readOnly: true,
      }],
      extraHosts: [{ hostname: "host.docker.internal", address: "host-gateway" }],
    });
    const profile = {
      workspace: { requirement: "durable" as const },
      outputs: { requirement: "durable" as const },
      runtimeCheckpoint: "disabled" as const,
      driver: {
        type: "openma_supervised" as const,
        protocol: "openma-harness-supervisor-v1" as const,
        supervisor: {
          command: "/usr/local/bin/node",
          args: ["/opt/openma-fixture/openma-acp-supervisor.mjs"],
          env: {
            PATH: "/opt/openma-fixture:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            ANTHROPIC_BASE_URL: sandboxBaseUrl,
            ANTHROPIC_ENVIRONMENT_ID: scope.environmentId,
            ANTHROPIC_ENVIRONMENT_KEY: "must-not-reach-agent",
            ANTHROPIC_SESSION_ID: scope.sessionId,
            ANTHROPIC_WORK_ID: scope.workId,
            ANTHROPIC_WORK_SECRET: workSecret,
          },
        },
        harness: { id: "codex-acp", version: "1" },
        readyTimeoutMs: 5_000,
        heartbeatTimeoutMs: 5_000,
        drainTimeoutMs: 5_000,
      },
    };

    const firstController = new AbortController();
    const firstRun = runtime.host.run({ scope, profile, signal: firstController.signal });
    await expect.poll(async () => {
      const row = await sql.prepare(
        "SELECT revision FROM runtime_resource_fences WHERE session_id = ? AND work_id = ?",
      ).bind(scope.sessionId, scope.workId).first<{ revision: number }>();
      return Number(row?.revision ?? 0);
    }, { timeout: 10_000 }).toBe(1);
    firstController.abort(new Error("simulated host crash after committed turn"));
    await expect(firstRun).resolves.toEqual({ type: "lease_lost" });
    await expect(dockerContainersForWork(scope.workId)).resolves.toEqual([]);

    secondGeneration = true;
    await expect(runtime.host.run({ scope, profile })).resolves.toEqual({
      type: "completed",
      revision: 3,
    });
    const verifier = await runtime.fences.acquire({
      scope,
      ownerId: "production-acp-verifier",
      ttlMs: 10_000,
    });
    if (verifier.type !== "acquired" || verifier.publication === null) {
      throw new Error("expected production supervisor publication");
    }
    const restored = await runtime.workspace.materialize({
      scope,
      fence: verifier.fence,
      strategy: "checkpoint_restore",
      activeCheckpoint: verifier.publication.workspaceCandidate,
      idempotencyKey: "verify-production-supervisor",
      signal: new AbortController().signal,
    });
    const observation = JSON.parse(await readFile(
      join(String(restored.metadata?.hostPath), "production-observation.json"),
      "utf8",
    ));
    expect(observation.instructions).toBe("Production supervisor system prompt.\n");
    expect(observation.mcpServers).toEqual([{
      type: "http",
      name: "github",
      url: `${sandboxBaseUrl}/v1/oma/mcp-proxy/${scope.sessionId}/github`,
      headers: [{ name: "Authorization", value: `Bearer ${sessionsToken}` }],
    }]);
    expect(JSON.stringify(observation)).not.toContain("upstream-secret.invalid");
    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "agent.message",
        content: expect.arrayContaining([
          expect.objectContaining({ text: "resume:native-production-session:second" }),
        ]),
      }),
      expect.objectContaining({
        type: "session.status_idle",
      }),
    ]));
    expect(requestAuthorizations.length).toBeGreaterThan(0);
    expect(new Set(requestAuthorizations)).toEqual(new Set([`Bearer ${sessionsToken}`]));
    await runtime.fences.release({ fence: verifier.fence, reason: "completed" });
    await expect(dockerContainersForWork(scope.workId)).resolves.toEqual([]);
  }, 60_000);

  it("runs control loop + ACP in the sandbox, publishes cache usage, checkpoints native state, and leaks no container", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "oma-supervised-acp-docker-"));
    roots.push(rootDir);
    const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const scope = {
      workspaceId: "workspace_supervised_acp",
      environmentId: "environment_supervised_acp",
      sessionId: `session_supervised_acp_${Date.now()}`,
      workId: `work_supervised_acp_${Date.now()}`,
    };
    const agentSource = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let mode = "uninitialized";
input.on("line", (line) => {
  const request = JSON.parse(line);
  const result = (value) => send({ jsonrpc: "2.0", id: request.id, result: value });
  switch (request.method) {
    case "initialize":
      result({
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { close: {}, resume: {} } },
      });
      break;
    case "session/new":
      mode = "new";
      result({ sessionId: "native-acp-session" });
      break;
    case "session/resume": {
      const transcript = path.join(process.env.CODEX_HOME, "sessions", "turn.jsonl");
      if (!fs.existsSync(transcript)) throw new Error("native transcript missing after restore");
      mode = "resume:" + request.params.sessionId;
      result({});
      break;
    }
    case "session/prompt": {
      const text = request.params.prompt.map((block) => block.text ?? "").join("");
      const nativeRoot = process.env.CODEX_HOME;
      fs.mkdirSync(path.join(nativeRoot, "sessions"), { recursive: true });
      fs.writeFileSync(path.join(nativeRoot, "sessions", "turn.jsonl"), JSON.stringify({ text }) + "\n");
      fs.writeFileSync(path.join(nativeRoot, "credentials.json"), "must-not-persist\n");
      fs.mkdirSync(process.env.OUTPUT_PATH, { recursive: true });
      fs.writeFileSync(path.join(process.env.OUTPUT_PATH, "answer.txt"), "sandbox answer");
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: request.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "inside:" + mode + ":" + text },
          },
        },
      });
      result({
        stopReason: "end_turn",
        usage: {
          totalTokens: 100,
          inputTokens: mode === "new" ? 95 : 20,
          outputTokens: 5,
          cachedReadTokens: mode === "new" ? 0 : 75,
          cachedWriteTokens: 0,
        },
      });
      break;
    }
    case "session/close":
    case "session/cancel":
      result({});
      break;
    default:
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
  }
});
`;
    const fixture = `
      import { appendFile } from "node:fs/promises";
      import { Readable, Writable } from "node:stream";
      import { serveHarnessSupervisorJsonl } from ${JSON.stringify(
        join(repositoryRoot, "packages/harness-supervisor/src/index.ts"),
      )};
      import { createAcpRuntime } from ${JSON.stringify(
        join(repositoryRoot, "packages/acp-runtime/src/placement.ts"),
      )};
      import { NodeSpawner } from ${JSON.stringify(
        join(repositoryRoot, "packages/acp-runtime/src/spawners/node.ts"),
      )};
      import { createManagedAcpSupervisorHarness } from ${JSON.stringify(
        join(repositoryRoot, "packages/harness-runtime-acp/src/index.ts"),
      )};
      import { createAcpNativeSessionState, createNodeAcpHarnessStateIo } from ${JSON.stringify(
        join(repositoryRoot, "packages/harness-runtime-acp/src/node.ts"),
      )};

      await serveHarnessSupervisorJsonl({
        input: Readable.toWeb(process.stdin),
        output: Writable.toWeb(process.stdout),
        heartbeatIntervalMs: 50,
        resolveHarness: async ({ id, version }) => {
          if (id !== "acp" || version !== "1") return null;
          const state = createAcpNativeSessionState({
            io: createNodeAcpHarnessStateIo(),
            resolveSession: async () => ({
              agent: {
                id: "codex-acp",
                command: "/usr/local/bin/node",
                args: ["/opt/openma-fixture/acp-agent.cjs"],
                cwd: "/workspace",
                env: { OUTPUT_PATH: "/mnt/session/outputs" },
              },
            }),
          });
          return createManagedAcpSupervisorHarness({
            connect: async ({ scope }) => ({
              async *commands() {
                yield {
                  type: "session.start",
                  sessionId: scope.sessionId,
                  agentId: "codex-acp",
                  runtime: "cloud",
                };
                yield {
                  type: "session.prompt",
                  sessionId: scope.sessionId,
                  turnId: "turn_docker_1",
                  text: "hello docker",
                };
                yield { type: "control.complete", workId: scope.workId };
              },
              async publish(event) {
                await appendFile("/workspace/runtime-events.jsonl", JSON.stringify(event) + "\\n");
              },
              async close() {},
            }),
            acpRuntime: createAcpRuntime({ type: "local", spawner: new NodeSpawner() }),
            sessionPreparation: state,
            sessionState: state,
            drainDeadlineMs: 2_000,
          });
        },
      });
    `;
    const agentPath = join(rootDir, "acp-agent.cjs");
    const fixtureSource = join(rootDir, "supervisor-acp-fixture.ts");
    const fixtureBundle = join(rootDir, "supervisor-acp-fixture.mjs");
    await writeFile(agentPath, agentSource);
    await writeFile(fixtureSource, fixture);
    await promisify(execFile)(join(repositoryRoot, "node_modules/.bin/esbuild"), [
      fixtureSource,
      "--bundle",
      "--format=esm",
      "--platform=node",
      "--target=node24",
      `--outfile=${fixtureBundle}`,
    ]);
    const sql = await createBetterSqlite3SqlClient(":memory:");
    const runtime = await createNodeManagedRuntime({
      rootDir,
      sql,
      initializeFenceSchema: true,
      ownerId: "supervised-acp-docker-host",
      leaseTtlMs: 10_000,
      heartbeatIntervalMs: 100,
      image: process.env.OMA_RUNTIME_NODE_IMAGE ?? "node:24-alpine",
      additionalMounts: [{
        source: rootDir,
        destination: "/opt/openma-fixture",
        readOnly: true,
      }],
    });

    await expect(runtime.host.run({
      scope,
      profile: {
        workspace: { requirement: "durable" },
        outputs: { requirement: "durable" },
        runtimeCheckpoint: "disabled",
        driver: {
          type: "openma_supervised",
          protocol: "openma-harness-supervisor-v1",
          supervisor: {
            command: "/usr/local/bin/node",
            args: ["/opt/openma-fixture/supervisor-acp-fixture.mjs"],
          },
          harness: { id: "acp", version: "1" },
          readyTimeoutMs: 5_000,
          heartbeatTimeoutMs: 5_000,
          drainTimeoutMs: 5_000,
        },
      },
    })).resolves.toEqual({ type: "completed", revision: 2 });

    const verifier = await runtime.fences.acquire({
      scope,
      ownerId: "supervised-acp-docker-verifier",
      ttlMs: 10_000,
    });
    if (verifier.type !== "acquired" || verifier.publication === null) {
      throw new Error("expected supervised ACP publication");
    }
    const restored = await runtime.workspace.materialize({
      scope,
      fence: verifier.fence,
      strategy: "checkpoint_restore",
      activeCheckpoint: verifier.publication.workspaceCandidate,
      idempotencyKey: "verify-supervised-acp-state",
      signal: new AbortController().signal,
    });
    const restoredRoot = String(restored.metadata?.hostPath);
    const stateRoot = join(
      restoredRoot,
      ".openma/harness-state/acp",
      encodeURIComponent(scope.sessionId),
      "codex/v1",
    );
    await expect(readFile(join(stateRoot, "native/sessions/turn.jsonl"), "utf8"))
      .resolves.toBe('{"text":"hello docker"}\n');
    await expect(readFile(join(stateRoot, "native/credentials.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    const firstEvents = (await readFile(join(restoredRoot, "runtime-events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(firstEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "session.ready", acpSessionId: "native-acp-session" }),
      expect.objectContaining({
        type: "session.event",
        event: expect.objectContaining({
          type: "promptComplete",
          response: expect.objectContaining({
            usage: expect.objectContaining({ cachedReadTokens: 0 }),
          }),
        }),
      }),
      expect.objectContaining({ type: "session.complete", turnId: "turn_docker_1" }),
    ]));
    await runtime.fences.release({ fence: verifier.fence, reason: "completed" });

    // A second Runtime Host attempt must create a fresh container, restore the
    // OpenMA-owned checkpoint, and use ACP session/resume only after the
    // Harbor-derived native Codex session directory has been materialized.
    await expect(runtime.host.run({
      scope,
      profile: {
        workspace: { requirement: "durable" },
        outputs: { requirement: "durable" },
        runtimeCheckpoint: "disabled",
        driver: {
          type: "openma_supervised",
          protocol: "openma-harness-supervisor-v1",
          supervisor: {
            command: "/usr/local/bin/node",
            args: ["/opt/openma-fixture/supervisor-acp-fixture.mjs"],
          },
          harness: { id: "acp", version: "1" },
          readyTimeoutMs: 5_000,
          heartbeatTimeoutMs: 5_000,
          drainTimeoutMs: 5_000,
        },
      },
    })).resolves.toEqual({ type: "completed", revision: 4 });

    const finalVerifier = await runtime.fences.acquire({
      scope,
      ownerId: "supervised-acp-docker-final-verifier",
      ttlMs: 10_000,
    });
    if (finalVerifier.type !== "acquired" || finalVerifier.publication === null) {
      throw new Error("expected restored supervised ACP publication");
    }
    const finalRestored = await runtime.workspace.materialize({
      scope,
      fence: finalVerifier.fence,
      strategy: "checkpoint_restore",
      activeCheckpoint: finalVerifier.publication.workspaceCandidate,
      idempotencyKey: "verify-supervised-acp-resume",
      signal: new AbortController().signal,
    });
    const finalEvents = (await readFile(
      join(String(finalRestored.metadata?.hostPath), "runtime-events.jsonl"),
      "utf8",
    )).trim().split("\n").map((line) => JSON.parse(line));
    expect(finalEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "session.event",
        event: expect.objectContaining({
          sessionUpdate: "agent_message_chunk",
          content: expect.objectContaining({
            text: "inside:resume:native-acp-session:hello docker",
          }),
        }),
      }),
      expect.objectContaining({
        type: "session.event",
        event: expect.objectContaining({
          type: "promptComplete",
          response: expect.objectContaining({
            usage: expect.objectContaining({ cachedReadTokens: 75 }),
          }),
        }),
      }),
    ]));
    const manifestHash = finalVerifier.publication.outputCandidate!.contentHash
      .slice("sha256:".length);
    const manifest = JSON.parse(await readFile(
      join(rootDir, "outputs", "manifests", `${manifestHash}.json`),
      "utf8",
    ));
    expect(manifest.entries).toEqual([
      expect.objectContaining({ logicalPath: "answer.txt", size: 14 }),
    ]);

    await expect(dockerContainersForWork(scope.workId)).resolves.toEqual([]);
  }, 60_000);
});

async function dockerContainersForWork(workId: string): Promise<string[]> {
  const label = createHash("sha256").update(workId).digest("hex").slice(0, 32);
  const result = await promisify(execFile)("docker", [
    "ps",
    "-aq",
    "--filter",
    `label=dev.openma.work=${label}`,
  ]);
  return result.stdout.trim() ? result.stdout.trim().split("\n") : [];
}
