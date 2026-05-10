// @ts-nocheck
import { env, exports } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { registerHarness } from "../../apps/agent/src/harness/registry";
import type { HarnessInterface, HarnessContext } from "../../apps/agent/src/harness/interface";
import { CfDoStreamRepo, ensureSchema as ensureEventLogSchema } from "@open-managed-agents/event-log/cf-do";
import { SqliteHistory } from "../../apps/agent/src/runtime/history";

// ============================================================
// recoverInterruptedState — DO-level integration
// ============================================================
//
// Unit tests in test/unit/recovery.test.ts prove the recovery LOGIC.
// This goes one layer deeper: the SessionDO wrapper actually wires the
// real CfDoStreamRepo + SqliteHistory adapters to the recovery scan,
// the schema DDL matches what the adapters read, and ensureSchema
// triggers the scan on cold start. We can't induce a real Cloudflare
// cold start in workerd, so:
//   1. Reach into a live SessionDO via runInDurableObject,
//   2. Seed orphan state directly into the streams + events tables,
//   3. Reset the in-memory `initialized` guard,
//   4. Trigger any endpoint that calls ensureSchema → recovery fires,
//   5. Read events back via the DO's own GET /events endpoint.

class NoopHarness implements HarnessInterface {
  async run(_ctx: HarnessContext): Promise<void> { /* no LLM */ }
}
registerHarness("noop", () => new NoopHarness());

const H = { "x-api-key": "test-key", "Content-Type": "application/json" };
function api(path: string, init?: RequestInit) {
  return exports.default.fetch(new Request(`http://localhost${path}`, init));
}
function post(path: string, body: unknown) {
  return api(path, { method: "POST", headers: H, body: JSON.stringify(body) });
}

async function newSession(): Promise<string> {
  const a = await post("/v1/agents", { name: "RecoveryTest", model: "claude-sonnet-4-6", harness: "noop" });
  const agent = await a.json();
  const e = await post("/v1/environments", { name: "rec-env", config: { type: "cloud" } });
  const environment = await e.json();
  const s = await post("/v1/sessions", { agent: agent.id, environment_id: environment.id });
  const session = await s.json();
  // Wake the DO so ensureSchema runs once and the streams table exists.
  await post(`/v1/sessions/${session.id}/events`, {
    events: [{ type: "user.message", content: [{ type: "text", text: "warmup" }] }],
  });
  await new Promise((r) => setTimeout(r, 200));
  return session.id;
}

/**
 * Some test DBs have schema drift on the `environments` migration that
 * breaks /v1/environments — the unified-runtime alarm tests don't need
 * a full agent / environment / session graph, just a sessions row to
 * UPDATE. This helper inserts the minimum directly into AUTH_DB and
 * warms up the DO so its internal sqlite is initialised.
 */
async function newSessionDirect(idHint: string): Promise<string> {
  await ensureTurnIdColumnsForTest();
  const sessionId = `${idHint}_${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  await env.AUTH_DB.prepare(
    `INSERT INTO sessions
       (id, tenant_id, agent_id, environment_id, title, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(sessionId, "default", "agent_test", "env_test", "", "idle", now, now)
    .run();
  // Warm the DO so its storage.sql exists when we go to seed event-log
  // state and so the runtimeAdapter resolves its lazy state on first
  // alarm() call.
  const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));
  await runInDurableObject(stub, async (instance, _state) => {
    // _state is loaded lazily inside the DO; force it by reading sessions
    // through a synthetic POST /init shape. Easiest path: directly set
    // the field that the runtimeAdapter getter requires.
    (instance as { _state: unknown })._state = {
      session_id: sessionId,
      tenant_id: "default",
      agent_id: "agent_test",
      environment_id: "env_test",
    };
  });
  return sessionId;
}

// Belt-and-braces — top-level helper too, in case the test pool resets
// storage between cases. (No-op when the column already exists.)
async function ensureTurnIdColumnsForTest() {
  // Some test DBs land here without migration 0001 / 0014 having
  // applied (the test fixture's migration runner stops at earlier
  // failures, e.g. duplicate 0010_* / 0011_* migration filenames).
  // Synthesise the minimum schema for the alarm tests below. CREATE
  // TABLE IF NOT EXISTS is a no-op when the real migration produced
  // a richer schema.
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
    `ALTER TABLE sessions ADD COLUMN turn_id TEXT`,
    `ALTER TABLE sessions ADD COLUMN turn_started_at INTEGER`,
  ]) {
    try {
      await env.AUTH_DB.prepare(stmt).run();
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (!/duplicate column name/i.test(msg)) throw err;
    }
  }
}

describe("SessionDO recovery — DO-level", () => {
  beforeAll(ensureTurnIdColumnsForTest);
  it("finalizes streaming row + appends agent.message on next boot", async () => {
    const sessionId = await newSession();
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    await runInDurableObject(stub, async (instance, state) => {
      ensureEventLogSchema(state.storage.sql);
      const streams = new CfDoStreamRepo(state.storage.sql);
      await streams.start("msg_dangling", Date.now() - 5000);
      await streams.appendChunk("msg_dangling", "Sure, here is ");
      await streams.appendChunk("msg_dangling", "the answer:");
      // Reach into the private flag — JS lets us; @ts-nocheck silences the warning.
      (instance as { initialized: boolean }).initialized = false;
    });

    // Trigger re-init by hitting any endpoint that calls ensureSchema.
    await stub.fetch(new Request("http://internal/status"));
    // recoverInterruptedState fires async (void this.recoverInterruptedState()).
    await new Promise((r) => setTimeout(r, 100));

    const ev = await stub.fetch(new Request("http://internal/events"));
    const { data: events } = await ev.json();

    const recovered = events.find(
      (e: { type: string; data: { message_id?: string } }) =>
        e.type === "agent.message" && e.data.message_id === "msg_dangling",
    );
    expect(recovered, "recovery should append agent.message for dangling stream").toBeDefined();
    expect(recovered.data.content[0].text).toBe("Sure, here is the answer:");

    await runInDurableObject(stub, async (_instance, state) => {
      const streams = new CfDoStreamRepo(state.storage.sql);
      const row = await streams.get("msg_dangling");
      expect(row?.status).toBe("interrupted");
    });
  });

  it("injects placeholder tool_result for orphan agent.tool_use", async () => {
    const sessionId = await newSession();
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    await runInDurableObject(stub, async (instance, state) => {
      ensureEventLogSchema(state.storage.sql);
      const history = new SqliteHistory(state.storage.sql);
      history.append({
        type: "agent.tool_use",
        id: "tu_orphan_bash",
        name: "bash",
        input: { command: "ls" },
      });
      (instance as { initialized: boolean }).initialized = false;
    });

    await stub.fetch(new Request("http://internal/status"));
    await new Promise((r) => setTimeout(r, 100));

    const ev = await stub.fetch(new Request("http://internal/events"));
    const { data: events } = await ev.json();

    const placeholder = events.find(
      (e: { type: string; data: { tool_use_id?: string } }) =>
        e.type === "agent.tool_result" && e.data.tool_use_id === "tu_orphan_bash",
    );
    expect(placeholder, "recovery should inject agent.tool_result").toBeDefined();
    expect(placeholder.data.content).toMatch(/interrupted/);
  });

  it("injects mcp_tool_result with is_error=true for orphan mcp_tool_use", async () => {
    const sessionId = await newSession();
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    await runInDurableObject(stub, async (instance, state) => {
      ensureEventLogSchema(state.storage.sql);
      const history = new SqliteHistory(state.storage.sql);
      history.append({
        type: "agent.mcp_tool_use",
        id: "mtu_orphan",
        name: "search",
        server_label: "linear",
      });
      (instance as { initialized: boolean }).initialized = false;
    });

    await stub.fetch(new Request("http://internal/status"));
    await new Promise((r) => setTimeout(r, 100));

    const ev = await stub.fetch(new Request("http://internal/events"));
    const { data: events } = await ev.json();

    const placeholder = events.find(
      (e: { type: string; data: { mcp_tool_use_id?: string } }) =>
        e.type === "agent.mcp_tool_result" && e.data.mcp_tool_use_id === "mtu_orphan",
    );
    expect(placeholder).toBeDefined();
    expect(placeholder.data.is_error).toBe(true);
  });

  it("does not re-finalize streams already in terminal state (idempotent)", async () => {
    const sessionId = await newSession();
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    await runInDurableObject(stub, async (instance, state) => {
      ensureEventLogSchema(state.storage.sql);
      const streams = new CfDoStreamRepo(state.storage.sql);
      await streams.start("msg_already_done", Date.now());
      await streams.appendChunk("msg_already_done", "ok");
      await streams.finalize("msg_already_done", "completed");
      (instance as { initialized: boolean }).initialized = false;
    });

    await stub.fetch(new Request("http://internal/status"));
    await new Promise((r) => setTimeout(r, 100));

    const ev = await stub.fetch(new Request("http://internal/events"));
    const { data: events } = await ev.json();
    const newMessages = events.filter(
      (e: { type: string; data: { message_id?: string } }) =>
        e.type === "agent.message" && e.data.message_id === "msg_already_done",
    );
    expect(newMessages).toHaveLength(0);
  });

  // ── extra crash points ─────────────────────────────────────────────

  it("orphan agent.custom_tool_use → row reconciled but NO event injected (user-driven)", async () => {
    // Custom tools resolve via user.custom_tool_result, which is sent
    // by the SDK client. Server can't fabricate it without inventing
    // user input. Recovery must surface a warning and leave the log
    // alone — the harness's next-turn projection will see the dangling
    // tool_use and the SDK is responsible for resending the result.
    const sessionId = await newSession();
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    await runInDurableObject(stub, async (instance, state) => {
      ensureEventLogSchema(state.storage.sql);
      const history = new SqliteHistory(state.storage.sql);
      history.append({
        type: "agent.custom_tool_use",
        id: "ctu_orphan",
        name: "approve_purchase",
        input: { amount: 99.99 },
      });
      (instance as { initialized: boolean }).initialized = false;
    });

    await stub.fetch(new Request("http://internal/status"));
    await new Promise((r) => setTimeout(r, 100));

    const ev = await stub.fetch(new Request("http://internal/events"));
    const { data: events } = await ev.json();

    const customUses = events.filter(
      (e: { type: string; data: { id?: string } }) =>
        e.type === "agent.custom_tool_use" && e.data.id === "ctu_orphan",
    );
    const fabricatedResults = events.filter(
      (e: { type: string; data: { id?: string } }) =>
        e.type === "user.custom_tool_result" && e.data.id === "ctu_orphan",
    );
    expect(customUses).toHaveLength(1); // original stays
    expect(fabricatedResults).toHaveLength(0); // recovery does NOT fabricate
  });

  it("multiple orphans of mixed types in ONE session are all handled in one boot", async () => {
    // Production-realistic: a process death can leave behind a stuck
    // stream + a dangling tool_use + a dangling mcp_tool_use all in
    // the same session. Recovery should drain all three in one pass.
    const sessionId = await newSession();
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    await runInDurableObject(stub, async (instance, state) => {
      ensureEventLogSchema(state.storage.sql);
      const streams = new CfDoStreamRepo(state.storage.sql);
      const history = new SqliteHistory(state.storage.sql);

      await streams.start("msg_mixed", Date.now() - 1000);
      await streams.appendChunk("msg_mixed", "partial");

      history.append({
        type: "agent.tool_use",
        id: "tu_mixed",
        name: "bash",
        input: { command: "ls" },
      });
      history.append({
        type: "agent.mcp_tool_use",
        id: "mtu_mixed",
        name: "search",
        server_label: "linear",
      });
      // Plus one resolved pair to show recovery doesn't touch them.
      history.append({
        type: "agent.tool_use",
        id: "tu_resolved",
        name: "read",
      });
      history.append({
        type: "agent.tool_result",
        tool_use_id: "tu_resolved",
        content: "ok",
      });

      (instance as { initialized: boolean }).initialized = false;
    });

    await stub.fetch(new Request("http://internal/status"));
    await new Promise((r) => setTimeout(r, 200));

    const ev = await stub.fetch(new Request("http://internal/events"));
    const { data: events } = await ev.json();

    // Stuck stream → agent.message synthesised.
    const synth = events.find(
      (e: { type: string; data: { message_id?: string } }) =>
        e.type === "agent.message" && e.data.message_id === "msg_mixed",
    );
    expect(synth, "stuck stream finalised").toBeDefined();
    expect(synth.data.content[0].text).toBe("partial");

    // Orphan tool_use → tool_result injected.
    const toolResult = events.find(
      (e: { type: string; data: { tool_use_id?: string } }) =>
        e.type === "agent.tool_result" && e.data.tool_use_id === "tu_mixed",
    );
    expect(toolResult, "tool_use placeholder injected").toBeDefined();

    // Orphan mcp_tool_use → mcp_tool_result injected with is_error.
    const mcpResult = events.find(
      (e: { type: string; data: { mcp_tool_use_id?: string } }) =>
        e.type === "agent.mcp_tool_result" && e.data.mcp_tool_use_id === "mtu_mixed",
    );
    expect(mcpResult, "mcp_tool_use placeholder injected").toBeDefined();
    expect(mcpResult.data.is_error).toBe(true);

    // Already-resolved pair untouched (only one tool_result for tu_resolved).
    const resolvedResults = events.filter(
      (e: { type: string; data: { tool_use_id?: string } }) =>
        e.type === "agent.tool_result" && e.data.tool_use_id === "tu_resolved",
    );
    expect(resolvedResults).toHaveLength(1);

    // Stream row reached terminal state.
    await runInDurableObject(stub, async (_instance, state) => {
      const streams = new CfDoStreamRepo(state.storage.sql);
      const row = await streams.get("msg_mixed");
      expect(row?.status).toBe("interrupted");
    });
  });

  it("stream with no buffered chunks → placeholder text on agent.message", async () => {
    // Edge: process died before the LLM emitted its first delta. The
    // streams row exists but chunks_json is []. recovery.ts uses a
    // default text so the synthesised agent.message is never empty
    // (empty text would break harness projections).
    const sessionId = await newSession();
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    await runInDurableObject(stub, async (instance, state) => {
      ensureEventLogSchema(state.storage.sql);
      const streams = new CfDoStreamRepo(state.storage.sql);
      await streams.start("msg_silent", Date.now());
      // No appendChunk — stream died before first delta.
      (instance as { initialized: boolean }).initialized = false;
    });

    await stub.fetch(new Request("http://internal/status"));
    await new Promise((r) => setTimeout(r, 100));

    const ev = await stub.fetch(new Request("http://internal/events"));
    const { data: events } = await ev.json();

    const synth = events.find(
      (e: { type: string; data: { message_id?: string } }) =>
        e.type === "agent.message" && e.data.message_id === "msg_silent",
    );
    expect(synth).toBeDefined();
    expect(synth.data.content[0].text).toMatch(/interrupted/i);
  });

  // ── unified-runtime turn-marker eviction (alarm() path) ─────────────

  it("orphan turn marker (sessions.status='running') is reconciled by alarm() → _checkOrphanTurns", async () => {
    // Production scenario: DO is evicted mid-turn. The sessions row in
    // D1 still has status='running' + turn_id set — the in-memory
    // SessionDO never got to run its endTurn. When the next alarm
    // fires (rearmed 30s out by hintTurnInFlight), _checkOrphanTurns
    // sees the row, runs recovery, and flips status back to idle.
    const sessionId = await newSessionDirect("alarm_orphan");
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    // Plant the orphan-turn marker directly in D1 (the row already
    // exists at status='idle' from newSessionDirect; UPDATE in place).
    await env.AUTH_DB.prepare(
      `UPDATE sessions SET status='running', turn_id=?, turn_started_at=?, updated_at=?
        WHERE id=?`,
    )
      .bind(
        "turn_evicted",
        // Old enough to clear _checkOrphanTurns' 90s grace period
        // (added 2026-05-10 to stop alarm-fired self-recovery; see
        // session-do.ts:_checkOrphanTurns docstring). Real orphans
        // from a previous DO incarnation are typically minutes+ old.
        Date.now() - 120_000,
        Date.now(),
        sessionId,
      )
      .run();

    // Trigger the alarm() callback. runDurableObjectAlarm only fires
    // if a storage alarm is set, so set one in the past first; the
    // workerd runtime then runs alarm() the moment we call.
    await runInDurableObject(stub, async (_inst, state) => {
      await state.storage.setAlarm(Date.now() - 1000);
    });
    await runDurableObjectAlarm(stub);
    await new Promise((r) => setTimeout(r, 100));

    // Read back the D1 row.
    const after = await env.AUTH_DB.prepare(
      `SELECT status, turn_id, turn_started_at FROM sessions WHERE id=?`,
    )
      .bind(sessionId)
      .first();
    expect(after.status).toBe("idle");
    expect(after.turn_id).toBeNull();
    expect(after.turn_started_at).toBeNull();
  });

  it("alarm() with NO orphan turn is a clean no-op (sessions row stays idle)", async () => {
    // Defensive: alarms fire for many reasons (schedule rows, container
    // keepalive). _checkOrphanTurns must be a true no-op when there's
    // nothing to recover, NOT a stray UPDATE that flips a healthy
    // session into a weird state.
    const sessionId = await newSessionDirect("alarm_noop");
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    // newSessionDirect leaves the row idle; confirm baseline.
    const before = await env.AUTH_DB.prepare(
      `SELECT status FROM sessions WHERE id=?`,
    )
      .bind(sessionId)
      .first();
    expect(before.status).toBe("idle");

    await runInDurableObject(stub, async (_inst, state) => {
      await state.storage.setAlarm(Date.now() - 1000);
    });
    await runDurableObjectAlarm(stub);
    await new Promise((r) => setTimeout(r, 50));

    const after = await env.AUTH_DB.prepare(
      `SELECT status, turn_id FROM sessions WHERE id=?`,
    )
      .bind(sessionId)
      .first();
    expect(after.status).toBe("idle");
    expect(after.turn_id).toBeNull();
  });

  it("orphan turn marker with NO event-log state still flips status to 'idle'", async () => {
    // Minimal-orphan case: the process died before writing the first
    // event (right after beginTurn returned). recovery.ts reads an
    // empty log + zero streams — report is empty. But _checkOrphanTurns
    // STILL must call adapter.endTurn so the sessions row doesn't
    // stay stuck at 'running' forever.
    const sessionId = await newSessionDirect("orphan_minimal");
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    await env.AUTH_DB.prepare(
      `UPDATE sessions SET status='running', turn_id=?, turn_started_at=?, updated_at=?
        WHERE id=?`,
    )
      // Old turn_started_at — clears the 90s grace period in
      // _checkOrphanTurns. See sibling test above for context.
      .bind("turn_dead", Date.now() - 120_000, Date.now(), sessionId)
      .run();

    await runInDurableObject(stub, async (_inst, state) => {
      await state.storage.setAlarm(Date.now() - 1000);
    });
    await runDurableObjectAlarm(stub);
    await new Promise((r) => setTimeout(r, 100));

    const after = await env.AUTH_DB.prepare(
      `SELECT status, turn_id FROM sessions WHERE id=?`,
    )
      .bind(sessionId)
      .first();
    expect(after.status).toBe("idle");
    expect(after.turn_id).toBeNull();
  });

  it("orphan turn + dangling tool_use in same session: alarm reconciles row AND injects placeholder", async () => {
    // The full crash-recovery story end-to-end on CF: a turn died with
    // unflushed event-log state (orphan tool_use) AND the sessions row
    // marked running. _checkOrphanTurns calls onFiberRecovered →
    // recoverAgentTurn (which does the event-log recovery) THEN flips
    // status to idle. Both effects must occur in the same alarm pass.
    const sessionId = await newSessionDirect("orphan_combined");
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    // Seed the event-log orphan inside the DO and arm the alarm in the
    // same RPC so we don't pay two round-trips.
    await runInDurableObject(stub, async (_instance, state) => {
      ensureEventLogSchema(state.storage.sql);
      const history = new SqliteHistory(state.storage.sql);
      history.append({
        type: "agent.tool_use",
        id: "tu_combined",
        name: "bash",
      });
      await state.storage.setAlarm(Date.now() - 1000);
    });

    // Plant the orphan-turn marker in D1.
    await env.AUTH_DB.prepare(
      `UPDATE sessions SET status='running', turn_id=?, turn_started_at=?, updated_at=?
        WHERE id=?`,
    )
      // Old turn_started_at — clears _checkOrphanTurns 90s grace.
      .bind("turn_combined", Date.now() - 120_000, Date.now(), sessionId)
      .run();

    await runDurableObjectAlarm(stub);
    await new Promise((r) => setTimeout(r, 200));

    // Sessions row reconciled.
    const sess = await env.AUTH_DB.prepare(
      `SELECT status, turn_id FROM sessions WHERE id=?`,
    )
      .bind(sessionId)
      .first();
    expect(sess.status).toBe("idle");
    expect(sess.turn_id).toBeNull();

    // Event-log placeholder injected.
    const ev = await stub.fetch(new Request("http://internal/events"));
    const { data: events } = await ev.json();
    const placeholder = events.find(
      (e: { type: string; data: { tool_use_id?: string } }) =>
        e.type === "agent.tool_result" && e.data.tool_use_id === "tu_combined",
    );
    expect(placeholder).toBeDefined();
  });

  // ─── Active-turn filter (the port-correct fix) ──────────────────────
  // The original bug (sess-slqg7xf4kvm6s2j4 2026-05-10 07:01:43Z): the
  // 30s keep-alive alarm fired mid-stream, _checkOrphanTurns saw the
  // D1 row with our OWN active turn_id, didn't filter, treated it as
  // orphan, and emitted session.status_rescheduled + a parallel
  // streamText. Hint-counter+grace was a workaround; the contract-
  // correct fix is to track turnId in _activeTurnIds (populated by
  // RuntimeAdapter.hintTurnInFlight) and filter via .has(o.turn_id).

  it("alarm() does NOT recover a turn that's in _activeTurnIds (own active turn)", async () => {
    const sessionId = await newSessionDirect("active_turn_skip");
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));
    const ownTurnId = "turn_active_own";

    // Plant the D1 row exactly as adapter.beginTurn would, then
    // register the same turn id in the SessionDO's local active set —
    // simulating what hintTurnInFlight does after beginTurn lands.
    await env.AUTH_DB.prepare(
      `UPDATE sessions SET status='running', turn_id=?, turn_started_at=?, updated_at=?
        WHERE id=?`,
    )
      .bind(ownTurnId, Date.now() - 600_000, Date.now(), sessionId)
      .run();
    await runInDurableObject(stub, async (instance, state) => {
      const set = (instance as { _activeTurnIds: Set<string> })._activeTurnIds;
      set.add(ownTurnId);
      await state.storage.setAlarm(Date.now() - 1000);
    });
    await runDurableObjectAlarm(stub);
    await new Promise((r) => setTimeout(r, 100));

    // Row should still be 'running' with turn_id intact — the alarm
    // saw our own turn id in _activeTurnIds, skipped it, didn't write.
    const after = await env.AUTH_DB.prepare(
      `SELECT status, turn_id FROM sessions WHERE id=?`,
    )
      .bind(sessionId)
      .first();
    expect(after.status).toBe("running");
    expect(after.turn_id).toBe(ownTurnId);

    // Event-log should NOT contain a session.status_rescheduled event
    // (the original bug's symptom).
    const ev = await stub.fetch(new Request("http://internal/events"));
    const { data: events } = await ev.json();
    const reschedule = events.find(
      (e: { type: string }) => e.type === "session.status_rescheduled",
    );
    expect(reschedule, "must not emit reschedule for own active turn").toBeUndefined();

    // Cleanup so the next test starts fresh.
    await runInDurableObject(stub, async (instance) => {
      (instance as { _activeTurnIds: Set<string> })._activeTurnIds.delete(ownTurnId);
    });
  });

  it("alarm() DOES recover a turn that's NOT in _activeTurnIds (real orphan)", async () => {
    // Mirror image: D1 row exists but the turn id is NOT in our local
    // active set — simulates a previous DO incarnation that died.
    // Fresh isolate sees the residue and recovers properly.
    const sessionId = await newSessionDirect("real_orphan_recover");
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    await env.AUTH_DB.prepare(
      `UPDATE sessions SET status='running', turn_id=?, turn_started_at=?, updated_at=?
        WHERE id=?`,
    )
      .bind("turn_dead_incarnation", Date.now() - 300_000, Date.now(), sessionId)
      .run();
    // Deliberately do NOT add to _activeTurnIds — that's the whole
    // point of "real orphan from a previous incarnation".
    await runInDurableObject(stub, async (_inst, state) => {
      await state.storage.setAlarm(Date.now() - 1000);
    });
    await runDurableObjectAlarm(stub);
    await new Promise((r) => setTimeout(r, 100));

    const after = await env.AUTH_DB.prepare(
      `SELECT status, turn_id FROM sessions WHERE id=?`,
    )
      .bind(sessionId)
      .first();
    expect(after.status).toBe("idle");
    expect(after.turn_id).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────
  // Cold-start orphan flush + alarm hygiene
  //
  // The new path (replaces the old onFiberRecovered → recoverAgentTurn
  // chain that re-ran the LLM in alarm and burned the 180s wall budget,
  // observed on staging sess-slqg7xf4kvm6s2j4 2026-05-10). Mirrors the
  // shape of cloudflare/agents SDK's run-fiber.test.ts cleanup
  // assertions — same family of guarantees, ours implemented on top of
  // the event log instead of cf_agents_runs.
  // ─────────────────────────────────────────────────────────────────

  it("first fetch() triggers _finalizeStaleTurns once; subsequent fetches skip", async () => {
    // Setup: orphan turn marker from a prior incarnation. Cold-start
    // fetch() should run the flush exactly once and the guard should
    // prevent re-flushing on later fetches.
    const sessionId = await newSessionDirect("cold_start_once");
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));
    await env.AUTH_DB.prepare(
      `UPDATE sessions SET status='running', turn_id=?, turn_started_at=?
        WHERE id=?`,
    )
      .bind("turn_dead_prior", Date.now() - 300_000, sessionId)
      .run();

    // Reset the in-memory cold-start guard so the test acts on a fresh
    // incarnation. (Outside of tests this is set by class instantiation.)
    await runInDurableObject(stub, (instance) => {
      (instance as { _coldStartFlushDone: boolean })._coldStartFlushDone = false;
    });

    // First fetch — any cheap endpoint will do; the flush is wired into
    // the fetch() entry, not any specific route.
    await stub.fetch("https://internal/full-status").catch(() => null);
    // Background flush is fire-and-forget — let it land.
    await new Promise((r) => setTimeout(r, 150));

    const afterFirst = await env.AUTH_DB
      .prepare(`SELECT status, turn_id FROM sessions WHERE id=?`)
      .bind(sessionId)
      .first();
    expect(afterFirst.status).toBe("idle");
    expect(afterFirst.turn_id).toBeNull();

    // Re-poison the row to simulate a second orphan post-cold-start.
    // The guard means the second fetch should NOT clear it (only the
    // alarm path catches mid-life orphans).
    await env.AUTH_DB.prepare(
      `UPDATE sessions SET status='running', turn_id=?, turn_started_at=?
        WHERE id=?`,
    )
      .bind("turn_dead_again", Date.now() - 60_000, sessionId)
      .run();

    await stub.fetch("https://internal/full-status").catch(() => null);
    await new Promise((r) => setTimeout(r, 50));

    const afterSecond = await env.AUTH_DB
      .prepare(`SELECT status FROM sessions WHERE id=?`)
      .bind(sessionId)
      .first();
    // Still 'running' because the cold-start guard tripped — alarm()
    // would catch this on its next fire (separate code path covered
    // by the alarm() tests above).
    expect(afterSecond.status).toBe("running");
  });

  it("alarm() finishes fast (no LLM replay) even with stale turn", async () => {
    // alarm() previously routed orphans through recoverAgentTurn which
    // ran the LLM stream from inside alarm and burned the 180s wall
    // budget (3-min CF cap). The new path is SQL-only and should
    // complete in milliseconds.
    const sessionId = await newSessionDirect("alarm_fast");
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    // Seed event-log noise + arm the alarm in the same RPC (matches
    // the working orphan_combined test pattern — single RPC keeps
    // the storage view consistent across DO incarnations).
    await runInDurableObject(stub, async (_instance, state) => {
      ensureEventLogSchema(state.storage.sql);
      const history = new SqliteHistory(state.storage.sql);
      for (let i = 0; i < 10; i++) {
        history.append({ type: "agent.tool_use", id: `tu_${i}`, name: "noop", input: {} });
      }
      await state.storage.setAlarm(Date.now() - 1000);
    });
    // Plant the orphan-turn marker in D1 (after seed; matches
    // orphan_combined).
    await env.AUTH_DB.prepare(
      `UPDATE sessions SET status='running', turn_id=?, turn_started_at=?
        WHERE id=?`,
    )
      .bind("turn_burn", Date.now() - 120_000, sessionId)
      .run();

    const t0 = Date.now();
    await runDurableObjectAlarm(stub);
    const elapsed = Date.now() - t0;
    // Settle any deferred writes the alarm body kicked off (matches
    // the orphan_combined test that asserts the same row state).
    await new Promise((r) => setTimeout(r, 200));

    // The SQL-only flush should be well under 1 second on the
    // miniflare/in-memory test harness; pre-fix the LLM replay path
    // would block until 180s-cap or a fake-LLM stub completed.
    // Generous bound: 1500ms covers even slow CI.
    expect(elapsed).toBeLessThan(1500);

    const after = await env.AUTH_DB
      .prepare(`SELECT status FROM sessions WHERE id=?`)
      .bind(sessionId)
      .first();
    expect(after.status).toBe("idle");
  });

  it("_finalizeStaleTurns emits aborted tool_result for unpaired tool_use", async () => {
    // Mirror the existing "injects placeholder tool_result for orphan
    // agent.tool_use" test, but explicitly through the new _finalizeStaleTurns
    // path (alarm-triggered) and asserts the abort marker shape ours
    // contributes (is_error: true + a "Tool call interrupted" message).
    const sessionId = await newSessionDirect("finalize_aborted_result");
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    await env.AUTH_DB.prepare(
      `UPDATE sessions SET status='running', turn_id=?, turn_started_at=?
        WHERE id=?`,
    )
      .bind("turn_with_unpaired", Date.now() - 120_000, sessionId)
      .run();
    await runInDurableObject(stub, async (_instance, state) => {
      ensureEventLogSchema(state.storage.sql);
      const history = new SqliteHistory(state.storage.sql);
      history.append({
        type: "agent.tool_use",
        id: "tu_orphan_x",
        name: "noop",
        input: {},
      });
    });

    await runInDurableObject(stub, async (_inst, state) => {
      await state.storage.setAlarm(Date.now() - 1000);
    });
    await runDurableObjectAlarm(stub);
    await new Promise((r) => setTimeout(r, 100));

    const events = await runInDurableObject(stub, (instance) => {
      const sql = (instance as { ctx: { storage: { sql: SqlStorage } } }).ctx.storage.sql;
      return sql.exec(
        `SELECT type, data FROM events WHERE type='agent.tool_result' OR type='agent.mcp_tool_result'`,
      ).toArray();
    });
    const aborted = events.find((e) => {
      try {
        const d = JSON.parse(e.data as string);
        return d.tool_use_id === "tu_orphan_x";
      } catch {
        return false;
      }
    });
    expect(aborted).toBeDefined();
    const data = JSON.parse(aborted!.data as string);
    expect(data.is_error).toBe(true);
    expect(String(data.content)).toMatch(/interrupted/i);
  });

  // ─────────────────────────────────────────────────────────────────
  // Alarm heartbeat-merge regression guards
  //
  // _scheduleNextAlarm() runs at the end of alarm() and was historically
  // calling deleteAlarm() whenever cf_agents_schedules was empty —
  // silently clobbering the keep-alive heartbeat that the supervisor
  // turn relies on. Pre-2026-05-10 this latent bug only mattered when
  // alarm() also burned its 180s wall-time budget on LLM replay (caught
  // by code review on session sess-slqg7xf4kvm6s2j4). The merge fix in
  // _scheduleNextAlarm folds the heartbeat into the same setAlarm call
  // (min(heartbeat, next-schedule)) so it can't be clobbered.
  // ─────────────────────────────────────────────────────────────────

  it("alarm() with inflight supervisor turn does NOT clobber its own heartbeat", async () => {
    // Pre-merge: alarm() set the heartbeat then _scheduleNextAlarm()
    // called deleteAlarm() 5ms later when cf_agents_schedules was
    // empty (the common case). Asserting "setAlarm fired" alone is
    // necessary-not-sufficient; we MUST also assert deleteAlarm did
    // NOT fire. Spy on both. Use a real supervisor inflight marker
    // (sessions.status='running' with a turn_id we own — covered by
    // _activeTurnIds so finalize doesn't try to clean it up).
    const sessionId = await newSessionDirect("heartbeat_no_clobber");
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    // Plant a "live supervisor turn" — D1 row marked running, plus
    // register the turn_id in _activeTurnIds so _finalizeStaleTurns
    // skips it (matches the contract for the caller's own active turn).
    const ownTurnId = "turn_inflight_supervisor";
    await env.AUTH_DB.prepare(
      `UPDATE sessions SET status='running', turn_id=?, turn_started_at=?
        WHERE id=?`,
    )
      .bind(ownTurnId, Date.now() - 10_000, sessionId)
      .run();

    const setAlarmInside: number[] = [];
    let deleteCallsInside = 0;
    let spyArmed = false;
    await runInDurableObject(stub, async (instance, state) => {
      const set = (instance as { _activeTurnIds: Set<string> })._activeTurnIds;
      set.add(ownTurnId);

      const ctx = (instance as unknown as { ctx: { storage: {
        setAlarm: (t: number) => Promise<void>;
        deleteAlarm: () => Promise<void>;
      } } }).ctx;
      const origSet = ctx.storage.setAlarm.bind(ctx.storage);
      const origDel = ctx.storage.deleteAlarm.bind(ctx.storage);

      // Trigger the alarm BEFORE installing spies so the trigger
      // setAlarm/deleteAlarm calls aren't counted.
      await state.storage.deleteAlarm();
      await state.storage.setAlarm(Date.now() - 1000);

      spyArmed = true;
      ctx.storage.setAlarm = async (t: number) => {
        if (spyArmed) setAlarmInside.push(t);
        return origSet(t);
      };
      ctx.storage.deleteAlarm = async () => {
        if (spyArmed) deleteCallsInside++;
        return origDel();
      };
    });
    await runDurableObjectAlarm(stub);
    await new Promise((r) => setTimeout(r, 50));
    spyArmed = false;

    // setAlarm fired — heartbeat scheduled ~30s out.
    expect(setAlarmInside.length).toBeGreaterThan(0);
    const lastT = setAlarmInside[setAlarmInside.length - 1];
    expect(lastT).toBeGreaterThan(Date.now());
    expect(lastT - Date.now()).toBeLessThan(60_000);
    // deleteAlarm did NOT fire — the heartbeat survives. This is the
    // load-bearing regression guard. Pre-merge it would have been > 0.
    expect(deleteCallsInside).toBe(0);
  });

  it("alarm() with no inflight turn calls deleteAlarm (no leaked heartbeat)", async () => {
    // Negative case — proves the heartbeat is conditional on
    // _hasInflightTurn(), not unconditional.
    const sessionId = await newSessionDirect("no_heartbeat_when_idle");
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    const setAlarmInside: number[] = [];
    let deleteCallsInside = 0;
    let spyArmed = false;
    await runInDurableObject(stub, async (_instance, state) => {
      const ctx = (_instance as unknown as { ctx: { storage: {
        setAlarm: (t: number) => Promise<void>;
        deleteAlarm: () => Promise<void>;
      } } }).ctx;
      const origSet = ctx.storage.setAlarm.bind(ctx.storage);
      const origDel = ctx.storage.deleteAlarm.bind(ctx.storage);

      await state.storage.deleteAlarm();
      await state.storage.setAlarm(Date.now() - 1000);

      spyArmed = true;
      ctx.storage.setAlarm = async (t: number) => {
        if (spyArmed) setAlarmInside.push(t);
        return origSet(t);
      };
      ctx.storage.deleteAlarm = async () => {
        if (spyArmed) deleteCallsInside++;
        return origDel();
      };
    });
    await runDurableObjectAlarm(stub);
    await new Promise((r) => setTimeout(r, 50));
    spyArmed = false;

    // No setAlarm — nothing to keep alive.
    expect(setAlarmInside.length).toBe(0);
    // deleteAlarm DID fire — _scheduleNextAlarm cleared the slot
    // because nothing's scheduled and no heartbeat needed.
    expect(deleteCallsInside).toBeGreaterThan(0);
  });

  it("_finalizeStaleTurns no half-state — endTurn failure suppresses event emit", async () => {
    // Reviewer-flagged: the previous shape emitted session.status_rescheduled
    // BEFORE endTurn, so a throw in endTurn left Console showing
    // "rescheduled" with no resolution and the row stuck 'running'.
    // The new shape only emits on endTurn success. Test by stubbing
    // adapter.endTurn to throw and asserting NO rescheduled/idle event
    // landed in the event log.
    const sessionId = await newSessionDirect("finalize_no_half");
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    await env.AUTH_DB.prepare(
      `UPDATE sessions SET status='running', turn_id=?, turn_started_at=?
        WHERE id=?`,
    )
      .bind("turn_endturn_fails", Date.now() - 120_000, sessionId)
      .run();

    await runInDurableObject(stub, async (instance) => {
      const adapter = (instance as unknown as { runtimeAdapter: { endTurn: (s: string, t: string, st: string) => Promise<void> } }).runtimeAdapter;
      const orig = adapter.endTurn.bind(adapter);
      adapter.endTurn = async () => {
        throw new Error("simulated endTurn failure");
      };
      const finalize = (instance as unknown as { _finalizeStaleTurns: () => Promise<void> })._finalizeStaleTurns.bind(instance);
      await finalize();
      // Restore so subsequent test isolation isn't broken by this stub.
      adapter.endTurn = orig;
    });

    // Row must still be 'running' (endTurn was the throw site).
    const row = await env.AUTH_DB
      .prepare(`SELECT status FROM sessions WHERE id=?`)
      .bind(sessionId)
      .first();
    expect(row.status).toBe("running");

    // No rescheduled/idle event leaked out.
    const events = await stub.fetch(new Request("http://internal/events"));
    const { data } = await events.json() as { data: Array<{ type: string }> };
    expect(data.find((e) => e.type === "session.status_rescheduled")).toBeUndefined();
    expect(data.find((e) => e.type === "session.status_idle")).toBeUndefined();
  });

  it("cold-start guard resets to false on flush failure — next fetch retries", async () => {
    // Reviewer-flagged: the previous shape set _coldStartFlushDone=true
    // synchronously before the async flush; if the flush rejected, the
    // guard stayed true forever and recovery was permanently dead. New
    // shape resets to false in .catch() so a future fetch retries.
    const sessionId = await newSessionDirect("cold_start_retry");
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    await env.AUTH_DB.prepare(
      `UPDATE sessions SET status='running', turn_id=?, turn_started_at=?
        WHERE id=?`,
    )
      .bind("turn_retry_target", Date.now() - 120_000, sessionId)
      .run();

    // Reset guard + stub _finalizeStaleTurns to throw on first call,
    // succeed on second. Confirms (a) first fetch trips guard + flush
    // throws, (b) guard reset, (c) second fetch retries + succeeds.
    let calls = 0;
    await runInDurableObject(stub, (instance) => {
      (instance as { _coldStartFlushDone: boolean })._coldStartFlushDone = false;
      const orig = (instance as unknown as { _finalizeStaleTurns: () => Promise<void> })._finalizeStaleTurns.bind(instance);
      (instance as unknown as { _finalizeStaleTurns: () => Promise<void> })._finalizeStaleTurns = async () => {
        calls++;
        if (calls === 1) throw new Error("first attempt fails");
        return orig();
      };
    });

    await stub.fetch("https://internal/full-status").catch(() => null);
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toBe(1);
    // Guard should have been reset by the .catch.
    const guardAfterFail = await runInDurableObject(stub, (instance) => {
      return (instance as { _coldStartFlushDone: boolean })._coldStartFlushDone;
    });
    expect(guardAfterFail).toBe(false);

    // Second fetch — flush retries + succeeds.
    await stub.fetch("https://internal/full-status").catch(() => null);
    await new Promise((r) => setTimeout(r, 200));
    expect(calls).toBe(2);
    const row = await env.AUTH_DB
      .prepare(`SELECT status FROM sessions WHERE id=?`)
      .bind(sessionId)
      .first();
    expect(row.status).toBe("idle");
  });

  it("hintTurnEnded is idempotent — double-fire from endTurn + outer finally is safe", async () => {
    // turn-runtime.ts fires hintTurnEnded in its outer finally as a
    // safety net for endTurn throwing; adapter.endTurn ALSO fires it
    // on success. Double-fire happens on the happy path. Set.delete
    // on a missing key is a no-op (idempotent), but pin the contract.
    const sessionId = await newSessionDirect("hint_idempotent");
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    await runInDurableObject(stub, (instance) => {
      const set = (instance as { _activeTurnIds: Set<string> })._activeTurnIds;
      set.add("turn_test");
      // First delete — entry exists, removed.
      set.delete("turn_test");
      expect(set.has("turn_test")).toBe(false);
      // Second delete — already missing, must not throw.
      expect(() => set.delete("turn_test")).not.toThrow();
      expect(set.has("turn_test")).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // CF-agents SDK invariant mirrors
  //
  // Audited cloudflare/agents/packages/agents/src/tests/{alarms,
  // retries,retry-integration,msg-ordering}.test.ts. The SDK retry
  // primitive (`tryN`/`this.retry()`/`shouldRetry`/queue+schedule
  // retry options) does not exist on our cfless-portable surface, so
  // those invariants are out-of-scope. These mirror the alarm
  // scheduling + msg-ordering invariants that DO apply: callback
  // mutates schedules mid-alarm, callback re-arms itself, alarm()
  // boots without a prior fetch (analog of CF's "init runs before
  // scheduled callbacks"), and WS replay-then-broadcast ordering.
  // ─────────────────────────────────────────────────────────────────

  it("alarm() survives a scheduled callback that mutates cf_agents_schedules mid-flight", async () => {
    // CF mirror: alarms.test.ts "should not throw when a scheduled
    // callback nukes storage". On our surface the dangerous shape is
    // a callback that calls cancelSchedule(other) or schedule() while
    // the alarm() loop is iterating `due` rows. The loop already
    // collected `due` into an array, and the rearm at the bottom must
    // still succeed even if the callback wiped neighbouring rows.
    const sessionId = await newSessionDirect("alarm_mutate_schedules");
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    await runInDurableObject(stub, async (instance, state) => {
      // Register a one-shot callback that, when invoked from alarm(),
      // wipes ALL rows from cf_agents_schedules. This is the worst
      // case the production loop could hit (a callback that deletes
      // its sibling rows). The post-loop _scheduleNextAlarm must NOT
      // throw — empty table just means "no next alarm, deleteAlarm".
      (instance as unknown as Record<string, unknown>)._oma_test_nuke = async function () {
        (instance as unknown as { ctx: { storage: { sql: SqlStorage } } })
          .ctx.storage.sql.exec(`DELETE FROM cf_agents_schedules`);
      };
      // Schedule it 1s in the past so alarm() picks it up immediately.
      const past = Math.floor(Date.now() / 1000) - 1;
      state.storage.sql.exec(
        `INSERT INTO cf_agents_schedules (id, callback, payload, type, time)
         VALUES (?, ?, ?, 'scheduled', ?)`,
        "sched_nuke", "_oma_test_nuke", "{}", past,
      );
      await state.storage.setAlarm(Date.now() - 1000);
    });

    // Alarm must run to completion without throwing — return value is
    // false when the post-handler alarm slot is empty (no rearm), true
    // when one was set; either way the loop has to complete cleanly.
    await expect(runDurableObjectAlarm(stub)).resolves.not.toThrow();

    // The schedule row was deleted by the callback. The post-loop
    // _scheduleNextAlarm reads the empty table and falls through to
    // deleteAlarm — verify by checking no row remains.
    await runInDurableObject(stub, async (_inst, state) => {
      const rows = state.storage.sql
        .exec(`SELECT id FROM cf_agents_schedules`)
        .toArray();
      expect(rows.length).toBe(0);
    });
  });

  it("alarm() reschedules cron callback to next time after firing", async () => {
    // CF mirror: alarms.test.ts establishes that scheduled callbacks
    // run within a known lifecycle. Our analog: the alarm() loop
    // reschedules cron rows to the next cron expression's next-fire
    // time and re-arms the storage alarm via _scheduleNextAlarm. Pin
    // that the reschedule actually moves the row forward.
    const sessionId = await newSessionDirect("alarm_cron_rearm");
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    let firedCount = 0;
    await runInDurableObject(stub, async (instance, state) => {
      (instance as unknown as Record<string, unknown>)._oma_test_cron =
        async function () { firedCount++; };
      // Cron "* * * * *" → every minute. Backdate `time` so alarm()
      // sees it as due now.
      const past = Math.floor(Date.now() / 1000) - 1;
      state.storage.sql.exec(
        `INSERT INTO cf_agents_schedules (id, callback, payload, type, cron, time)
         VALUES (?, ?, ?, 'cron', ?, ?)`,
        "sched_cron", "_oma_test_cron", "{}", "* * * * *", past,
      );
      await state.storage.setAlarm(Date.now() - 1000);
    });

    await runDurableObjectAlarm(stub);
    await new Promise((r) => setTimeout(r, 50));

    expect(firedCount).toBe(1);

    // Row should still exist (cron reschedules in place) and `time`
    // should now be in the future — the next cron tick.
    await runInDurableObject(stub, async (_inst, state) => {
      const rows = state.storage.sql
        .exec<{ id: string; time: number }>(
          `SELECT id, time FROM cf_agents_schedules WHERE id=?`, "sched_cron",
        )
        .toArray();
      expect(rows.length).toBe(1);
      expect(rows[0].time).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    // Cleanup so subsequent tests don't see this row.
    await runInDurableObject(stub, (_inst, state) => {
      state.storage.sql.exec(`DELETE FROM cf_agents_schedules WHERE id=?`, "sched_cron");
    });
  });

  it("alarm() with poisoned (unparseable payload) row deletes the row instead of looping", async () => {
    // CF mirror: alarms.test.ts implies the alarm pipeline must be
    // resilient to a single row breaking it. Our concrete shape: a
    // payload column that fails JSON.parse. session-do.ts handles
    // this with `DELETE FROM cf_agents_schedules WHERE id = ?`
    // followed by `continue` so the loop doesn't burn cycles.
    const sessionId = await newSessionDirect("alarm_bad_payload");
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    await runInDurableObject(stub, async (instance, state) => {
      // Install a real callback so the lookup succeeds and the loop
      // proceeds to the payload parse (which fails). The bad-payload
      // branch in alarm() then DELETEs the row.
      (instance as unknown as Record<string, unknown>)._oma_test_payload_target =
        async function () { /* unused — payload parse fails before us */ };
      const past = Math.floor(Date.now() / 1000) - 1;
      state.storage.sql.exec(
        `INSERT INTO cf_agents_schedules (id, callback, payload, type, time)
         VALUES (?, ?, ?, 'scheduled', ?)`,
        "sched_bad", "_oma_test_payload_target", "<not json>", past,
      );
      await state.storage.setAlarm(Date.now() - 1000);
    });

    // Alarm must run to completion without throwing.
    await expect(runDurableObjectAlarm(stub)).resolves.not.toThrow();

    // Row should be GONE — the poisoned-payload branch deletes it so
    // the alarm doesn't re-fire on the same broken row forever.
    await runInDurableObject(stub, async (_inst, state) => {
      const rows = state.storage.sql
        .exec(`SELECT id FROM cf_agents_schedules WHERE id=?`, "sched_bad")
        .toArray();
      expect(rows.length).toBe(0);
    });
  });

  it("alarm() handles missing-callback row gracefully (logs + continues, doesn't crash)", async () => {
    // CF mirror: alarms.test.ts's robustness theme. If a row references
    // a callback name that no longer exists on the class (e.g. after a
    // deploy that renamed/removed it), the alarm must continue
    // processing other rows + the rearm must still happen.
    const sessionId = await newSessionDirect("alarm_missing_cb");
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    let goodFiredCount = 0;
    await runInDurableObject(stub, async (instance, state) => {
      (instance as unknown as Record<string, unknown>)._oma_test_good =
        async function () { goodFiredCount++; };
      const past = Math.floor(Date.now() / 1000) - 1;
      // Two rows: one points at a missing callback, one at a real one.
      // Loop must skip the missing-cb row and still fire the good one.
      state.storage.sql.exec(
        `INSERT INTO cf_agents_schedules (id, callback, payload, type, time)
         VALUES (?, ?, ?, 'scheduled', ?)`,
        "sched_missing", "noSuchCallback", "{}", past,
      );
      state.storage.sql.exec(
        `INSERT INTO cf_agents_schedules (id, callback, payload, type, time)
         VALUES (?, ?, ?, 'scheduled', ?)`,
        "sched_good", "_oma_test_good", "{}", past,
      );
      await state.storage.setAlarm(Date.now() - 1000);
    });

    await expect(runDurableObjectAlarm(stub)).resolves.not.toThrow();
    await new Promise((r) => setTimeout(r, 50));

    expect(goodFiredCount).toBe(1);
    // Cleanup any leftover rows so test isolation holds.
    await runInDurableObject(stub, (_inst, state) => {
      state.storage.sql.exec(`DELETE FROM cf_agents_schedules WHERE id IN (?, ?)`, "sched_missing", "sched_good");
    });
  });

  it("alarm() rearm uses min(heartbeat, next-schedule) when both are present", async () => {
    // CF mirror: alarms.test.ts asserts the alarm system is consistent
    // about when the next alarm fires. Our heartbeat-merge contract:
    // when there's an inflight turn (heartbeat ~30s) AND a scheduled
    // row 1h out, the next alarm must be the heartbeat (the min). The
    // pre-merge bug picked one or the other and dropped the heartbeat
    // when schedules existed but were further out.
    const sessionId = await newSessionDirect("alarm_min_merge");
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));
    const ownTurnId = "turn_min_merge";

    await env.AUTH_DB.prepare(
      `UPDATE sessions SET status='running', turn_id=?, turn_started_at=?
        WHERE id=?`,
    )
      .bind(ownTurnId, Date.now() - 5_000, sessionId)
      .run();

    const setAlarmInside: number[] = [];
    let spyArmed = false;
    await runInDurableObject(stub, async (instance, state) => {
      (instance as { _activeTurnIds: Set<string> })._activeTurnIds.add(ownTurnId);
      // Plant a one-shot schedule 1 hour in the future. Heartbeat is
      // 30s out (KEEP_ALIVE_INTERVAL_MS) so the merged min should be
      // the heartbeat, ~30s.
      const farFuture = Math.floor(Date.now() / 1000) + 3600;
      state.storage.sql.exec(
        `INSERT INTO cf_agents_schedules (id, callback, payload, type, time)
         VALUES (?, ?, ?, 'scheduled', ?)`,
        "sched_far", "_oma_test_noop", "{}", farFuture,
      );

      const ctx = (instance as unknown as { ctx: { storage: {
        setAlarm: (t: number) => Promise<void>;
        deleteAlarm: () => Promise<void>;
      } } }).ctx;
      const origSet = ctx.storage.setAlarm.bind(ctx.storage);
      // Trigger setAlarm BEFORE arming the spy so the trigger isn't counted.
      await state.storage.setAlarm(Date.now() - 1000);
      spyArmed = true;
      ctx.storage.setAlarm = async (t: number) => {
        if (spyArmed) setAlarmInside.push(t);
        return origSet(t);
      };
    });

    await runDurableObjectAlarm(stub);
    await new Promise((r) => setTimeout(r, 50));
    spyArmed = false;

    // The rearm should be the heartbeat (~30s out), not the 1h schedule.
    expect(setAlarmInside.length).toBeGreaterThan(0);
    const lastT = setAlarmInside[setAlarmInside.length - 1];
    const deltaMs = lastT - Date.now();
    expect(deltaMs).toBeLessThan(60_000); // heartbeat horizon
    expect(deltaMs).toBeGreaterThan(0);

    // Cleanup
    await env.AUTH_DB.prepare(
      `UPDATE sessions SET status='idle', turn_id=NULL, turn_started_at=NULL WHERE id=?`,
    ).bind(sessionId).run();
    await runInDurableObject(stub, (instance, state) => {
      (instance as { _activeTurnIds: Set<string> })._activeTurnIds.delete(ownTurnId);
      state.storage.sql.exec(`DELETE FROM cf_agents_schedules WHERE id=?`, "sched_far");
    });
  });

  it("alarm() rearm uses next-schedule when no heartbeat needed and schedule is sooner than heartbeat horizon", async () => {
    // Mirror image of the above: inflight=false, but a schedule row
    // exists 5 minutes out. The merged result must be the schedule
    // time (no heartbeat to merge with). Pins the "no inflight ⇒ no
    // heartbeat" path while still rearming for real schedule work.
    const sessionId = await newSessionDirect("alarm_schedule_only");
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    const setAlarmInside: number[] = [];
    let deleteCallsInside = 0;
    let spyArmed = false;
    const targetSec = Math.floor(Date.now() / 1000) + 300; // 5 min out
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO cf_agents_schedules (id, callback, payload, type, time)
         VALUES (?, ?, ?, 'scheduled', ?)`,
        "sched_5min", "_oma_test_noop", "{}", targetSec,
      );

      const ctx = (instance as unknown as { ctx: { storage: {
        setAlarm: (t: number) => Promise<void>;
        deleteAlarm: () => Promise<void>;
      } } }).ctx;
      const origSet = ctx.storage.setAlarm.bind(ctx.storage);
      const origDel = ctx.storage.deleteAlarm.bind(ctx.storage);
      await state.storage.setAlarm(Date.now() - 1000);
      spyArmed = true;
      ctx.storage.setAlarm = async (t: number) => {
        if (spyArmed) setAlarmInside.push(t);
        return origSet(t);
      };
      ctx.storage.deleteAlarm = async () => {
        if (spyArmed) deleteCallsInside++;
        return origDel();
      };
    });

    await runDurableObjectAlarm(stub);
    await new Promise((r) => setTimeout(r, 50));
    spyArmed = false;

    // setAlarm fired at the schedule's time (or close to it). The
    // load-bearing assertion: the LAST setAlarm wins (workerd uses
    // last-write semantics for the alarm slot) and matches the
    // schedule's target time, NOT zero / NOT cleared.
    expect(setAlarmInside.length).toBeGreaterThan(0);
    const lastT = setAlarmInside[setAlarmInside.length - 1];
    // Should be approximately targetSec*1000 (within 1s tolerance).
    expect(Math.abs(lastT - targetSec * 1000)).toBeLessThan(1500);
    // No spurious extra delete after the setAlarm — that was the
    // pre-merge bug. (deleteCallsInside may be 0 or 1 depending on
    // whether the platform pre-clears the slot; what matters is the
    // FINAL setAlarm sticks.)
    void deleteCallsInside;

    await runInDurableObject(stub, (_inst, state) => {
      state.storage.sql.exec(`DELETE FROM cf_agents_schedules WHERE id=?`, "sched_5min");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // WebSocket message ordering — replay precedes any subsequent
  // broadcast. Mirrors cloudflare/agents msg-ordering.test.ts: the WS
  // upgrade must produce a deterministic prefix of pre-existing events
  // before any new event reaches the new socket. Our shape: GET /ws
  // calls history.getEvents() then ws.send() in a sync loop, returning
  // the 101 only after the loop completes. A subsequent broadcastEvent
  // (driven by any RPC after the upgrade returns) lands strictly after.
  // ─────────────────────────────────────────────────────────────────

  it("WS upgrade replays existing events in order before any subsequent broadcast", async () => {
    const sessionId = await newSessionDirect("ws_replay_order");
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    // Seed three pre-existing events directly into the DO's events
    // table so the WS replay has something deterministic to send.
    await runInDurableObject(stub, async (instance, state) => {
      ensureEventLogSchema(state.storage.sql);
      const history = new SqliteHistory(state.storage.sql);
      history.append({ type: "user.message", content: [{ type: "text", text: "first" }] });
      history.append({ type: "user.message", content: [{ type: "text", text: "second" }] });
      history.append({ type: "user.message", content: [{ type: "text", text: "third" }] });
      // Mark initialized so /ws doesn't trigger a recovery scan.
      (instance as { initialized: boolean }).initialized = true;
    });

    // Open the WebSocket. The fetch returns only after replay is done.
    const upgradeRes = await stub.fetch(
      new Request("http://internal/ws", { headers: { Upgrade: "websocket" } }),
    );
    expect(upgradeRes.status).toBe(101);
    const ws = upgradeRes.webSocket as WebSocket;
    ws.accept();

    const received: string[] = [];
    const allFour = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out after ${received.length}`)), 3000);
      ws.addEventListener("message", (ev: MessageEvent) => {
        received.push(ev.data as string);
        if (received.length >= 4) {
          clearTimeout(t);
          resolve();
        }
      });
    });

    // Now broadcast a fresh event. Because replay runs sync within
    // fetch() before returning, this MUST land strictly after the
    // three replay messages.
    await runInDurableObject(stub, (instance) => {
      const broadcast = (instance as unknown as {
        broadcastEvent: (e: unknown) => void;
      }).broadcastEvent.bind(instance);
      broadcast({ type: "user.message", content: [{ type: "text", text: "fourth-live" }] });
    });

    await allFour;
    ws.close();

    expect(received.length).toBe(4);
    const parsed = received.map((r) => JSON.parse(r));
    // Replayed three, in order, then the live one.
    expect(parsed[0].content[0].text).toBe("first");
    expect(parsed[1].content[0].text).toBe("second");
    expect(parsed[2].content[0].text).toBe("third");
    expect(parsed[3].content[0].text).toBe("fourth-live");
  });
});
