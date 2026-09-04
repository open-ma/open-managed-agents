import { describe, expect, it } from "vitest";
import type {
  Environment,
  RecordSessionRuntimeEventsCommand,
  RecordSessionRuntimeEventsResult,
  Session,
  SessionRuntimeProjectionApplicationPort,
} from "@open-managed-agents/managed-agents-application";
import type {
  SessionRealtimeFrame,
  SessionRealtimeHub,
} from "@open-managed-agents/session-realtime";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";
import { MemorySessionRealtimeHub } from "@open-managed-agents/session-realtime-memory";
import * as runtimeModule from "../src/lib/node-managed-session-runtime.js";

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

const executionFence: SessionExecutionFence = {
  executionId: "event_input_01",
  workspaceId: "workspace_01",
  sessionId: "session_01",
  attemptId: "attempt_01",
  ownerId: "node_01",
  generation: 1,
  expiresAt: "2026-08-26T01:01:00.000Z",
};

interface RuntimeEngine {
  start(
    input: runtimeModule.StartNodeManagedSessionRuntime,
    output: (frame: unknown) => Promise<void>,
  ): Promise<void>;
  stop(input: runtimeModule.StopNodeManagedSessionRuntime): Promise<void>;
  accept(input: runtimeModule.AcceptNodeManagedSessionEvents): Promise<void>;
  archiveThread(
    input: runtimeModule.ArchiveNodeManagedSessionThread,
  ): Promise<void>;
}

interface DriverConstructor {
  new (dependencies: {
    engine: RuntimeEngine;
    realtime: SessionRealtimeHub;
    projectionFor(
      workspaceId: string,
    ): SessionRuntimeProjectionApplicationPort;
  }): runtimeModule.NodeManagedSessionRuntimeDriver;
}

describe("DefaultNodeManagedSessionRuntimeDriver", () => {
  it("commits runtime output under the execution fence that produced it", async () => {
    let emit: ((frame: unknown) => Promise<void>) | undefined;
    const projectionCalls: RecordSessionRuntimeEventsCommand[] = [];
    const engine: RuntimeEngine = {
      start: async (_input, output) => { emit = output; },
      stop: async () => {},
      accept: async () => {
        await emit?.({
          id: "event_status_fenced",
          type: "session.status_running",
          processed_at: "2026-08-26T01:00:00.000Z",
        });
      },
      archiveThread: async () => {},
    };
    const driver = new runtimeModule.DefaultNodeManagedSessionRuntimeDriver({
      engine,
      realtime: new MemorySessionRealtimeHub(),
      projectionFor: () => ({
        recordSessionRuntimeEvents: async (command) => {
          projectionCalls.push(structuredClone(command));
          return { type: "recorded", session };
        },
      }),
    });

    await driver.accept({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      events: [{
        id: "event_input_01",
        type: "user.message",
        content: [{ type: "text", text: "Run" }],
        processedAt: "2026-08-26T00:59:00.000Z",
      }],
      executionFence,
    });

    expect(projectionCalls).toEqual([{
      sessionId: "session_01",
      events: [{
        id: "event_status_fenced",
        type: "session.status_running",
        processedAt: "2026-08-26T01:00:00.000Z",
      }],
      executionFence,
    }]);
  });

  it("fails the producing attempt when its output fence is rejected", async () => {
    let emit: ((frame: unknown) => Promise<void>) | undefined;
    const engine: RuntimeEngine = {
      start: async (_input, output) => { emit = output; },
      stop: async () => {},
      accept: async () => {
        await emit?.({
          id: "event_status_stale",
          type: "session.status_running",
          processed_at: "2026-08-26T01:00:00.000Z",
        });
      },
      archiveThread: async () => {},
    };
    const driver = new runtimeModule.DefaultNodeManagedSessionRuntimeDriver({
      engine,
      realtime: new MemorySessionRealtimeHub(),
      projectionFor: () => ({
        recordSessionRuntimeEvents: async () => ({
          type: "execution_fence_lost",
        }),
      }),
    });

    await expect(driver.accept({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      events: [{
        id: "event_input_01",
        type: "user.message",
        content: [{ type: "text", text: "Run" }],
        processedAt: "2026-08-26T00:59:00.000Z",
      }],
      executionFence,
    })).rejects.toThrow("execution fence was lost");
  });

  it("publishes application-native frames through the injected realtime Port", async () => {
    let emit: ((frame: unknown) => Promise<void>) | undefined;
    const engine: RuntimeEngine = {
      start: async (_input, output) => { emit = output; },
      stop: async () => {},
      accept: async () => {},
      archiveThread: async () => {},
    };
    const published: Array<{
      workspaceId: string;
      sessionId: string;
      frame: SessionRealtimeFrame;
    }> = [];
    const realtime: SessionRealtimeHub = {
      attach: () => () => {},
      publish: (input) => { published.push(structuredClone(input)); },
      closeSession: () => {},
    };
    const driver = new runtimeModule.DefaultNodeManagedSessionRuntimeDriver({
      engine,
      realtime,
      projectionFor: () => ({
        recordSessionRuntimeEvents: async () => ({ type: "recorded", session }),
      }),
    } as ConstructorParameters<DriverConstructor>[0]);
    await driver.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });

    await emit?.({
      id: "event_status_realtime",
      type: "session.status_running",
      processed_at: "2026-08-26T01:00:00.000Z",
    });

    expect(published).toEqual([{
      workspaceId: "workspace_01",
      sessionId: "session_01",
      frame: {
        event: {
          id: "event_status_realtime",
          type: "session.status_running",
          processedAt: "2026-08-26T01:00:00.000Z",
        },
      },
    }]);
  });

  it("projects an official runtime event before publishing it live", async () => {
    const Driver = (
      runtimeModule as typeof runtimeModule & {
        DefaultNodeManagedSessionRuntimeDriver?: DriverConstructor;
      }
    ).DefaultNodeManagedSessionRuntimeDriver;
    expect(Driver).toBeTypeOf("function");
    if (Driver === undefined) return;

    let emit: ((frame: unknown) => Promise<void>) | undefined;
    const engine: RuntimeEngine = {
      start: async (_input, output) => { emit = output; },
      stop: async () => {},
      accept: async () => {},
      archiveThread: async () => {},
    };
    let releaseProjection: (() => void) | undefined;
    const projectionGate = new Promise<void>((resolve) => {
      releaseProjection = resolve;
    });
    const projectionCalls: RecordSessionRuntimeEventsCommand[] = [];
    const projection: SessionRuntimeProjectionApplicationPort = {
      recordSessionRuntimeEvents: async (
        command,
      ): Promise<RecordSessionRuntimeEventsResult> => {
        projectionCalls.push(structuredClone(command));
        await projectionGate;
        return { type: "recorded", session };
      },
    };
    const driver = new Driver({
      engine,
      realtime: new MemorySessionRealtimeHub(),
      projectionFor: (workspaceId) => {
        expect(workspaceId).toBe("workspace_01");
        return projection;
      },
    });
    await driver.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    const iterator = driver.subscribe({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
    })[Symbol.asyncIterator]();
    let delivered = false;
    const delivery = iterator.next().then((result) => {
      delivered = true;
      return result;
    });

    const frame = {
      id: "event_status_01",
      type: "session.status_running",
      processed_at: "2026-08-26T01:00:00.000Z",
    };
    const emitted = emit?.(frame);
    expect(emitted).toBeInstanceOf(Promise);
    await Promise.resolve();
    expect(delivered).toBe(false);
    releaseProjection?.();
    await emitted;

    expect(projectionCalls).toEqual([
      {
        sessionId: "session_01",
        events: [
          {
            id: "event_status_01",
            type: "session.status_running",
            processedAt: "2026-08-26T01:00:00.000Z",
          },
        ],
      },
    ]);
    await expect(delivery).resolves.toEqual({
      value: {
        id: "event_status_01",
        type: "session.status_running",
        processedAt: "2026-08-26T01:00:00.000Z",
      },
      done: false,
    });
    await iterator.return?.();
  });

  it("retries projection version conflicts before publishing", async () => {
    let emit: ((frame: unknown) => Promise<void>) | undefined;
    const engine: RuntimeEngine = {
      start: async (_input, output) => { emit = output; },
      stop: async () => {},
      accept: async () => {},
      archiveThread: async () => {},
    };
    let attempts = 0;
    const projection: SessionRuntimeProjectionApplicationPort = {
      recordSessionRuntimeEvents: async () => {
        attempts += 1;
        return attempts < 3
          ? { type: "version_conflict", message: "concurrent output" }
          : { type: "recorded", session };
      },
    };
    const driver = new runtimeModule.DefaultNodeManagedSessionRuntimeDriver({
      engine,
      realtime: new MemorySessionRealtimeHub(),
      projectionFor: () => projection,
    });
    await driver.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    const iterator = driver.subscribe({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
    })[Symbol.asyncIterator]();
    const delivery = iterator.next();
    const frame = {
      id: "event_status_02",
      type: "session.status_running",
      processed_at: "2026-08-26T02:00:00.000Z",
    };

    await emit?.(frame);

    expect(attempts).toBe(3);
    await expect(delivery).resolves.toEqual({
      value: {
        id: "event_status_02",
        type: "session.status_running",
        processedAt: "2026-08-26T02:00:00.000Z",
      },
      done: false,
    });
    await iterator.return?.();
  });

  it("publishes ephemeral runtime deltas without projecting them", async () => {
    let emit: ((frame: unknown) => Promise<void>) | undefined;
    const engine: RuntimeEngine = {
      start: async (_input, output) => { emit = output; },
      stop: async () => {},
      accept: async () => {},
      archiveThread: async () => {},
    };
    let projectionAttempts = 0;
    const driver = new runtimeModule.DefaultNodeManagedSessionRuntimeDriver({
      engine,
      realtime: new MemorySessionRealtimeHub(),
      projectionFor: () => ({
        recordSessionRuntimeEvents: async () => {
          projectionAttempts += 1;
          return { type: "recorded", session };
        },
      }),
    });
    await driver.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    const iterator = driver.subscribe({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      deltaEventTypes: ["agent.message"],
    })[Symbol.asyncIterator]();
    let delivered = false;
    const delivery = iterator.next().then((result) => {
      delivered = true;
      return result;
    });
    const frame = {
      type: "agent.message_chunk",
      message_id: "event_message_01",
      delta: "Hello",
    };

    await emit?.(frame);
    await Promise.resolve();

    expect(projectionAttempts).toBe(0);
    expect(delivered).toBe(true);
    await expect(delivery).resolves.toEqual({
      value: {
        type: "event_delta",
        eventId: "event_message_01",
        delta: {
          type: "content_delta",
          content: { type: "text", text: "Hello" },
        },
      },
      done: false,
    });
    await iterator.return?.();
  });

  it("stops the engine from the full snapshot and closes live streams", async () => {
    let stopped: runtimeModule.StopNodeManagedSessionRuntime | undefined;
    const engine: RuntimeEngine = {
      start: async () => {},
      stop: async (input) => { stopped = input; },
      accept: async () => {},
      archiveThread: async () => {},
    };
    const driver = new runtimeModule.DefaultNodeManagedSessionRuntimeDriver({
      engine,
      realtime: new MemorySessionRealtimeHub(),
      projectionFor: () => ({
        recordSessionRuntimeEvents: async () => ({
          type: "recorded",
          session,
        }),
      }),
    });
    await driver.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    const iterator = driver.subscribe({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
    })[Symbol.asyncIterator]();
    let closed = false;
    const completion = iterator.next().then((result) => {
      closed = result.done;
      return result;
    });

    await driver.stop({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      reason: "deleted",
    });
    await Promise.resolve();

    expect(stopped).toEqual({
      workspaceId: "workspace_01",
      sessionId: "session_01",
      session,
      reason: "deleted",
    });
    expect(closed).toBe(true);
    await expect(completion).resolves.toEqual({ value: undefined, done: true });
  });

  it("serializes concurrent runtime outputs per session", async () => {
    let emit: ((frame: unknown) => Promise<void>) | undefined;
    const engine: RuntimeEngine = {
      start: async (_input, output) => { emit = output; },
      stop: async () => {},
      accept: async () => {},
      archiveThread: async () => {},
    };
    let releaseFirst: (() => void) | undefined;
    const firstProjection = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted: (() => void) | undefined;
    const firstProjectionStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const projectedIds: string[] = [];
    const driver = new runtimeModule.DefaultNodeManagedSessionRuntimeDriver({
      engine,
      realtime: new MemorySessionRealtimeHub(),
      projectionFor: () => ({
        recordSessionRuntimeEvents: async (command) => {
          const id = command.events[0]?.id;
          if (id !== undefined) projectedIds.push(id);
          if (id === "event_status_01") {
            markFirstStarted?.();
            await firstProjection;
          }
          return { type: "recorded", session };
        },
      }),
    });
    await driver.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    const iterator = driver.subscribe({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
    })[Symbol.asyncIterator]();
    const firstDelivery = iterator.next();
    const first = emit?.({
      id: "event_status_01",
      type: "session.status_running",
      processed_at: "2026-08-26T01:00:00.000Z",
    });
    const second = emit?.({
      id: "event_status_02",
      type: "session.status_running",
      processed_at: "2026-08-26T02:00:00.000Z",
    });
    await firstProjectionStarted;

    expect(projectedIds).toEqual(["event_status_01"]);
    releaseFirst?.();
    await Promise.all([first, second]);
    const secondDelivery = iterator.next();

    await expect(firstDelivery).resolves.toMatchObject({
      value: { id: "event_status_01" },
      done: false,
    });
    await expect(secondDelivery).resolves.toMatchObject({
      value: { id: "event_status_02" },
      done: false,
    });
    expect(projectedIds).toEqual(["event_status_01", "event_status_02"]);
    await iterator.return?.();
  });

  it("drains accepted runtime output before stop completes", async () => {
    let emit: ((frame: unknown) => Promise<void>) | undefined;
    const engine: RuntimeEngine = {
      start: async (_input, output) => { emit = output; },
      stop: async () => {},
      accept: async () => {},
      archiveThread: async () => {},
    };
    let releaseProjection: (() => void) | undefined;
    const projectionGate = new Promise<void>((resolve) => {
      releaseProjection = resolve;
    });
    let markProjectionStarted: (() => void) | undefined;
    const projectionStarted = new Promise<void>((resolve) => {
      markProjectionStarted = resolve;
    });
    const driver = new runtimeModule.DefaultNodeManagedSessionRuntimeDriver({
      engine,
      realtime: new MemorySessionRealtimeHub(),
      projectionFor: () => ({
        recordSessionRuntimeEvents: async () => {
          markProjectionStarted?.();
          await projectionGate;
          return { type: "recorded", session };
        },
      }),
    });
    await driver.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    const output = emit?.({
      id: "event_status_03",
      type: "session.status_running",
      processed_at: "2026-08-26T03:00:00.000Z",
    });
    await projectionStarted;
    let stopped = false;
    const stopping = driver.stop({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      reason: "deleted",
    }).then(() => { stopped = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(stopped).toBe(false);
    releaseProjection?.();
    await Promise.all([output, stopping]);
    expect(stopped).toBe(true);
  });

  it("lazy-starts a fresh engine from accepted event context", async () => {
    const calls: object[] = [];
    const engine: RuntimeEngine = {
      start: async (input) => { calls.push({ type: "start", ...input }); },
      stop: async () => {},
      accept: async (input) => { calls.push({ type: "accept", ...input }); },
      archiveThread: async () => {},
    };
    const driver = new runtimeModule.DefaultNodeManagedSessionRuntimeDriver({
      engine,
      realtime: new MemorySessionRealtimeHub(),
      projectionFor: () => ({
        recordSessionRuntimeEvents: async () => ({
          type: "recorded",
          session,
        }),
      }),
    });
    const event = {
      id: "event_message_01",
      type: "user.message" as const,
      content: [{ type: "text" as const, text: "Resume" }],
      processedAt: "2026-08-26T04:00:00.000Z",
    };

    await driver.accept({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      events: [event],
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
        events: [event],
      },
    ]);
  });

  it("clears runtime ownership when engine stop fails", async () => {
    let starts = 0;
    let failStop = true;
    const engine: RuntimeEngine = {
      start: async () => { starts += 1; },
      stop: async () => {
        if (failStop) {
          failStop = false;
          throw new Error("sandbox shutdown failed");
        }
      },
      accept: async () => {},
      archiveThread: async () => {},
    };
    const driver = new runtimeModule.DefaultNodeManagedSessionRuntimeDriver({
      engine,
      realtime: new MemorySessionRealtimeHub(),
      projectionFor: () => ({
        recordSessionRuntimeEvents: async () => ({
          type: "recorded",
          session,
        }),
      }),
    });
    await driver.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });

    await expect(driver.stop({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      reason: "deleted",
    })).rejects.toThrow("sandbox shutdown failed");
    await driver.accept({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      events: [{
        id: "event_after_failed_stop_01",
        type: "user.message",
        content: [{ type: "text", text: "Restart" }],
        processedAt: "2026-08-26T05:00:00.000Z",
      }],
    });

    expect(starts).toBe(2);
  });

  it("isolates equal session IDs across workspaces for ownership, output, and stop", async () => {
    const outputs = new Map<string, (frame: unknown) => Promise<void>>();
    const engine: RuntimeEngine = {
      start: async (input, output) => {
        outputs.set(input.workspaceId, output);
      },
      stop: async () => {},
      accept: async () => {},
      archiveThread: async () => {},
    };
    const driver = new runtimeModule.DefaultNodeManagedSessionRuntimeDriver({
      engine,
      realtime: new MemorySessionRealtimeHub(),
      projectionFor: () => ({
        recordSessionRuntimeEvents: async () => ({
          type: "recorded",
          session,
        }),
      }),
    });
    const startFor = (workspaceId: string) => driver.start({
      workspaceId,
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    await startFor("workspace_a");
    await startFor("workspace_b");
    expect([...outputs.keys()]).toEqual(["workspace_a", "workspace_b"]);

    const iteratorA = driver.subscribe({
      workspaceId: "workspace_a",
      sessionId: session.id,
      session,
    })[Symbol.asyncIterator]();
    const iteratorB = driver.subscribe({
      workspaceId: "workspace_b",
      sessionId: session.id,
      session,
    })[Symbol.asyncIterator]();
    const deliveryA = iteratorA.next();
    let deliveredB = false;
    const deliveryB = iteratorB.next().then((value) => {
      deliveredB = true;
      return value;
    });
    const frameA = { type: "agent.message_chunk", message_id: "a", delta: "A" };
    await outputs.get("workspace_a")?.(frameA);
    await expect(deliveryA).resolves.toEqual({
      value: {
        type: "event_delta",
        eventId: "a",
        delta: {
          type: "content_delta",
          content: { type: "text", text: "A" },
        },
      },
      done: false,
    });
    await Promise.resolve();
    expect(deliveredB).toBe(false);

    const frameB = { type: "agent.message_chunk", message_id: "b", delta: "B" };
    await outputs.get("workspace_b")?.(frameB);
    await expect(deliveryB).resolves.toEqual({
      value: {
        type: "event_delta",
        eventId: "b",
        delta: {
          type: "content_delta",
          content: { type: "text", text: "B" },
        },
      },
      done: false,
    });

    const closedA = iteratorA.next();
    await driver.stop({
      workspaceId: "workspace_a",
      sessionId: session.id,
      session,
      reason: "deleted",
    });
    await expect(closedA).resolves.toEqual({ value: undefined, done: true });

    const stillLiveB = iteratorB.next();
    const secondFrameB = { type: "agent.message_chunk", message_id: "b2", delta: "B2" };
    await outputs.get("workspace_b")?.(secondFrameB);
    await expect(stillLiveB).resolves.toEqual({
      value: {
        type: "event_delta",
        eventId: "b2",
        delta: {
          type: "content_delta",
          content: { type: "text", text: "B2" },
        },
      },
      done: false,
    });
    await iteratorB.return?.();
  });
});
