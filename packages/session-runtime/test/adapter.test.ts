// Unified-runtime adapter tests.
//
// What this proves: the RuntimeAdapter shape works identically against
// any SqlClient. CF (CfD1SqlClient over DO storage) and Node
// (BetterSqlite3SqlClient over a shared file/PG) both produce the same
// observable behaviour because they speak the same port.
//
// Engine: better-sqlite3 in `:memory:` mode. Real SQL semantics, no I/O,
// no platform branches. The SqlClient hides the engine; if the adapter's
// SQL works on better-sqlite3 it works on D1 + postgres (modulo dialect
// quirks already handled by the client adapters).
//
// Coverage map vs the testing plan (Phase 5):
//   ✓ beginTurn / endTurn / listOrphanTurns invariants
//   ✓ endTurn idempotency (no clobber after a stale call)
//   ✓ Crash-recovery flow: beginTurn → "process death" (no endTurn) →
//     listOrphanTurns surfaces the row → endTurn clears it
//   ✓ hintTurnInFlight callback fires + only on beginTurn
//   - Node child_process kill simulation: separate file (apps/main-node)
//   - fast-check property tests on recovery.ts: separate file
//   - CF DO ctx.abort() eviction: lives in test/integration/recovery-do

import { describe, it, expect, beforeEach } from "vitest";
import { createBetterSqlite3SqlClient, type SqlClient } from "@open-managed-agents/sql-client";
import {
  SqlStreamRepo,
  SqlEventLog,
  ensureSchema as ensureEventLogSchema,
} from "@open-managed-agents/event-log/sql";
import {
  RuntimeAdapterImpl,
  type RuntimeAdapter,
} from "@open-managed-agents/session-runtime";
import type { SessionEvent } from "@open-managed-agents/shared";

interface Fixture {
  sql: SqlClient;
  adapter: RuntimeAdapter;
  hintFires: string[];
}

async function newFixture(): Promise<Fixture> {
  // `:memory:` gives a fresh, isolated SQLite DB per fixture — no
  // teardown needed between tests, no fs I/O.
  const sql = await createBetterSqlite3SqlClient(":memory:");
  // Mirror the unified `sessions` schema (apps/main-node main DDL +
  // apps/main/migrations/0014_session_turn_id.sql).
  await sql.exec(`
    CREATE TABLE sessions (
      id              TEXT PRIMARY KEY NOT NULL,
      tenant_id       TEXT NOT NULL,
      agent_id        TEXT,
      status          TEXT NOT NULL,
      title           TEXT,
      turn_id         TEXT,
      turn_started_at INTEGER,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
  `);
  await ensureEventLogSchema(sql);

  // Seed a session row.
  const now = Date.now();
  await sql
    .prepare(
      `INSERT INTO sessions (id, tenant_id, agent_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind("sess_test", "tn_test", "agent_test", "idle", now, now)
    .run();

  const eventLog = new SqlEventLog(sql, "sess_test", () => {});
  const streams = new SqlStreamRepo(sql, "sess_test");
  const hintFires: string[] = [];
  const adapter = new RuntimeAdapterImpl({
    sql,
    eventLog,
    streams,
    onTurnInFlight: (sid) => hintFires.push(sid),
  });

  return { sql, adapter, hintFires };
}

async function readSession(
  sql: SqlClient,
  id: string,
): Promise<{ status: string; turn_id: string | null; turn_started_at: number | null } | null> {
  return sql
    .prepare(`SELECT status, turn_id, turn_started_at FROM sessions WHERE id = ?`)
    .bind(id)
    .first();
}

describe("RuntimeAdapter — unified shape (Node + CF)", () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await newFixture();
  });

  it("beginTurn marks status='running' + sets turn_id + turn_started_at", async () => {
    await f.adapter.beginTurn("sess_test", "turn_abc");
    const row = await readSession(f.sql, "sess_test");
    expect(row?.status).toBe("running");
    expect(row?.turn_id).toBe("turn_abc");
    expect(row?.turn_started_at).toBeGreaterThan(0);
  });

  it("endTurn(idle) clears turn_id and flips status", async () => {
    await f.adapter.beginTurn("sess_test", "turn_abc");
    await f.adapter.endTurn("sess_test", "turn_abc", "idle");
    const row = await readSession(f.sql, "sess_test");
    expect(row?.status).toBe("idle");
    expect(row?.turn_id).toBeNull();
    expect(row?.turn_started_at).toBeNull();
  });

  it("endTurn(destroyed) flips status to destroyed", async () => {
    await f.adapter.beginTurn("sess_test", "turn_abc");
    await f.adapter.endTurn("sess_test", "turn_abc", "destroyed");
    const row = await readSession(f.sql, "sess_test");
    expect(row?.status).toBe("destroyed");
    expect(row?.turn_id).toBeNull();
  });

  it("endTurn is idempotent — second call with same turn_id no-op", async () => {
    await f.adapter.beginTurn("sess_test", "turn_abc");
    await f.adapter.endTurn("sess_test", "turn_abc", "idle");
    // Race scenario: a stale recovery path tries to endTurn after the
    // session already moved on. Should be a silent no-op (filtered by
    // turn_id in the WHERE clause).
    await f.adapter.endTurn("sess_test", "turn_abc", "destroyed");
    const row = await readSession(f.sql, "sess_test");
    // Status stayed 'idle' from the first endTurn.
    expect(row?.status).toBe("idle");
  });

  it("endTurn with stale turn_id doesn't clobber a fresh beginTurn", async () => {
    // T1: turn_abc runs and ends.
    await f.adapter.beginTurn("sess_test", "turn_abc");
    await f.adapter.endTurn("sess_test", "turn_abc", "idle");
    // T2: turn_def starts.
    await f.adapter.beginTurn("sess_test", "turn_def");
    // T3: a delayed/buggy endTurn for the OLD turn_abc fires. WHERE
    // clause filters by turn_id — should not affect turn_def.
    await f.adapter.endTurn("sess_test", "turn_abc", "destroyed");
    const row = await readSession(f.sql, "sess_test");
    expect(row?.status).toBe("running");
    expect(row?.turn_id).toBe("turn_def");
  });

  it("listOrphanTurns returns rows with status='running' AND turn_id IS NOT NULL", async () => {
    await f.adapter.beginTurn("sess_test", "turn_abc");
    const orphans = await f.adapter.listOrphanTurns("sess_test");
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({
      session_id: "sess_test",
      turn_id: "turn_abc",
    });
  });

  it("listOrphanTurns returns empty after endTurn", async () => {
    await f.adapter.beginTurn("sess_test", "turn_abc");
    await f.adapter.endTurn("sess_test", "turn_abc", "idle");
    const orphans = await f.adapter.listOrphanTurns("sess_test");
    expect(orphans).toHaveLength(0);
  });

  it("crash-recovery flow: beginTurn → simulated crash → orphan visible → endTurn clears", async () => {
    // 1. Turn starts, marker written to sessions.turn_id.
    await f.adapter.beginTurn("sess_test", "turn_crashed");
    // 2. "Process death" — simulate by losing in-memory state. The
    //    SQL row remains. This is exactly what fly auto_stop / k8s
    //    SIGKILL / DO eviction look like to the recovery path: nobody
    //    called endTurn before the process died.
    //    (We don't simulate restart; we just verify the next process's
    //    listOrphanTurns sees the row.)
    // 3. New process boots → registry.bootstrap calls listOrphanTurns
    //    (Node) or alarm() calls _checkOrphanTurns (CF). Same query.
    const orphans = await f.adapter.listOrphanTurns("sess_test");
    expect(orphans).toHaveLength(1);
    expect(orphans[0].turn_id).toBe("turn_crashed");
    // 4. Recovery completes (recoverInterruptedState injects placeholder
    //    events; not exercised here — see test/unit/recovery.test.ts).
    //    Then adapter.endTurn(sid, turnId, "idle") flips the row.
    await f.adapter.endTurn("sess_test", "turn_crashed", "idle");
    const after = await f.adapter.listOrphanTurns("sess_test");
    expect(after).toHaveLength(0);
  });

  it("hintTurnInFlight callback fires when invoked — wires CF's setAlarm path", async () => {
    // hintTurnInFlight is a separate method on the adapter (not auto-
    // called by beginTurn) so callers can place the hint at the exact
    // point they want — both turn-runtime.ts (SessionDO path) and
    // SessionStateMachine.runHarnessTurn (Node path) call it right
    // after beginTurn. The test mirrors that pattern.
    expect(f.hintFires).toEqual([]);
    await f.adapter.beginTurn("sess_test", "turn_a");
    f.adapter.hintTurnInFlight?.("sess_test");
    expect(f.hintFires).toEqual(["sess_test"]);
    // endTurn doesn't fire it.
    await f.adapter.endTurn("sess_test", "turn_a", "idle");
    expect(f.hintFires).toEqual(["sess_test"]);
    // Next turn — caller invokes hint again.
    await f.adapter.beginTurn("sess_test", "turn_b");
    f.adapter.hintTurnInFlight?.("sess_test");
    expect(f.hintFires).toEqual(["sess_test", "sess_test"]);
  });

  it("listOrphanTurns scopes to the requested session_id", async () => {
    // Create a second session, mark it running.
    const now = Date.now();
    await f.sql
      .prepare(
        `INSERT INTO sessions (id, tenant_id, agent_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind("sess_other", "tn_test", "agent_test", "idle", now, now)
      .run();
    await f.adapter.beginTurn("sess_other", "turn_other");
    await f.adapter.beginTurn("sess_test", "turn_self");

    const ownOrphans = await f.adapter.listOrphanTurns("sess_test");
    expect(ownOrphans).toHaveLength(1);
    expect(ownOrphans[0].turn_id).toBe("turn_self");

    const otherOrphans = await f.adapter.listOrphanTurns("sess_other");
    expect(otherOrphans).toHaveLength(1);
    expect(otherOrphans[0].turn_id).toBe("turn_other");
  });
});
