import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { PostgresSqlClient } from "@open-managed-agents/sql-client/adapters/postgres";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  SentSessionEvent,
  Session,
  SessionResource,
  SessionThread,
} from "@open-managed-agents/managed-agents-application";
import {
  SqlSessionEventPersistence,
  SqlSessionPersistence,
  SqlSessionResourcePersistence,
  SqlSessionThreadEventPersistence,
  SqlSessionThreadPersistence,
} from "../src";
import { getStorageIntegrationConfig } from "../../../test/storage-integration.js";
import { sessionStorePortContract } from "./contracts/store-port-contracts";
import { ensureSessionExecutionCoordinatorSchema } from "@open-managed-agents/session-runtime-sql/coordination";

const PG_URL = getStorageIntegrationConfig().postgres.sessionsSql;
const WORKSPACE_ID = "managed_sessions_adapter_pg_contract";

const repository: SessionResource = {
  id: "sesrsc_pg_01",
  type: "github_repository",
  createdAt: "2026-08-26T00:00:00.000Z",
  mountPath: "/workspace/openma",
  updatedAt: "2026-08-26T00:00:00.000Z",
  url: "https://github.com/openma-ai/open-managed-agents",
};

const session: Session = {
  id: "session_pg_contract_01",
  agent: {
    id: "agent_pg_contract_01",
    description: null,
    mcpServers: [],
    model: { id: "claude-opus-5" },
    multiagent: null,
    name: "PostgreSQL agent",
    skills: [],
    system: null,
    tools: [],
    version: 1,
  },
  archivedAt: null,
  budget: null,
  createdAt: "2026-08-26T00:00:00.000Z",
  environmentId: "env_pg_contract",
  metadata: {},
  outcomeEvaluations: [],
  resources: [repository],
  stats: {},
  status: "running",
  title: "PostgreSQL session",
  updatedAt: "2026-08-26T00:00:00.000Z",
  usage: {},
  vaultIds: [],
};

const thread: SessionThread = {
  id: "thread_pg_contract_01",
  agent: { type: "advisor", model: "claude-opus-5" },
  archivedAt: null,
  createdAt: "2026-08-26T00:30:00.000Z",
  parentThreadId: null,
  sessionId: session.id,
  stats: null,
  status: "running",
  updatedAt: "2026-08-26T00:30:00.000Z",
  usage: null,
};

let connection: ReturnType<typeof postgres>;
let client: SqlClient;

function assertLocalTestDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error(
      `Refusing PostgreSQL contract test against non-loopback host ${host}`,
    );
  }
}

async function cleanup(): Promise<void> {
  for (const table of [
    "managed_session_executions",
    "managed_session_events",
    "managed_session_threads",
    "managed_session_resource_secrets",
    "managed_session_initial_events",
    "managed_session_memory_stores",
    "managed_sessions",
  ]) {
    await client
      .prepare(`DELETE FROM ${table} WHERE workspace_id = ?`)
      .bind(WORKSPACE_ID)
      .run();
  }
}

beforeAll(async () => {
  assertLocalTestDatabase(PG_URL);
  connection = postgres(PG_URL, {
    max: 1,
    types: {
      bigint: {
        to: 20,
        from: [20],
        serialize: (value: number) => value.toString(),
        parse: (value: string) => Number(value),
      },
    },
  });
  client = new PostgresSqlClient(
    connection as unknown as ConstructorParameters<typeof PostgresSqlClient>[0],
  );
  await client.exec(`
    CREATE TABLE IF NOT EXISTS managed_sessions (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      document text NOT NULL,
      revision bigint NOT NULL,
      agent_id text NOT NULL,
      agent_version bigint NOT NULL,
      environment_id text NOT NULL,
      deployment_id text,
      status text NOT NULL,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL,
      archived_at bigint
    );
    CREATE TABLE IF NOT EXISTS managed_session_memory_stores (
      session_id text NOT NULL,
      workspace_id text NOT NULL,
      memory_store_id text NOT NULL,
      PRIMARY KEY (session_id, memory_store_id)
    );
    CREATE TABLE IF NOT EXISTS managed_session_initial_events (
      session_id text NOT NULL,
      workspace_id text NOT NULL,
      sequence bigint NOT NULL,
      document text NOT NULL,
      PRIMARY KEY (session_id, sequence)
    );
    CREATE TABLE IF NOT EXISTS managed_session_events (
      workspace_id text NOT NULL,
      session_id text NOT NULL,
      thread_id text,
      id text NOT NULL,
      type text NOT NULL,
      document text NOT NULL,
      processed_at bigint NOT NULL,
      PRIMARY KEY (workspace_id, session_id, id)
    );
    ALTER TABLE managed_session_events ADD COLUMN IF NOT EXISTS thread_id text;
    CREATE TABLE IF NOT EXISTS managed_session_threads (
      workspace_id text NOT NULL,
      session_id text NOT NULL,
      id text NOT NULL,
      document text NOT NULL,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL,
      archived_at bigint,
      PRIMARY KEY (workspace_id, session_id, id)
    );
    CREATE TABLE IF NOT EXISTS managed_session_resource_secrets (
      workspace_id text NOT NULL,
      session_id text NOT NULL,
      resource_id text NOT NULL,
      secret_type text NOT NULL,
      sealed_value text NOT NULL,
      updated_at bigint NOT NULL,
      PRIMARY KEY (workspace_id, session_id, resource_id)
    );
  `);
  await ensureSessionExecutionCoordinatorSchema(client);
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await connection.end({ timeout: 5 });
});

describe("Managed Sessions SQL adapters on PostgreSQL", () => {
  it("has one atomic winner when event acceptance transactions race", async () => {
    const sessions = new SqlSessionPersistence(client, {
      seal: async (value) => `sealed:${value}`,
    });
    await sessions.insert({
      workspaceId: WORKSPACE_ID,
      session,
      initialEvents: [],
      resourceSecrets: [],
    });
    const contenderConnections = [
      postgres(PG_URL, { max: 1 }),
      postgres(PG_URL, { max: 1 }),
    ];
    const contenders = contenderConnections.map((candidate) =>
      new PostgresSqlClient(
        candidate as unknown as ConstructorParameters<typeof PostgresSqlClient>[0],
      )
    );
    const events = ["alpha", "beta"].map((name): SentSessionEvent => ({
      id: `event_pg_race_${name}`,
      type: "user.message",
      content: [{ type: "text", text: name }],
      processedAt: "2026-08-26T00:10:00.000Z",
    }));
    try {
      const results = await Promise.all(contenders.map((contender, index) =>
        new SqlSessionEventPersistence(contender, { executionOutbox: true })
          .append({
            workspaceId: WORKSPACE_ID,
            sessionId: session.id,
            expectedRevision: 1,
            events: [events[index]!],
            nextSession: {
              ...session,
              updatedAt: "2026-08-26T00:10:00.000Z",
            },
          })
      ));
      expect(results.filter((result) => result.type === "appended")).toHaveLength(1);
      expect(results.filter((result) => result.type === "revision_conflict"))
        .toHaveLength(1);

      const acceptedEvents = await client.prepare(
        `SELECT id FROM managed_session_events
          WHERE workspace_id = ? AND session_id = ?`,
      ).bind(WORKSPACE_ID, session.id).all<{ id: string }>();
      const acceptedExecutions = await client.prepare(
        `SELECT id FROM managed_session_executions
          WHERE workspace_id = ? AND session_id = ?`,
      ).bind(WORKSPACE_ID, session.id).all<{ id: string }>();
      expect(acceptedEvents.results).toHaveLength(1);
      expect(acceptedExecutions.results).toEqual(acceptedEvents.results);
    } finally {
      await Promise.all(contenderConnections.map((candidate) =>
        candidate.end({ timeout: 5 })
      ));
      await cleanup();
    }
  });

  it("preserves Session, Event, resource-secret CAS, and deletion semantics", async () => {
    const sealer = { seal: async (value: string) => `sealed:${value}` };
    const sessions = new SqlSessionPersistence(client, sealer);
    const resources = new SqlSessionResourcePersistence(client, sealer);
    const events = new SqlSessionEventPersistence(client);
    const threads = new SqlSessionThreadPersistence(client);
    const threadEvents = new SqlSessionThreadEventPersistence(client);
    const event: SentSessionEvent = {
      id: "event_pg_01",
      type: "user.interrupt",
      sessionThreadId: thread.id,
      processedAt: "2026-08-26T01:00:00.000Z",
    };

    await sessions.insert({
      workspaceId: WORKSPACE_ID,
      session,
      initialEvents: [],
      resourceSecrets: [
        {
          type: "github_token",
          resourceId: repository.id,
          authorizationToken: "ghp_initial",
        },
      ],
    });
    await events.append({
      workspaceId: WORKSPACE_ID,
      sessionId: session.id,
      expectedRevision: 1,
      events: [event],
      nextSession: {
        ...session,
        updatedAt: event.processedAt!,
      },
    });
    await client
      .prepare(
        `INSERT INTO managed_session_threads
          (workspace_id, session_id, id, document, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        WORKSPACE_ID,
        thread.sessionId,
        thread.id,
        JSON.stringify(thread),
        Date.parse(thread.createdAt),
        Date.parse(thread.updatedAt),
        null,
      )
      .run();
    const updatedRepository: SessionResource = {
      ...repository,
      updatedAt: "2026-08-26T02:00:00.000Z",
    };
    await expect(
      resources.replaceCurrent({
        workspaceId: WORKSPACE_ID,
        sessionId: session.id,
        expectedRevision: 2,
        resources: [updatedRepository],
        updatedAt: updatedRepository.updatedAt,
        secretChanges: [
          {
            type: "store_github_token",
            resourceId: repository.id,
            authorizationToken: "ghp_rotated",
          },
        ],
      }),
    ).resolves.toEqual({
      type: "replaced",
      record: { resources: [updatedRepository], revision: 3 },
    });
    await expect(
      resources.replaceCurrent({
        workspaceId: WORKSPACE_ID,
        sessionId: session.id,
        expectedRevision: 1,
        resources: [],
        updatedAt: "2026-08-26T03:00:00.000Z",
        secretChanges: [],
      }),
    ).resolves.toEqual({ type: "revision_conflict", actualRevision: 3 });
    await expect(
      events.list({
        workspaceId: WORKSPACE_ID,
        sessionId: session.id,
        limit: 10,
        order: "asc",
      }),
    ).resolves.toEqual([event]);
    await expect(
      threads.find({
        workspaceId: WORKSPACE_ID,
        sessionId: thread.sessionId,
        threadId: thread.id,
      }),
    ).resolves.toEqual(thread);
    await expect(
      threadEvents.list({
        workspaceId: WORKSPACE_ID,
        sessionId: thread.sessionId,
        threadId: thread.id,
        limit: 10,
      }),
    ).resolves.toEqual([event]);
    await expect(
      sessions.deleteCurrent({
        workspaceId: WORKSPACE_ID,
        sessionId: session.id,
      }),
    ).resolves.toEqual({ type: "deleted" });
  });
});

sessionStorePortContract(
  "Docker PostgreSQL",
  () => new SqlSessionPersistence(client, { seal: async (value) => `sealed:${value}` }),
);
