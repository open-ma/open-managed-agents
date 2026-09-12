import { describe, expect, it } from "vitest";
import type { Environment } from "../src/domain/environment";
import type { EnvironmentWork } from "@open-managed-agents/domain/environment-work";
import type {
  EnvironmentWorkStore,
  StoredEnvironmentWork,
} from "@open-managed-agents/environment-work-store";
import type { Session } from "../src/domain/session";
import { EnvironmentWorkApplicationService } from "../src/environment-work/application";
import type { EnvironmentWorkAvailabilityWaiterPort } from "../src/environment-work/availability-waiter";
import type { EnvironmentWorkEnvironmentSourcePort } from "../src/environment-work/environment-source";
import { EnvironmentWorkEnqueuerService } from "../src/environment-work/enqueuer-application";

const environment: Environment = {
  id: "env_self_01",
  archivedAt: null,
  config: { type: "self_hosted" },
  createdAt: "2026-08-26T09:00:00.000Z",
  description: null,
  metadata: {},
  name: "Self hosted",
  updatedAt: "2026-08-26T09:00:00.000Z",
};

const work: EnvironmentWork = {
  id: "work_01",
  acknowledgedAt: null,
  createdAt: "2026-08-26T09:10:00.000Z",
  data: { type: "session", id: "session_01" },
  environmentId: "env_self_01",
  latestHeartbeatAt: null,
  metadata: { shard: "a", old: "remove" },
  startedAt: null,
  state: "queued",
  stopRequestedAt: null,
  stoppedAt: null,
};

const stored: StoredEnvironmentWork = {
  work,
  secret: {
    sessionsToken: "sk-ant-req-session-token",
    apiBaseUrl: "https://openma.test",
  },
  claim: null,
  heartbeatTtlSeconds: 90,
  revision: 3,
};

const session: Session = {
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
};

function makeDependencies(overrides: {
  environments?: Partial<EnvironmentWorkEnvironmentSourcePort>;
  store?: Partial<EnvironmentWorkStore>;
  availability?: Partial<EnvironmentWorkAvailabilityWaiterPort>;
} = {}) {
  const unexpected = (operation: string) => async () => {
    throw new Error(`unexpected ${operation} call`);
  };
  return {
    workspaceId: "workspace_01",
    environments: {
      find: unexpected("find environment"),
      ...overrides.environments,
    } satisfies EnvironmentWorkEnvironmentSourcePort,
    store: {
      insert: unexpected("insert work"),
      find: unexpected("find work"),
      findActiveSession: unexpected("find active Session work"),
      list: unexpected("list work"),
      replace: unexpected("replace work"),
      claimAvailable: unexpected("claim available work"),
      queueStats: unexpected("get work queue stats"),
      ...overrides.store,
    } satisfies EnvironmentWorkStore,
    availability: {
      wait: unexpected("wait for work availability"),
      ...overrides.availability,
    } satisfies EnvironmentWorkAvailabilityWaiterPort,
    credentials: {
      issue: unexpected("issue credential"),
      bindToClaim: async ({ secret }: { secret: typeof stored.secret }) => ({ secret }),
    },
    clock: { now: () => new Date("2026-08-26T09:20:00.000Z") },
  };
}

describe("Environment Work application", () => {
  it("enqueues a complete self-hosted Session work aggregate with an issued credential", async () => {
    const credentialCalls: object[] = [];
    const insertCalls: object[] = [];
    const wakeupCalls: object[] = [];
    const queuedWork: EnvironmentWork = {
      ...work,
      createdAt: "2026-08-26T09:20:00.000Z",
      metadata: {},
    };
    const enqueuer = new EnvironmentWorkEnqueuerService({
      workspaceId: "workspace_01",
      store: {
        ...makeDependencies().store,
        insert: async (input) => {
          insertCalls.push(input);
          return { ...input.record, revision: 1 };
        },
      },
      credentials: {
        issue: async (input) => {
          credentialCalls.push(input);
          return { type: "issued", secret: stored.secret };
        },
        bindToClaim: async ({ secret }) => ({ secret }),
      },
      wakeup: {
        notifyRunStarted: async (input) => {
          wakeupCalls.push(input);
        },
      },
      clock: { now: () => new Date("2026-08-26T09:20:00.000Z") },
      ids: { nextEnvironmentWorkId: () => "work_01" },
    });

    await expect(
      enqueuer.enqueue({
        workspaceId: "workspace_01",
        environment,
        session,
      }),
    ).resolves.toEqual({ type: "queued", work: queuedWork });
    expect(credentialCalls).toEqual([
      { workspaceId: "workspace_01", workId: "work_01", environment, session },
    ]);
    expect(insertCalls).toEqual([
      {
        workspaceId: "workspace_01",
        record: {
          work: queuedWork,
          secret: stored.secret,
          claim: null,
          heartbeatTtlSeconds: 90,
        },
      },
    ]);
    expect(wakeupCalls).toEqual([{
      workspaceId: "workspace_01",
      environmentId: "env_self_01",
      sessionId: "session_01",
      workId: "work_01",
      occurredAt: "2026-08-26T09:20:00.000Z",
    }]);
  });

  it("keeps durable work queued when the best-effort webhook delivery fails", async () => {
    let inserted = false;
    const enqueuer = new EnvironmentWorkEnqueuerService({
      workspaceId: "workspace_01",
      store: {
        ...makeDependencies().store,
        insert: async (input) => {
          inserted = true;
          return { ...input.record, revision: 1 };
        },
      },
      credentials: {
        issue: async () => ({ type: "issued", secret: stored.secret }),
        bindToClaim: async ({ secret }) => ({ secret }),
      },
      wakeup: {
        notifyRunStarted: async () => {
          throw new Error("injected webhook outage");
        },
      },
      clock: { now: () => new Date("2026-08-26T09:20:00.000Z") },
      ids: { nextEnvironmentWorkId: () => "work_01" },
    });

    await expect(enqueuer.enqueue({
      workspaceId: "workspace_01",
      environment,
      session,
    })).resolves.toMatchObject({
      type: "queued",
      work: { id: "work_01", state: "queued" },
    });
    expect(inserted).toBe(true);
  });

  it("requests graceful shutdown for the active work of a stopped Session", async () => {
    const active = {
      ...stored,
      work: {
        ...work,
        acknowledgedAt: "2026-08-26T09:19:00.000Z",
        latestHeartbeatAt: "2026-08-26T09:19:30.000Z",
        startedAt: "2026-08-26T09:19:00.000Z",
        state: "active" as const,
      },
    } satisfies StoredEnvironmentWork;
    const enqueuer = new EnvironmentWorkEnqueuerService({
      workspaceId: "workspace_01",
      store: {
        ...makeDependencies().store,
        findActiveSession: async () => active,
        replace: async (input) => ({
          type: "replaced",
          record: { ...input.next, revision: 4 },
        }),
      },
      credentials: {
        issue: async () => {
          throw new Error("unexpected credential issue");
        },
        bindToClaim: async ({ secret }) => ({ secret }),
      },
      wakeup: { notifyRunStarted: async () => {} },
      clock: { now: () => new Date("2026-08-26T09:20:00.000Z") },
      ids: { nextEnvironmentWorkId: () => "work_unexpected" },
    });

    await expect(
      enqueuer.stop({
        workspaceId: "workspace_01",
        session,
        reason: "deleted",
      }),
    ).resolves.toEqual({
      type: "stopped",
      work: {
        ...active.work,
        state: "stopping",
        stopRequestedAt: "2026-08-26T09:20:00.000Z",
      },
    });
  });

  it("retrieves and paginates work without exposing its session credential", async () => {
    const listCalls: object[] = [];
    const service = new EnvironmentWorkApplicationService(
      makeDependencies({
        environments: { find: async () => environment },
        store: {
          find: async () => stored,
          list: async (input) => {
            listCalls.push(input);
            return [stored];
          },
        },
      }),
    );

    await expect(
      service.retrieveEnvironmentWork({
        environmentId: "env_self_01",
        workId: "work_01",
      }),
    ).resolves.toEqual({
      type: "found",
      work: { ...work, secret: null },
    });
    await expect(
      service.listEnvironmentWork({
        environmentId: "env_self_01",
        pageSize: 10,
      }),
    ).resolves.toEqual({
      type: "page",
      page: { workItems: [{ ...work, secret: null }], nextCursor: null },
    });
    expect(listCalls).toEqual([
      {
        workspaceId: "workspace_01",
        environmentId: "env_self_01",
        limit: 11,
      },
    ]);
  });

  it("validates a merged metadata patch before replacing the complete record", async () => {
    const replaceCalls: object[] = [];
    const service = new EnvironmentWorkApplicationService(
      makeDependencies({
        store: {
          find: async () => stored,
          replace: async (input) => {
            replaceCalls.push(input);
            return {
              type: "replaced",
              record: { ...input.next, revision: input.expectedRevision + 1 },
            };
          },
        },
      }),
    );

    await expect(
      service.updateEnvironmentWork({
        environmentId: "env_self_01",
        workId: "work_01",
        metadata: { shard: "b", old: null },
      }),
    ).resolves.toEqual({
      type: "updated",
      work: { ...work, metadata: { shard: "b" }, secret: null },
    });
    expect(replaceCalls).toEqual([
      {
        workspaceId: "workspace_01",
        environmentId: "env_self_01",
        workId: "work_01",
        expectedRevision: 3,
        next: {
          work: { ...work, metadata: { shard: "b" } },
          secret: stored.secret,
          claim: null,
          heartbeatTtlSeconds: 90,
        },
      },
    ]);
  });

  it("waits once, atomically claims work, and exposes the credential only on poll", async () => {
    const claimCalls: object[] = [];
    const waitCalls: object[] = [];
    const claimed = {
      ...stored,
      claim: {
        claimedAt: "2026-08-26T09:20:00.000Z",
        workerId: "worker_01",
      },
      revision: 4,
    } satisfies StoredEnvironmentWork;
    let attempt = 0;
    const service = new EnvironmentWorkApplicationService(
      makeDependencies({
        environments: { find: async () => environment },
        store: {
          claimAvailable: async (input) => {
            claimCalls.push(input);
            attempt += 1;
            return attempt === 1
              ? { type: "empty" }
              : { type: "claimed", record: claimed };
          },
          replace: async (input) => ({
            type: "replaced",
            record: { ...input.next, revision: input.expectedRevision + 1 },
          }),
        },
        availability: {
          wait: async (input) => {
            waitCalls.push(input);
          },
        },
      }),
    );

    await expect(
      service.pollEnvironmentWork({
        environmentId: "env_self_01",
        blockMilliseconds: 500,
        reclaimOlderThanMilliseconds: 5_000,
        workerId: "worker_01",
      }),
    ).resolves.toEqual({
      type: "work",
      work: { ...work, secret: stored.secret },
    });
    expect(claimCalls).toEqual([
      {
        workspaceId: "workspace_01",
        environmentId: "env_self_01",
        claimedAt: "2026-08-26T09:20:00.000Z",
        reclaimBefore: "2026-08-26T09:19:55.000Z",
        workerId: "worker_01",
        heartbeatTtlSeconds: 90,
      },
      {
        workspaceId: "workspace_01",
        environmentId: "env_self_01",
        claimedAt: "2026-08-26T09:20:00.000Z",
        reclaimBefore: "2026-08-26T09:19:55.000Z",
        workerId: "worker_01",
        heartbeatTtlSeconds: 90,
      },
    ]);
    expect(waitCalls).toEqual([
      {
        workspaceId: "workspace_01",
        environmentId: "env_self_01",
        maximumWaitMilliseconds: 500,
      },
    ]);
  });

  it("binds a fresh sessions token to the claimed Work before exposing it", async () => {
    const claimed = {
      ...stored,
      claim: {
        claimedAt: "2026-08-26T09:20:00.000Z",
        workerId: "worker_01",
      },
      revision: 4,
    } satisfies StoredEnvironmentWork;
    const replacementCalls: object[] = [];
    const service = new EnvironmentWorkApplicationService({
      ...makeDependencies({
        environments: { find: async () => environment },
        store: {
          claimAvailable: async () => ({ type: "claimed", record: claimed }),
          replace: async (input) => {
            replacementCalls.push(input);
            return {
              type: "replaced" as const,
              record: { ...input.next, revision: 5 },
            };
          },
        },
      }),
      credentials: {
        issue: async () => {
          throw new Error("unexpected initial credential issue");
        },
        bindToClaim: async () => ({
          secret: {
            ...stored.secret,
            sessionsToken: "sk-ant-req-claim-bound-token",
          },
        }),
      },
    } as never);

    await expect(service.pollEnvironmentWork({
      environmentId: "env_self_01",
      workerId: "worker_01",
    })).resolves.toEqual({
      type: "work",
      work: {
        ...work,
        secret: {
          ...stored.secret,
          sessionsToken: "sk-ant-req-claim-bound-token",
        },
      },
    });
    expect(replacementCalls).toEqual([{
      workspaceId: "workspace_01",
      environmentId: "env_self_01",
      workId: "work_01",
      expectedRevision: 4,
      next: {
        work,
        secret: {
          ...stored.secret,
          sessionsToken: "sk-ant-req-claim-bound-token",
        },
        claim: claimed.claim,
        heartbeatTtlSeconds: 90,
      },
    }]);
  });

  it("acknowledges a claimed item under optimistic concurrency", async () => {
    const claimed = {
      ...stored,
      claim: {
        claimedAt: "2026-08-26T09:19:59.000Z",
        workerId: "worker_01",
      },
    } satisfies StoredEnvironmentWork;
    const service = new EnvironmentWorkApplicationService(
      makeDependencies({
        store: {
          find: async () => claimed,
          replace: async (input) => ({
            type: "replaced",
            record: { ...input.next, revision: 4 },
          }),
        },
      }),
    );

    await expect(
      service.acknowledgeEnvironmentWork({
        environmentId: "env_self_01",
        workId: "work_01",
      }),
    ).resolves.toEqual({
      type: "acknowledged",
      work: {
        ...work,
        acknowledgedAt: "2026-08-26T09:20:00.000Z",
        state: "starting",
        secret: null,
      },
    });
  });

  it("conditionally records the first heartbeat and activates the lease", async () => {
    const starting = {
      ...stored,
      work: {
        ...work,
        acknowledgedAt: "2026-08-26T09:19:59.000Z",
        state: "starting" as const,
      },
    } satisfies StoredEnvironmentWork;
    const service = new EnvironmentWorkApplicationService(
      makeDependencies({
        store: {
          find: async () => starting,
          replace: async (input) => ({
            type: "replaced",
            record: { ...input.next, revision: 4 },
          }),
        },
      }),
    );

    await expect(
      service.heartbeatEnvironmentWork({
        environmentId: "env_self_01",
        workId: "work_01",
        desiredTtlSeconds: 30,
        expectedLastHeartbeat: "NO_HEARTBEAT",
      }),
    ).resolves.toEqual({
      type: "recorded",
      heartbeat: {
        lastHeartbeat: "2026-08-26T09:20:00.000Z",
        leaseExtended: true,
        state: "active",
        ttlSeconds: 30,
      },
    });
  });

  it("records a stopping heartbeat without inventing a work start", async () => {
    const replaceCalls: object[] = [];
    const stopping = {
      ...stored,
      work: {
        ...work,
        acknowledgedAt: "2026-08-26T09:19:59.000Z",
        state: "stopping" as const,
        stopRequestedAt: "2026-08-26T09:19:59.500Z",
      },
    } satisfies StoredEnvironmentWork;
    const service = new EnvironmentWorkApplicationService(
      makeDependencies({
        store: {
          find: async () => stopping,
          replace: async (input) => {
            replaceCalls.push(input);
            return {
              type: "replaced",
              record: { ...input.next, revision: 4 },
            };
          },
        },
      }),
    );

    await expect(
      service.heartbeatEnvironmentWork({
        environmentId: "env_self_01",
        workId: "work_01",
        desiredTtlSeconds: 30,
        expectedLastHeartbeat: "NO_HEARTBEAT",
      }),
    ).resolves.toEqual({
      type: "recorded",
      heartbeat: {
        lastHeartbeat: "2026-08-26T09:20:00.000Z",
        leaseExtended: false,
        state: "stopping",
        ttlSeconds: 30,
      },
    });
    expect(replaceCalls).toEqual([
      expect.objectContaining({
        next: expect.objectContaining({
          work: expect.objectContaining({
            state: "stopping",
            startedAt: null,
            latestHeartbeatAt: "2026-08-26T09:20:00.000Z",
          }),
        }),
      }),
    ]);
  });

  it("force-stops work and reports queue statistics for an existing environment", async () => {
    const active = {
      ...stored,
      work: {
        ...work,
        acknowledgedAt: "2026-08-26T09:19:00.000Z",
        latestHeartbeatAt: "2026-08-26T09:19:30.000Z",
        startedAt: "2026-08-26T09:19:00.000Z",
        state: "active" as const,
      },
    } satisfies StoredEnvironmentWork;
    const service = new EnvironmentWorkApplicationService(
      makeDependencies({
        environments: { find: async () => environment },
        store: {
          find: async () => active,
          replace: async (input) => ({
            type: "replaced",
            record: { ...input.next, revision: 4 },
          }),
          queueStats: async () => ({
            depth: 2,
            oldestQueuedAt: "2026-08-26T09:10:00.000Z",
            pending: 1,
            workersPolling: 3,
          }),
        },
      }),
    );

    await expect(
      service.stopEnvironmentWork({
        environmentId: "env_self_01",
        workId: "work_01",
        force: true,
      }),
    ).resolves.toEqual({
      type: "stopped",
      work: {
        ...active.work,
        state: "stopped",
        stopRequestedAt: "2026-08-26T09:20:00.000Z",
        stoppedAt: "2026-08-26T09:20:00.000Z",
        secret: null,
      },
    });
    await expect(
      service.getEnvironmentWorkQueueStats({
        environmentId: "env_self_01",
      }),
    ).resolves.toEqual({
      type: "found",
      stats: {
        depth: 2,
        oldestQueuedAt: "2026-08-26T09:10:00.000Z",
        pending: 1,
        workersPolling: 3,
      },
    });
  });
});
