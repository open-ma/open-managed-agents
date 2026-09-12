import { describe, expect, it } from "vitest";
import {
  isCurrentEnvironmentWorkClaim,
  type EnvironmentWorkRecord,
} from "@open-managed-agents/environment-work-store";
import { MemoryEnvironmentWorkStore } from "../src/index";

function record(id: string, createdAt: string, sessionId = `session_${id}`): EnvironmentWorkRecord {
  return {
    work: {
      id,
      acknowledgedAt: null,
      createdAt,
      data: { type: "session", id: sessionId },
      environmentId: "env_01",
      latestHeartbeatAt: null,
      metadata: {},
      startedAt: null,
      state: "queued",
      stopRequestedAt: null,
      stoppedAt: null,
    },
    secret: { sessionsToken: `secret_${id}` },
    claim: null,
    heartbeatTtlSeconds: 90,
  };
}

describe("MemoryEnvironmentWorkStore", () => {
  it("lets the current worker control an expired lease without allowing Session writes", async () => {
    const store = new MemoryEnvironmentWorkStore();
    const currentToken = "secret_current";
    const active: EnvironmentWorkRecord = {
      ...record("work_01", "2026-08-26T09:00:00.000Z", "session_01"),
      work: {
        ...record("work_01", "2026-08-26T09:00:00.000Z", "session_01").work,
        acknowledgedAt: "2026-08-26T09:00:01.000Z",
        startedAt: "2026-08-26T09:00:02.000Z",
        state: "active",
      },
      secret: { sessionsToken: currentToken },
      claim: {
        claimedAt: "2026-08-26T09:00:00.000Z",
        workerId: "worker_current",
        generation: 1,
      },
      heartbeatTtlSeconds: 30,
    };
    await store.insert({ workspaceId: "workspace_a", record: active });

    const authenticate = (path: string, token = currentToken) =>
      isCurrentEnvironmentWorkClaim(
        { store, now: () => new Date("2026-08-26T09:00:31.000Z") },
        {
          workspaceId: "workspace_a",
          environmentId: "env_01",
          sessionId: "session_01",
          workId: "work_01",
          claimedAt: "2026-08-26T09:00:00.000Z",
          generation: 1,
          token,
          method: "POST",
          path,
        },
      );

    await expect(authenticate(
      "/v1/environments/env_01/work/work_01/heartbeat",
    )).resolves.toBe(true);
    await expect(authenticate(
      "/v1/sessions/session_01/events",
    )).resolves.toBe(false);
    await expect(authenticate(
      "/v1/environments/env_01/work/work_01/heartbeat",
      "secret_stale",
    )).resolves.toBe(false);
  });

  it("isolates workspaces and protects records with revision CAS", async () => {
    const store = new MemoryEnvironmentWorkStore();
    const initial = record("work_01", "2026-08-26T09:00:00.000Z");
    await expect(store.insert({ workspaceId: "workspace_a", record: initial }))
      .resolves.toEqual({ ...initial, revision: 1 });
    await expect(store.find({
      workspaceId: "workspace_b",
      environmentId: "env_01",
      workId: "work_01",
    })).resolves.toBeNull();

    const next = {
      ...initial,
      work: { ...initial.work, metadata: { shard: "b" } },
    };
    await expect(store.replace({
      workspaceId: "workspace_a",
      environmentId: "env_01",
      workId: "work_01",
      expectedRevision: 1,
      next,
    })).resolves.toEqual({
      type: "replaced",
      record: { ...next, revision: 2 },
    });
    await expect(store.replace({
      workspaceId: "workspace_a",
      environmentId: "env_01",
      workId: "work_01",
      expectedRevision: 1,
      next: initial,
    })).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
  });

  it("claims the oldest available work and reports queue/worker state", async () => {
    const store = new MemoryEnvironmentWorkStore();
    const first = record("work_01", "2026-08-26T09:00:00.000Z", "session_01");
    const second = record("work_02", "2026-08-26T09:01:00.000Z", "session_02");
    await store.insert({ workspaceId: "workspace_a", record: first });
    await store.insert({ workspaceId: "workspace_a", record: second });

    const claimed = await store.claimAvailable({
      workspaceId: "workspace_a",
      environmentId: "env_01",
      claimedAt: "2026-08-26T09:02:00.000Z",
      reclaimBefore: "2026-08-26T09:01:55.000Z",
      workerId: "worker_01",
      heartbeatTtlSeconds: 90,
    });
    expect(claimed).toMatchObject({
      type: "claimed",
      record: {
        work: { id: "work_01" },
        claim: { workerId: "worker_01" },
        revision: 2,
      },
    });
    await expect(store.findActiveSession({
      workspaceId: "workspace_a",
      sessionId: "session_01",
    })).resolves.toMatchObject({ work: { id: "work_01" } });
    await expect(store.list({
      workspaceId: "workspace_a",
      environmentId: "env_01",
      limit: 10,
    })).resolves.toMatchObject([
      { work: { id: "work_02" } },
      { work: { id: "work_01" } },
    ]);
    await expect(store.queueStats({
      workspaceId: "workspace_a",
      environmentId: "env_01",
      workerActiveSince: "2026-08-26T09:01:30.000Z",
    })).resolves.toEqual({
      depth: 1,
      oldestQueuedAt: "2026-08-26T09:00:00.000Z",
      pending: 1,
      workersPolling: 1,
    });
  });

  it.each([
    {
      state: "starting" as const,
      acknowledgedAt: "2026-08-26T09:02:00.000Z",
      latestHeartbeatAt: null,
      startedAt: null,
    },
    {
      state: "active" as const,
      acknowledgedAt: "2026-08-26T09:01:00.000Z",
      latestHeartbeatAt: "2026-08-26T09:02:00.000Z",
      startedAt: "2026-08-26T09:01:01.000Z",
    },
  ])("requeues an expired $state lease for exactly one replacement worker", async (lifecycle) => {
    const store = new MemoryEnvironmentWorkStore();
    const expired: EnvironmentWorkRecord = {
      ...record("work_expired", "2026-08-26T09:00:00.000Z"),
      work: {
        ...record("work_expired", "2026-08-26T09:00:00.000Z").work,
        ...lifecycle,
      },
      claim: {
        claimedAt: "2026-08-26T09:02:00.000Z",
        workerId: "worker_dead",
        generation: 1,
      },
      heartbeatTtlSeconds: 30,
    };
    await store.insert({ workspaceId: "workspace_a", record: expired });

    const [first, second] = await Promise.all([
      store.claimAvailable({
        workspaceId: "workspace_a",
        environmentId: "env_01",
        claimedAt: "2026-08-26T09:02:30.001Z",
        reclaimBefore: "2026-08-26T09:02:25.001Z",
        workerId: "worker_replacement_a",
        heartbeatTtlSeconds: 90,
      }),
      store.claimAvailable({
        workspaceId: "workspace_a",
        environmentId: "env_01",
        claimedAt: "2026-08-26T09:02:30.001Z",
        reclaimBefore: "2026-08-26T09:02:25.001Z",
        workerId: "worker_replacement_b",
        heartbeatTtlSeconds: 90,
      }),
    ]);

    expect([first.type, second.type].sort()).toEqual(["claimed", "empty"]);
    const winner = first.type === "claimed" ? first.record : second.type === "claimed" ? second.record : null;
    expect(winner).toMatchObject({
      work: {
        acknowledgedAt: null,
        latestHeartbeatAt: null,
        startedAt: null,
        state: "queued",
      },
      claim: {
        claimedAt: "2026-08-26T09:02:30.001Z",
        generation: 2,
      },
      heartbeatTtlSeconds: 90,
      revision: 2,
    });
  });
});
