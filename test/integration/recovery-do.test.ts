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
  // keepAliveWhile + OR-rearm wiring
  //
  // The actual fix for the staging eviction bug — sub-agents bypass
  // sessions.status='running' (they don't write that row), so alarm
  // rearm has to also read _activeKeepAlive. These tests prove the
  // wiring isn't dead: the runSubAgent path goes through
  // adapter.keepAliveWhile, which fires setAlarm + populates
  // _activeKeepAlive, and the alarm() rearm logic respects that set.
  // ─────────────────────────────────────────────────────────────────

  it("adapter.keepAliveWhile populates _activeKeepAlive during fn + clears in finally", async () => {
    // Mirror of cloudflare/agents SDK's "should increment refs" +
    // "should decrement when disposed" + "should clean up even when
    // the function throws", but exercising the REAL CF wiring in
    // SessionDO.getRuntimeAdapter (not just the port mock).
    const sessionId = await newSessionDirect("keepalive_wiring");
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    // Success path: refs go 0 → 1 (during) → 0 (after).
    let observedDuring = -1;
    await runInDurableObject(stub, async (instance) => {
      const adapter = (instance as unknown as { runtimeAdapter: { keepAliveWhile: <T>(fn: () => Promise<T>) => Promise<T> } }).runtimeAdapter;
      const set = (instance as { _activeKeepAlive: Set<number> })._activeKeepAlive;
      expect(set.size).toBe(0);
      const r = await adapter.keepAliveWhile(async () => {
        observedDuring = set.size;
        return "ok";
      });
      expect(r).toBe("ok");
      expect(set.size).toBe(0);
    });
    expect(observedDuring).toBe(1);

    // Throw path: refs still clear in finally.
    let caught = false;
    await runInDurableObject(stub, async (instance) => {
      const adapter = (instance as unknown as { runtimeAdapter: { keepAliveWhile: <T>(fn: () => Promise<T>) => Promise<T> } }).runtimeAdapter;
      const set = (instance as { _activeKeepAlive: Set<number> })._activeKeepAlive;
      try {
        await adapter.keepAliveWhile(async () => {
          throw new Error("boom");
        });
      } catch {
        caught = true;
      }
      expect(set.size).toBe(0);
    });
    expect(caught).toBe(true);
  });

  it("adapter.keepAliveWhile schedules an alarm on entry (CF wiring proof)", async () => {
    // Without this, the no-op `(fn) => fn()` slot in runSubAgent
    // (the actual line that was changed in dd21bdd) could regress to
    // a no-op CF impl and tests would still pass via the port mock.
    // We spy on ctx.storage.setAlarm directly because miniflare's
    // runDurableObjectAlarm clears the slot post-handler, making
    // state.storage.getAlarm() unreliable for "did alarm rearm" checks.
    const sessionId = await newSessionDirect("keepalive_alarm");
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    const setAlarmTimes: number[] = [];
    await runInDurableObject(stub, async (instance) => {
      const ctx = (instance as unknown as { ctx: { storage: { setAlarm: (t: number) => Promise<void> } } }).ctx;
      const orig = ctx.storage.setAlarm.bind(ctx.storage);
      ctx.storage.setAlarm = async (t: number) => {
        setAlarmTimes.push(t);
        return orig(t);
      };
      const adapter = (instance as unknown as { runtimeAdapter: { keepAliveWhile: <T>(fn: () => Promise<T>) => Promise<T> } }).runtimeAdapter;
      await adapter.keepAliveWhile(async () => "ok");
      ctx.storage.setAlarm = orig; // restore
    });
    // setAlarm should have been called at least once with t ≈ now+30s.
    expect(setAlarmTimes.length).toBeGreaterThan(0);
    const t = setAlarmTimes[setAlarmTimes.length - 1];
    expect(t).toBeGreaterThan(Date.now());
    expect(t - Date.now()).toBeLessThan(60_000);
  });

  it("alarm() rearms while _activeKeepAlive.size > 0 even with no inflight turn", async () => {
    // The OR-rearm: `_activeKeepAlive.size > 0 || _hasInflightTurn()`.
    // Sub-agents bypass beginTurn/sessions.status — without the OR,
    // alarm wouldn't rearm during a long sub-agent call and the DO
    // would get evicted. This is the load-bearing change.
    //
    // We can't read state.storage.getAlarm() post-handler — miniflare
    // clears the alarm slot once the handler completes regardless of
    // any setAlarm call inside it. Spy on ctx.storage.setAlarm to
    // catch the rearm directly.
    const sessionId = await newSessionDirect("rearm_or_keepalive");
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    const setAlarmCalls: number[] = [];
    await runInDurableObject(stub, async (instance, state) => {
      // Sanity: row is idle — any rearm comes from the OR branch.
      const row = await env.AUTH_DB
        .prepare(`SELECT status FROM sessions WHERE id=?`)
        .bind(sessionId)
        .first();
      expect(row?.status).toBe("idle");

      const set = (instance as { _activeKeepAlive: Set<number> })._activeKeepAlive;
      set.add(99);

      const ctx = (instance as unknown as { ctx: { storage: { setAlarm: (t: number) => Promise<void> } } }).ctx;
      const orig = ctx.storage.setAlarm.bind(ctx.storage);
      ctx.storage.setAlarm = async (t: number) => {
        setAlarmCalls.push(t);
        return orig(t);
      };
      await state.storage.deleteAlarm();
      await state.storage.setAlarm(Date.now() - 1000); // due now
      // Note: that setAlarm call lands BEFORE the spy was installed;
      // setAlarmCalls only records calls from inside alarm() onward.
      ctx.storage.setAlarm = async (t: number) => {
        setAlarmCalls.push(t);
        return orig(t);
      };
    });
    await runDurableObjectAlarm(stub);
    await new Promise((r) => setTimeout(r, 50));

    // alarm() should have called setAlarm at least once (the rearm).
    expect(setAlarmCalls.length).toBeGreaterThan(0);
    const lastT = setAlarmCalls[setAlarmCalls.length - 1];
    expect(lastT).toBeGreaterThan(Date.now());
    expect(lastT - Date.now()).toBeLessThan(60_000);

    // Cleanup so the next test isn't polluted.
    await runInDurableObject(stub, (instance) => {
      const set = (instance as { _activeKeepAlive: Set<number> })._activeKeepAlive;
      set.delete(99);
    });
  });

  it("alarm() does NOT rearm when both _activeKeepAlive empty AND no inflight turn", async () => {
    // Negative case for the OR-rearm — proves we're not just leaking
    // setAlarm calls regardless of state. Same spy approach as the
    // positive case above.
    const sessionId = await newSessionDirect("rearm_idle");
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    const setAlarmCallsInsideAlarm: number[] = [];
    let spyArmed = false;
    await runInDurableObject(stub, async (instance, state) => {
      const set = (instance as { _activeKeepAlive: Set<number> })._activeKeepAlive;
      expect(set.size).toBe(0);

      const ctx = (instance as unknown as { ctx: { storage: { setAlarm: (t: number) => Promise<void> } } }).ctx;
      const orig = ctx.storage.setAlarm.bind(ctx.storage);
      await state.storage.deleteAlarm();
      await state.storage.setAlarm(Date.now() - 1000);
      // Install the spy AFTER the trigger setAlarm so we only count
      // calls from inside alarm().
      spyArmed = true;
      ctx.storage.setAlarm = async (t: number) => {
        if (spyArmed) setAlarmCallsInsideAlarm.push(t);
        return orig(t);
      };
    });
    await runDurableObjectAlarm(stub);
    await new Promise((r) => setTimeout(r, 50));
    spyArmed = false;
    expect(setAlarmCallsInsideAlarm.length).toBe(0);
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
});
