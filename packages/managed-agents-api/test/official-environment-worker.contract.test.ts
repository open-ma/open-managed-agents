import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  environmentWorkView,
  makeEnvironmentWorkPort,
} from "./environment-work-fixtures";
import { makeSessionEventsPort } from "./session-event-fixtures";
import { makeSessionsPort, sessionView } from "./session-fixtures";
import { buildManagedAgentsTestApi } from "./test-api";

const workdirCleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    workdirCleanup.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

describe("official Anthropic EnvironmentWorker compatibility", () => {
  it("runs one claimed Session through poll, ack, lease, events, and force-stop", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "openma-official-worker-"));
    workdirCleanup.push(workdir);

    const environmentId = "env_self_01";
    const sessionId = sessionView.id;
    const environmentKey = "sk-ant-environment-test";
    const sessionsToken = "sk-ant-req-session-test";
    const controller = new AbortController();
    const calls: Array<{ operation: string; input: unknown }> = [];
    const toolInputs: unknown[] = [];
    let polled = false;
    let acceptToolResult!: () => void;
    const toolResultAccepted = new Promise<void>((resolve) => {
      acceptToolResult = resolve;
    });

    const activeWork = {
      ...environmentWorkView,
      data: { type: "session" as const, id: sessionId },
      environmentId,
      secret: {
        sessionsToken,
        apiBaseUrl: "http://openma.test",
      },
    };
    const api = buildManagedAgentsTestApi({
      environmentWork: makeEnvironmentWorkPort({
        pollEnvironmentWork: async (input) => {
          calls.push({ operation: "poll", input });
          if (polled) return { type: "empty" };
          polled = true;
          return { type: "work", work: activeWork };
        },
        acknowledgeEnvironmentWork: async (input) => {
          calls.push({ operation: "ack", input });
          return { type: "acknowledged", work: activeWork };
        },
        heartbeatEnvironmentWork: async (input) => {
          calls.push({ operation: "heartbeat", input });
          return {
            type: "heartbeat",
            heartbeat: {
              lastHeartbeat: "2026-09-03T02:00:00.000Z",
              leaseExtended: true,
              state: "active",
              ttlSeconds: 90,
            },
          };
        },
        stopEnvironmentWork: async (input) => {
          calls.push({ operation: "stop", input });
          controller.abort();
          return {
            type: "stopped",
            work: {
              ...activeWork,
              state: "stopped",
              stoppedAt: "2026-09-03T02:00:01.000Z",
            },
          };
        },
      }),
      sessions: makeSessionsPort({
        retrieveSession: async (input) => {
          calls.push({ operation: "retrieve_session", input });
          return {
            type: "found",
            session: {
              ...sessionView,
              id: sessionId,
              environmentId,
              resources: [],
            },
          };
        },
      }),
      sessionEvents: makeSessionEventsPort({
        sendSessionEvents: async (input) => {
          calls.push({ operation: "send_events", input });
          acceptToolResult();
          return {
            type: "accepted",
            events: [{
              id: "event_tool_result",
              type: "user.tool_result",
              toolUseId: "tool_use_echo",
              content: [{ type: "text", text: "echo:contract" }],
              isError: false,
              processedAt: "2026-09-03T02:00:00.400Z",
            }],
          };
        },
        listSessionEvents: async (input) => {
          calls.push({ operation: "list_events", input });
          return {
            type: "page",
            page: { events: [], nextCursor: null },
          };
        },
        streamSessionEvents: async (input) => {
          calls.push({ operation: "stream_events", input });
          return {
            type: "stream",
          events: (async function* () {
              yield {
                id: "tool_use_echo",
                type: "agent.tool_use" as const,
                name: "echo_contract",
                input: { value: "contract" },
                evaluatedPermission: "allow" as const,
                processedAt: "2026-09-03T02:00:00.250Z",
              };
              await toolResultAccepted;
              yield {
                id: "event_terminated",
                type: "session.status_terminated" as const,
                processedAt: "2026-09-03T02:00:00.500Z",
              };
            })(),
          };
        },
      }),
    });

    const requests: Array<{
      authorization: string | null;
      beta: string | null;
      method: string;
      path: string;
      xApiKey: string | null;
    }> = [];
    const client = new Anthropic({
      apiKey: "sk-ant-parent-must-not-leak",
      baseURL: "http://openma.test",
      maxRetries: 0,
      fetch: async (input, init) => {
        const request = input instanceof Request
          ? new Request(input, init)
          : new Request(input.toString(), init);
        requests.push({
          authorization: request.headers.get("authorization"),
          beta: request.headers.get("anthropic-beta"),
          method: request.method,
          path: new URL(request.url).pathname,
          xApiKey: request.headers.get("x-api-key"),
        });
        return api.fetch(request);
      },
    });

    await client.beta.environments.work.worker({
      environmentId,
      environmentKey,
      maxIdleMs: 1,
      memorySyncIntervalMs: null,
      tools: [
        betaZodTool({
          name: "echo_contract",
          description: "Echo one contract-test value",
          inputSchema: z.object({ value: z.string() }),
          run: async (input) => {
            toolInputs.push(input);
            return `echo:${input.value}`;
          },
        }),
      ],
      workerId: "worker_official_01",
      workdir,
    }).run(controller.signal);

    expect(calls.map((call) => call.operation)).toEqual([
      "poll",
      "ack",
      "heartbeat",
      "retrieve_session",
      "stream_events",
      "list_events",
      "send_events",
      "stop",
    ]);
    expect(toolInputs).toEqual([{ value: "contract" }]);
    expect(calls.find((call) => call.operation === "send_events")?.input)
      .toEqual({
        sessionId,
        events: [{
          type: "user.tool_result",
          toolUseId: "tool_use_echo",
          content: [{ type: "text", text: "echo:contract" }],
          isError: false,
        }],
      });
    expect(calls.find((call) => call.operation === "heartbeat")?.input)
      .toMatchObject({ expectedLastHeartbeat: "NO_HEARTBEAT" });
    expect(calls.find((call) => call.operation === "stop")?.input)
      .toEqual({ environmentId, force: true, workId: activeWork.id });

    const standingCredentialRequests = requests.filter((request) =>
      request.path === `/v1/environments/${environmentId}/work/poll`
      || request.path.endsWith(`/${activeWork.id}/ack`)
    );
    expect(standingCredentialRequests).toHaveLength(2);
    for (const request of standingCredentialRequests) {
      expect(request.authorization).toBe(`Bearer ${environmentKey}`);
      expect(request.xApiKey).toBeNull();
    }
    for (const request of requests.filter(
      (candidate) => !standingCredentialRequests.includes(candidate),
    )) {
      expect(request.authorization).toBe(`Bearer ${sessionsToken}`);
      expect(request.xApiKey).toBeNull();
      expect(request.beta).toContain("managed-agents-2026-04-01");
    }
  });
});
