import { beforeEach, describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  InitialSessionEvent,
  Session,
} from "@open-managed-agents/managed-agents-application";
import {
  SqlSessionPersistence,
  SqlSessionRuntimeProjectionPersistence,
  SqlSessionSource,
} from "../src";
import { sessionStorePortContract } from "./contracts/store-port-contracts";
import {
  ensureSessionExecutionCoordinatorSchema,
  SqlSessionExecutionCoordinator,
} from "@open-managed-agents/session-runtime-sql/coordination";

const SCHEMA_SQL = `
CREATE TABLE managed_sessions (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL,
  document text NOT NULL,
  revision integer NOT NULL,
  agent_id text NOT NULL,
  agent_version integer NOT NULL,
  environment_id text NOT NULL,
  deployment_id text,
  status text NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  archived_at integer
);
CREATE INDEX idx_managed_sessions_workspace_created_id
  ON managed_sessions (workspace_id, created_at, id);
CREATE INDEX idx_managed_sessions_workspace_agent
  ON managed_sessions (workspace_id, agent_id, agent_version);

CREATE TABLE managed_session_memory_stores (
  session_id text NOT NULL,
  workspace_id text NOT NULL,
  memory_store_id text NOT NULL,
  PRIMARY KEY (session_id, memory_store_id)
);
CREATE INDEX idx_managed_session_memory_stores_workspace_store
  ON managed_session_memory_stores (workspace_id, memory_store_id, session_id);

CREATE TABLE managed_session_initial_events (
  session_id text NOT NULL,
  workspace_id text NOT NULL,
  sequence integer NOT NULL,
  document text NOT NULL,
  PRIMARY KEY (session_id, sequence)
);

CREATE TABLE managed_session_events (
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  thread_id text,
  id text NOT NULL,
  type text NOT NULL,
  document text NOT NULL,
  processed_at integer NOT NULL,
  PRIMARY KEY (workspace_id, session_id, id)
);

CREATE TABLE managed_session_threads (
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  id text NOT NULL,
  document text NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  archived_at integer,
  PRIMARY KEY (workspace_id, session_id, id)
);

CREATE TABLE managed_session_resource_secrets (
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  resource_id text NOT NULL,
  secret_type text NOT NULL,
  sealed_value text NOT NULL,
  updated_at integer NOT NULL,
  PRIMARY KEY (workspace_id, session_id, resource_id)
);

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
`;

const session: Session = {
  id: "session_01",
  agent: {
    id: "agent_01",
    description: null,
    mcpServers: [],
    model: { id: "claude-opus-5" },
    multiagent: null,
    name: "Coding Agent",
    skills: [],
    system: "Work carefully",
    tools: [],
    version: 3,
  },
  archivedAt: null,
  budget: null,
  createdAt: "2026-08-26T02:00:00.000Z",
  environmentId: "env_01",
  metadata: { owner: "platform" },
  outcomeEvaluations: [],
  resources: [
    {
      type: "memory_store",
      memoryStoreId: "memstore_01",
      access: "read_only",
      instructions: "Use preferences",
      name: "Preferences",
    },
    {
      id: "sesrsc_repo_create",
      type: "github_repository",
      createdAt: "2026-08-26T02:00:00.000Z",
      mountPath: "/workspace/openma",
      updatedAt: "2026-08-26T02:00:00.000Z",
      url: "https://github.com/openma-ai/open-managed-agents",
    },
  ],
  stats: {},
  status: "running",
  title: "Ship migration",
  updatedAt: "2026-08-26T02:00:00.000Z",
  usage: {},
  vaultIds: [],
};

const initialEvents: InitialSessionEvent[] = [
  {
    type: "user.define_outcome",
    description: "Migration complete",
    rubric: { type: "file", fileId: "file_rubric" },
    maxIterations: 4,
  },
];

const testSealer = {
  seal: async (value: string) => `sealed:${value}`,
};

function sessionAt(
  id: string,
  createdAt: string,
  overrides: Partial<Session> = {},
): Session {
  return {
    ...session,
    id,
    createdAt,
    updatedAt: createdAt,
    title: id,
    ...overrides,
  };
}

let client: SqlClient;

beforeEach(async () => {
  client = await createBetterSqlite3SqlClient(":memory:");
  await client.exec(SCHEMA_SQL);
});

describe("SqlSessionPersistence", () => {
  it("atomically inserts the session, initial events, and memory-store index", async () => {
    const persistence = new SqlSessionPersistence(client, testSealer);

    await persistence.insert({
      workspaceId: "workspace_01",
      session,
      initialEvents,
      resourceSecrets: [
        {
          type: "github_token",
          resourceId: "sesrsc_repo_create",
          authorizationToken: "ghp_create",
        },
      ],
    });
    await expect(
      persistence.findCurrent({
        workspaceId: "workspace_01",
        sessionId: session.id,
      }),
    ).resolves.toEqual({ session, revision: 1 });
    await expect(
      new SqlSessionSource(client).find({
        workspaceId: "workspace_01",
        sessionId: session.id,
      }),
    ).resolves.toEqual(session);
    await expect(
      persistence.findCurrent({
        workspaceId: "workspace_other",
        sessionId: session.id,
      }),
    ).resolves.toBeNull();
    await expect(
      client
        .prepare(
          `SELECT document FROM managed_session_initial_events
            WHERE workspace_id = ? AND session_id = ? ORDER BY sequence`,
        )
        .bind("workspace_01", session.id)
        .all<{ document: string }>(),
    ).resolves.toMatchObject({
      results: [{ document: JSON.stringify(initialEvents[0]) }],
    });
    await expect(
      client
        .prepare(
          `SELECT memory_store_id FROM managed_session_memory_stores
            WHERE workspace_id = ? AND session_id = ?`,
        )
        .bind("workspace_01", session.id)
        .first<{ memory_store_id: string }>(),
    ).resolves.toEqual({ memory_store_id: "memstore_01" });
    await expect(
      client
        .prepare(
          `SELECT sealed_value FROM managed_session_resource_secrets
            WHERE workspace_id = ? AND session_id = ? AND resource_id = ?`,
        )
        .bind("workspace_01", session.id, "sesrsc_repo_create")
        .first<{ sealed_value: string }>(),
    ).resolves.toEqual({ sealed_value: "sealed:ghp_create" });
  });

  it("replaces a session with revision CAS and rejects a stale writer", async () => {
    const persistence = new SqlSessionPersistence(client, testSealer);
    await persistence.insert({
      workspaceId: "workspace_01",
      session,
      initialEvents: [],
      resourceSecrets: [],
    });
    const next: Session = {
      ...session,
      title: "Updated title",
      updatedAt: "2026-08-26T03:00:00.000Z",
    };

    await expect(
      persistence.replaceCurrent({
        workspaceId: "workspace_01",
        sessionId: session.id,
        expectedRevision: 1,
        next,
      }),
    ).resolves.toEqual({
      type: "replaced",
      record: { session: next, revision: 2 },
    });
    await expect(
      persistence.replaceCurrent({
        workspaceId: "workspace_01",
        sessionId: session.id,
        expectedRevision: 1,
        next: { ...next, title: "Stale overwrite" },
      }),
    ).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
    await expect(
      persistence.findCurrent({
        workspaceId: "workspace_01",
        sessionId: session.id,
      }),
    ).resolves.toEqual({ session: next, revision: 2 });
  });

  it("atomically projects runtime events under the session revision CAS", async () => {
    const sessions = new SqlSessionPersistence(client, testSealer);
    await sessions.insert({
      workspaceId: "workspace_01",
      session: { ...session, status: "idle" },
      initialEvents: [],
      resourceSecrets: [],
    });
    const projection = new SqlSessionRuntimeProjectionPersistence(client);
    const runtimeEvent = {
      id: "event_runtime_01",
      type: "session.status_running" as const,
      processedAt: "2026-08-26T03:00:00.000Z",
    };
    const next = {
      ...session,
      status: "running" as const,
      updatedAt: runtimeEvent.processedAt,
    };

    await expect(
      projection.project({
        workspaceId: "workspace_01",
        sessionId: session.id,
        expectedRevision: 1,
        events: [runtimeEvent],
        next,
      }),
    ).resolves.toEqual({
      type: "projected",
      record: { session: next, revision: 2 },
    });
    await expect(
      projection.project({
        workspaceId: "workspace_01",
        sessionId: session.id,
        expectedRevision: 1,
        events: [
          {
            id: "event_must_not_persist",
            type: "session.status_idle",
            processedAt: "2026-08-26T04:00:00.000Z",
            stopReason: { type: "end_turn" },
          },
        ],
        next: { ...next, status: "idle", updatedAt: "2026-08-26T04:00:00.000Z" },
      }),
    ).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
    await expect(
      client
        .prepare(
          `SELECT id FROM managed_session_events
            WHERE workspace_id = ? AND session_id = ? ORDER BY id`,
        )
        .bind("workspace_01", session.id)
        .all<{ id: string }>(),
    ).resolves.toMatchObject({ results: [{ id: "event_runtime_01" }] });
  });

  it("atomically fences runtime projection against a reclaimed execution", async () => {
    await ensureSessionExecutionCoordinatorSchema(client);
    const sessions = new SqlSessionPersistence(client, testSealer);
    await sessions.insert({
      workspaceId: "workspace_01",
      session: { ...session, status: "idle" },
      initialEvents: [],
      resourceSecrets: [],
    });
    const coordinator = new SqlSessionExecutionCoordinator(client);
    await coordinator.admit({
      execution: {
        id: "execution_01",
        workspaceId: "workspace_01",
        sessionId: session.id,
        admittedAt: "2026-08-26T02:00:00.000Z",
        events: [{
          id: "input_01",
          type: "user.message",
          content: [{ type: "text", text: "Run" }],
          processedAt: "2026-08-26T02:00:00.000Z",
        }],
      },
    });
    const old = await coordinator.claim({
      ownerId: "node_old",
      attemptId: "attempt_old",
      claimedAt: "2026-08-26T02:00:01.000Z",
      leaseTtlMs: 1_000,
    });
    expect(old.type).toBe("claimed");
    if (old.type !== "claimed") return;
    const current = await sessions.findCurrent({
      workspaceId: "workspace_01",
      sessionId: session.id,
    });
    expect(current).not.toBeNull();
    if (current === null) return;

    await coordinator.claim({
      ownerId: "node_new",
      attemptId: "attempt_new",
      claimedAt: "2026-08-26T02:00:03.000Z",
      leaseTtlMs: 30_000,
    });
    const projection = new SqlSessionRuntimeProjectionPersistence(client, {
      now: () => new Date("2026-08-26T02:00:04.000Z"),
    });
    const event = {
      id: "stale_output_01",
      type: "session.status_running" as const,
      processedAt: "2026-08-26T02:00:04.000Z",
    };
    await expect(projection.project({
      workspaceId: "workspace_01",
      sessionId: session.id,
      expectedRevision: current.revision,
      executionFence: old.fence,
      events: [event],
      next: {
        ...current.session,
        status: "running",
        updatedAt: event.processedAt,
      },
    })).resolves.toEqual({ type: "execution_fence_lost" });
    await expect(client.prepare(
      "SELECT id FROM managed_session_events WHERE id = ?",
    ).bind(event.id).first()).resolves.toBeNull();
  });

  it("treats an exact runtime event replay as idempotent without advancing revision", async () => {
    const sessions = new SqlSessionPersistence(client, testSealer);
    await sessions.insert({
      workspaceId: "workspace_01",
      session,
      initialEvents: [],
      resourceSecrets: [],
    });
    const projection = new SqlSessionRuntimeProjectionPersistence(client);
    const event = {
      id: "runtime_replay_01",
      type: "session.status_idle" as const,
      processedAt: "2026-08-26T03:00:00.000Z",
      stopReason: { type: "end_turn" as const },
    };
    const next = {
      ...session,
      status: "idle" as const,
      updatedAt: event.processedAt,
    };
    await expect(projection.project({
      workspaceId: "workspace_01",
      sessionId: session.id,
      expectedRevision: 1,
      events: [event],
      next,
    })).resolves.toMatchObject({
      type: "projected",
      record: { revision: 2 },
    });

    await expect(projection.project({
      workspaceId: "workspace_01",
      sessionId: session.id,
      expectedRevision: 2,
      events: [event],
      next,
    })).resolves.toEqual({
      type: "projected",
      record: { revision: 2, session: next },
    });
    await expect(client.prepare(
      `SELECT COUNT(*) AS count FROM managed_session_events
        WHERE workspace_id = ? AND session_id = ? AND id = ?`,
    ).bind("workspace_01", session.id, event.id).first<{ count: number }>())
      .resolves.toEqual({ count: 1 });
  });

  it("atomically fences an in-sandbox runtime projection against a reclaimed Environment Work", async () => {
    const sessions = new SqlSessionPersistence(client, testSealer);
    await sessions.insert({
      workspaceId: "workspace_01",
      session: { ...session, status: "idle" },
      initialEvents: [],
      resourceSecrets: [],
    });
    await client.prepare(
      `INSERT INTO managed_environment_work
        (workspace_id, environment_id, id, session_id, document, sealed_secret,
         claim_at, claim_worker_id, claim_generation, heartbeat_ttl_seconds,
         revision, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "workspace_01",
      "env_01",
      "work_01",
      session.id,
      "{}",
      "sealed",
      Date.parse("2026-08-26T02:00:03.000Z"),
      "worker_new",
      2,
      90,
      8,
      "active",
      Date.parse("2026-08-26T02:00:00.000Z"),
    ).run();
    const current = await sessions.findCurrent({
      workspaceId: "workspace_01",
      sessionId: session.id,
    });
    expect(current).not.toBeNull();
    if (current === null) return;
    const projection = new SqlSessionRuntimeProjectionPersistence(client, {
      now: () => new Date("2026-08-26T02:00:04.000Z"),
    });
    const event = {
      id: "stale_sandbox_output_01",
      type: "session.status_running" as const,
      processedAt: "2026-08-26T02:00:04.000Z",
    };

    await expect(projection.project({
      workspaceId: "workspace_01",
      sessionId: session.id,
      expectedRevision: current.revision,
      environmentWorkFence: {
        workspaceId: "workspace_01",
        environmentId: "env_01",
        sessionId: session.id,
        workId: "work_01",
        generation: 1,
      },
      events: [event],
      next: {
        ...current.session,
        status: "running",
        updatedAt: event.processedAt,
      },
    })).resolves.toEqual({ type: "execution_fence_lost" });
    await expect(client.prepare(
      "SELECT id FROM managed_session_events WHERE id = ?",
    ).bind(event.id).first()).resolves.toBeNull();
  });

  it("rejects an exact runtime event replay after its Environment Work generation is fenced", async () => {
    const sessions = new SqlSessionPersistence(client, testSealer);
    await sessions.insert({
      workspaceId: "workspace_01",
      session: { ...session, status: "idle" },
      initialEvents: [],
      resourceSecrets: [],
    });
    await client.prepare(
      `INSERT INTO managed_environment_work
        (workspace_id, environment_id, id, session_id, document, sealed_secret,
         claim_at, claim_worker_id, claim_generation, heartbeat_ttl_seconds,
         revision, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "workspace_01",
      "env_01",
      "work_replay_01",
      session.id,
      "{}",
      "sealed",
      Date.parse("2026-08-26T02:00:03.000Z"),
      "worker_old",
      1,
      90,
      7,
      "active",
      Date.parse("2026-08-26T02:00:00.000Z"),
    ).run();
    const projection = new SqlSessionRuntimeProjectionPersistence(client, {
      now: () => new Date("2026-08-26T02:00:04.000Z"),
    });
    const event = {
      id: "runtime_fenced_replay_01",
      type: "session.status_running" as const,
      processedAt: "2026-08-26T02:00:04.000Z",
    };
    const next = {
      ...session,
      status: "running" as const,
      updatedAt: event.processedAt,
    };
    const fence = {
      workspaceId: "workspace_01",
      environmentId: "env_01",
      sessionId: session.id,
      workId: "work_replay_01",
      generation: 1,
    };

    await expect(projection.project({
      workspaceId: "workspace_01",
      sessionId: session.id,
      expectedRevision: 1,
      environmentWorkFence: fence,
      events: [event],
      next,
    })).resolves.toMatchObject({
      type: "projected",
      record: { revision: 2 },
    });
    await client.prepare(
      `UPDATE managed_environment_work
          SET claim_worker_id = ?, claim_generation = ?, revision = revision + 1
        WHERE workspace_id = ? AND id = ?`,
    ).bind("worker_new", 2, "workspace_01", "work_replay_01").run();

    await expect(projection.project({
      workspaceId: "workspace_01",
      sessionId: session.id,
      expectedRevision: 2,
      environmentWorkFence: fence,
      events: [event],
      next,
    })).resolves.toEqual({ type: "execution_fence_lost" });
  });

  it("archives lifecycle state and increments the internal revision", async () => {
    const persistence = new SqlSessionPersistence(client, testSealer);
    await persistence.insert({
      workspaceId: "workspace_01",
      session,
      initialEvents: [],
      resourceSecrets: [],
    });

    await expect(
      persistence.archiveCurrent({
        workspaceId: "workspace_01",
        sessionId: session.id,
        archivedAt: "2026-08-26T04:00:00.000Z",
      }),
    ).resolves.toEqual({
      type: "archived",
      record: {
        revision: 2,
        session: {
          ...session,
          archivedAt: "2026-08-26T04:00:00.000Z",
          updatedAt: "2026-08-26T04:00:00.000Z",
        },
      },
    });
    await expect(
      persistence.archiveCurrent({
        workspaceId: "workspace_other",
        sessionId: session.id,
        archivedAt: "2026-08-26T05:00:00.000Z",
      }),
    ).resolves.toEqual({ type: "not_found" });
  });

  it("deletes the session and its owned staging records atomically", async () => {
    const persistence = new SqlSessionPersistence(client, testSealer);
    await persistence.insert({
      workspaceId: "workspace_01",
      session,
      initialEvents,
      resourceSecrets: [],
    });
    await client
      .prepare(
        `INSERT INTO managed_session_events
          (workspace_id, session_id, id, type, document, processed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "workspace_01",
        session.id,
        "event_01",
        "session.status_running",
        JSON.stringify({
          id: "event_01",
          type: "session.status_running",
          processedAt: "2026-08-26T02:00:00.000Z",
        }),
        Date.parse("2026-08-26T02:00:00.000Z"),
      )
      .run();
    await client
      .prepare(
        `INSERT INTO managed_session_threads
          (workspace_id, session_id, id, document, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "workspace_01",
        session.id,
        "thread_01",
        JSON.stringify({ id: "thread_01", sessionId: session.id }),
        Date.parse("2026-08-26T02:00:00.000Z"),
        Date.parse("2026-08-26T02:00:00.000Z"),
        null,
      )
      .run();
    await client
      .prepare(
        `INSERT INTO managed_session_resource_secrets
          (workspace_id, session_id, resource_id, secret_type, sealed_value, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "workspace_01",
        session.id,
        "sesrsc_repo_01",
        "github_token",
        "sealed-token",
        Date.parse("2026-08-26T02:00:00.000Z"),
      )
      .run();

    await expect(
      persistence.deleteCurrent({
        workspaceId: "workspace_other",
        sessionId: session.id,
      }),
    ).resolves.toEqual({ type: "not_found" });
    await expect(
      persistence.deleteCurrent({
        workspaceId: "workspace_01",
        sessionId: session.id,
      }),
    ).resolves.toEqual({ type: "deleted" });
    await expect(
      client
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM managed_sessions) AS sessions,
             (SELECT COUNT(*) FROM managed_session_initial_events) AS staged_events,
             (SELECT COUNT(*) FROM managed_session_events) AS events,
             (SELECT COUNT(*) FROM managed_session_threads) AS threads,
             (SELECT COUNT(*) FROM managed_session_resource_secrets) AS secrets,
             (SELECT COUNT(*) FROM managed_session_memory_stores) AS stores`,
        )
        .first<{
          sessions: number;
          staged_events: number;
          events: number;
          threads: number;
          secrets: number;
          stores: number;
        }>(),
    ).resolves.toEqual({
      sessions: 0,
      staged_events: 0,
      events: 0,
      threads: 0,
      secrets: 0,
      stores: 0,
    });
  });

  it("lists sessions with official filters and bidirectional composite positions", async () => {
    const persistence = new SqlSessionPersistence(client, testSealer);
    const oldest = sessionAt("session_01", "2026-08-26T00:00:00.000Z");
    const archived = sessionAt("session_02", "2026-08-26T01:00:00.000Z", {
      status: "idle",
    });
    const newest = sessionAt("session_03", "2026-08-26T02:00:00.000Z", {
      deploymentId: "deployment_01",
    });
    const foreign = sessionAt("session_foreign", "2026-08-26T03:00:00.000Z");
    for (const value of [oldest, archived, newest]) {
      await persistence.insert({
        workspaceId: "workspace_01",
        session: value,
        initialEvents: [],
        resourceSecrets: [],
      });
    }
    await persistence.insert({
      workspaceId: "workspace_other",
      session: foreign,
      initialEvents: [],
      resourceSecrets: [],
    });
    await persistence.archiveCurrent({
      workspaceId: "workspace_01",
      sessionId: archived.id,
      archivedAt: "2026-08-26T04:00:00.000Z",
    });

    await expect(
      persistence.listCurrent({
        workspaceId: "workspace_01",
        limit: 10,
        includeArchived: false,
        order: "desc",
        agentId: "agent_01",
        agentVersion: 3,
        createdAtOrAfter: "2026-08-26T00:00:00.000Z",
        createdAtOrBefore: "2026-08-26T02:00:00.000Z",
        memoryStoreId: "memstore_01",
        statuses: ["running"],
      }),
    ).resolves.toEqual([
      { session: newest, revision: 1 },
      { session: oldest, revision: 1 },
    ]);
    await expect(
      persistence.listCurrent({
        workspaceId: "workspace_01",
        limit: 10,
        includeArchived: false,
        order: "desc",
        position: {
          createdAt: newest.createdAt,
          sessionId: newest.id,
          direction: "next",
        },
      }),
    ).resolves.toEqual([{ session: oldest, revision: 1 }]);
    await expect(
      persistence.listCurrent({
        workspaceId: "workspace_01",
        limit: 10,
        includeArchived: false,
        order: "desc",
        position: {
          createdAt: oldest.createdAt,
          sessionId: oldest.id,
          direction: "previous",
        },
      }),
    ).resolves.toEqual([{ session: newest, revision: 1 }]);
    await expect(
      persistence.listCurrent({
        workspaceId: "workspace_01",
        limit: 10,
        includeArchived: true,
        order: "asc",
        deploymentId: "deployment_01",
      }),
    ).resolves.toEqual([{ session: newest, revision: 1 }]);
  });
});

sessionStorePortContract(
  "SQLite",
  () => new SqlSessionPersistence(client, testSealer),
);
