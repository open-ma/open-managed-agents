import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const servers: ReturnType<typeof createServer>[] = [];

async function runCli(baseURL: string, ...args: string[]) {
  return execFileAsync(process.execPath, ["--import", "tsx", entry, ...args], {
    env: { ...process.env, OMA_BASE_URL: baseURL, OMA_API_KEY: "cli-contract-key" },
  });
}

async function listen(
  handler: Parameters<typeof createServer>[0],
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    ),
  ));
});

describe("Managed Agents CLI transport", () => {
  it("surfaces the socket error code when runtime list cannot reach the server", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not bind TCP");
    }
    const baseURL = `http://127.0.0.1:${address.port}`;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );

    await expect(runCli(baseURL, "runtime", "list")).rejects.toMatchObject({
      stderr: expect.stringContaining("ECONNREFUSED"),
    });
  });

  it("sends the official Managed Agents beta header on v1 commands", async () => {
    let receivedBeta: string | undefined;
    const baseURL = await listen((request, response) => {
      receivedBeta = request.headers["anthropic-beta"];
      if (receivedBeta !== "managed-agents-2026-04-01") {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "missing managed agents beta" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [], has_more: false, next_page: null }));
    });
    const result = await runCli(baseURL, "agents", "list");

    expect(result.stdout).toContain("No agents");
    expect(receivedBeta).toBe("managed-agents-2026-04-01");
  });

  it("keeps agents list machine-readable in json mode even when the page is empty", async () => {
    const baseURL = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [], has_more: false, next_page: null }));
    });

    const result = await runCli(baseURL, "agents", "list", "--json");

    expect(JSON.parse(result.stdout)).toEqual({
      data: [],
      has_more: false,
      next_page: null,
    });
  });

  it("prints the complete agents page in json mode", async () => {
    const page = {
      data: [{
        id: "agent_123",
        type: "agent",
        name: "Contract agent",
        model: { id: "deepseek-v4-pro" },
        created_at: "2026-09-01T00:00:00Z",
      }],
      has_more: false,
      next_page: null,
    };
    const baseURL = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(page));
    });

    const result = await runCli(baseURL, "agents", "list", "--json");

    expect(JSON.parse(result.stdout)).toEqual(page);
  });

  it("archives agents with the official action endpoint", async () => {
    let requestShape = "";
    const baseURL = await listen((request, response) => {
      requestShape = `${request.method} ${request.url}`;
      if (requestShape !== "POST /v1/agents/agent_123/archive") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "wrong route" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "agent_123", type: "agent", archived_at: "2026-09-01T00:00:00Z" }));
    });

    const result = await runCli(baseURL, "agents", "delete", "agent_123");

    expect(requestShape).toBe("POST /v1/agents/agent_123/archive");
    expect(result.stdout).toContain("Agent archived: agent_123");
  });

  it("creates sessions with an official versioned agent reference", async () => {
    let sessionBody: unknown;
    const baseURL = await listen((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.method === "GET" && request.url === "/v1/agents/agent_123") {
        response.end(JSON.stringify({ id: "agent_123", type: "agent", version: 7 }));
        return;
      }
      if (request.method === "POST" && request.url === "/v1/sessions") {
        let raw = "";
        request.on("data", (chunk) => raw += chunk);
        request.on("end", () => {
          sessionBody = JSON.parse(raw);
          response.end(JSON.stringify({ id: "session_123", type: "session" }));
        });
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "wrong route" }));
    });

    const result = await runCli(
      baseURL,
      "sessions", "create", "--agent", "agent_123", "--env", "env_123", "--title", "Contract",
    );

    expect(sessionBody).toEqual({
      agent: { type: "agent", id: "agent_123", version: 7 },
      environment_id: "env_123",
      title: "Contract",
    });
    expect(result.stdout).toContain("Session created: session_123");
  });

  it("chats by subscribing to the official event stream before sending a user event", async () => {
    let streamURL: URL | undefined;
    let streamResponse: Parameters<Parameters<typeof createServer>[0]>[1] | undefined;
    let sentBody: unknown;
    const baseURL = await listen((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (
        request.method === "GET"
        && url.pathname === "/v1/sessions/session_123/events/stream"
      ) {
        streamURL = url;
        streamResponse = response;
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
        });
        response.flushHeaders();
        return;
      }

      if (
        request.method === "POST"
        && url.pathname === "/v1/sessions/session_123/events"
      ) {
        let raw = "";
        request.on("data", (chunk) => raw += chunk);
        request.on("end", () => {
          sentBody = JSON.parse(raw);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({
            data: [{
              id: "event_user_01",
              type: "user.message",
              content: [{ type: "text", text: "Reply exactly E2E_OK." }],
              processed_at: "2026-09-01T00:00:00.000Z",
            }],
          }));
          streamResponse?.write(
            `event: event_start\ndata: ${JSON.stringify({
              type: "event_start",
              event: { id: "event_agent_01", type: "agent.message" },
            })}\n\n`,
          );
          streamResponse?.write(
            `event: event_delta\ndata: ${JSON.stringify({
              type: "event_delta",
              event_id: "event_agent_01",
              delta: {
                type: "content_delta",
                content: { type: "text", text: "E2E_OK" },
                index: 0,
              },
            })}\n\n`,
          );
          streamResponse?.write(
            `event: agent.message\ndata: ${JSON.stringify({
              id: "event_agent_01",
              type: "agent.message",
              content: [{ type: "text", text: "E2E_OK" }],
              processed_at: "2026-09-01T00:00:01.000Z",
            })}\n\n`,
          );
          streamResponse?.end(
            `event: session.status_idle\ndata: ${JSON.stringify({
              id: "event_idle_01",
              type: "session.status_idle",
              stop_reason: { type: "end_turn" },
              processed_at: "2026-09-01T00:00:01.000Z",
            })}\n\n`,
          );
        });
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: "wrong route" }));
    });

    const result = await runCli(
      baseURL,
      "sessions", "chat", "session_123", "Reply", "exactly", "E2E_OK.",
    );

    expect(streamURL?.searchParams.getAll("event_deltas[]")).toEqual([
      "agent.message",
      "agent.thinking",
    ]);
    expect(sentBody).toEqual({
      events: [{
        type: "user.message",
        content: [{ type: "text", text: "Reply exactly E2E_OK." }],
      }],
    });
    expect(result.stdout).toBe("E2E_OK\n");
  });

  it("renders the official nested session agent reference", async () => {
    const baseURL = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        data: [{
          id: "session_123",
          type: "session",
          title: "Official session",
          status: "idle",
          agent: { type: "agent", id: "agent_123", version: 7 },
          created_at: "2026-09-01T00:00:00Z",
        }],
        has_more: false,
        next_page: null,
      }));
    });

    const result = await runCli(baseURL, "sessions", "list");

    expect(result.stdout).toContain("agent_123");
  });
});
