import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Socket } from "node:net";
import OpenAI from "openai";
import { detachedProcessOptions, killProcessTree } from "../helpers/process-tree";

export type ModelReply = { text: string } | { name: string; input: Record<string, unknown> } | null;
export type OpenAINodeModel = (input: Record<string, any>) => Promise<ModelReply> | ModelReply;
export interface OpenAINodeOptions { startupTimeoutMs?: number }

export interface OpenAINodeProcess {
  /** These getters follow the new listening port after restart(). */
  readonly baseURL: string;
  readonly client: OpenAI;
  readonly directory: string;
  readonly requests: Array<Record<string, any>>;
  readonly logs: string[];
  /** Kill the Node process, then start it against the same native SQLite/blob data. */
  restart(): Promise<void>;
  dispose(): Promise<void>;
}

function defaultReply(input: Record<string, any>): ModelReply {
  const hasResult = (input.messages ?? []).some((message: any) => Array.isArray(message.content) && message.content.some((part: any) => part.type === "tool_result"));
  const lookup = (input.tools ?? []).some((tool: any) => tool.name === "lookup");
  return lookup && !hasResult
    ? { name: "lookup", input: { key: "answer" } }
    : { text: hasResult ? "NATIVE_TOOL_RESULT_OK" : "NATIVE_NONE_OK" };
}

/** Starts a production Node server plus a local scripted model endpoint.
 * Callers own cleanup: register fixture.dispose() in their afterEach/finally.
 * No Vitest hooks are registered here, so fixtures cannot affect other files. */
export async function bootOpenAINode(reply: OpenAINodeModel = defaultReply, options: OpenAINodeOptions = {}): Promise<OpenAINodeProcess> {
  const root = resolve(__dirname, "../../../..");
  const directory = await mkdtemp(join(tmpdir(), "openma-openai-node-"));
  const requests: Array<Record<string, any>> = [];
  const logs: string[] = [];
  const sockets = new Set<Socket>();
  let processHandle: ChildProcess | undefined;
  let baseURL = "";
  let client: OpenAI;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  let lifecycle: Promise<void> = Promise.resolve();
  const model = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, any>;
      requests.push(input);
      const requestNumber = requests.length;
      const output = await reply(input);
      if (response.destroyed) return;
      if (output === null) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.flushHeaders();
        return;
      }
      const calling = "name" in output;
      const events = [
        { type: "message_start", message: { id: `msg_fixture_${requestNumber}`, type: "message", role: "assistant", model: "claude-sonnet-4-20250514", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: calling ? { type: "tool_use", id: `call_fixture_${requestNumber}`, name: output.name, input: {} } : { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: calling ? { type: "input_json_delta", partial_json: JSON.stringify(output.input) } : { type: "text_delta", text: output.text } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: calling ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
        { type: "message_stop" },
      ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    } catch (error) {
      logs.push(`Local model fixture failed: ${String(error)}\n`);
      if (!response.destroyed) {
        if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { type: "api_error", message: "Local model fixture failed" } }));
      }
    }
  });
  model.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const disconnectModelClients = () => {
    model.closeAllConnections();
    for (const socket of sockets) socket.destroy();
  };
  const stop = async () => {
    if (processHandle !== undefined) {
      if (processHandle.pid !== undefined) await killProcessTree(processHandle);
      processHandle = undefined;
    }
    disconnectModelClients();
  };
  const dispose = (): Promise<void> => {
    if (disposal !== undefined) return disposal;
    disposed = true;
    disposal = (async () => {
      await lifecycle.catch(() => undefined);
      try { await stop(); }
      finally {
        disconnectModelClients();
        try {
          if (model.listening) await new Promise<void>((resolve, reject) => model.close(error => error ? reject(error) : resolve()));
        } finally { await rm(directory, { recursive: true, force: true }); }
      }
    })();
    return disposal;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      model.once("error", reject);
      model.listen(0, "127.0.0.1", () => { model.off("error", reject); resolve(); });
    });
    const modelPort = (model.address() as { port: number }).port;
    // Inherit only OS process-launching essentials. In particular, real model
    // keys/endpoints, NODE_OPTIONS and deployment/provider secrets never enter
    // the tested process through the invoking developer's environment.
    const inherited = Object.fromEntries(["PATH", "HOME", "USER", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]
      .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
    const start = async () => {
      const currentLogs: string[] = [];
      let spawnError: Error | undefined;
      const child = spawn(join(root, "apps/main-node/node_modules/.bin/tsx"), [join(root, "apps/main-node/src/index.ts")], {
        ...detachedProcessOptions, cwd: root, env: {
          ...inherited, PORT: "0", HOST: "127.0.0.1", DATABASE_URL: "", OPENMA_PROCESS_MODE: "standalone",
          DATABASE_PATH: join(directory, "oma.db"), AUTH_DATABASE_PATH: join(directory, "auth.db"), SANDBOX_WORKDIR: join(directory, "sandboxes"), MEMORY_BLOB_DIR: join(directory, "memories"), FILES_BLOB_DIR: join(directory, "files"), SESSION_OUTPUTS_DIR: join(directory, "outputs"),
          AUTH_DISABLED: "1", PLATFORM_ROOT_SECRET: "openai-node-test-configuration-secret", NODE_ENV: "test", DREAM_CURATOR_MODE: "dedup", ANTHROPIC_API_KEY: "local-test-model-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${modelPort}`,
          MEMORY_S3_ENDPOINT: "", FILES_S3_ENDPOINT: "", SANDBOX_PROVIDER: "litebox",
        }, stdio: ["ignore", "pipe", "pipe"],
      });
      processHandle = child;
      child.once("error", error => { spawnError = error; });
      const record = (data: Buffer) => { const text = data.toString(); logs.push(text); currentLogs.push(text); };
      child.stdout!.on("data", record);
      child.stderr!.on("data", record);
      const deadline = Date.now() + (options.startupTimeoutMs ?? 60_000);
      while (Date.now() < deadline) {
        if (spawnError !== undefined) throw spawnError;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Node exited: ${currentLogs.join("")}`);
        for (const line of currentLogs.join("").split("\n")) {
          try {
            const event = JSON.parse(line);
            if (event.op === "main-node.listening" && event.port) {
              baseURL = `http://127.0.0.1:${event.port}`;
              client = new OpenAI({ apiKey: "test", baseURL: `${baseURL}/openai/v1`, maxRetries: 0 });
              return;
            }
          } catch { /* Dependencies may log plain text or partial lines. */ }
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`Node did not start: ${currentLogs.join("")}`);
    };
    await start();
    return {
      get baseURL() { return baseURL; }, get client() { return client; }, directory, requests, logs,
      restart() {
        if (disposed) return Promise.reject(new Error("Cannot restart a disposed Node fixture"));
        lifecycle = lifecycle.then(async () => { await stop(); await start(); });
        return lifecycle;
      },
      dispose,
    };
  } catch (error) { await dispose(); throw error; }
}
