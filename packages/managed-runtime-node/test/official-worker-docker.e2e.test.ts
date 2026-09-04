import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import {
  environmentWorkView,
  makeEnvironmentWorkPort,
} from "../../managed-agents-api/test/environment-work-fixtures";
import { makeSessionEventsPort } from "../../managed-agents-api/test/session-event-fixtures";
import {
  makeSessionsPort,
  sessionView,
} from "../../managed-agents-api/test/session-fixtures";
import { buildManagedAgentsTestApi } from "../../managed-agents-api/test/test-api";
import { createNodeManagedRuntime } from "../src/index";

const roots: string[] = [];
const servers: Server[] = [];

afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  })));
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function serveApi(
  fetch: (request: Request) => Response | Promise<Response>,
): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer(async (incoming, outgoing) => {
    try {
      const body: Uint8Array[] = [];
      for await (const chunk of incoming) body.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) headers.append(name, item);
        } else if (value !== undefined) {
          headers.set(name, value);
        }
      }
      const request = new Request(
        `http://${incoming.headers.host}${incoming.url ?? "/"}`,
        {
          method: incoming.method,
          headers,
          ...(["GET", "HEAD"].includes(incoming.method ?? "GET")
            ? {}
            : { body: Buffer.concat(body) }),
        },
      );
      const response = await fetch(request);
      outgoing.statusCode = response.status;
      response.headers.forEach((value, name) => outgoing.setHeader(name, value));
      if (response.body === null) {
        outgoing.end();
        return;
      }
      const reader = response.body.getReader();
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        outgoing.write(Buffer.from(item.value));
      }
      outgoing.end();
    } catch (error) {
      outgoing.statusCode = 500;
      outgoing.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected TCP server");
  return { baseUrl: `http://host.docker.internal:${address.port}`, server };
}

describe("official EnvironmentWorker in Docker", () => {
  it("runs the unmodified Anthropic SDK through the real HTTP API boundary", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const rootDir = await mkdtemp(join(tmpdir(), "oma-official-worker-docker-"));
    roots.push(rootDir);

    const environmentId = "env_docker_official_01";
    const environmentKey = "sk-ant-environment-docker";
    const sessionsToken = "sk-ant-session-docker";
    let polled = false;
    let stopped = false;
    let acceptToolResult!: () => void;
    const toolResultAccepted = new Promise<void>((resolve) => {
      acceptToolResult = resolve;
    });
    const operations: string[] = [];
    const activeWork = {
      ...environmentWorkView,
      id: "work_docker_official_01",
      environmentId,
      data: { type: "session" as const, id: sessionView.id },
      secret: { sessionsToken, apiBaseUrl: "http://set-after-listen" },
    };
    const api = buildManagedAgentsTestApi({
      environmentWork: makeEnvironmentWorkPort({
        pollEnvironmentWork: async () => {
          operations.push("poll");
          if (polled) return { type: "empty" };
          polled = true;
          return { type: "work", work: activeWork };
        },
        acknowledgeEnvironmentWork: async () => {
          operations.push("ack");
          return { type: "acknowledged", work: activeWork };
        },
        heartbeatEnvironmentWork: async () => {
          operations.push("heartbeat");
          return {
            type: "recorded",
            heartbeat: {
              lastHeartbeat: "2026-09-03T12:00:00.000Z",
              leaseExtended: true,
              state: "active",
              ttlSeconds: 30,
            },
          };
        },
        stopEnvironmentWork: async () => {
          operations.push("stop");
          stopped = true;
          return {
            type: "stopped",
            work: {
              ...activeWork,
              state: "stopped",
              stoppedAt: "2026-09-03T12:00:01.000Z",
            },
          };
        },
      }),
      sessions: makeSessionsPort({
        retrieveSession: async () => {
          operations.push("retrieve_session");
          return {
            type: "found",
            session: {
              ...sessionView,
              environmentId,
              resources: [],
            },
          };
        },
      }),
      sessionEvents: makeSessionEventsPort({
        streamSessionEvents: async () => ({
          type: "stream",
          events: (async function* () {
            operations.push("stream_events");
            yield {
              id: "tool_use_docker",
              type: "agent.tool_use" as const,
              name: "echo_contract",
              input: { value: "docker" },
              evaluatedPermission: "allow" as const,
              processedAt: "2026-09-03T12:00:00.100Z",
            };
            await toolResultAccepted;
            yield {
              id: "event_terminated_docker",
              type: "session.status_terminated" as const,
              processedAt: "2026-09-03T12:00:00.300Z",
            };
          })(),
        }),
        listSessionEvents: async () => {
          operations.push("list_events");
          return { type: "page", page: { events: [], nextCursor: null } };
        },
        sendSessionEvents: async (input) => {
          operations.push("send_events");
          expect(input.events).toEqual([expect.objectContaining({
            type: "user.tool_result",
            toolUseId: "tool_use_docker",
            content: [{ type: "text", text: "echo:docker" }],
          })]);
          acceptToolResult();
          return {
            type: "accepted",
            events: [{
              id: "tool_result_docker",
              type: "user.tool_result",
              toolUseId: "tool_use_docker",
              content: [{ type: "text", text: "echo:docker" }],
              isError: false,
              processedAt: "2026-09-03T12:00:00.200Z",
            }],
          };
        },
      }),
    });
    const served = await serveApi((request) => {
      const path = new URL(request.url).pathname;
      if (stopped && path.endsWith("/work/poll")) {
        return Response.json({ type: "error", error: { type: "authentication_error" } }, {
          status: 401,
        });
      }
      return api.fetch(request);
    });
    servers.push(served.server);
    activeWork.secret.apiBaseUrl = served.baseUrl;

    const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const script = `
      import Anthropic from "/opt/openma/node_modules/@anthropic-ai/sdk/index.mjs";
      import { betaZodTool } from "/opt/openma/node_modules/@anthropic-ai/sdk/helpers/beta/zod.mjs";
      import { z } from "/opt/openma/node_modules/zod/index.js";
      let handled = false;
      const client = new Anthropic({
        apiKey: "sk-ant-parent-must-not-leak",
        baseURL: ${JSON.stringify(served.baseUrl)},
        maxRetries: 0,
      });
      try {
        await client.beta.environments.work.worker({
          environmentId: ${JSON.stringify(environmentId)},
          environmentKey: ${JSON.stringify(environmentKey)},
          maxIdleMs: 10,
          memorySyncIntervalMs: null,
          tools: [betaZodTool({
            name: "echo_contract",
            description: "Echo a Docker contract value",
            inputSchema: z.object({ value: z.string() }),
            run: async ({ value }) => {
              handled = true;
              return "echo:" + value;
            },
          })],
          workerId: "worker_docker_official_01",
          workdir: "/workspace",
        }).run();
      } catch (error) {
        if (!handled) throw error;
      }
      if (!handled) throw new Error("official worker did not execute the tool");
    `;
    const sql = await createBetterSqlite3SqlClient(":memory:");
    const runtime = await createNodeManagedRuntime({
      rootDir,
      sql,
      initializeFenceSchema: true,
      ownerId: "official-worker-docker-host",
      leaseTtlMs: 20_000,
      heartbeatIntervalMs: 1_000,
      image: process.env.OMA_RUNTIME_NODE_IMAGE ?? "node:24-alpine",
      additionalMounts: [{
        source: repositoryRoot,
        destination: "/opt/openma",
        readOnly: true,
      }],
      extraHosts: [{ hostname: "host.docker.internal", address: "host-gateway" }],
    });

    await expect(runtime.host.run({
      scope: {
        workspaceId: "workspace_docker_official",
        environmentId,
        sessionId: sessionView.id,
        workId: activeWork.id,
      },
      profile: {
        workspace: { requirement: "ephemeral" },
        outputs: { requirement: "disabled" },
        runtimeCheckpoint: "disabled",
        driver: {
          type: "ama_worker",
          process: {
            command: "/usr/local/bin/node",
            args: ["--input-type=module", "--eval", script],
          },
        },
      },
    })).resolves.toEqual({ type: "completed", revision: 1 });

    // The official worker performs heartbeat and session retrieval from
    // independent loops. Their relative order after acknowledgement is not
    // part of the protocol (and can legitimately race), while the lifecycle
    // boundaries below are. Assert those protocol invariants instead of
    // freezing one scheduler interleaving.
    expect(operations[0]).toBe("poll");
    expect(operations[1]).toBe("ack");
    const indexOf = (operation: string) => operations.indexOf(operation);
    expect(indexOf("heartbeat")).toBeGreaterThan(indexOf("ack"));
    expect(indexOf("retrieve_session")).toBeGreaterThan(indexOf("ack"));
    expect(indexOf("stream_events")).toBeGreaterThan(indexOf("retrieve_session"));
    expect(indexOf("list_events")).toBeGreaterThan(indexOf("stream_events"));
    expect(indexOf("send_events")).toBeGreaterThan(indexOf("list_events"));
    expect(indexOf("stop")).toBeGreaterThan(indexOf("send_events"));
    expect(indexOf("heartbeat")).toBeLessThan(indexOf("stop"));
    expect(operations.at(-1)).toBe("stop");
  });
});
