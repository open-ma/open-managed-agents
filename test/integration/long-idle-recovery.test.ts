// Long-idle session recovery — CF DO eviction simulation.
//
// Production scenario: a user sends a message, agent finishes the turn,
// session goes idle. User walks away. After ~30 minutes of inactivity
// the SessionDO is evicted by Cloudflare. Hours/days later, the user
// comes back and posts another user.message. The DO cold-starts; the
// next alarm fires _checkOrphanTurns; if there's anything left in
// flight (there shouldn't be on a clean idle, but a turn that was
// in-flight at eviction time leaves a sessions.turn_id marker), the
// recovery path reconciles it.
//
// Test surface:
//
//   1. Idle session that survives long absence: status stays "idle",
//      no orphan recovery noise, the next user.message after a long
//      gap processes normally.
//
//   2. Orphaned turn (turn_id non-null at "eviction"): cold-start +
//      first alarm reconciles to status='idle' and turn_id=null. The
//      next user.message can then proceed.
//
//   3. Long-idle gap doesn't break the event log bijection: the
//      eventsToMessages projection still produces a clean
//      user/assistant alternation that the next streamText call could
//      consume without 400.
//
// We can't really wait 30 minutes in CI, so the long-idle scenarios
// are simulated by:
//   - Setting `turn_started_at` to "30 minutes ago" on the orphan row
//   - Forcing a cold-start by reaching into the DO and resetting the
//     `initialized` flag (mirrors what existing recovery-do tests do)
//   - Setting a past-dated alarm and invoking `runDurableObjectAlarm`

// @ts-nocheck
import { env } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { registerHarness } from "../../apps/agent/src/harness/registry";
import type { HarnessInterface, HarnessContext } from "../../apps/agent/src/harness/interface";
import { SqliteHistory } from "../../apps/agent/src/runtime/history";
import { ensureSchema as ensureEventLogSchema } from "@open-managed-agents/event-log/cf-do";

class NoopHarness implements HarnessInterface {
  async run(_ctx: HarnessContext): Promise<void> { /* no LLM */ }
}
registerHarness("noop", () => new NoopHarness());

const HALF_HOUR_MS = 30 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

async function ensureTurnIdColumns(): Promise<void> {
  // Mirrors the helper in recovery-do.test.ts — test fixture's migration
  // runner stops at duplicate-named migrations (0010_*/0011_*), so 0014's
  // turn_id columns may not have applied. Synthesize defensively.
  await env.AUTH_DB.prepare(
    `CREATE TABLE IF NOT EXISTS sessions (
       id              TEXT PRIMARY KEY NOT NULL,
       tenant_id       TEXT NOT NULL,
       agent_id        TEXT NOT NULL,
       environment_id  TEXT NOT NULL,
       title           TEXT NOT NULL DEFAULT '',
       status          TEXT NOT NULL,
       created_at      INTEGER NOT NULL,
       updated_at      INTEGER
     )`,
  ).run();
  for (const stmt of [
    "ALTER TABLE sessions ADD COLUMN turn_id TEXT",
    "ALTER TABLE sessions ADD COLUMN turn_started_at INTEGER",
  ]) {
    try { await env.AUTH_DB.prepare(stmt).run(); }
    catch (e) {
      const m = (e as Error).message ?? "";
      if (!/duplicate column name/i.test(m)) throw e;
    }
  }
}

async function newSessionDirect(idHint: string): Promise<string> {
  await ensureTurnIdColumns();
  const sid = `${idHint}_${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  await env.AUTH_DB.prepare(
    `INSERT INTO sessions
       (id, tenant_id, agent_id, environment_id, title, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(sid, "default", "agent_test", "env_test", "", "idle", now, now).run();
  const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sid));
  await runInDurableObject(stub, async (instance) => {
    (instance as { _state: unknown })._state = {
      session_id: sid,
      tenant_id: "default",
      agent_id: "agent_test",
      environment_id: "env_test",
    };
  });
  return sid;
}

describe("Long-idle session recovery (DO eviction simulation)", () => {
  beforeAll(ensureTurnIdColumns);

  it("idle session that 'sleeps' overnight stays idle on cold-start (no false orphan)", async () => {
    // Setup: clean idle session, no in-flight turn.
    const sid = await newSessionDirect("longidle_clean");
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sid));

    // Simulate eviction: reset the in-memory `initialized` flag so the
    // DO must re-warm next request. (Real eviction loses ALL in-memory
    // state; in tests this proxies that.)
    await runInDurableObject(stub, async (instance) => {
      (instance as { initialized?: boolean }).initialized = false;
    });

    // Simulate "user comes back a day later" by setting an alarm in the
    // past and triggering it (alarm() runs _checkOrphanTurns which is
    // the cold-start recovery entry on CF).
    await runInDurableObject(stub, async (_inst, state) => {
      await state.storage.setAlarm(Date.now() - 1000);
    });
    await runDurableObjectAlarm(stub);
    await new Promise((r) => setTimeout(r, 100));

    // No orphan recovery should have fired (status was 'idle'). Row
    // unchanged.
    const row = await env.AUTH_DB.prepare(
      `SELECT status, turn_id FROM sessions WHERE id=?`,
    ).bind(sid).first();
    expect(row.status).toBe("idle");
    expect(row.turn_id).toBeNull();
  });

  it("orphan turn from 30 min ago: cold-start + alarm flips to idle", async () => {
    // Setup: session with status='running' + turn_started_at=30 min ago,
    // i.e. a turn that was in-flight when the DO got evicted.
    const sid = await newSessionDirect("longidle_30min_orphan");
    const longAgo = Date.now() - HALF_HOUR_MS;
    await env.AUTH_DB.prepare(
      `UPDATE sessions
          SET status='running', turn_id=?, turn_started_at=?, updated_at=?
        WHERE id=?`,
    ).bind("turn_evicted_30m", longAgo, Date.now(), sid).run();

    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sid));
    // Force cold-start of recovery state (init flag).
    await runInDurableObject(stub, async (instance) => {
      (instance as { initialized?: boolean }).initialized = false;
    });
    // Alarm in the past → fire on next runDurableObjectAlarm.
    await runInDurableObject(stub, async (_inst, state) => {
      await state.storage.setAlarm(Date.now() - 1000);
    });
    await runDurableObjectAlarm(stub);
    await new Promise((r) => setTimeout(r, 200));

    // Recovery path ran: row reconciled to idle, turn_id cleared.
    const row = await env.AUTH_DB.prepare(
      `SELECT status, turn_id, turn_started_at FROM sessions WHERE id=?`,
    ).bind(sid).first();
    expect(row.status).toBe("idle");
    expect(row.turn_id).toBeNull();
    expect(row.turn_started_at).toBeNull();
  });

  it("orphan turn from 24 hours ago: still recovers (no time-based cutoff)", async () => {
    // Pin the contract: listOrphanTurns has no max-age filter. A session
    // can be paused indefinitely; whenever the user comes back and the
    // alarm fires, recovery completes. If we ever add a stale-turn purge,
    // it should be a separate code path (periodic GC), not a guard that
    // hides genuine orphans.
    const sid = await newSessionDirect("longidle_24h_orphan");
    const longAgo = Date.now() - ONE_DAY_MS;
    await env.AUTH_DB.prepare(
      `UPDATE sessions
          SET status='running', turn_id=?, turn_started_at=?, updated_at=?
        WHERE id=?`,
    ).bind("turn_evicted_24h", longAgo, Date.now(), sid).run();

    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sid));
    await runInDurableObject(stub, async (instance) => {
      (instance as { initialized?: boolean }).initialized = false;
    });
    await runInDurableObject(stub, async (_inst, state) => {
      await state.storage.setAlarm(Date.now() - 1000);
    });
    await runDurableObjectAlarm(stub);
    await new Promise((r) => setTimeout(r, 200));

    const row = await env.AUTH_DB.prepare(
      `SELECT status, turn_id FROM sessions WHERE id=?`,
    ).bind(sid).first();
    expect(row.status).toBe("idle");
    expect(row.turn_id).toBeNull();
  });

  it("long-idle session with prior tool_use orphan: recovery injects placeholder + flips status", async () => {
    // Combined-state scenario: agent did a tool call right before
    // eviction. The DO storage has the tool_use event, no tool_result,
    // and the sessions row is marked running. Cold-start must:
    //   (a) reconcile sessions row to idle (turn_id cleared)
    //   (b) inject placeholder agent.tool_result so the next LLM call's
    //       eventsToMessages projection has a complete bijection
    const sid = await newSessionDirect("longidle_tool_orphan");
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sid));

    // Plant the orphan tool_use inside the DO's event log + arm alarm
    // in one runInDurableObject so we don't pay extra round-trips.
    await runInDurableObject(stub, async (instance, state) => {
      (instance as { initialized?: boolean }).initialized = false;
      ensureEventLogSchema(state.storage.sql);
      const history = new SqliteHistory(state.storage.sql);
      history.append({
        type: "agent.tool_use",
        id: "tu_long_idle",
        name: "bash",
        input: { command: "sleep 1000" },
      });
      await state.storage.setAlarm(Date.now() - 1000);
    });

    const longAgo = Date.now() - HALF_HOUR_MS;
    await env.AUTH_DB.prepare(
      `UPDATE sessions
          SET status='running', turn_id=?, turn_started_at=?, updated_at=?
        WHERE id=?`,
    ).bind("turn_long_idle", longAgo, Date.now(), sid).run();

    await runDurableObjectAlarm(stub);
    await new Promise((r) => setTimeout(r, 300));

    // (a) Sessions row reconciled.
    const row = await env.AUTH_DB.prepare(
      `SELECT status, turn_id FROM sessions WHERE id=?`,
    ).bind(sid).first();
    expect(row.status).toBe("idle");
    expect(row.turn_id).toBeNull();

    // (b) Placeholder tool_result was injected — the bijection holds.
    const ev = await stub.fetch(new Request("http://internal/events"));
    const { data: events } = (await ev.json()) as {
      data: Array<{ type: string; data: { tool_use_id?: string } }>;
    };
    const placeholder = events.find(
      (e) =>
        e.type === "agent.tool_result" &&
        e.data?.tool_use_id === "tu_long_idle",
    );
    expect(placeholder).toBeDefined();
  });
});
