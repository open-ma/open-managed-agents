import { describe, expect, it } from "vitest";
import { MemoryEnvironmentWorkStore } from "@open-managed-agents/environment-work-store-memory";
import {
  clockPort,
  idGeneratorPort,
  workspaceContextPort,
} from "../src/capabilities";
import { createApp, providePort } from "../src/index";
import { managedAgentsPortTokens } from "../src/managed-agents";
import {
  environmentSessionWorkEnqueuerPort,
  environmentWorkAvailabilityWaiterPort,
  environmentWorkEnqueuerModule,
  environmentWorkEnvironmentSourcePort,
  environmentWorkModule,
  environmentWorkSessionCredentialIssuerPort,
  environmentWorkWakeupPort,
  environmentWorkStorePort,
} from "../src/modules/environment-work";

describe("Environment Work modules", () => {
  it("shares one Store between the SDK work surface and Session enqueuer", async () => {
    const store = new MemoryEnvironmentWorkStore();
    await store.insert({
      workspaceId: "workspace_01",
      record: {
        work: {
          id: "work_01",
          acknowledgedAt: null,
          createdAt: "2026-08-26T09:00:00.000Z",
          data: { type: "session", id: "session_01" },
          environmentId: "env_01",
          latestHeartbeatAt: null,
          metadata: {},
          startedAt: null,
          state: "queued",
          stopRequestedAt: null,
          stoppedAt: null,
        },
        secret: { sessionsToken: "secret" },
        claim: null,
        heartbeatTtlSeconds: 90,
      },
    });
    const app = createApp({
      modules: [
        providePort(workspaceContextPort, { workspaceId: "workspace_01" }),
        providePort(clockPort, { now: () => new Date("2026-08-26T09:00:00.000Z") }),
        providePort(idGeneratorPort, { next: () => "work_02" }),
        providePort(environmentWorkStorePort, store),
        providePort(environmentWorkEnvironmentSourcePort, { find: async () => null }),
        providePort(environmentWorkAvailabilityWaiterPort, { wait: async () => {} }),
        providePort(environmentWorkSessionCredentialIssuerPort, {
          issue: async () => ({
            type: "issued" as const,
            secret: { sessionsToken: "issued" },
          }),
          bindToClaim: async ({ secret }) => ({ secret }),
        }),
        providePort(environmentWorkWakeupPort, { notifyRunStarted: async () => {} }),
        environmentWorkModule(),
        environmentWorkEnqueuerModule(),
      ],
    });

    await expect(app.port(managedAgentsPortTokens.environmentWork)
      .retrieveEnvironmentWork({ environmentId: "env_01", workId: "work_01" }))
      .resolves.toMatchObject({ type: "found", work: { id: "work_01", secret: null } });
    expect(app.port(environmentSessionWorkEnqueuerPort)).toBeDefined();
  });

  it("fences a dead acknowledged worker and lets exactly one replacement reclaim its Session", async () => {
    const store = new MemoryEnvironmentWorkStore();
    await store.insert({
      workspaceId: "workspace_01",
      record: {
        work: {
          id: "work_lease_01",
          acknowledgedAt: null,
          createdAt: "2026-08-26T09:00:00.000Z",
          data: { type: "session", id: "session_lease_01" },
          environmentId: "env_01",
          latestHeartbeatAt: null,
          metadata: {},
          startedAt: null,
          state: "queued",
          stopRequestedAt: null,
          stoppedAt: null,
        },
        secret: { sessionsToken: "secret" },
        claim: null,
        heartbeatTtlSeconds: 30,
      },
    });
    let now = new Date("2026-08-26T09:00:00.000Z");
    let claimToken = 0;
    const app = createApp({
      modules: [
        providePort(workspaceContextPort, { workspaceId: "workspace_01" }),
        providePort(clockPort, { now: () => now }),
        providePort(environmentWorkStorePort, store),
        providePort(environmentWorkEnvironmentSourcePort, {
          find: async () => ({
            id: "env_01",
            archivedAt: null,
            config: { type: "self_hosted" as const },
            createdAt: "2026-08-26T08:00:00.000Z",
            description: null,
            metadata: {},
            name: "Environment",
            updatedAt: "2026-08-26T08:00:00.000Z",
          }),
        }),
        providePort(environmentWorkAvailabilityWaiterPort, { wait: async () => {} }),
        providePort(environmentWorkSessionCredentialIssuerPort, {
          issue: async () => ({
            type: "issued" as const,
            secret: { sessionsToken: "unused" },
          }),
          bindToClaim: async ({ secret }) => ({
            secret: {
              ...secret,
              sessionsToken: `claim-token-${++claimToken}`,
            },
          }),
        }),
        providePort(environmentWorkWakeupPort, { notifyRunStarted: async () => {} }),
        environmentWorkModule(),
      ],
    });
    const workApi = app.port(managedAgentsPortTokens.environmentWork);

    await expect(workApi.pollEnvironmentWork({
      environmentId: "env_01",
      workerId: "worker_dead",
    })).resolves.toMatchObject({ type: "work", work: { state: "queued" } });
    await expect(workApi.acknowledgeEnvironmentWork({
      environmentId: "env_01",
      workId: "work_lease_01",
    })).resolves.toMatchObject({ type: "acknowledged", work: { state: "starting" } });
    const deadWorkerHeartbeat = await workApi.heartbeatEnvironmentWork({
      environmentId: "env_01",
      workId: "work_lease_01",
      desiredTtlSeconds: 30,
      expectedLastHeartbeat: "NO_HEARTBEAT",
    });
    expect(deadWorkerHeartbeat).toMatchObject({
      type: "recorded",
      heartbeat: { leaseExtended: true, state: "active", ttlSeconds: 30 },
    });
    if (deadWorkerHeartbeat.type !== "recorded") {
      throw new Error("expected the first worker to hold an active lease");
    }
    const staleHeartbeat = deadWorkerHeartbeat.heartbeat.lastHeartbeat;

    now = new Date("2026-08-26T09:00:30.001Z");
    const replacementPolls = await Promise.all([
      workApi.pollEnvironmentWork({ environmentId: "env_01", workerId: "worker_a" }),
      workApi.pollEnvironmentWork({ environmentId: "env_01", workerId: "worker_b" }),
    ]);
    expect(replacementPolls.map((result) => result.type).sort()).toEqual(["empty", "work"]);
    expect(replacementPolls.find((result) => result.type === "work")).toMatchObject({
      type: "work",
      work: {
        acknowledgedAt: null,
        latestHeartbeatAt: null,
        startedAt: null,
        state: "queued",
      },
    });

    await expect(workApi.heartbeatEnvironmentWork({
      environmentId: "env_01",
      workId: "work_lease_01",
      expectedLastHeartbeat: staleHeartbeat,
    })).resolves.toMatchObject({ type: "precondition_failed" });
    await expect(workApi.acknowledgeEnvironmentWork({
      environmentId: "env_01",
      workId: "work_lease_01",
    })).resolves.toMatchObject({ type: "acknowledged", work: { state: "starting" } });
    await expect(workApi.heartbeatEnvironmentWork({
      environmentId: "env_01",
      workId: "work_lease_01",
      desiredTtlSeconds: 30,
      expectedLastHeartbeat: "NO_HEARTBEAT",
    })).resolves.toMatchObject({
      type: "recorded",
      heartbeat: { leaseExtended: true, state: "active", ttlSeconds: 30 },
    });
    await expect(workApi.heartbeatEnvironmentWork({
      environmentId: "env_01",
      workId: "work_lease_01",
      expectedLastHeartbeat: staleHeartbeat,
    })).resolves.toMatchObject({ type: "precondition_failed" });
  });
});
