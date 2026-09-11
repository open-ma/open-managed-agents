import { beforeEach, describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { AppendSessionEvents } from "@open-managed-agents/session-event-store";
import type {
  Session,
  SentSessionEvent,
  SessionEventView,
} from "@open-managed-agents/managed-agents-application";
import { SqlSessionEventPersistence } from "../src";
import {
  ensureSessionExecutionCoordinatorSchema,
  SqlSessionExecutionCoordinator,
} from "@open-managed-agents/session-runtime-sql/coordination";

const SCHEMA_SQL = `
CREATE TABLE managed_sessions (
  workspace_id text NOT NULL,
  id text NOT NULL,
  document text NOT NULL,
  revision integer NOT NULL,
  status text NOT NULL,
  updated_at integer NOT NULL,
  PRIMARY KEY (workspace_id, id)
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
CREATE INDEX idx_managed_session_events_workspace_session_time_id
  ON managed_session_events (workspace_id, session_id, processed_at, id);
CREATE INDEX idx_managed_session_events_workspace_session_type_time_id
  ON managed_session_events (workspace_id, session_id, type, processed_at, id);
`;

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
  title: null,
  updatedAt: "2026-08-26T04:00:00.000Z",
  usage: {},
  vaultIds: [],
};

function appendCommand(events: SentSessionEvent[]): AppendSessionEvents {
  return {
    workspaceId: "workspace_01",
    sessionId: session.id,
    expectedRevision: 1,
    events,
    nextSession: session,
  };
}

function sent(
  id: string,
  processedAt: string,
  text: string,
): SentSessionEvent {
  return {
    id,
    type: "system.message",
    content: [{ type: "text", text }],
    processedAt,
  };
}

describe("SqlSessionEventPersistence", () => {
  let client: SqlClient;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA_SQL);
    await ensureSessionExecutionCoordinatorSchema(client);
    await client
      .prepare(
        `INSERT INTO managed_sessions
          (workspace_id, id, document, revision, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "workspace_01",
        session.id,
        JSON.stringify(session),
        1,
        session.status,
        Date.parse(session.updatedAt),
      )
      .run();
  });

  it("atomically appends event documents inside the tenant and session scope", async () => {
    const persistence = new SqlSessionEventPersistence(client);
    const events = [
      sent("event_01", "2026-08-26T05:00:00.000Z", "First"),
      sent("event_02", "2026-08-26T06:00:00.000Z", "Second"),
    ];

    await expect(
      persistence.append(appendCommand(events)),
    ).resolves.toEqual({ type: "appended", events, session });
    await expect(
      persistence.list({
        workspaceId: "workspace_01",
        sessionId: "session_01",
        limit: 10,
        order: "asc",
      }),
    ).resolves.toEqual(events);
    await expect(
      persistence.list({
        workspaceId: "workspace_other",
        sessionId: "session_01",
        limit: 10,
        order: "asc",
      }),
    ).resolves.toEqual([]);
  });

  it("persists an explicit thread relation without deriving it from event JSON at read time", async () => {
    const persistence = new SqlSessionEventPersistence(client);
    const event: SentSessionEvent = {
      id: "event_thread_01",
      type: "user.interrupt",
      sessionThreadId: "thread_01",
      processedAt: "2026-08-26T05:00:00.000Z",
    };

    await persistence.append(appendCommand([event]));

    await expect(
      client
        .prepare(
          `SELECT thread_id
             FROM managed_session_events
            WHERE workspace_id = ? AND session_id = ? AND id = ?`,
        )
        .bind("workspace_01", "session_01", event.id)
        .first<{ thread_id: string | null }>(),
    ).resolves.toEqual({ thread_id: "thread_01" });
  });

  it("atomically commits accepted events and their durable execution outbox", async () => {
    const persistence = new SqlSessionEventPersistence(client, {
      executionOutbox: true,
    });
    const event: SentSessionEvent = {
      id: "event_user_01",
      type: "user.message",
      content: [{ type: "text", text: "Run the task" }],
      processedAt: "2026-08-26T05:00:00.000Z",
    };

    await expect(persistence.append(appendCommand([event]))).resolves.toMatchObject({
      type: "appended",
    });

    const coordinator = new SqlSessionExecutionCoordinator(client);
    await expect(coordinator.find({
      workspaceId: "workspace_01",
      executionId: event.id,
    })).resolves.toMatchObject({
      id: event.id,
      sessionId: "session_01",
      state: "queued",
      events: [event],
    });
  });

  it("creates one atomic execution outbox row per thread lane in a mixed SDK batch", async () => {
    const persistence = new SqlSessionEventPersistence(client, {
      executionOutbox: true,
    });
    const primary: SentSessionEvent = {
      id: "event_primary",
      type: "user.message",
      content: [{ type: "text", text: "Primary" }],
      processedAt: "2026-08-26T05:00:00.000Z",
    };
    const child: SentSessionEvent = {
      id: "event_child",
      type: "user.message",
      sessionThreadId: "sthr_child",
      content: [{ type: "text", text: "Child" }],
      processedAt: "2026-08-26T05:00:00.000Z",
    };

    await expect(
      persistence.append(appendCommand([primary, child])),
    ).resolves.toMatchObject({ type: "appended" });

    const rows = await client.prepare(
      `SELECT id, lane_id, events_json
         FROM managed_session_executions ORDER BY id`,
    ).all<{ id: string; lane_id: string; events_json: string }>();
    expect(rows.results?.map((row) => ({
      id: row.id,
      lane_id: row.lane_id,
      events: JSON.parse(row.events_json),
    }))).toEqual([
      {
        id: "event_child",
        lane_id: "sthr_child",
        events: [child],
      },
      {
        id: "event_primary",
        lane_id: "sthr_primary",
        events: [primary],
      },
    ]);
  });

  it("atomically interrupts only the named thread lane", async () => {
    const persistence = new SqlSessionEventPersistence(client, {
      executionOutbox: true,
    });
    const coordinator = new SqlSessionExecutionCoordinator(client);
    await coordinator.admit({
      execution: {
        id: "primary_running",
        workspaceId: "workspace_01",
        sessionId: "session_01",
        laneId: "sthr_primary",
        admittedAt: "2026-08-26T05:00:00.000Z",
        events: [{
          id: "primary_running",
          type: "user.message",
          content: [{ type: "text", text: "Primary" }],
          processedAt: "2026-08-26T05:00:00.000Z",
        }],
      },
    });
    await coordinator.admit({
      execution: {
        id: "child_running",
        workspaceId: "workspace_01",
        sessionId: "session_01",
        laneId: "sthr_child",
        admittedAt: "2026-08-26T05:00:00.000Z",
        events: [{
          id: "child_running",
          type: "user.message",
          sessionThreadId: "sthr_child",
          content: [{ type: "text", text: "Child" }],
          processedAt: "2026-08-26T05:00:00.000Z",
        }],
      },
    });
    await coordinator.claim({
      ownerId: "owner_primary",
      attemptId: "attempt_primary",
      claimedAt: "2026-08-26T05:00:01.000Z",
      leaseTtlMs: 30_000,
    });
    await coordinator.claim({
      ownerId: "owner_child",
      attemptId: "attempt_child",
      claimedAt: "2026-08-26T05:00:01.000Z",
      leaseTtlMs: 30_000,
    });
    const interrupt: SentSessionEvent = {
      id: "interrupt_primary",
      type: "user.interrupt",
      sessionThreadId: "sthr_primary",
      processedAt: "2026-08-26T05:00:02.000Z",
    };

    await expect(
      persistence.append(appendCommand([interrupt])),
    ).resolves.toMatchObject({ type: "appended" });

    await expect(coordinator.find({
      workspaceId: "workspace_01",
      executionId: "primary_running",
    })).resolves.toMatchObject({
      interruptRequestedAt: interrupt.processedAt,
    });
    await expect(coordinator.find({
      workspaceId: "workspace_01",
      executionId: "child_running",
    })).resolves.toMatchObject({ interruptRequestedAt: null });
  });

  it("does not leak events or work when two acceptances use the same revision", async () => {
    const persistence = new SqlSessionEventPersistence(client, {
      executionOutbox: true,
    });
    const first: SentSessionEvent = {
      id: "event_winner",
      type: "user.message",
      content: [{ type: "text", text: "Winner" }],
      processedAt: "2026-08-26T05:00:00.000Z",
    };
    const loser: SentSessionEvent = {
      id: "event_loser",
      type: "user.message",
      content: [{ type: "text", text: "Loser" }],
      processedAt: "2026-08-26T05:00:01.000Z",
    };

    await expect(persistence.append(appendCommand([first]))).resolves.toMatchObject({
      type: "appended",
    });
    await expect(persistence.append(appendCommand([loser]))).resolves.toEqual({
      type: "revision_conflict",
      actualRevision: 2,
    });

    const events = await client.prepare(
      `SELECT id FROM managed_session_events ORDER BY id`,
    ).all<{ id: string }>();
    const executions = await client.prepare(
      `SELECT id FROM managed_session_executions ORDER BY id`,
    ).all<{ id: string }>();
    expect(events.results).toEqual([{ id: "event_winner" }]);
    expect(executions.results).toEqual([{ id: "event_winner" }]);
  });

  it("atomically signals the running attempt and queues non-interrupt work from a mixed batch", async () => {
    const persistence = new SqlSessionEventPersistence(client, {
      executionOutbox: true,
    });
    const current: SentSessionEvent = {
      id: "event_current",
      type: "user.message",
      content: [{ type: "text", text: "Long task" }],
      processedAt: "2026-08-26T05:00:00.000Z",
    };
    await persistence.append(appendCommand([current]));
    const coordinator = new SqlSessionExecutionCoordinator(client);
    await coordinator.claim({
      ownerId: "node_01",
      attemptId: "attempt_01",
      claimedAt: "2026-08-26T05:00:01.000Z",
      leaseTtlMs: 30_000,
    });
    await coordinator.admit({
      execution: {
        id: "event_already_queued",
        workspaceId: "workspace_01",
        sessionId: "session_01",
        admittedAt: "2026-08-26T05:00:01.500Z",
        events: [{
          id: "event_already_queued",
          type: "user.message",
          content: [{ type: "text", text: "Stale queued task" }],
          processedAt: "2026-08-26T05:00:01.500Z",
        }],
      },
    });
    const interrupt: SentSessionEvent = {
      id: "event_interrupt",
      type: "user.interrupt",
      processedAt: "2026-08-26T05:00:02.000Z",
    };
    const next: SentSessionEvent = {
      id: "event_next",
      type: "user.message",
      content: [{ type: "text", text: "Replacement task" }],
      processedAt: "2026-08-26T05:00:02.000Z",
    };

    await expect(persistence.append({
      ...appendCommand([interrupt, next]),
      expectedRevision: 2,
      nextSession: {
        ...session,
        updatedAt: "2026-08-26T05:00:02.000Z",
      },
    })).resolves.toMatchObject({ type: "appended" });

    await expect(coordinator.find({
      workspaceId: "workspace_01",
      executionId: current.id,
    })).resolves.toMatchObject({
      state: "running",
      interruptRequestedAt: interrupt.processedAt,
    });
    await expect(coordinator.find({
      workspaceId: "workspace_01",
      executionId: next.id,
    })).resolves.toMatchObject({
      state: "queued",
      events: [next],
    });
    await expect(coordinator.find({
      workspaceId: "workspace_01",
      executionId: "event_already_queued",
    })).resolves.toMatchObject({ state: "cancelled" });
    await expect(coordinator.find({
      workspaceId: "workspace_01",
      executionId: interrupt.id,
    })).resolves.toBeNull();
  });

  it("lists by official filters and advances from a stable composite position", async () => {
    const persistence = new SqlSessionEventPersistence(client);
    const first = sent("event_01", "2026-08-26T05:00:00.000Z", "First");
    const sameTime = sent("event_02", "2026-08-26T05:00:00.000Z", "Second");
    const status: SessionEventView = {
      id: "event_03",
      type: "session.status_running",
      processedAt: "2026-08-26T06:00:00.000Z",
    };
    await persistence.append(appendCommand([first, sameTime]));
    await client
      .prepare(
        `INSERT INTO managed_session_events
          (workspace_id, session_id, id, type, document, processed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "workspace_01",
        "session_01",
        status.id,
        status.type,
        JSON.stringify(status),
        Date.parse(status.processedAt),
      )
      .run();

    await expect(
      persistence.list({
        workspaceId: "workspace_01",
        sessionId: "session_01",
        limit: 10,
        order: "asc",
        createdAtOrAfter: "2026-08-26T05:00:00.000Z",
        createdBefore: "2026-08-26T06:00:00.000Z",
        types: ["system.message"],
        position: {
          processedAt: first.processedAt!,
          eventId: first.id,
        },
      }),
    ).resolves.toEqual([sameTime]);
    await expect(
      persistence.list({
        workspaceId: "workspace_01",
        sessionId: "session_01",
        limit: 2,
        order: "desc",
        createdAfter: "2026-08-26T04:00:00.000Z",
        createdAtOrBefore: "2026-08-26T06:00:00.000Z",
      }),
    ).resolves.toEqual([status, sameTime]);
  });
});
