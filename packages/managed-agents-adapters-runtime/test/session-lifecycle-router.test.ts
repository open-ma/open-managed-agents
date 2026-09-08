import { describe, expect, it } from "vitest";
import type {
  Environment,
  Session,
} from "@open-managed-agents/managed-agents-application";
import {
  environmentExecutionAuthority,
  EnvironmentAwareSessionEventDispatchRouter,
  EnvironmentAwareSessionEventStreamRouter,
  EnvironmentAwareSessionLifecycleRouter,
} from "../src";

const session = {
  id: "session_01",
  agent: {
    id: "agent_01",
    description: null,
    mcpServers: [],
    model: { id: "claude-opus-5" },
    multiagent: null,
    name: "Agent",
    skills: [],
    system: null,
    tools: [],
    version: 1,
  },
  archivedAt: null,
  budget: null,
  createdAt: "2026-08-26T09:20:00.000Z",
  environmentId: "env_self_01",
  metadata: {},
  outcomeEvaluations: [],
  resources: [],
  stats: {},
  status: "running",
  title: null,
  updatedAt: "2026-08-26T09:20:00.000Z",
  usage: {},
  vaultIds: [],
} satisfies Session;

const selfHostedEnvironment = {
  id: "env_self_01",
  archivedAt: null,
  config: { type: "self_hosted" },
  createdAt: "2026-08-26T09:00:00.000Z",
  description: null,
  metadata: {},
  name: "Self hosted",
  updatedAt: "2026-08-26T09:00:00.000Z",
} satisfies Environment;

const managedEnvironment = {
  ...selfHostedEnvironment,
  id: "env_managed_01",
  name: "Managed",
  config: {
    type: "cloud",
    networking: { type: "unrestricted" },
    packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] },
  },
} satisfies Environment;

describe("Environment-aware Session lifecycle router", () => {
  it("selects exactly one execution authority from environment placement", () => {
    expect(environmentExecutionAuthority(selfHostedEnvironment)).toBe(
      "environment_work",
    );
    expect(environmentExecutionAuthority(managedEnvironment)).toBe(
      "session_execution",
    );
  });

  it("starts managed environments through Session execution without queuing Work", async () => {
    const calls: string[] = [];
    const router = new EnvironmentAwareSessionLifecycleRouter({
      environments: { find: async () => managedEnvironment },
      runtime: {
        sessionStarted: async () => {
          calls.push("session_execution.start");
        },
        sessionStopped: async () => {},
      },
      selfHostedWork: {
        enqueue: async () => {
          calls.push("environment_work.enqueue");
          return { type: "queued", work: {} as never };
        },
        stop: async () => ({ type: "not_found" }),
      },
    });

    await router.sessionStarted({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session: { ...session, environmentId: managedEnvironment.id },
      environment: managedEnvironment,
      initialEvents: [],
    });

    expect(calls).toEqual(["session_execution.start"]);
  });

  it("queues self-hosted starts and routes their stops through Environment Work", async () => {
    const workCalls: object[] = [];
    const router = new EnvironmentAwareSessionLifecycleRouter({
      environments: { find: async () => selfHostedEnvironment },
      runtime: {
        sessionStarted: async () => {
          throw new Error("unexpected runtime start");
        },
        sessionStopped: async () => {
          throw new Error("unexpected runtime stop");
        },
      },
      selfHostedWork: {
        enqueue: async (input) => {
          workCalls.push({ operation: "enqueue", input });
          return {
            type: "queued",
            work: {
              id: "work_01",
              acknowledgedAt: null,
              createdAt: session.createdAt,
              data: { type: "session", id: session.id },
              environmentId: selfHostedEnvironment.id,
              latestHeartbeatAt: null,
              metadata: {},
              startedAt: null,
              state: "queued",
              stopRequestedAt: null,
              stoppedAt: null,
            },
          };
        },
        stop: async (input) => {
          workCalls.push({ operation: "stop", input });
          return { type: "not_found" };
        },
      },
    });

    await router.sessionStarted({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment: selfHostedEnvironment,
      initialEvents: [],
    });
    await router.sessionStopped({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      reason: "deleted",
    });

    expect(workCalls).toEqual([
      {
        operation: "enqueue",
        input: {
          workspaceId: "workspace_01",
          environment: selfHostedEnvironment,
          session,
        },
      },
      {
        operation: "stop",
        input: {
          workspaceId: "workspace_01",
          session,
          reason: "deleted",
        },
      },
    ]);
  });

  it("runs deletion cleanup after stopping either runtime placement", async () => {
    const calls: string[] = [];
    const router = new EnvironmentAwareSessionLifecycleRouter({
      environments: { find: async () => selfHostedEnvironment },
      runtime: {
        sessionStarted: async () => {},
        sessionStopped: async () => {
          calls.push("runtime.stop");
        },
      },
      selfHostedWork: {
        enqueue: async () => ({ type: "queued", work: {} as never }),
        stop: async () => {
          calls.push("self-hosted.stop");
          return { type: "not_found" };
        },
      },
      cleanupSession: async ({ workspaceId, sessionId }) => {
        calls.push(`cleanup:${workspaceId}:${sessionId}`);
      },
    });

    await router.sessionStopped({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      reason: "deleted",
    });

    expect(calls).toEqual([
      "self-hosted.stop",
      `cleanup:workspace_01:${session.id}`,
    ]);
  });
});

describe("Environment-aware Session event dispatch router", () => {
  it("delegates managed events to the host runtime", async () => {
    const accepted: object[] = [];
    const router = new EnvironmentAwareSessionEventDispatchRouter({
      runtime: {
        async sessionEventsAccepted(input) { accepted.push(input); },
      },
    });
    const input = {
      workspaceId: "workspace_01",
      sessionId: session.id,
      session: { ...session, environmentId: managedEnvironment.id },
      environment: managedEnvironment,
      events: [],
    };

    await router.sessionEventsAccepted(input);

    expect(accepted).toEqual([input]);
  });

  it("does not start a second host brain for self-hosted events", async () => {
    const runtimeCalls: object[] = [];
    const router = new EnvironmentAwareSessionEventDispatchRouter({
      runtime: {
        async sessionEventsAccepted(input) { runtimeCalls.push(input); },
      },
    });

    await router.sessionEventsAccepted({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment: selfHostedEnvironment,
      events: [{
        type: "user.message",
        id: "event_01",
        processedAt: "2026-08-26T09:21:00.000Z",
        content: [{ type: "text", text: "continue" }],
      }],
    });

    expect(runtimeCalls).toEqual([]);
  });
});

describe("Environment-aware Session event stream router", () => {
  it("streams managed Sessions from their host runtime", async () => {
    const calls: string[] = [];
    const router = new EnvironmentAwareSessionEventStreamRouter({
      environments: { find: async () => managedEnvironment },
      runtime: {
        async *subscribe() {
          calls.push("runtime");
          yield { type: "event_start", eventId: "event_01" } as never;
        },
      },
      selfHosted: {
        async *subscribe() {
          calls.push("persisted");
        },
      },
    });

    const events = [];
    for await (const event of router.subscribe({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session: { ...session, environmentId: managedEnvironment.id },
    })) events.push(event);

    expect(calls).toEqual(["runtime"]);
    expect(events).toEqual([{ type: "event_start", eventId: "event_01" }]);
  });

  it("streams self-hosted Session and thread lanes from the canonical store", async () => {
    const calls: object[] = [];
    const router = new EnvironmentAwareSessionEventStreamRouter({
      environments: { find: async () => selfHostedEnvironment },
      runtime: {
        async *subscribe(input) {
          calls.push({ source: "runtime", input });
        },
      },
      selfHosted: {
        async *subscribe(input) {
          calls.push({ source: "persisted", input });
          yield { type: "session.status_idle", id: "idle" } as never;
        },
      },
    });
    const sessionInput = {
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
    };
    const threadInput = {
      ...sessionInput,
      threadId: "thread_01",
      thread: {} as never,
    };

    for await (const _event of router.subscribe(sessionInput)) void _event;
    for await (const _event of router.subscribe(threadInput)) void _event;

    expect(calls).toEqual([
      { source: "persisted", input: sessionInput },
      { source: "persisted", input: threadInput },
    ]);
  });

  it("fails closed when a Session references a missing Environment", async () => {
    const router = new EnvironmentAwareSessionEventStreamRouter({
      environments: { find: async () => null },
      runtime: { async *subscribe() {} },
      selfHosted: { async *subscribe() {} },
    });

    const read = async () => {
      for await (const _event of router.subscribe({
        workspaceId: "workspace_01",
        sessionId: session.id,
        session,
      })) void _event;
    };
    await expect(read()).rejects.toThrow(
      `Environment ${session.environmentId} was not found while streaming Session ${session.id}`,
    );
  });
});
