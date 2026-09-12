import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LocalSubprocessSandbox } from "@open-managed-agents/sandbox/adapters/local-subprocess";
import { AcpRuntimeImpl } from "./runtime";
import { NodeSpawner } from "./spawners/node";
import { SandboxSpawner } from "./spawners/sandbox";
import { createAcpRuntime } from "./placement";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ),
  );
});

describe("sandbox ACP runtime", () => {
  it("runs the shared ACP session loop over a sandbox duplex process", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "oma-acp-sandbox-"));
    temporaryDirectories.push(workdir);
    const sandbox = new LocalSubprocessSandbox({ workdir });
    const runtime = new AcpRuntimeImpl(
      new SandboxSpawner(sandbox),
    );
    const session = await runtime.start({
      agent: {
        command: process.execPath,
        args: ["-e", fakeAcpAgentSource],
        cwd: "/workspace",
      },
    });

    expect(session.acpSessionId).toBe("sandbox-acp-session");
    const events: unknown[] = [];
    for await (const event of session.prompt("hello from host")) {
      events.push(event);
    }
    expect(events).toContainEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "sandbox:hello from host" },
    });

    await session.dispose();
    expect(session.isAlive()).toBe(false);
  });

  it("selects local or sandbox placement without changing the ACP session contract", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "oma-acp-placement-"));
    temporaryDirectories.push(workdir);
    const sandbox = new LocalSubprocessSandbox({ workdir });
    const localRuntime = createAcpRuntime({
      type: "local",
      spawner: new NodeSpawner(),
    });
    const sandboxRuntime = createAcpRuntime({
      type: "sandbox",
      sandbox,
    });

    const localResult = await runFakeAgent(localRuntime, workdir);
    const sandboxResult = await runFakeAgent(sandboxRuntime, "/workspace");

    expect(localResult).toEqual({
      acpSessionId: "sandbox-acp-session",
      updates: [{
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "sandbox:hello from host" },
      }],
    });
    expect(sandboxResult).toEqual(localResult);
  });

  it("sends the standard MCP stdio transport unchanged in session/new", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "oma-acp-mcp-stdio-"));
    temporaryDirectories.push(workdir);
    const runtime = createAcpRuntime({
      type: "sandbox",
      sandbox: new LocalSubprocessSandbox({ workdir }),
    });
    const mcpServers = [{
      name: "workspace",
      command: "/usr/local/bin/workspace-mcp",
      args: ["--root", "/workspace"],
      env: [{ name: "LOG_LEVEL", value: "info" }],
    }];
    const session = await runtime.start({
      agent: {
        command: process.execPath,
        args: ["-e", fakeAcpAgentSource],
        cwd: "/workspace",
      },
      mcpServers,
    });

    const events: unknown[] = [];
    for await (const event of session.prompt("report mcp")) events.push(event);
    expect(events).toContainEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: JSON.stringify(mcpServers) },
    });
    await session.dispose();
  });

  it("reports a placement session dead when its ACP child exits unexpectedly", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "oma-acp-liveness-"));
    temporaryDirectories.push(workdir);
    const runtime = createAcpRuntime({
      type: "local",
      spawner: new NodeSpawner(),
    });
    const session = await runtime.start({
      agent: {
        command: process.execPath,
        args: ["-e", exitingAcpAgentSource],
        cwd: workdir,
      },
    });

    expect(session.isAlive()).toBe(true);
    for await (const _event of session.prompt("exit now")) {
      // Drain the final prompt result before observing process liveness.
    }
    await expect.poll(() => session.isAlive()).toBe(false);
  });

  it("hard-kills an ACP child that ignores cancellation after the turn deadline", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "oma-acp-stuck-cancel-"));
    temporaryDirectories.push(workdir);
    const runtime = createAcpRuntime(
      { type: "local", spawner: new NodeSpawner() },
      { cancelGraceMs: 20 },
    );
    const session = await runtime.start({
      agent: {
        command: process.execPath,
        args: ["-e", cancellationIgnoringAcpAgentSource],
        cwd: workdir,
      },
      perTurnTimeoutMs: 20,
    });

    const consume = async () => {
      for await (const _event of session.prompt("never finish")) {
        // The malicious fixture never completes its prompt.
      }
    };
    await expect(consume()).rejects.toThrow(
      "did not stop within 20ms after cancellation",
    );
    expect(session.isAlive()).toBe(false);
  }, 500);

  it("cancels and bounds cleanup when a prompt consumer stops reading early", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "oma-acp-consumer-close-"));
    temporaryDirectories.push(workdir);
    const runtime = createAcpRuntime(
      { type: "local", spawner: new NodeSpawner() },
      { cancelGraceMs: 20 },
    );
    const session = await runtime.start({
      agent: {
        command: process.execPath,
        args: ["-e", streamThenHangAcpAgentSource],
        cwd: workdir,
      },
    });

    for await (const _event of session.prompt("emit once")) break;

    await expect.poll(() => session.isAlive()).toBe(false);
  }, 500);

  it("hard-kills an ACP child that ignores session/close during dispose", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "oma-acp-stuck-close-"));
    temporaryDirectories.push(workdir);
    const sandbox = new LocalSubprocessSandbox({ workdir });
    const runtime = createAcpRuntime(
      { type: "sandbox", sandbox },
      { cancelGraceMs: 20 },
    );
    const session = await runtime.start({
      agent: {
        command: process.execPath,
        args: ["-e", closeIgnoringAcpAgentSource],
        cwd: "/workspace",
      },
    });

    let settled = false;
    const disposal = session.dispose().then(() => { settled = true; });
    await Promise.race([
      disposal,
      new Promise<void>((resolve) => setTimeout(resolve, 80)),
    ]);
    const settledWithinDeadline = settled;
    if (!settled) await sandbox.destroy();

    expect(settledWithinDeadline).toBe(true);
    expect(session.isAlive()).toBe(false);
    await disposal;
  });
});

async function runFakeAgent(
  runtime: {
    start(options: {
      agent: { command: string; args: string[]; cwd: string };
    }): Promise<{
      acpSessionId: string;
      prompt(text: string): AsyncIterable<unknown>;
      dispose(): Promise<void>;
    }>;
  },
  cwd: string,
): Promise<{ acpSessionId: string; updates: unknown[] }> {
  const session = await runtime.start({
    agent: {
      command: process.execPath,
      args: ["-e", fakeAcpAgentSource],
      cwd,
    },
  });
  const updates: unknown[] = [];
  for await (const event of session.prompt("hello from host")) {
    if (
      event !== null &&
      typeof event === "object" &&
      "sessionUpdate" in event
    ) updates.push(event);
  }
  await session.dispose();
  return { acpSessionId: session.acpSessionId, updates };
}

const fakeAcpAgentSource = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let mcpServers = [];
input.on("line", (line) => {
  const request = JSON.parse(line);
  const result = (value) => send({ jsonrpc: "2.0", id: request.id, result: value });
  switch (request.method) {
    case "initialize":
      result({ protocolVersion: 1, agentCapabilities: {} });
      break;
    case "session/new":
      mcpServers = request.params.mcpServers;
      result({ sessionId: "sandbox-acp-session" });
      break;
    case "session/prompt": {
      const text = request.params.prompt.map((block) => block.text ?? "").join("");
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: request.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: text === "report mcp" ? JSON.stringify(mcpServers) : "sandbox:" + text,
            },
          },
        },
      });
      result({ stopReason: "end_turn" });
      break;
    }
    case "session/close":
      result({});
      break;
    case "session/cancel":
      result({});
      break;
    default:
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Method not found" },
      });
  }
});
`;

const exitingAcpAgentSource = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
input.on("line", (line) => {
  const request = JSON.parse(line);
  const result = (value) => send({ jsonrpc: "2.0", id: request.id, result: value });
  switch (request.method) {
    case "initialize":
      result({ protocolVersion: 1, agentCapabilities: {} });
      break;
    case "session/new":
      result({ sessionId: "exiting-acp-session" });
      break;
    case "session/prompt":
      result({ stopReason: "end_turn" });
      setImmediate(() => process.exit(17));
      break;
    default:
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Method not found" },
      });
  }
});
`;

const cancellationIgnoringAcpAgentSource = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
input.on("line", (line) => {
  const request = JSON.parse(line);
  const result = (value) => send({ jsonrpc: "2.0", id: request.id, result: value });
  switch (request.method) {
    case "initialize":
      result({ protocolVersion: 1, agentCapabilities: {} });
      break;
    case "session/new":
      result({ sessionId: "stuck-acp-session" });
      break;
    case "session/prompt":
      // Intentionally never resolve this request.
      break;
    case "session/cancel":
      // Ignore the notification and keep the prompt running forever.
      break;
    default:
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Method not found" },
      });
  }
});
`;

const streamThenHangAcpAgentSource = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
input.on("line", (line) => {
  const request = JSON.parse(line);
  const result = (value) => send({ jsonrpc: "2.0", id: request.id, result: value });
  switch (request.method) {
    case "initialize":
      result({ protocolVersion: 1, agentCapabilities: {} });
      break;
    case "session/new":
      result({ sessionId: "stream-then-hang" });
      break;
    case "session/prompt":
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: request.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "one chunk" },
          },
        },
      });
      break;
    case "session/cancel":
      break;
    default:
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Method not found" },
      });
  }
});
`;

const closeIgnoringAcpAgentSource = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
input.on("line", (line) => {
  const request = JSON.parse(line);
  const result = (value) => send({ jsonrpc: "2.0", id: request.id, result: value });
  switch (request.method) {
    case "initialize":
      result({
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { close: {} } },
      });
      break;
    case "session/new":
      result({ sessionId: "stuck-close-session" });
      break;
    case "session/close":
      // Intentionally never resolve this request.
      break;
    default:
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Method not found" },
      });
  }
});
`;
