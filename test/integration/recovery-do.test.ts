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
