import { describe, expect, it } from "vitest";
import type {
  Environment,
  Session,
  SessionThread,
} from "@open-managed-agents/managed-agents-application";
import {
  NodeManagedSessionRuntimeAdapter,
  type NodeManagedSessionRuntimeDriver,
} from "../src/lib/node-managed-session-runtime.js";

const runtimeAdapterSources = import.meta.glob(
  "../src/lib/node-managed-session-runtime.ts",
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

const managedRunnerSources = import.meta.glob(
  "../src/lib/node-managed-session-runner.ts",
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

const session: Session = {
  id: "session_01",
  agent: {
    id: "agent_01",
    description: null,
    mcpServers: [],
    model: { id: "claude-opus-5" },
    multiagent: null,
    name: "Coding agent",
    skills: [],
    system: null,
    tools: [],
    version: 1,
  },
  archivedAt: null,
  budget: null,
  createdAt: "2026-08-26T00:00:00.000Z",
  environmentId: "env_01",
  metadata: {},
  outcomeEvaluations: [],
  resources: [],
  stats: {},
  status: "running",
  title: "Node session",
  updatedAt: "2026-08-26T00:00:00.000Z",
  usage: {},
  vaultIds: [],
};

const environment: Environment = {
  id: "env_01",
  archivedAt: null,
  config: { type: "self_hosted" },
  createdAt: "2026-08-26T00:00:00.000Z",
  description: null,
  metadata: {},
  name: "Node runtime",
  updatedAt: "2026-08-26T00:00:00.000Z",
};

const thread: SessionThread = {
  id: "thread_01",
  agent: {
    type: "agent",
    id: "agent_01",
    description: null,
    mcpServers: [],
    model: { id: "claude-opus-5" },
    name: "Coding agent",
    skills: [],
    system: null,
    tools: [],
    version: 1,
  },
  archivedAt: "2026-08-26T02:00:00.000Z",
  createdAt: "2026-08-26T00:00:00.000Z",
  parentThreadId: null,
  sessionId: session.id,
  stats: null,
  status: "terminated",
  updatedAt: "2026-08-26T02:00:00.000Z",
  usage: null,
};

describe("NodeManagedSessionRuntimeAdapter", () => {
  it("uses durable coordination without eagerly binding a Session to this process", async () => {
    const calls: string[] = [];
    const driver: NodeManagedSessionRuntimeDriver = {
      start: async () => { calls.push("start"); },
      stop: async () => { calls.push("stop"); },
      accept: async () => { calls.push("direct_accept"); },
      archiveThread: async () => {},
      subscribe: () => (async function* () {})(),
    };
    const coordination = {
      sessionEventsAccepted: async () => { calls.push("coordinated_accept"); },
      cancelSession: async () => { calls.push("cancel_session"); },
    };
    const adapter = new NodeManagedSessionRuntimeAdapter(driver, coordination);

    await adapter.sessionStarted({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    await adapter.sessionEventsAccepted({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      events: [{
        id: "event_01",
        type: "user.message",
        content: [{ type: "text", text: "Go" }],
        processedAt: "2026-08-26T01:00:00.000Z",
      }],
    });
    await adapter.sessionStopped({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      reason: "deleted",
    });

    expect(calls).toEqual(["coordinated_accept", "cancel_session", "stop"]);
  });

  it("drives Node runtime commands from complete application context", async () => {
    const calls: object[] = [];
    const driver: NodeManagedSessionRuntimeDriver = {
      start: async (input) => { calls.push({ type: "start", ...input }); },
      stop: async (input) => { calls.push({ type: "stop", ...input }); },
      accept: async (input) => { calls.push({ type: "accept", ...input }); },
      archiveThread: async (input) => {
        calls.push({ type: "archive_thread", ...input });
      },
      subscribe: () => (async function* () {})(),
    };
    const adapter = new NodeManagedSessionRuntimeAdapter(driver);

    await adapter.sessionStarted({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    await adapter.sessionEventsAccepted({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      events: [
        {
          id: "event_01",
          type: "user.message",
          content: [{ type: "text", text: "Go" }],
          processedAt: "2026-08-26T01:00:00.000Z",
        },
        {
          id: "event_02",
          type: "system.message",
          content: [{ type: "text", text: "Use the migration checklist" }],
          processedAt: "2026-08-26T01:00:00.000Z",
        },
      ],
    });
    await adapter.sessionThreadArchived({
      workspaceId: "workspace_01",
      sessionId: session.id,
      threadId: thread.id,
      session,
      thread,
    });
    await adapter.sessionStopped({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      reason: "deleted",
    });

    expect(calls).toEqual([
      {
        type: "start",
        workspaceId: "workspace_01",
        sessionId: "session_01",
        session,
        environment,
        initialEvents: [],
      },
      {
        type: "accept",
        workspaceId: "workspace_01",
        sessionId: "session_01",
        session,
        environment,
        events: [
          {
            id: "event_01",
            type: "user.message",
            content: [{ type: "text", text: "Go" }],
            processedAt: "2026-08-26T01:00:00.000Z",
          },
          {
            id: "event_02",
            type: "system.message",
            content: [{ type: "text", text: "Use the migration checklist" }],
            processedAt: "2026-08-26T01:00:00.000Z",
          },
        ],
      },
      {
        type: "archive_thread",
        workspaceId: "workspace_01",
        sessionId: "session_01",
        threadId: "thread_01",
        session,
        thread,
      },
      {
        type: "stop",
        workspaceId: "workspace_01",
        sessionId: "session_01",
        session,
        reason: "deleted",
      },
    ]);
  });

  it("decodes Node runtime publications with the shared official codec", async () => {
    let subscription: unknown;
    const driver: NodeManagedSessionRuntimeDriver = {
      start: async () => {},
      stop: async () => {},
      accept: async () => {},
      archiveThread: async () => {},
      subscribe: (input) => {
        subscription = input;
        return (async function* () {
        yield {
          id: "event_status_01",
          type: "session.status_running",
          processed_at: "2026-08-26T01:00:00.000Z",
        };
        yield {
          type: "agent.message_chunk",
          message_id: "event_message_01",
          delta: "Node",
        };
        })();
      },
    };
    const adapter = new NodeManagedSessionRuntimeAdapter(driver);
    const received = [];
    for await (const event of adapter.subscribe({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      deltaEventTypes: ["agent.message"],
    })) received.push(event);

    expect(subscription).toEqual({
      workspaceId: "workspace_01",
      sessionId: "session_01",
      session,
      deltaEventTypes: ["agent.message"],
    });
    expect(received).toEqual([
      {
        id: "event_status_01",
        type: "session.status_running",
        processedAt: "2026-08-26T01:00:00.000Z",
      },
      {
        type: "event_delta",
        eventId: "event_message_01",
        delta: {
          type: "content_delta",
          content: { type: "text", text: "Node" },
        },
      },
    ]);
  });

  it("drops malformed thread runtime frames at the codec boundary", async () => {
    const driver: NodeManagedSessionRuntimeDriver = {
      start: async () => {},
      stop: async () => {},
      accept: async () => {},
      archiveThread: async () => {},
      subscribe: () => (async function* () {
        yield null;
        yield "malformed";
      })(),
    };
    const adapter = new NodeManagedSessionRuntimeAdapter(driver);
    const received = [];

    for await (const event of adapter.subscribe({
      workspaceId: "workspace_01",
      sessionId: session.id,
      threadId: thread.id,
      session,
      thread,
      deltaEventTypes: ["agent.message"],
    })) received.push(event);

    expect(received).toEqual([]);
  });

  it("depends inward without importing legacy session routing or stores", () => {
    expect(Object.keys(runtimeAdapterSources)).toEqual([
      "../src/lib/node-managed-session-runtime.ts",
    ]);
    const source = Object.values(runtimeAdapterSources)[0] ?? "";
    expect(source).toContain("@open-managed-agents/managed-agents-application");
    expect(source).not.toMatch(
      /@open-managed-agents\/(?:managed-agents-api|session-runtime(?:["/])|services|sessions-store|environments-store|shared)/,
    );
    expect(source).not.toMatch(/@anthropic-ai\/sdk/);
    expect(source).not.toMatch(
      /NodeSessionRouter|SessionRouter|managed_sessions|session_events/,
    );
  });

  it("keeps the managed runner seam strongly typed and free of legacy lookups", () => {
    expect(Object.keys(managedRunnerSources)).toEqual([
      "../src/lib/node-managed-session-runner.ts",
    ]);
    const source = Object.values(managedRunnerSources)[0] ?? "";
    expect(source).not.toMatch(/\b(?:unknown|any|object)\b/);
    expect(source).not.toMatch(
      /NodeSessionRouter|SessionRegistry|managed_sessions|session_events/,
    );
    expect(source).not.toMatch(
      /@open-managed-agents\/(?:managed-agents-api|sessions-store|environments-store|shared)/,
    );
    expect(source).not.toMatch(/@anthropic-ai\/sdk/);
  });
});
