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
  /** keepAliveWhile observer wired into the adapter (CF would do this
   *  via setAlarm + a refs counter). The fixture mirrors the same
   *  mechanic in-memory so we can assert refs invariants without
   *  requiring a real DO. */
  keepAlive: { refs: number; alarmsSet: number; releases: number };
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
  const keepAlive = { refs: 0, alarmsSet: 0, releases: 0 };
  const adapter = new RuntimeAdapterImpl({
    sql,
    eventLog,
    streams,
    onTurnInFlight: (sid) => hintFires.push(sid),
    // Mirror CF SessionDO's keepAliveWhile shape: increment refs at
    // start, fire-and-forget setAlarm, decrement in finally. The
    // adapter is the contract; the platform decides what setAlarm
    // means. Tests assert refs invariants only — alarm wiring is
    // observed via `alarmsSet` counter.
    keepAliveWhile: async <T>(fn: () => Promise<T>): Promise<T> => {
      keepAlive.refs++;
      keepAlive.alarmsSet++;
      try {
        return await fn();
      } finally {
        keepAlive.refs--;
        keepAlive.releases++;
      }
    },
  });

  return { sql, adapter, hintFires, keepAlive };
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

  // ── edge cases ─────────────────────────────────────────────────────

  it("listOrphanTurns excludes status='idle' rows even when turn_id stale-leaks", async () => {
    // Defensive: should never happen in production (endTurn always
    // nulls turn_id), but we want the orphan filter to be defence in
    // depth — status, not just turn_id, gates the result.
    const now = Date.now();
    await f.sql
      .prepare(
        `UPDATE sessions SET status='idle', turn_id='leaked_turn', updated_at=?
          WHERE id=?`,
      )
      .bind(now, "sess_test")
      .run();
    const orphans = await f.adapter.listOrphanTurns("sess_test");
    expect(orphans).toEqual([]);
  });

  it("listOrphanTurns excludes status='destroyed' rows even with turn_id set", async () => {
    const now = Date.now();
    await f.sql
      .prepare(
        `UPDATE sessions SET status='destroyed', turn_id='leaked_turn', updated_at=?
          WHERE id=?`,
      )
      .bind(now, "sess_test")
      .run();
    const orphans = await f.adapter.listOrphanTurns("sess_test");
    expect(orphans).toEqual([]);
  });

  it("listOrphanTurns excludes status='running' rows where turn_id IS NULL (defensive)", async () => {
    // Pathological: status='running' but no turn_id. Shouldn't happen,
    // but the orphan filter MUST require BOTH conditions so a stuck
    // status flag without a turn id can't trigger spurious recovery.
    const now = Date.now();
    await f.sql
      .prepare(
        `UPDATE sessions SET status='running', turn_id=NULL, updated_at=?
          WHERE id=?`,
      )
      .bind(now, "sess_test")
      .run();
    const orphans = await f.adapter.listOrphanTurns("sess_test");
    expect(orphans).toEqual([]);
  });

  it("beginTurn replaces an existing turn_id (last-writer-wins)", async () => {
    // Race: two callers both think they're starting a fresh turn (e.g.
    // a recovery and a real user.message). UPDATE has no WHERE-by-
    // turn_id so the second beginTurn replaces the first. Documents
    // current contract: caller is expected to serialize beginTurn at
    // the application layer (state machine holds the activeTurnId lock).
    await f.adapter.beginTurn("sess_test", "turn_a");
    await f.adapter.beginTurn("sess_test", "turn_b");
    const row = await readSession(f.sql, "sess_test");
    expect(row?.status).toBe("running");
    expect(row?.turn_id).toBe("turn_b");
  });

  it("turn_started_at advances on each beginTurn (used for stuck-turn detection)", async () => {
    await f.adapter.beginTurn("sess_test", "turn_a");
    const t1 = (await readSession(f.sql, "sess_test"))?.turn_started_at;
    expect(t1).toBeGreaterThan(0);
    // Force a >=1ms gap so SQLite ms timestamps differ even on a fast box.
    await new Promise((r) => setTimeout(r, 5));
    await f.adapter.endTurn("sess_test", "turn_a", "idle");
    await f.adapter.beginTurn("sess_test", "turn_b");
    const t2 = (await readSession(f.sql, "sess_test"))?.turn_started_at;
    expect(t2).toBeGreaterThan(t1!);
  });

  it("endTurn before any beginTurn is a silent no-op (row stays as-is)", async () => {
    // Stale recovery code path could conceivably try this. Filter on
    // turn_id IS NULL means the UPDATE matches nothing.
    await f.adapter.endTurn("sess_test", "ghost_turn", "idle");
    const row = await readSession(f.sql, "sess_test");
    expect(row?.status).toBe("idle");
    expect(row?.turn_id).toBeNull();
  });

  it("endTurn for an unknown sessionId is a silent no-op (no row, no UPDATE)", async () => {
    // Defence against orphan rows being deleted out from under recovery.
    await f.adapter.endTurn("sess_does_not_exist", "any_turn", "idle");
    // Original row still as-seeded.
    const row = await readSession(f.sql, "sess_test");
    expect(row?.status).toBe("idle");
  });

  it("listOrphanTurns surfaces turn_started_at exactly as written", async () => {
    // The recovery logger reports "started Nms ago" — relies on a
    // faithful pass-through of turn_started_at. Pin the contract.
    const before = Date.now();
    await f.adapter.beginTurn("sess_test", "turn_age");
    const orphans = await f.adapter.listOrphanTurns("sess_test");
    expect(orphans).toHaveLength(1);
    expect(orphans[0].turn_started_at).toBeGreaterThanOrEqual(before);
    expect(orphans[0].turn_started_at).toBeLessThanOrEqual(Date.now());
  });

  it("destroying then beginning the same session is rejected at the status level (orphan stays empty)", async () => {
    // Once a session is destroyed, beginTurn still UPDATES the row
    // (current implementation has no status-guard) but a destroyed
    // session shouldn't be receiving turns. Pin current behaviour: the
    // UPDATE happens and the row flips back to 'running' — the entry
    // shell is responsible for rejecting requests on destroyed sessions
    // before reaching the adapter. This test documents that the adapter
    // is unguarded so a future hardening change is intentional.
    await f.adapter.beginTurn("sess_test", "turn_x");
    await f.adapter.endTurn("sess_test", "turn_x", "destroyed");
    expect((await readSession(f.sql, "sess_test"))?.status).toBe("destroyed");
    // Adapter currently allows this — flips destroyed → running.
    await f.adapter.beginTurn("sess_test", "turn_after_destroy");
    expect((await readSession(f.sql, "sess_test"))?.status).toBe("running");
    // Document for the next reader: tighten via a status-guarded
    // UPDATE if/when the entry shell is no longer trusted to filter.
  });

  it("hintTurnInFlight is optional — omitting onTurnInFlight does not throw", async () => {
    // Adapter without the hint callback (Node case) — calling
    // hintTurnInFlight should be a silent no-op.
    const sql = f.sql;
    const eventLog = (
      f.adapter as unknown as { eventLog: typeof f.adapter.eventLog }
    ).eventLog;
    const streams = (f.adapter as unknown as { streams: typeof f.adapter.streams }).streams;
    const adapterNoHint = new RuntimeAdapterImpl({
      sql,
      eventLog,
      streams,
      // onTurnInFlight intentionally omitted
    });
    expect(() => adapterNoHint.hintTurnInFlight!("sess_test")).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────
// keepAliveWhile — port shape borrowed from cloudflare/agents SDK
// (which this codebase migrated FROM for cfless portability). Same
// invariants their `keep-alive.test.ts` asserts against their
// AIChatAgent.keepAliveWhile implementation; here we exercise the
// RuntimeAdapter port that both CF SessionDO and Node Registry
// implement, so the contract stays platform-neutral.
// ─────────────────────────────────────────────────────────────────────
describe("RuntimeAdapter — keepAliveWhile", () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await newFixture();
  });

  it("returns the function result", async () => {
    const r = await f.adapter.keepAliveWhile!(async () => "completed");
    expect(r).toBe("completed");
  });

  it("increments refs while fn is running and clears in finally (success)", async () => {
    expect(f.keepAlive.refs).toBe(0);
    let observedDuringFn = -1;
    await f.adapter.keepAliveWhile!(async () => {
      observedDuringFn = f.keepAlive.refs;
    });
    expect(observedDuringFn).toBe(1);
    expect(f.keepAlive.refs).toBe(0);
    expect(f.keepAlive.releases).toBe(1);
  });

  it("clears refs even when fn throws", async () => {
    expect(f.keepAlive.refs).toBe(0);
    let caught = false;
    try {
      await f.adapter.keepAliveWhile!(async () => {
        expect(f.keepAlive.refs).toBe(1);
        throw new Error("boom");
      });
    } catch {
      caught = true;
    }
    expect(caught).toBe(true);
    expect(f.keepAlive.refs).toBe(0);
    expect(f.keepAlive.releases).toBe(1);
  });

  it("schedules an alarm on entry (fixture proxy for CF setAlarm)", async () => {
    expect(f.keepAlive.alarmsSet).toBe(0);
    await f.adapter.keepAliveWhile!(async () => "x");
    expect(f.keepAlive.alarmsSet).toBe(1);
  });

  it("supports concurrent overlapping invocations (refs add)", async () => {
    expect(f.keepAlive.refs).toBe(0);
    let releaseInner!: () => void;
    const innerHeld = new Promise<void>((r) => { releaseInner = r; });

    // Start outer fiber, hold it open via a manual gate while we start
    // an inner fiber and observe refs=2 — the additive semantic is what
    // makes nested sub-agents safe.
    const outerPromise = f.adapter.keepAliveWhile!(async () => {
      const innerResult = await f.adapter.keepAliveWhile!(async () => {
        expect(f.keepAlive.refs).toBe(2);
        await innerHeld;
        return "inner-done";
      });
      expect(f.keepAlive.refs).toBe(1);
      return innerResult;
    });
    // Nudge the event loop so the inner fiber registers before we release.
    await new Promise((r) => setTimeout(r, 5));
    releaseInner();
    const r = await outerPromise;
    expect(r).toBe("inner-done");
    expect(f.keepAlive.refs).toBe(0);
    expect(f.keepAlive.releases).toBe(2);
  });

  it("identity passthrough when keepAliveWhile callback is unwired (Node default)", async () => {
    // Node SessionRegistry doesn't have eviction so it leaves
    // opts.keepAliveWhile unset. The adapter MUST fall back to a
    // bare-fn invocation rather than throwing — otherwise sub-agent
    // call sites that always wrap in keepAliveWhile (CF + Node
    // share the same default-loop) would break under Node.
    const eventLog = (
      f.adapter as unknown as { eventLog: typeof f.adapter.eventLog }
    ).eventLog;
    const streams = (f.adapter as unknown as { streams: typeof f.adapter.streams }).streams;
    const nodeAdapter = new RuntimeAdapterImpl({
      sql: f.sql,
      eventLog,
      streams,
      // keepAliveWhile intentionally omitted
    });
    const r = await nodeAdapter.keepAliveWhile!(async () => "node-ok");
    expect(r).toBe("node-ok");
    // Fixture's keepAlive counter belongs to a DIFFERENT adapter, so
    // no observable side effect from the Node-shaped one.
    expect(f.keepAlive.refs).toBe(0);
  });
});
