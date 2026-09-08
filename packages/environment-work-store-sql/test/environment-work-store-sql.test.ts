import { beforeEach, describe, expect, it } from "vitest";
import type {
  EnvironmentWorkRecord,
  StoredEnvironmentWork,
} from "@open-managed-agents/environment-work-store";
import {
  createBetterSqlite3SqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import {
  SqlEnvironmentWorkStore,
  type EnvironmentWorkSecretCipher,
} from "../src";

const SCHEMA_SQL = `
CREATE TABLE managed_environment_work (
  workspace_id text NOT NULL,
  environment_id text NOT NULL,
  id text NOT NULL,
  session_id text,
  document text NOT NULL,
  sealed_secret text NOT NULL,
  claim_at integer,
  claim_worker_id text,
  claim_generation integer NOT NULL DEFAULT 0,
  heartbeat_ttl_seconds integer NOT NULL,
  revision integer NOT NULL,
  state text NOT NULL,
  created_at integer NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX idx_managed_environment_work_queue
  ON managed_environment_work (workspace_id, environment_id, state, claim_at, created_at, id);
CREATE TABLE managed_environment_work_workers (
  workspace_id text NOT NULL,
  environment_id text NOT NULL,
  worker_id text NOT NULL,
  last_polled_at integer NOT NULL,
  PRIMARY KEY (workspace_id, environment_id, worker_id)
);
`;

const cipher: EnvironmentWorkSecretCipher = {
  seal: async ({ plaintext }) => ({ ciphertext: `sealed:${plaintext}` }),
  open: async ({ ciphertext }) => ({ plaintext: ciphertext.slice(7) }),
};

const record: EnvironmentWorkRecord = {
  work: {
    id: "work_01",
    acknowledgedAt: null,
    createdAt: "2026-08-26T09:10:00.000Z",
    data: { type: "session", id: "session_01" },
    environmentId: "env_self_01",
    latestHeartbeatAt: null,
    metadata: { shard: "a" },
    startedAt: null,
    state: "queued",
    stopRequestedAt: null,
    stoppedAt: null,
  },
  secret: {
    sessionsToken: "sk-ant-req-session-token",
    apiBaseUrl: "https://openma.test",
  },
  claim: null,
  heartbeatTtlSeconds: 90,
};

describe("SqlEnvironmentWorkStore", () => {
  let client: SqlClient;
  let persistence: SqlEnvironmentWorkStore;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA_SQL);
    persistence = new SqlEnvironmentWorkStore(client, cipher);
  });

  it("stores a complete work record with its credential encrypted at rest", async () => {
    await expect(
      persistence.insert({ workspaceId: "workspace_01", record }),
    ).resolves.toEqual({ ...record, revision: 1 });

    const row = await client
      .prepare(
        `SELECT document, sealed_secret
           FROM managed_environment_work
          WHERE workspace_id = ? AND id = ?`,
      )
      .bind("workspace_01", "work_01")
      .first<{ document: string; sealed_secret: string }>();
    expect(row?.document).not.toContain("sk-ant-req-session-token");
    expect(row?.sealed_secret).toContain("sealed:");

    await expect(
      persistence.find({
        workspaceId: "workspace_01",
        environmentId: "env_self_01",
        workId: "work_01",
      }),
    ).resolves.toEqual({ ...record, revision: 1 });
    await expect(
      persistence.findActiveSession({
        workspaceId: "workspace_01",
        sessionId: "session_01",
      }),
    ).resolves.toEqual({ ...record, revision: 1 });
    await expect(
      persistence.list({
        workspaceId: "workspace_01",
        environmentId: "env_self_01",
        limit: 10,
      }),
    ).resolves.toEqual([{ ...record, revision: 1 }]);
  });

  it("claims one queued item atomically and reports delivery/worker statistics", async () => {
    await persistence.insert({ workspaceId: "workspace_01", record });

    const claimed = await persistence.claimAvailable({
      workspaceId: "workspace_01",
      environmentId: "env_self_01",
      claimedAt: "2026-08-26T09:20:00.000Z",
      reclaimBefore: "2026-08-26T09:19:55.000Z",
      workerId: "worker_01",
      heartbeatTtlSeconds: 90,
    });
    expect(claimed).toEqual({
      type: "claimed",
      record: {
        ...record,
        claim: {
          claimedAt: "2026-08-26T09:20:00.000Z",
          workerId: "worker_01",
          generation: 1,
        },
        revision: 2,
      },
    });
    await expect(
      persistence.claimAvailable({
        workspaceId: "workspace_01",
        environmentId: "env_self_01",
        claimedAt: "2026-08-26T09:20:01.000Z",
        reclaimBefore: "2026-08-26T09:19:56.000Z",
        workerId: "worker_01",
        heartbeatTtlSeconds: 90,
      }),
    ).resolves.toEqual({ type: "empty" });
    await expect(
      persistence.queueStats({
        workspaceId: "workspace_01",
        environmentId: "env_self_01",
        workerActiveSince: "2026-08-26T09:19:30.000Z",
      }),
    ).resolves.toEqual({
      depth: 0,
      oldestQueuedAt: "2026-08-26T09:10:00.000Z",
      pending: 1,
      workersPolling: 1,
    });
  });

  it("replaces under CAS and reports the actual conflicting revision", async () => {
    const inserted = await persistence.insert({
      workspaceId: "workspace_01",
      record,
    });
    const next: EnvironmentWorkRecord = {
      ...record,
      work: { ...record.work, metadata: { shard: "b" } },
    };
    const replaced = await persistence.replace({
      workspaceId: "workspace_01",
      environmentId: "env_self_01",
      workId: "work_01",
      expectedRevision: inserted.revision,
      next,
    });
    expect(replaced).toEqual({
      type: "replaced",
      record: { ...next, revision: 2 },
    });
    await expect(
      persistence.replace({
        workspaceId: "workspace_01",
        environmentId: "env_self_01",
        workId: "work_01",
        expectedRevision: 1,
        next,
      }),
    ).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
  });

  it.each([
    {
      state: "starting" as const,
      acknowledgedAt: "2026-08-26T09:20:00.000Z",
      latestHeartbeatAt: null,
      startedAt: null,
    },
    {
      state: "active" as const,
      acknowledgedAt: "2026-08-26T09:19:00.000Z",
      latestHeartbeatAt: "2026-08-26T09:20:00.000Z",
      startedAt: "2026-08-26T09:19:01.000Z",
    },
  ])("atomically requeues an expired $state lease for one replacement worker", async (lifecycle) => {
    const expired: EnvironmentWorkRecord = {
      ...record,
      work: { ...record.work, ...lifecycle },
      claim: {
        claimedAt: "2026-08-26T09:20:00.000Z",
        workerId: "worker_dead",
        generation: 1,
      },
      heartbeatTtlSeconds: 30,
    };
    await persistence.insert({ workspaceId: "workspace_01", record: expired });

    const [first, second] = await Promise.all([
      persistence.claimAvailable({
        workspaceId: "workspace_01",
        environmentId: "env_self_01",
        claimedAt: "2026-08-26T09:20:30.001Z",
        reclaimBefore: "2026-08-26T09:20:25.001Z",
        workerId: "worker_replacement_a",
        heartbeatTtlSeconds: 90,
      }),
      persistence.claimAvailable({
        workspaceId: "workspace_01",
        environmentId: "env_self_01",
        claimedAt: "2026-08-26T09:20:30.001Z",
        reclaimBefore: "2026-08-26T09:20:25.001Z",
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
        claimedAt: "2026-08-26T09:20:30.001Z",
        generation: 2,
      },
      heartbeatTtlSeconds: 90,
      revision: 2,
    });
    await expect(persistence.find({
      workspaceId: "workspace_01",
      environmentId: "env_self_01",
      workId: "work_01",
    })).resolves.toMatchObject({
      work: { state: "queued", latestHeartbeatAt: null },
      revision: 2,
    });
  });
});
