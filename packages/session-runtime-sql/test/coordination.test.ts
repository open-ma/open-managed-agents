import { beforeEach, describe, expect, it } from "vitest";
import type {
  AdmitSessionExecution,
  SessionExecutionCoordinatorPort,
  SessionExecutionFence,
} from "@open-managed-agents/session-runtime-contract/coordination";
import {
  createBetterSqlite3SqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import {
  ensureSessionExecutionCoordinatorSchema,
  SqlSessionExecutionCoordinator,
} from "../src/coordination";
import {
  sessionExecutionEventBatches,
  sessionExecutionId,
} from "@open-managed-agents/session-runtime-contract/coordination";
import { sessionExecutionStoreConformance } from
  "../../session-runtime-contract/test/execution-store-conformance";

const at = (seconds: number) =>
  new Date(Date.UTC(2026, 8, 4, 0, 0, seconds)).toISOString();

function executionRow(overrides: Record<string, unknown> = {}) {
  return {
    workspace_id: "workspace_01",
    session_id: "session_01",
    lane_id: "sthr_primary",
    id: "execution_row",
    admitted_at_ms: String(Date.parse(at(1))),
    events_json: JSON.stringify(admitted("event", "session_01", at(1)).execution.events),
    events_fingerprint: "fingerprint",
    state: "queued",
    attempt_id: null,
    owner_id: null,
    generation: "0",
    attempt_count: "0",
    max_attempts: "10",
    deadline_at_ms: String(Date.parse(at(30))),
    claimed_at_ms: null,
    lease_expires_at_ms: null,
    interrupt_requested_at_ms: null,
    settled_at_ms: null,
    failure: null,
    revision: "1",
    ...overrides,
  };
}

function fakeSql(options: {
  row?: Record<string, unknown> | null;
  allResults?: Array<{ name?: string }>;
  omitAllResults?: boolean;
  batchResults?: Array<{ meta: { changes: number } }>;
} = {}): SqlClient {
  const statement = {
    bind: () => statement,
    run: async () => ({ meta: { changes: 1 } }),
    first: async () => options.row ?? null,
    all: async () => options.omitAllResults
      ? {}
      : { results: options.allResults ?? [] },
  };
  return {
    prepare: () => statement,
    batch: async () => options.batchResults ?? [
      { meta: { changes: 0 } },
      { meta: { changes: 0 } },
    ],
    exec: async () => {},
  } as SqlClient;
}

function admitted(
  id: string,
  sessionId: string,
  admittedAt: string,
  text = id,
): AdmitSessionExecution {
  return {
    execution: {
      id,
      workspaceId: "workspace_01",
      sessionId,
      admittedAt,
      events: [{
        id,
        type: "user.message",
        content: [{ type: "text", text }],
        processedAt: admittedAt,
      }],
    },
  };
}

describe("SqlSessionExecutionCoordinator", () => {
  let sql: SqlClient;
  let coordinator: SessionExecutionCoordinatorPort;

  beforeEach(async () => {
    sql = await createBetterSqlite3SqlClient(":memory:");
    await ensureSessionExecutionCoordinatorSchema(sql);
    coordinator = new SqlSessionExecutionCoordinator(sql);
  });

  it("rejects malformed admissions, timestamps, leases, and empty execution ids", async () => {
    await expect(coordinator.admit({
      execution: {
        id: "empty",
        workspaceId: "workspace_01",
        sessionId: "session_01",
        admittedAt: at(1),
        events: [],
      },
    })).rejects.toThrow("at least one event");
    await expect(coordinator.admit(
      admitted("bad_time", "session_01", "not-a-time"),
    )).rejects.toThrow("Invalid admission timestamp");
    await expect(coordinator.claim({
      ownerId: "node_a",
      attemptId: "attempt_a",
      claimedAt: at(1),
      leaseTtlMs: 0,
    })).rejects.toThrow("positive integer");
    await expect(coordinator.claim({
      ownerId: "node_a",
      attemptId: "attempt_fractional",
      claimedAt: at(1),
      leaseTtlMs: 1.5,
    })).rejects.toThrow("positive integer");
    await expect(coordinator.admit({
      ...admitted("bad_attempts", "session_01", at(1)),
      policy: { maxAttempts: 0, timeoutMs: 1_000 },
    })).rejects.toThrow("maxAttempts must be a positive integer");
    await expect(coordinator.admit({
      ...admitted("fractional_attempts", "session_01", at(1)),
      policy: { maxAttempts: 1.5, timeoutMs: 1_000 },
    })).rejects.toThrow("maxAttempts must be a positive integer");
    await expect(coordinator.admit({
      ...admitted("bad_timeout", "session_01", at(1)),
      policy: { maxAttempts: 1, timeoutMs: 0 },
    })).rejects.toThrow("timeoutMs must be a positive integer");
    await expect(coordinator.admit({
      ...admitted("fractional_timeout", "session_01", at(1)),
      policy: { maxAttempts: 1, timeoutMs: 1.5 },
    })).rejects.toThrow("timeoutMs must be a positive integer");
    await expect(coordinator.admit({
      ...admitted(
        "overflow_deadline",
        "session_01",
        new Date(8_640_000_000_000_000).toISOString(),
      ),
      policy: { maxAttempts: 1, timeoutMs: Number.MAX_SAFE_INTEGER },
    })).rejects.toThrow("deadline exceeds safe timestamp range");
    expect(() => sessionExecutionId([])).toThrow("at least one event");
    expect(sessionExecutionId(admitted("one", "session_01", at(1)).execution.events))
      .toBe("one");
    const batches = sessionExecutionEventBatches([
      ...admitted("first", "session_01", at(1)).execution.events,
      ...admitted("second", "session_01", at(2)).execution.events,
    ]);
    expect(batches).toEqual([
      expect.objectContaining({ id: "first", laneId: "sthr_primary", events: expect.arrayContaining([
        expect.objectContaining({ id: "first" }),
        expect.objectContaining({ id: "second" }),
      ]) }),
    ]);
    expect(sessionExecutionEventBatches([{
      ...admitted("null_lane", "session_01", at(1)).execution.events[0],
      sessionThreadId: null,
    }])).toEqual([
      expect.objectContaining({ id: "null_lane", laneId: "sthr_primary" }),
    ]);
  });

  it("handles SQL portability envelopes and rejects corrupt execution rows", async () => {
    await expect(ensureSessionExecutionCoordinatorSchema(fakeSql({
      omitAllResults: true,
    }))).resolves.toBeUndefined();

    const portable = new SqlSessionExecutionCoordinator(fakeSql({
      row: executionRow(),
    }));
    await expect(portable.find({
      workspaceId: "workspace_01",
      executionId: "execution_row",
    })).resolves.toMatchObject({
      attemptCount: 0,
      maxAttempts: 10,
      revision: 1,
    });

    const corrupt = new SqlSessionExecutionCoordinator(fakeSql({
      row: executionRow({ generation: "not-an-integer" }),
    }));
    await expect(corrupt.find({
      workspaceId: "workspace_01",
      executionId: "execution_row",
    })).rejects.toThrow("Invalid execution generation");

    const malformedClaim = new SqlSessionExecutionCoordinator(fakeSql({
      row: executionRow(),
    }));
    await expect(malformedClaim.claim({
      ownerId: "node_a",
      attemptId: "attempt_a",
      claimedAt: at(2),
      leaseTtlMs: 1_000,
    })).rejects.toThrow("Claimed Session Execution has no attempt");
  });

  it("fails admission if the inserted execution cannot be read back", async () => {
    const store = new SqlSessionExecutionCoordinator(fakeSql());
    store.find = async () => null;

    await expect(store.admit(admitted("vanished", "session_01", at(1))))
      .rejects.toThrow("vanished after admission");
  });

  it("rejects a malformed SQL batch response during session cancellation", async () => {
    const store = new SqlSessionExecutionCoordinator(fakeSql({ batchResults: [] }));

    await expect(store.cancelSession({
      workspaceId: "workspace_01",
      sessionId: "session_01",
      cancelledAt: at(2),
      reason: "cancel",
    })).rejects.toThrow("two results");
  });

  it("upgrades an early preview table before creating the lane index", async () => {
    const legacy = await createBetterSqlite3SqlClient(":memory:");
    await legacy.exec(`
      CREATE TABLE managed_session_executions (
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        id TEXT NOT NULL,
        admitted_at_ms BIGINT NOT NULL,
        events_json TEXT NOT NULL,
        state TEXT NOT NULL,
        attempt_id TEXT,
        owner_id TEXT,
        PRIMARY KEY (workspace_id, id)
      )
    `);
    await ensureSessionExecutionCoordinatorSchema(legacy);
    const columns = await legacy
      .prepare("PRAGMA table_info(managed_session_executions)")
      .all<{ name: string }>();
    expect(columns.results?.map((column) => column.name)).toEqual(
      expect.arrayContaining(["lane_id", "events_fingerprint", "deadline_at_ms"]),
    );
    const upgraded = new SqlSessionExecutionCoordinator(legacy);
    await expect(upgraded.admit(admitted("upgraded", "session_01", at(1))))
      .resolves.toMatchObject({ type: "admitted", execution: { laneId: "sthr_primary" } });
  });

  it("admits idempotent replays but exposes an identity collision", async () => {
    const input = admitted("execution_01", "session_01", at(1));
    await expect(coordinator.admit(input)).resolves.toMatchObject({
      type: "admitted",
      execution: { state: "queued", revision: 1 },
    });
    await expect(coordinator.admit(structuredClone(input))).resolves.toMatchObject({
      type: "replayed",
      execution: { id: "execution_01", revision: 1 },
    });
    await expect(
      coordinator.admit(admitted("execution_01", "session_01", at(1), "different")),
    ).resolves.toMatchObject({ type: "conflict" });
  });

  it("claims only each session's FIFO head while allowing other sessions to run", async () => {
    await coordinator.admit(admitted("a1", "session_a", at(1)));
    await coordinator.admit(admitted("a2", "session_a", at(2)));
    await coordinator.admit(admitted("b1", "session_b", at(3)));

    const first = await coordinator.claim({
      ownerId: "node_a",
      attemptId: "attempt_a1",
      claimedAt: at(4),
      leaseTtlMs: 30_000,
    });
    const second = await coordinator.claim({
      ownerId: "node_b",
      attemptId: "attempt_b1",
      claimedAt: at(4),
      leaseTtlMs: 30_000,
    });
    const third = await coordinator.claim({
      ownerId: "node_c",
      attemptId: "attempt_none",
      claimedAt: at(4),
      leaseTtlMs: 30_000,
    });

    expect(first).toMatchObject({
      type: "claimed",
      execution: { id: "a1", sessionId: "session_a" },
    });
    expect(second).toMatchObject({
      type: "claimed",
      execution: { id: "b1", sessionId: "session_b" },
    });
    expect(third).toEqual({ type: "empty" });
  });

  it("reclaims an expired lease and fences the stale attempt from renew and settle", async () => {
    await coordinator.admit(admitted("execution_01", "session_01", at(1)));
    const first = await coordinator.claim({
      ownerId: "node_old",
      attemptId: "attempt_old",
      claimedAt: at(2),
      leaseTtlMs: 2_000,
    });
    expect(first.type).toBe("claimed");
    if (first.type !== "claimed") return;

    const reclaimed = await coordinator.claim({
      ownerId: "node_new",
      attemptId: "attempt_new",
      claimedAt: at(5),
      leaseTtlMs: 30_000,
    });
    expect(reclaimed).toMatchObject({
      type: "claimed",
      fence: { generation: 2, ownerId: "node_new", attemptId: "attempt_new" },
    });
    await expect(coordinator.renew({
      fence: first.fence,
      renewedAt: at(5),
      leaseTtlMs: 30_000,
    })).resolves.toEqual({ type: "lost" });
    await expect(coordinator.settle({
      fence: first.fence,
      settledAt: at(5),
      outcome: "completed",
    })).resolves.toEqual({ type: "lost" });
  });

  it("never lets one live worker reclaim its own expired in-flight attempt", async () => {
    await coordinator.admit(admitted("execution_01", "session_01", at(1)));
    await coordinator.claim({
      ownerId: "node_live",
      attemptId: "attempt_old",
      claimedAt: at(2),
      leaseTtlMs: 1_000,
    });

    await expect(coordinator.claim({
      ownerId: "node_live",
      attemptId: "attempt_duplicate",
      claimedAt: at(5),
      leaseTtlMs: 30_000,
    })).resolves.toEqual({ type: "empty" });
    await expect(coordinator.claim({
      ownerId: "node_replacement",
      attemptId: "attempt_replacement",
      claimedAt: at(5),
      leaseTtlMs: 30_000,
    })).resolves.toMatchObject({
      type: "claimed",
      fence: { ownerId: "node_replacement", generation: 2 },
    });
  });

  it("terminalizes poison work after its attempt budget is exhausted", async () => {
    await coordinator.admit({
      ...admitted("poison", "session_a", at(1)),
      policy: { maxAttempts: 1, timeoutMs: 60_000 },
    });
    await coordinator.claim({
      ownerId: "dead_node",
      attemptId: "attempt_1",
      claimedAt: at(2),
      leaseTtlMs: 1_000,
    });

    await expect(coordinator.claim({
      ownerId: "replacement",
      attemptId: "attempt_2",
      claimedAt: at(5),
      leaseTtlMs: 30_000,
    })).resolves.toEqual({ type: "empty" });
    await expect(coordinator.find({
      workspaceId: "workspace_01",
      executionId: "poison",
    })).resolves.toMatchObject({
      state: "failed",
      attemptCount: 1,
      maxAttempts: 1,
      failure: "execution attempt limit exhausted",
    });
  });

  it("never claims or renews work beyond its absolute deadline", async () => {
    await coordinator.admit({
      ...admitted("expired_before_claim", "session_a", at(1)),
      policy: { maxAttempts: 3, timeoutMs: 1_000 },
    });
    await expect(coordinator.claim({
      ownerId: "node_a",
      attemptId: "late_attempt",
      claimedAt: at(3),
      leaseTtlMs: 30_000,
    })).resolves.toEqual({ type: "empty" });
    await expect(coordinator.find({
      workspaceId: "workspace_01",
      executionId: "expired_before_claim",
    })).resolves.toMatchObject({
      state: "failed",
      failure: "execution deadline exceeded",
      deadlineAt: at(2),
    });

    await coordinator.admit({
      ...admitted("expires_running", "session_b", at(4)),
      policy: { maxAttempts: 3, timeoutMs: 2_000 },
    });
    const claimed = await coordinator.claim({
      ownerId: "node_b",
      attemptId: "attempt_running",
      claimedAt: at(5),
      leaseTtlMs: 30_000,
    });
    expect(claimed.type).toBe("claimed");
    if (claimed.type !== "claimed") return;
    await expect(coordinator.renew({
      fence: claimed.fence,
      renewedAt: at(6),
      leaseTtlMs: 30_000,
    })).resolves.toEqual({ type: "lost" });
  });

  it("delivers a durable interrupt through heartbeat and advances after settlement", async () => {
    await coordinator.admit(admitted("a1", "session_a", at(1)));
    const claimed = await coordinator.claim({
      ownerId: "node_a",
      attemptId: "attempt_a1",
      claimedAt: at(3),
      leaseTtlMs: 30_000,
    });
    expect(claimed.type).toBe("claimed");
    if (claimed.type !== "claimed") return;

    await expect(coordinator.requestInterrupt({
      workspaceId: "workspace_01",
      sessionId: "session_a",
      requestedAt: at(4),
    })).resolves.toEqual({ type: "requested" });
    const renewed = await coordinator.renew({
      fence: claimed.fence,
      renewedAt: at(5),
      leaseTtlMs: 30_000,
    });
    expect(renewed).toMatchObject({
      type: "renewed",
      interruptRequestedAt: at(4),
    });
    const fence = renewed.type === "renewed" ? renewed.fence : claimed.fence;
    await expect(coordinator.settle({
      fence,
      settledAt: at(6),
      outcome: "cancelled",
    })).resolves.toMatchObject({
      type: "settled",
      execution: { state: "cancelled", settledAt: at(6) },
    });

    await coordinator.admit(admitted("a2", "session_a", at(7)));

    await expect(coordinator.claim({
      ownerId: "node_b",
      attemptId: "attempt_a2",
      claimedAt: at(8),
      leaseTtlMs: 30_000,
    })).resolves.toMatchObject({
      type: "claimed",
      execution: { id: "a2" },
    });
  });

  it("flushes queued work, keeps the first interrupt intent, and terminalizes an expired owner", async () => {
    await coordinator.admit(admitted("active", "session_a", at(1)));
    await coordinator.admit(admitted("queued", "session_a", at(2)));
    await coordinator.claim({
      ownerId: "dead_node",
      attemptId: "dead_attempt",
      claimedAt: at(3),
      leaseTtlMs: 1_000,
    });

    await expect(coordinator.requestInterrupt({
      workspaceId: "workspace_01",
      sessionId: "session_a",
      requestedAt: at(5),
    })).resolves.toEqual({ type: "requested" });
    await coordinator.requestInterrupt({
      workspaceId: "workspace_01",
      sessionId: "session_a",
      requestedAt: at(6),
    });

    await expect(coordinator.find({
      workspaceId: "workspace_01",
      executionId: "active",
    })).resolves.toMatchObject({
      state: "cancelled",
      interruptRequestedAt: at(5),
      settledAt: at(5),
    });
    await expect(coordinator.find({
      workspaceId: "workspace_01",
      executionId: "queued",
    })).resolves.toMatchObject({ state: "cancelled", settledAt: at(5) });
    await expect(coordinator.claim({
      ownerId: "replacement",
      attemptId: "replacement_attempt",
      claimedAt: at(7),
      leaseTtlMs: 30_000,
    })).resolves.toEqual({ type: "empty" });
  });

  it("has a single atomic winner when replicas race for one execution", async () => {
    await coordinator.admit(admitted("execution_01", "session_01", at(1)));
    const results = await Promise.all([
      coordinator.claim({
        ownerId: "node_a",
        attemptId: "attempt_a",
        claimedAt: at(2),
        leaseTtlMs: 30_000,
      }),
      coordinator.claim({
        ownerId: "node_b",
        attemptId: "attempt_b",
        claimedAt: at(2),
        leaseTtlMs: 30_000,
      }),
    ]);
    expect(results.filter((result) => result.type === "claimed")).toHaveLength(1);
    expect(results.filter((result) => result.type === "empty")).toHaveLength(1);
  });

  it("rejects a settlement after the current lease has expired", async () => {
    await coordinator.admit(admitted("execution_01", "session_01", at(1)));
    const claimed = await coordinator.claim({
      ownerId: "node_a",
      attemptId: "attempt_a",
      claimedAt: at(2),
      leaseTtlMs: 1_000,
    });
    expect(claimed.type).toBe("claimed");
    if (claimed.type !== "claimed") return;
    await expect(coordinator.settle({
      fence: claimed.fence,
      settledAt: at(4),
      outcome: "completed",
    })).resolves.toEqual({ type: "lost" });
  });

  it("does not let an idle interrupt leak into a later execution", async () => {
    await expect(coordinator.requestInterrupt({
      workspaceId: "workspace_01",
      sessionId: "session_01",
      requestedAt: at(1),
    })).resolves.toEqual({ type: "idle" });
    await coordinator.admit(admitted("execution_01", "session_01", at(2)));
    const claimed = await coordinator.claim({
      ownerId: "node_a",
      attemptId: "attempt_a",
      claimedAt: at(3),
      leaseTtlMs: 30_000,
    });
    expect(claimed).toMatchObject({
      type: "claimed",
      execution: { interruptRequestedAt: null },
    });
  });

  it("atomically fences queued and running executions for a deleted session", async () => {
    await coordinator.admit(admitted("a1", "session_a", at(1)));
    await coordinator.admit(admitted("a2", "session_a", at(2)));
    await coordinator.admit(admitted("b1", "session_b", at(3)));
    const claimed = await coordinator.claim({
      ownerId: "node_a",
      attemptId: "attempt_a1",
      claimedAt: at(4),
      leaseTtlMs: 30_000,
    });
    expect(claimed).toMatchObject({ type: "claimed", execution: { id: "a1" } });

    await expect(coordinator.cancelSession({
      workspaceId: "workspace_01",
      sessionId: "session_a",
      cancelledAt: at(5),
      reason: "session deleted",
    })).resolves.toEqual({ queued: 1, running: 1 });
    await expect(coordinator.find({
      workspaceId: "workspace_01",
      executionId: "a1",
    })).resolves.toMatchObject({ state: "cancelled", failure: "session deleted" });
    await expect(coordinator.find({
      workspaceId: "workspace_01",
      executionId: "a2",
    })).resolves.toMatchObject({ state: "cancelled", failure: "session deleted" });
    await expect(coordinator.claim({
      ownerId: "node_b",
      attemptId: "attempt_b1",
      claimedAt: at(6),
      leaseTtlMs: 30_000,
    })).resolves.toMatchObject({ type: "claimed", execution: { id: "b1" } });
  });
});

sessionExecutionStoreConformance("better-sqlite3", {
  async withStore(_fixtureId, run) {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    await ensureSessionExecutionCoordinatorSchema(sql);
    return run(new SqlSessionExecutionCoordinator(sql));
  },
});
