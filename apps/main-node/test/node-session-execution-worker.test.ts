import { beforeEach, describe, expect, it } from "vitest";
import type {
  Environment,
  Session,
} from "@open-managed-agents/managed-agents-application";
import type {
  SessionExecutionContextSourcePort,
} from "@open-managed-agents/session-runtime-contract/context";
import {
  ensureSessionExecutionCoordinatorSchema,
  SqlSessionExecutionCoordinator,
} from "@open-managed-agents/session-runtime-sql/coordination";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import {
  NodeSessionExecutionWorker,
  type NodeSessionExecutionRuntime,
  type RunNodeSessionExecution,
} from "../src/lib/node-session-execution-worker";

const session: Session = {
  id: "session_01",
  agent: {
    id: "agent_01",
    description: null,
    mcpServers: [],
    model: { id: "model_01" },
    multiagent: null,
    name: "Agent",
    skills: [],
    system: null,
    tools: [],
    version: 1,
  },
  archivedAt: null,
  budget: null,
  createdAt: "2026-09-04T00:00:00.000Z",
  environmentId: "env_01",
  metadata: {},
  outcomeEvaluations: [],
  resources: [],
  stats: {},
  status: "idle",
  title: "Session",
  updatedAt: "2026-09-04T00:00:00.000Z",
  usage: {},
  vaultIds: [],
};

const environment: Environment = {
  id: "env_01",
  archivedAt: null,
  config: { type: "cloud", networking: { type: "unrestricted" }, packages: {
    apt: [], cargo: [], gem: [], go: [], npm: [], pip: [],
  } },
  createdAt: "2026-09-04T00:00:00.000Z",
  description: null,
  metadata: {},
  name: "Environment",
  updatedAt: "2026-09-04T00:00:00.000Z",
};

function accepted(id: string, type: "user.message" | "user.interrupt" = "user.message") {
  const base = {
    workspaceId: "workspace_01",
    sessionId: session.id,
    session,
    environment,
  };
  return type === "user.interrupt"
    ? {
        ...base,
        events: [{
          id,
          type,
          processedAt: "2026-09-04T00:00:03.000Z",
        }] as const,
      }
    : {
        ...base,
        events: [{
          id,
          type,
          content: [{ type: "text" as const, text: id }],
          processedAt: "2026-09-04T00:00:01.000Z",
        }] as const,
      };
}

describe("NodeSessionExecutionWorker", () => {
  let now: Date;
  let coordinator: SqlSessionExecutionCoordinator;
  let context: SessionExecutionContextSourcePort;
  let runs: RunNodeSessionExecution[];
  let cancellations: string[];
  let runtime: NodeSessionExecutionRuntime;

  beforeEach(async () => {
    now = new Date("2026-09-04T00:00:02.000Z");
    const sql = await createBetterSqlite3SqlClient(":memory:");
    await ensureSessionExecutionCoordinatorSchema(sql);
    coordinator = new SqlSessionExecutionCoordinator(sql);
    context = {
      find: async () => ({ session, environment, revision: 1 }),
    };
    runs = [];
    cancellations = [];
    runtime = {
      run: async (input) => { runs.push(structuredClone(input)); },
      cancel: async (input) => { cancellations.push(input.reason); },
    };
  });

  function worker(ownerId = "node_01", overrides: Partial<ConstructorParameters<typeof NodeSessionExecutionWorker>[0]> = {}) {
    let attempt = 0;
    return new NodeSessionExecutionWorker({
      coordinator,
      context,
      runtime,
      ownerId,
      clock: { now: () => now },
      ids: { nextAttemptId: () => `${ownerId}_attempt_${++attempt}` },
      leaseTtlMs: 30_000,
      heartbeatIntervalMs: 10_000,
      maxConcurrent: 4,
      ...overrides,
    });
  }

  it("durably admits a Managed Event batch and runs it with fresh canonical context", async () => {
    const executor = worker();
    await executor.sessionEventsAccepted(accepted("event_01"));
    await executor.waitForIdle();

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      workspaceId: "workspace_01",
      sessionId: "session_01",
      executionId: "event_01",
      session,
      environment,
      events: [{ id: "event_01" }],
      fence: { ownerId: "node_01", generation: 1 },
    });
    await expect(coordinator.find({
      workspaceId: "workspace_01",
      executionId: "event_01",
    })).resolves.toMatchObject({ state: "completed" });
  });

  it("admits a threaded event into its own execution lane", async () => {
    const executor = worker();
    await executor.sessionEventsAccepted({
      ...accepted("thread_event"),
      events: [{
        ...accepted("thread_event").events[0],
        sessionThreadId: "sthr_child",
      }],
    });
    await executor.waitForIdle();

    await expect(coordinator.find({
      workspaceId: "workspace_01",
      executionId: "thread_event",
    })).resolves.toMatchObject({ laneId: "sthr_child" });
  });

  it("lets only one replica execute a durably admitted batch", async () => {
    await coordinator.admit({
      execution: {
        id: "event_01",
        workspaceId: "workspace_01",
        sessionId: "session_01",
        admittedAt: "2026-09-04T00:00:01.000Z",
        events: [...accepted("event_01").events],
      },
    });
    const nodeA = worker("node_a");
    const nodeB = worker("node_b");
    await Promise.all([nodeA.poll(), nodeB.poll()]);
    await Promise.all([nodeA.waitForIdle(), nodeB.waitForIdle()]);

    expect(runs).toHaveLength(1);
    expect(runs[0]?.fence.ownerId).toMatch(/^node_[ab]$/u);
  });

  it("recovers work whose previous owner lost its lease", async () => {
    await coordinator.admit({
      execution: {
        id: "event_01",
        workspaceId: "workspace_01",
        sessionId: "session_01",
        admittedAt: "2026-09-04T00:00:00.000Z",
        events: [...accepted("event_01").events],
      },
    });
    await coordinator.claim({
      ownerId: "dead_node",
      attemptId: "dead_attempt",
      claimedAt: "2026-09-04T00:00:00.000Z",
      leaseTtlMs: 1_000,
    });
    now = new Date("2026-09-04T00:00:02.000Z");

    const replacement = worker("replacement");
    await replacement.poll();
    await replacement.waitForIdle();

    expect(runs[0]?.fence).toMatchObject({
      ownerId: "replacement",
      generation: 2,
    });
  });

  it("turns a cross-replica interrupt into a durable signal and local cancellation", async () => {
    let release: (() => void) | undefined;
    const running = new Promise<void>((resolve) => { release = resolve; });
    runtime.run = async (input) => {
      runs.push(structuredClone(input));
      await running;
    };
    const executor = worker();
    await executor.sessionEventsAccepted(accepted("event_01"));
    await Promise.resolve();

    await executor.sessionEventsAccepted(accepted("interrupt_01", "user.interrupt"));
    expect(cancellations).toEqual(["interrupt_requested"]);
    release?.();
    await executor.waitForIdle();

    await expect(coordinator.find({
      workspaceId: "workspace_01",
      executionId: "event_01",
    })).resolves.toMatchObject({ state: "cancelled" });
  });

  it("cancels only the thread lane named by an interrupt", async () => {
    const releases: Array<() => void> = [];
    const cancelledExecutions: string[] = [];
    runtime.run = async (input) => {
      runs.push(structuredClone(input));
      await new Promise<void>((resolve) => releases.push(resolve));
    };
    runtime.cancel = async (input) => {
      cancelledExecutions.push(input.executionId);
    };
    const executor = worker();
    await executor.sessionEventsAccepted(accepted("primary"));
    await executor.sessionEventsAccepted({
      ...accepted("sibling"),
      events: [{
        ...accepted("sibling").events[0],
        sessionThreadId: "sthr_sibling",
      }],
    });
    await Promise.resolve();

    await executor.sessionEventsAccepted({
      ...accepted("interrupt_primary", "user.interrupt"),
      events: [{
        ...accepted("interrupt_primary", "user.interrupt").events[0],
        sessionThreadId: "sthr_primary",
      }],
    });

    expect(cancelledExecutions).toEqual(["primary"]);
    for (const release of releases) release();
    await executor.waitForIdle();
  });

  it("cancels the runtime and refuses to settle after losing its fence", async () => {
    let release: (() => void) | undefined;
    const running = new Promise<void>((resolve) => { release = resolve; });
    runtime.run = async (input) => {
      runs.push(structuredClone(input));
      await running;
    };
    const executor = worker("node_01", {
      heartbeatIntervalMs: 5,
      leaseTtlMs: 50,
      coordinator: {
        ...coordinator,
        admit: coordinator.admit.bind(coordinator),
        claim: coordinator.claim.bind(coordinator),
        find: coordinator.find.bind(coordinator),
        requestInterrupt: coordinator.requestInterrupt.bind(coordinator),
        cancelSession: coordinator.cancelSession.bind(coordinator),
        settle: coordinator.settle.bind(coordinator),
        renew: async () => ({ type: "lost" }),
      },
    });
    await executor.sessionEventsAccepted(accepted("event_01"));
    await new Promise((resolve) => setTimeout(resolve, 15));

    expect(cancellations).toContain("lease_lost");
    release?.();
    await executor.waitForIdle();
    await expect(coordinator.find({
      workspaceId: "workspace_01",
      executionId: "event_01",
    })).resolves.toMatchObject({ state: "running" });
  });

  it("treats an indeterminate heartbeat error as lost ownership", async () => {
    let release: (() => void) | undefined;
    const running = new Promise<void>((resolve) => { release = resolve; });
    const backgroundErrors: Error[] = [];
    runtime.run = async (input) => {
      runs.push(structuredClone(input));
      await running;
    };
    const executor = worker("node_01", {
      heartbeatIntervalMs: 5,
      leaseTtlMs: 50,
      onError: (error) => backgroundErrors.push(error),
      coordinator: {
        ...coordinator,
        admit: coordinator.admit.bind(coordinator),
        claim: coordinator.claim.bind(coordinator),
        find: coordinator.find.bind(coordinator),
        requestInterrupt: coordinator.requestInterrupt.bind(coordinator),
        cancelSession: coordinator.cancelSession.bind(coordinator),
        settle: coordinator.settle.bind(coordinator),
        renew: async () => { throw new Error("database unavailable"); },
      },
    });
    await executor.sessionEventsAccepted(accepted("event_01"));
    await new Promise((resolve) => setTimeout(resolve, 15));

    expect(cancellations).toContain("lease_lost");
    expect(backgroundErrors).toMatchObject([{ message: "database unavailable" }]);
    release?.();
    await executor.waitForIdle();
  });

  it("validates scheduler bounds and makes start/stop idempotent", async () => {
    expect(() => worker("node_01", {
      heartbeatIntervalMs: 30_000,
      leaseTtlMs: 30_000,
    })).toThrow("heartbeat must be shorter");
    expect(() => worker("node_01", { maxConcurrent: 0 })).toThrow(
      "maxConcurrent must be a positive integer",
    );

    const errors: Error[] = [];
    const executor = worker("node_01", {
      pollIntervalMs: 2,
      onError: (error) => errors.push(error),
      coordinator: {
        ...coordinator,
        admit: coordinator.admit.bind(coordinator),
        renew: coordinator.renew.bind(coordinator),
        settle: coordinator.settle.bind(coordinator),
        find: coordinator.find.bind(coordinator),
        requestInterrupt: coordinator.requestInterrupt.bind(coordinator),
        cancelSession: coordinator.cancelSession.bind(coordinator),
        claim: async () => { throw new Error("poll failed"); },
      },
    });
    executor.start();
    executor.start();
    await new Promise((resolve) => setTimeout(resolve, 8));
    executor.stop();
    executor.stop();
    expect(errors.some((error) => error.message === "poll failed")).toBe(true);
  });

  it("ignores empty and control-only batches and exposes admission conflicts", async () => {
    const executor = worker();
    await executor.sessionEventsAccepted({
      ...accepted("unused"),
      events: [],
    });
    await executor.sessionEventsAccepted({
      ...accepted("unused"),
      events: [{
        id: "system_01",
        type: "system.message",
        content: [{ type: "text", text: "metadata only" }],
        processedAt: "2026-09-04T00:00:01.000Z",
      }],
    });
    expect(runs).toEqual([]);

    await executor.sessionEventsAccepted(accepted("event_conflict"));
    await executor.waitForIdle();
    await expect(executor.sessionEventsAccepted({
      ...accepted("event_conflict"),
      events: [{
        ...accepted("event_conflict").events[0],
        content: [{ type: "text", text: "different payload" }],
      }],
    })).rejects.toThrow("conflicts with an existing admission");
  });

  it("settles missing context and runtime failures without stranding FIFO", async () => {
    const missing = worker("node_missing", {
      context: { find: async () => null },
    });
    await missing.sessionEventsAccepted(accepted("event_missing"));
    await missing.waitForIdle();
    await expect(coordinator.find({
      workspaceId: "workspace_01",
      executionId: "event_missing",
    })).resolves.toMatchObject({
      state: "failed",
      failure: "Session session_01 execution context was not found",
    });

    runtime.run = async () => { throw "string failure"; };
    const failing = worker("node_failure");
    await failing.sessionEventsAccepted(accepted("event_failure"));
    await failing.waitForIdle();
    await expect(coordinator.find({
      workspaceId: "workspace_01",
      executionId: "event_failure",
    })).resolves.toMatchObject({ state: "failed", failure: "string failure" });
  });

  it("cancels active work when the Session is stopped", async () => {
    let release: (() => void) | undefined;
    runtime.run = async (input) => {
      runs.push(structuredClone(input));
      await new Promise<void>((resolve) => { release = resolve; });
    };
    const executor = worker();
    await executor.sessionEventsAccepted(accepted("event_stop"));
    await Promise.resolve();

    await executor.cancelSession({
      workspaceId: "workspace_01",
      sessionId: "session_01",
      reason: "Session archived",
    });
    expect(cancellations).toEqual(["session_stopped"]);
    release?.();
    await executor.waitForIdle();
    await expect(coordinator.find({
      workspaceId: "workspace_01",
      executionId: "event_stop",
    })).resolves.toMatchObject({ state: "cancelled" });
  });

  it("observes a cross-replica interrupt through a successful heartbeat", async () => {
    let release: (() => void) | undefined;
    runtime.run = async (input) => {
      runs.push(structuredClone(input));
      await new Promise<void>((resolve) => { release = resolve; });
    };
    const executor = worker("node_heartbeat", {
      heartbeatIntervalMs: 5,
      leaseTtlMs: 50,
      coordinator: {
        ...coordinator,
        admit: coordinator.admit.bind(coordinator),
        claim: coordinator.claim.bind(coordinator),
        find: coordinator.find.bind(coordinator),
        requestInterrupt: coordinator.requestInterrupt.bind(coordinator),
        cancelSession: coordinator.cancelSession.bind(coordinator),
        settle: coordinator.settle.bind(coordinator),
        renew: async ({ fence }) => ({
          type: "renewed",
          fence: { ...fence, expiresAt: "2026-09-04T00:01:00.000Z" },
          interruptRequestedAt: "2026-09-04T00:00:03.000Z",
        }),
      },
    });
    await executor.sessionEventsAccepted(accepted("event_remote_interrupt"));
    await new Promise((resolve) => setTimeout(resolve, 15));

    expect(cancellations).toContain("interrupt_requested");
    release?.();
    await executor.waitForIdle();
  });

  it("refreshes the fence reference shared with a long-running runtime", async () => {
    let release: (() => void) | undefined;
    let observedFence: RunNodeSessionExecution["fence"] | undefined;
    runtime.run = async (input) => {
      observedFence = input.fence;
      await new Promise<void>((resolve) => { release = resolve; });
    };
    const executor = worker("node_fence_refresh", {
      heartbeatIntervalMs: 5,
      leaseTtlMs: 50,
      coordinator: {
        ...coordinator,
        admit: coordinator.admit.bind(coordinator),
        claim: coordinator.claim.bind(coordinator),
        find: coordinator.find.bind(coordinator),
        requestInterrupt: coordinator.requestInterrupt.bind(coordinator),
        cancelSession: coordinator.cancelSession.bind(coordinator),
        settle: coordinator.settle.bind(coordinator),
        renew: async ({ fence }) => ({
          type: "renewed" as const,
          fence: { ...fence, expiresAt: "2026-09-04T00:01:00.000Z" },
          interruptRequestedAt: null,
        }),
      },
    });
    await executor.sessionEventsAccepted(accepted("event_fence_refresh"));
    await new Promise((resolve) => setTimeout(resolve, 15));

    expect(observedFence?.expiresAt).toBe("2026-09-04T00:01:00.000Z");
    release?.();
    await executor.waitForIdle();
  });

  it("cancels a completed local attempt when settlement loses its fence", async () => {
    const executor = worker("node_settle_lost", {
      coordinator: {
        ...coordinator,
        admit: coordinator.admit.bind(coordinator),
        claim: coordinator.claim.bind(coordinator),
        renew: coordinator.renew.bind(coordinator),
        find: coordinator.find.bind(coordinator),
        requestInterrupt: coordinator.requestInterrupt.bind(coordinator),
        cancelSession: coordinator.cancelSession.bind(coordinator),
        settle: async () => ({ type: "lost" }),
      },
    });
    await executor.sessionEventsAccepted(accepted("event_settle_lost"));
    await executor.waitForIdle();

    expect(cancellations).toEqual(["lease_lost"]);
  });
});
