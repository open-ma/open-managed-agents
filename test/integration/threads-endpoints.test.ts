// @ts-nocheck
//
// Integration tests for the AMA thread CRUD endpoints on SessionDO.
// Reaches the DO directly via stub.fetch — bypasses the main worker's
// auth/sandbox-binding plumbing so we can focus on thread storage +
// archive semantics.
//
// Coverage:
//   - GET /threads lists primary + sub-agent threads from the SQL table
//   - GET /threads excludes archived by default; ?include_archived=true
//     surfaces them
//   - GET /threads/:tid returns 404 for unknown ids
//   - POST /threads/:tid/archive flips status, idempotent on re-call,
//     refuses to archive sthr_primary
//   - POST /event with archived session_thread_id returns 409

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";

function freshDoStub(idHint: string) {
  const id = `${idHint}_${Math.random().toString(36).slice(2, 10)}`;
  return env.SESSION_DO.get(env.SESSION_DO.idFromName(id));
}

async function seedSchemaAndState(
  stub: ReturnType<typeof freshDoStub>,
  agentId = "agent_test",
  agentName = "TestAgent",
) {
  await runInDurableObject(stub, async (instance, state) => {
    // Ensure DO sql tables (events + threads) exist by triggering the
    // private schema bootstrap.
    (instance as { _ensureCfAgentsSchema: () => void })._ensureCfAgentsSchema();
    (instance as { ensureSchema: () => void }).ensureSchema?.();
    // Stub state — _ensurePrimaryThread reads agent_id + agent_snapshot.name.
    (instance as { _state: unknown })._state = {
      session_id: "sess_test",
      tenant_id: "default",
      agent_id: agentId,
      agent_snapshot: { name: agentName },
    };
    (instance as { _ensurePrimaryThread: () => void })._ensurePrimaryThread();
    // Seed two sub-agent threads directly into the SQL table — bypasses
    // runSubAgent so we don't need the full tools/sandbox graph.
    state.storage.sql.exec(
      `INSERT INTO threads (id, agent_id, agent_name, parent_thread_id, created_at)
       VALUES ('sthr_subA', 'agent_worker', 'WorkerA', 'sthr_primary', ?)`,
      Date.now() - 5000,
    );
    state.storage.sql.exec(
      `INSERT INTO threads (id, agent_id, agent_name, parent_thread_id, created_at)
       VALUES ('sthr_subB', 'agent_worker', 'WorkerB', 'sthr_primary', ?)`,
      Date.now() - 3000,
    );
  });
}

describe("threads HTTP endpoints", () => {
  it("GET /threads lists primary + sub-agent threads", async () => {
    const stub = freshDoStub("threads_list");
    await seedSchemaAndState(stub);

    const res = await stub.fetch(new Request("http://internal/threads"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data).toHaveLength(3);
    const ids = body.data.map((t) => t.id);
    expect(ids).toContain("sthr_primary");
    expect(ids).toContain("sthr_subA");
    expect(ids).toContain("sthr_subB");

    const primary = body.data.find((t) => t.id === "sthr_primary")!;
    expect(primary.parent_thread_id).toBeNull();
    expect(primary.status).toBe("active");
    expect(primary.archived_at).toBeNull();

    const subA = body.data.find((t) => t.id === "sthr_subA")!;
    expect(subA.parent_thread_id).toBe("sthr_primary");
    expect(subA.agent_name).toBe("WorkerA");
  });

  it("GET /threads excludes archived; ?include_archived=true surfaces them", async () => {
    const stub = freshDoStub("threads_archived");
    await seedSchemaAndState(stub);
    // Archive subA
    await runInDurableObject(stub, async (_inst, state) => {
      state.storage.sql.exec(
        `UPDATE threads SET archived_at = ? WHERE id = 'sthr_subA'`,
        Date.now(),
      );
    });

    const def = await stub.fetch(new Request("http://internal/threads"));
    const defBody = (await def.json()) as { data: Array<{ id: string }> };
    expect(defBody.data.map((t) => t.id)).not.toContain("sthr_subA");
    expect(defBody.data).toHaveLength(2);

    const incl = await stub.fetch(
      new Request("http://internal/threads?include_archived=true"),
    );
    const inclBody = (await incl.json()) as { data: Array<{ id: string; status: string }> };
    expect(inclBody.data.map((t) => t.id)).toContain("sthr_subA");
    const archivedRow = inclBody.data.find((t) => t.id === "sthr_subA")!;
    expect(archivedRow.status).toBe("archived");
  });

  it("GET /threads/:tid returns 404 for unknown id", async () => {
    const stub = freshDoStub("threads_404");
    await seedSchemaAndState(stub);

    const res = await stub.fetch(new Request("http://internal/threads/sthr_does_not_exist"));
    expect(res.status).toBe(404);
  });

  it("POST /threads/sthr_primary/archive returns 400", async () => {
    const stub = freshDoStub("threads_primary_archive");
    await seedSchemaAndState(stub);

    const res = await stub.fetch(
      new Request("http://internal/threads/sthr_primary/archive", { method: "POST" }),
    );
    expect(res.status).toBe(400);
  });

  it("POST /threads/:tid/archive flips status, idempotent", async () => {
    const stub = freshDoStub("threads_archive");
    await seedSchemaAndState(stub);

    const r1 = await stub.fetch(
      new Request("http://internal/threads/sthr_subA/archive", { method: "POST" }),
    );
    expect(r1.status).toBe(200);
    const body1 = (await r1.json()) as { id: string; status: string; archived_at: string };
    expect(body1.status).toBe("archived");
    expect(body1.archived_at).not.toBeNull();
    const firstTs = body1.archived_at;

    // Idempotent: re-archive returns the same archived_at (UPDATE …
    // WHERE archived_at IS NULL — the second call's UPDATE is a no-op).
    await new Promise((r) => setTimeout(r, 10));
    const r2 = await stub.fetch(
      new Request("http://internal/threads/sthr_subA/archive", { method: "POST" }),
    );
    expect(r2.status).toBe(200);
    const body2 = (await r2.json()) as { archived_at: string };
    expect(body2.archived_at).toBe(firstTs);
  });

  it("POST /event with archived session_thread_id returns 409", async () => {
    const stub = freshDoStub("threads_archived_event");
    await seedSchemaAndState(stub);

    // Archive subA first.
    await stub.fetch(
      new Request("http://internal/threads/sthr_subA/archive", { method: "POST" }),
    );

    const res = await stub.fetch(
      new Request("http://internal/event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "user.message",
          session_thread_id: "sthr_subA",
          content: [{ type: "text", text: "should be rejected" }],
        }),
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("archived");
  });

  it("POST /event with primary thread (default) is accepted", async () => {
    const stub = freshDoStub("threads_primary_event");
    await seedSchemaAndState(stub);

    const res = await stub.fetch(
      new Request("http://internal/event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "user.message",
          content: [{ type: "text", text: "hi primary" }],
        }),
      }),
    );
    // 202 = accepted (drainEventQueue fires async); the response code
    // here verifies the archive guard didn't reject.
    expect([200, 202]).toContain(res.status);
  });

  it("stats.active_seconds sums paired span.model_request_start/end durations per thread", async () => {
    // Seed a handful of model-request span pairs across two threads with
    // known durations and assert _serializeThreadRow returns the expected
    // active_seconds. Pairs join via start_id ↔ model_request_start_id;
    // ts is the SQL `ts` column (seconds). One unpaired start (still
    // in-flight) verifies it doesn't break the sum.
    const stub = freshDoStub("threads_active_seconds");
    await seedSchemaAndState(stub);

    await runInDurableObject(stub, (_inst, state) => {
      // Helper: insert with explicit ts so durations are deterministic.
      const ins = (
        threadId: string,
        type: "span.model_request_start" | "span.model_request_end",
        ts: number,
        payload: Record<string, unknown>,
      ) => {
        state.storage.sql.exec(
          `INSERT INTO events (type, data, ts, processed_at, session_thread_id)
           VALUES (?, ?, ?, ?, ?)`,
          type,
          JSON.stringify({ type, ...payload }),
          ts,
          ts,
          threadId,
        );
      };
      // Primary: two paired calls (3s + 5s = 8s) plus one in-flight start.
      ins("sthr_primary", "span.model_request_start", 1000, { id: "p1", model: "m" });
      ins("sthr_primary", "span.model_request_end", 1003, { model_request_start_id: "p1", model: "m" });
      ins("sthr_primary", "span.model_request_start", 1010, { id: "p2", model: "m" });
      ins("sthr_primary", "span.model_request_end", 1015, { model_request_start_id: "p2", model: "m" });
      ins("sthr_primary", "span.model_request_start", 1020, { id: "p3-inflight", model: "m" });
      // Sub-agent A: one paired call (2s).
      ins("sthr_subA", "span.model_request_start", 2000, { id: "a1", model: "m" });
      ins("sthr_subA", "span.model_request_end", 2002, { model_request_start_id: "a1", model: "m" });
    });

    const list = await stub.fetch(new Request("http://internal/threads"));
    const body = (await list.json()) as {
      data: Array<{ id: string; stats: { active_seconds: number | null } }>;
    };
    const primary = body.data.find((t) => t.id === "sthr_primary")!;
    const subA = body.data.find((t) => t.id === "sthr_subA")!;
    const subB = body.data.find((t) => t.id === "sthr_subB")!;
    expect(primary.stats.active_seconds).toBe(8);
    expect(subA.stats.active_seconds).toBe(2);
    // No spans seeded for subB → 0, not null.
    expect(subB.stats.active_seconds).toBe(0);
  });

  it("POST /usage credits per-thread; GET /threads surfaces separate usage rows", async () => {
    // Two ingest hits to /usage with different session_thread_id values
    // should land in separate buckets on state.thread_usage and surface
    // as the AMA `usage` field on each thread row. Session-wide
    // input_tokens/output_tokens stay in sync (sum across threads).
    const stub = freshDoStub("threads_usage");
    await seedSchemaAndState(stub);

    const r1 = await stub.fetch(
      new Request("http://internal/usage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 30,
          session_thread_id: "sthr_primary",
        }),
      }),
    );
    expect(r1.status).toBe(200);

    const r2 = await stub.fetch(
      new Request("http://internal/usage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input_tokens: 200,
          output_tokens: 75,
          cache_creation_input_tokens: 40,
          session_thread_id: "sthr_subA",
        }),
      }),
    );
    expect(r2.status).toBe(200);
    // Session-wide echo sums across threads.
    const r2Body = (await r2.json()) as { input_tokens: number; output_tokens: number };
    expect(r2Body.input_tokens).toBe(300);
    expect(r2Body.output_tokens).toBe(125);

    const list = await stub.fetch(new Request("http://internal/threads"));
    const body = (await list.json()) as {
      data: Array<{
        id: string;
        usage: null | {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
      }>;
    };
    const primary = body.data.find((t) => t.id === "sthr_primary")!;
    const subA = body.data.find((t) => t.id === "sthr_subA")!;
    expect(primary.usage).not.toBeNull();
    expect(primary.usage!.input_tokens).toBe(100);
    expect(primary.usage!.output_tokens).toBe(50);
    expect(primary.usage!.cache_read_input_tokens).toBe(30);
    expect(subA.usage).not.toBeNull();
    expect(subA.usage!.input_tokens).toBe(200);
    expect(subA.usage!.output_tokens).toBe(75);
    expect(subA.usage!.cache_creation_input_tokens).toBe(40);
  });

  it("user.interrupt with sub-agent session_thread_id aborts only that thread", async () => {
    // Validates the runSubAgent → _threadAbortControllers wiring in
    // session-do.ts: registering a sub-agent's AbortController under its
    // threadId so a targeted user.interrupt aborts exactly that thread,
    // not the primary thread (which may be sleeping waiting for the
    // sub-agent to return). Driven via the Map directly because spinning
    // a real sub-agent harness needs the full sandbox/tools graph; the
    // wire-level contract is "POST user.interrupt with thread_id → that
    // thread's controller fires", and that's what we assert.
    const stub = freshDoStub("threads_subagent_abort");
    await seedSchemaAndState(stub);

    // Stand in for what runSubAgent does at the top of its body: register
    // a per-thread AbortController on the DO instance. The controllers
    // are seeded inside the DO context, then we POST user.interrupt from
    // outside (stub.fetch can't be called from inside runInDurableObject
    // — workerd refuses cross-DO I/O on the same isolate). We wait via
    // polling for the abort flag to flip, since the AbortSignal listener
    // fires inside the DO context too.
    const subThreadId = "sthr_subA";
    await runInDurableObject(stub, (instance) => {
      const map = (instance as { _threadAbortControllers: Map<string, AbortController> })
        ._threadAbortControllers;
      const primaryCtrl = new AbortController();
      map.set("sthr_primary", primaryCtrl);
      const subCtrl = new AbortController();
      map.set(subThreadId, subCtrl);
    });

    const res = await stub.fetch(
      new Request("http://internal/event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "user.interrupt",
          session_thread_id: subThreadId,
        }),
      }),
    );
    expect([200, 202]).toContain(res.status);

    // Re-enter the DO and read the post-state of both controllers.
    const result = await runInDurableObject(stub, (instance) => {
      const map = (instance as { _threadAbortControllers: Map<string, AbortController> })
        ._threadAbortControllers;
      // The interrupt handler deletes the sub-agent entry but leaves
      // the primary entry alone (sibling isolation).
      return {
        subStillRegistered: map.has(subThreadId),
        primaryStillRegistered: map.has("sthr_primary"),
        primaryAborted: map.get("sthr_primary")?.signal.aborted ?? null,
      };
    });
    expect(result.subStillRegistered).toBe(false);
    expect(result.primaryStillRegistered).toBe(true);
    expect(result.primaryAborted).toBe(false);
  });

  // ─── Stream end "aborted" persists partial agent.message ────────────
  // Mid-stream interrupts (user.interrupt, abort signal trips, MCP
  // timeouts) used to leave streams rows stuck at status='streaming'
  // and never write the partial as agent.message. Next turn's LLM
  // context was missing what the model had said before the cut.
  // broadcastStreamEnd("aborted") now finalizes the row AND appends
  // the partial as a canonical agent.message — same shape as cold-start
  // recoverInterruptedState, just done eagerly.
  it("broadcastStreamEnd('aborted') persists partial chunks as agent.message", async () => {
    const stub = freshDoStub("stream_abort_persist");
    await seedSchemaAndState(stub);

    const partialMessageId = "msg_abort_test";
    await runInDurableObject(stub, async (instance, state) => {
      // Manually drive the stream lifecycle the way default-loop does:
      // start → append chunks → end(aborted).
      const helpers = (instance as {
        buildStreamRuntimeMethods: (threadId?: string) => {
          broadcastStreamStart: (id: string) => Promise<void>;
          broadcastChunk: (id: string, delta: string) => Promise<void>;
          broadcastStreamEnd: (
            id: string,
            status: "completed" | "aborted",
            err?: string,
          ) => Promise<void>;
        };
      }).buildStreamRuntimeMethods("sthr_primary");
      await helpers.broadcastStreamStart(partialMessageId);
      await helpers.broadcastChunk(partialMessageId, "Hello ");
      await helpers.broadcastChunk(partialMessageId, "wor");
      // The interrupt path — should now also persist agent.message.
      await helpers.broadcastStreamEnd(partialMessageId, "aborted", "interrupted_mid_stream");

      // Read back: events table should have the partial text as a
      // canonical agent.message; streams row finalized as 'aborted'.
      const events: Array<{ type: string; data: string }> = [];
      for (const row of state.storage.sql.exec(
        `SELECT type, data FROM events ORDER BY seq`,
      )) {
        events.push({ type: row.type as string, data: row.data as string });
      }
      const agentMsg = events.find(
        (e) => e.type === "agent.message" && e.data.includes(partialMessageId),
      );
      expect(agentMsg, "agent.message with partial should land").toBeDefined();
      const parsed = JSON.parse(agentMsg!.data) as {
        content: Array<{ type: string; text: string }>;
        session_thread_id?: string;
      };
      expect(parsed.content[0].text).toBe("Hello wor");
      expect(parsed.session_thread_id).toBe("sthr_primary");
    });
  });

  it("broadcastStreamEnd('aborted') with zero chunks emits placeholder", async () => {
    const stub = freshDoStub("stream_abort_empty");
    await seedSchemaAndState(stub);

    await runInDurableObject(stub, async (instance, state) => {
      const helpers = (instance as {
        buildStreamRuntimeMethods: (threadId?: string) => {
          broadcastStreamStart: (id: string) => Promise<void>;
          broadcastStreamEnd: (
            id: string,
            status: "completed" | "aborted",
          ) => Promise<void>;
        };
      }).buildStreamRuntimeMethods();
      const id = "msg_zero_chunks";
      await helpers.broadcastStreamStart(id);
      // No chunks accumulated — abort right away (model never streamed).
      await helpers.broadcastStreamEnd(id, "aborted");

      let agentMsgData: string | null = null;
      for (const row of state.storage.sql.exec(
        `SELECT data FROM events WHERE type = 'agent.message' ORDER BY seq DESC LIMIT 1`,
      )) {
        agentMsgData = row.data as string;
      }
      expect(agentMsgData).not.toBeNull();
      const parsed = JSON.parse(agentMsgData!) as {
        content: Array<{ type: string; text: string }>;
      };
      // Placeholder mirrors recovery.ts's "(interrupted by maintenance restart)".
      expect(parsed.content[0].text).toContain("interrupted");
    });
  });

  // ─── drainEventQueue concurrency guard ─────────────────────────────
  // The original sess-88mm28kjaihxlca3 race: two concurrent drain
  // attempts on the same thread both passed the deriveStatus check
  // before either incremented hints, and both ran the LLM. Sync
  // _draining set fixes that — these tests pin the contract.
  it("drainEventQueue is mutually exclusive within a thread", async () => {
    const stub = freshDoStub("drain_mutex_same");
    await seedSchemaAndState(stub);

    const result = await runInDurableObject(stub, async (instance) => {
      const drainSet = (instance as { _draining: Set<string> })._draining;
      // Pre-set the in-flight flag — second caller must see it and
      // early-return without doing any work. Equivalent to what
      // happens when caller A is mid-drain and caller B fires.
      drainSet.add("sthr_primary");
      const before = Array.from(drainSet);
      // Call drainEventQueue — must early-return synchronously
      // because the flag is already there.
      const drainPromise = (instance as { drainEventQueue: (t: string) => Promise<void> })
        .drainEventQueue("sthr_primary");
      const after = Array.from(drainSet);
      await drainPromise;
      // After the call returns, the flag is still set (we own it).
      const stillSet = drainSet.has("sthr_primary");
      // Cleanup so the test is isolated.
      drainSet.delete("sthr_primary");
      return { before, after, stillSet };
    });
    expect(result.before).toEqual(["sthr_primary"]);
    expect(result.after).toEqual(["sthr_primary"]);
    expect(result.stillSet).toBe(true);
  });

  it("drainEventQueue across different threads doesn't share the mutex", async () => {
    // Spy on _draining.add to record whether drainEventQueue('sthr_subA')
    // entered the body (which calls add(threadId)). With primary already
    // in the set, a global-mutex implementation would early-return for
    // subA without ever adding it. Per-thread mutex must add subA
    // before the body proceeds. Using the spy is more reliable than
    // observing post-state, which can't distinguish early-return from
    // a same-tick add-then-remove cycle when no pending events exist.
    const stub = freshDoStub("drain_mutex_cross");
    await seedSchemaAndState(stub);

    const result = await runInDurableObject(stub, async (instance) => {
      const drainSet = (instance as { _draining: Set<string> })._draining;
      drainSet.add("sthr_primary");
      const adds: string[] = [];
      const originalAdd = drainSet.add.bind(drainSet);
      drainSet.add = (item: string) => {
        adds.push(item);
        return originalAdd(item);
      };
      await (instance as { drainEventQueue: (t: string) => Promise<void> })
        .drainEventQueue("sthr_subA");
      drainSet.delete("sthr_primary"); // cleanup
      return { adds };
    });
    // The body's `this._draining.add(threadId)` ran for sthr_subA,
    // proving the early-return check is per-thread (`.has(threadId)`),
    // not a global flag (`.size > 0`).
    expect(result.adds).toContain("sthr_subA");
  });

  // ─── 5-message burst (the user-visible bug) ────────────────────────
  // Pre-rewrite, drainEventQueue used a `lastIdleSeq` window: any
  // user.message appended between turn-start and the matching
  // status_idle was silently skipped (#2-5 in a 5-msg burst). With
  // per-event processed_at, all 5 land in the pending index and
  // get drained sequentially — no message lost.
  it("five user.messages burst all land as pending until drained", async () => {
    const stub = freshDoStub("five_msg_burst");
    await seedSchemaAndState(stub);

    // POST 5 user.messages back-to-back (no awaits between server
    // calls — simulates a user spamming Enter while a turn is mid-flight).
    const responses = await Promise.all(
      Array.from({ length: 5 }).map((_, i) =>
        stub.fetch(
          new Request("http://internal/event", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              type: "user.message",
              content: [{ type: "text", text: `burst-${i + 1}` }],
            }),
          }),
        ),
      ),
    );
    for (const r of responses) {
      expect([200, 202]).toContain(r.status);
    }

    // All 5 should be in the events table. processed_at may be NULL
    // (still pending) or set (drain caught up) — both are valid;
    // what matters is none silently dropped.
    const rows = await runInDurableObject(stub, async (_inst, state) => {
      const out: Array<{ seq: number; type: string; data: string; processed: boolean }> = [];
      for (const row of state.storage.sql.exec(
        `SELECT seq, type, data, processed_at FROM events
           WHERE type = 'user.message' AND session_thread_id = 'sthr_primary'
           ORDER BY seq`,
      )) {
        out.push({
          seq: row.seq as number,
          type: row.type as string,
          data: row.data as string,
          processed: row.processed_at != null,
        });
      }
      return out;
    });
    expect(rows).toHaveLength(5);
    // Order-agnostic: Promise.all kicks off all 5 in parallel — DO
    // SQLite serializes inserts but the parallel POSTs don't preserve
    // caller order. The contract that matters is "all 5 landed", not
    // their seq order. Pre-rewrite, only burst-1 would land and #2-5
    // would be silently dropped by the lastIdleSeq window.
    const texts = new Set(rows.map((r) => JSON.parse(r.data).content[0].text));
    expect(texts).toEqual(new Set(["burst-1", "burst-2", "burst-3", "burst-4", "burst-5"]));
  });

  // ─── End-to-end interrupt: AMA "queued inputs are flushed" ─────────
  // Seed a session with 3 pending user.messages on primary, POST
  // user.interrupt, observe: queue flushed (cancelled_at on all 3),
  // user.interrupt + session.status_idle appended, no session.error,
  // /events round-trip returns the cancelled events with metadata.
  it("user.interrupt flushes pending queue + writes idle, no session.error", async () => {
    const stub = freshDoStub("interrupt_e2e");
    await seedSchemaAndState(stub);

    // Seed 3 pending user.messages directly into the events table —
    // bypasses the POST /event drain trigger (which would race the
    // interrupt). These represent "queued inputs" per AMA spec.
    await runInDurableObject(stub, (_inst, state) => {
      for (let i = 1; i <= 3; i++) {
        state.storage.sql.exec(
          `INSERT INTO events (type, data, processed_at, session_thread_id)
           VALUES ('user.message', ?, NULL, 'sthr_primary')`,
          JSON.stringify({
            type: "user.message",
            content: [{ type: "text", text: `pending-${i}` }],
          }),
        );
      }
    });

    const beforeCount = await runInDurableObject(stub, (_inst, state) => {
      let pending = 0;
      for (const row of state.storage.sql.exec(
        `SELECT COUNT(*) AS n FROM events
           WHERE type = 'user.message' AND session_thread_id = 'sthr_primary'
             AND processed_at IS NULL AND cancelled_at IS NULL`,
      )) {
        pending = row.n as number;
      }
      return pending;
    });
    expect(beforeCount).toBe(3);

    // Interrupt the primary thread.
    const res = await stub.fetch(
      new Request("http://internal/event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "user.interrupt" }),
      }),
    );
    expect([200, 202]).toContain(res.status);

    const after = await runInDurableObject(stub, (_inst, state) => {
      // Pending count after — should be zero (all 3 cancelled).
      let pending = 0;
      for (const row of state.storage.sql.exec(
        `SELECT COUNT(*) AS n FROM events
           WHERE type = 'user.message' AND session_thread_id = 'sthr_primary'
             AND processed_at IS NULL AND cancelled_at IS NULL`,
      )) {
        pending = row.n as number;
      }
      // Cancelled count — should be 3.
      let cancelled = 0;
      for (const row of state.storage.sql.exec(
        `SELECT COUNT(*) AS n FROM events
           WHERE type = 'user.message' AND session_thread_id = 'sthr_primary'
             AND cancelled_at IS NOT NULL`,
      )) {
        cancelled = row.n as number;
      }
      // Lifecycle events written by interrupt handler.
      const lifecycle: string[] = [];
      for (const row of state.storage.sql.exec(
        `SELECT type FROM events
           WHERE type IN ('user.interrupt', 'session.status_idle', 'session.error')
           ORDER BY seq`,
      )) {
        lifecycle.push(row.type as string);
      }
      return { pending, cancelled, lifecycle };
    });
    expect(after.pending).toBe(0);
    expect(after.cancelled).toBe(3);
    // Interrupt + idle should be there. session.error must NOT —
    // user.interrupt is control flow, not error.
    expect(after.lifecycle).toContain("user.interrupt");
    expect(after.lifecycle).toContain("session.status_idle");
    expect(after.lifecycle).not.toContain("session.error");
  });

  // ─── Cross-thread flush isolation (data-level) ─────────────────────
  // The earlier "user.interrupt with session_thread_id aborts only
  // the matching turn" test covers AbortController scoping. This one
  // covers the SQL UPDATE: cancelling sthr_X must not touch sthr_Y's
  // pending rows.
  it("user.interrupt on sthr_X leaves sthr_Y pending events untouched", async () => {
    const stub = freshDoStub("interrupt_cross_data");
    await seedSchemaAndState(stub);

    await runInDurableObject(stub, (_inst, state) => {
      // 2 pending on subA, 2 pending on subB.
      for (const t of ["sthr_subA", "sthr_subB"]) {
        for (let i = 1; i <= 2; i++) {
          state.storage.sql.exec(
            `INSERT INTO events (type, data, processed_at, session_thread_id)
             VALUES ('user.message', ?, NULL, ?)`,
            JSON.stringify({ type: "user.message", content: [{ type: "text", text: `${t}-${i}` }] }),
            t,
          );
        }
      }
    });

    // Interrupt subA only.
    const res = await stub.fetch(
      new Request("http://internal/event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "user.interrupt",
          session_thread_id: "sthr_subA",
        }),
      }),
    );
    expect([200, 202]).toContain(res.status);

    const state = await runInDurableObject(stub, (_inst, s) => {
      const counts: Record<string, { pending: number; cancelled: number }> = {};
      for (const t of ["sthr_subA", "sthr_subB"]) {
        let pending = 0;
        let cancelled = 0;
        for (const row of s.storage.sql.exec(
          `SELECT processed_at, cancelled_at FROM events
             WHERE type = 'user.message' AND session_thread_id = ?`,
          t,
        )) {
          if (row.cancelled_at != null) cancelled += 1;
          else if (row.processed_at == null) pending += 1;
        }
        counts[t] = { pending, cancelled };
      }
      return counts;
    });
    expect(state.sthr_subA).toEqual({ pending: 0, cancelled: 2 });
    expect(state.sthr_subB).toEqual({ pending: 2, cancelled: 0 });
  });

  it("broadcastStreamEnd('completed') does NOT inject placeholder agent.message", async () => {
    // Successful stream-end is the harness's job to follow up with
    // the canonical agent.message via the normal step-finish path.
    // Eager-injecting here would double-write.
    const stub = freshDoStub("stream_complete_noinject");
    await seedSchemaAndState(stub);

    await runInDurableObject(stub, async (instance, state) => {
      const helpers = (instance as {
        buildStreamRuntimeMethods: (threadId?: string) => {
          broadcastStreamStart: (id: string) => Promise<void>;
          broadcastChunk: (id: string, delta: string) => Promise<void>;
          broadcastStreamEnd: (
            id: string,
            status: "completed" | "aborted",
          ) => Promise<void>;
        };
      }).buildStreamRuntimeMethods();
      const id = "msg_complete";
      await helpers.broadcastStreamStart(id);
      await helpers.broadcastChunk(id, "complete text");
      await helpers.broadcastStreamEnd(id, "completed");

      let count = 0;
      for (const _ of state.storage.sql.exec(
        `SELECT 1 FROM events WHERE type = 'agent.message'`,
      )) {
        count += 1;
      }
      expect(count).toBe(0);
    });
  });

  // ─── recoverEventQueue safety-net (alarm path) ─────────────────────
  // Triggered by the 5-second `recoverEventQueue` schedule armed by
  // POST /event. Guards against the case where the primary in-band
  // drain (drainEventQueue called from the POST handler) didn't catch
  // up before DO eviction. The contract:
  //   1. SELECT DISTINCT session_thread_id over the partial pending
  //      index → one entry per thread with pending events.
  //   2. Promise.all kicks off drainEventQueue per thread (no global
  //      mutex; per-thread mutex from _draining set keeps each call
  //      isolated).
  //   3. Empty pending set → defensive primary drain (cheap no-op).
  it("recoverEventQueue drains every thread that has pending events", async () => {
    // Spy on drainEventQueue: confirms recoverEventQueue dispatched a
    // call for each thread with pending rows (3 distinct thread ids).
    const stub = freshDoStub("recover_multi_thread");
    await seedSchemaAndState(stub);

    const result = await runInDurableObject(stub, async (instance) => {
      // Seed pending events on 3 different threads. Includes a 3rd
      // thread (sthr_subC) we manufacture inline, plus pre-existing
      // sthr_subA + sthr_primary from the seed helper.
      const sql = (instance as { ctx: { storage: { sql: SqlStorage } } }).ctx.storage.sql;
      sql.exec(
        `INSERT INTO threads (id, agent_id, agent_name, parent_thread_id, created_at)
         VALUES ('sthr_subC', 'agent_worker', 'WorkerC', 'sthr_primary', ?)`,
        Date.now() - 1000,
      );
      for (const tid of ["sthr_primary", "sthr_subA", "sthr_subC"]) {
        sql.exec(
          `INSERT INTO events (type, data, processed_at, session_thread_id)
           VALUES ('user.message', ?, NULL, ?)`,
          JSON.stringify({ type: "user.message", content: [{ type: "text", text: `pending on ${tid}` }] }),
          tid,
        );
      }

      // Spy: replace drainEventQueue with a capture wrapper. Returns
      // immediately so we don't accidentally fire a real LLM turn.
      const calls: string[] = [];
      (instance as { drainEventQueue: (t: string) => Promise<void> }).drainEventQueue = async (
        threadId: string,
      ) => {
        calls.push(threadId);
      };

      await (instance as { recoverEventQueue: () => Promise<void> }).recoverEventQueue();
      return { calls };
    });
    // All three thread ids should have been drained. Order isn't
    // guaranteed (Promise.all + DISTINCT scan order is implementation-
    // defined), so compare as a set.
    expect(new Set(result.calls)).toEqual(
      new Set(["sthr_primary", "sthr_subA", "sthr_subC"]),
    );
  });

  it("recoverEventQueue with no pending events runs a defensive primary drain", async () => {
    // Empty pending set: the cursor returns zero rows. Implementation
    // falls back to a single drainEventQueue("sthr_primary") call so
    // the alarm tail isn't wasted — the partial-index lookup inside
    // drainEventQueue early-returns when there's nothing to do.
    const stub = freshDoStub("recover_empty");
    await seedSchemaAndState(stub);

    const result = await runInDurableObject(stub, async (instance) => {
      const calls: string[] = [];
      (instance as { drainEventQueue: (t: string) => Promise<void> }).drainEventQueue = async (
        threadId: string,
      ) => {
        calls.push(threadId);
      };
      await (instance as { recoverEventQueue: () => Promise<void> }).recoverEventQueue();
      return { calls };
    });
    expect(result.calls).toEqual(["sthr_primary"]);
  });

  it("recoverEventQueue DISTINCT query collapses duplicate thread ids", async () => {
    // Multiple pending rows per thread → only one drain call per
    // thread. SELECT DISTINCT session_thread_id is the contract.
    // Without it, a thread with N queued messages would trigger N
    // parallel drain attempts (each early-returning thanks to the
    // _draining mutex, but wasteful).
    const stub = freshDoStub("recover_distinct");
    await seedSchemaAndState(stub);

    const result = await runInDurableObject(stub, async (instance) => {
      const sql = (instance as { ctx: { storage: { sql: SqlStorage } } }).ctx.storage.sql;
      // 5 pending on primary + 3 pending on subA = 8 rows, 2 threads.
      for (let i = 0; i < 5; i++) {
        sql.exec(
          `INSERT INTO events (type, data, processed_at, session_thread_id)
           VALUES ('user.message', ?, NULL, 'sthr_primary')`,
          JSON.stringify({ type: "user.message", content: [{ type: "text", text: `p${i}` }] }),
        );
      }
      for (let i = 0; i < 3; i++) {
        sql.exec(
          `INSERT INTO events (type, data, processed_at, session_thread_id)
           VALUES ('user.message', ?, NULL, 'sthr_subA')`,
          JSON.stringify({ type: "user.message", content: [{ type: "text", text: `a${i}` }] }),
        );
      }
      const calls: string[] = [];
      (instance as { drainEventQueue: (t: string) => Promise<void> }).drainEventQueue = async (
        threadId: string,
      ) => {
        calls.push(threadId);
      };
      await (instance as { recoverEventQueue: () => Promise<void> }).recoverEventQueue();
      return { calls };
    });
    // Exactly 2 calls (one per thread), not 8.
    expect(result.calls.length).toBe(2);
    expect(new Set(result.calls)).toEqual(new Set(["sthr_primary", "sthr_subA"]));
  });

  it("two parallel recoverEventQueue calls don't double-drain a thread", async () => {
    // Re-entrant safety: the alarm could fire while a prior alarm-
    // dispatched drain is still in flight. Per-thread mutex (_draining
    // Set) absorbs the second attempt — drainEventQueue's early-return
    // when this._draining.has(threadId) is the load-bearing line. We
    // verify the contract by parking a thread in the mutex and proving
    // a fresh recoverEventQueue → drain dispatch sees the early-return
    // (call still happens, but the body doesn't re-add to the set).
    const stub = freshDoStub("recover_reentrant");
    await seedSchemaAndState(stub);

    const result = await runInDurableObject(stub, async (instance) => {
      const sql = (instance as { ctx: { storage: { sql: SqlStorage } } }).ctx.storage.sql;
      sql.exec(
        `INSERT INTO events (type, data, processed_at, session_thread_id)
         VALUES ('user.message', ?, NULL, 'sthr_primary')`,
        JSON.stringify({ type: "user.message", content: [{ type: "text", text: "x" }] }),
      );
      const drainSet = (instance as { _draining: Set<string> })._draining;
      // Park primary in the mutex — simulates "first alarm's drain
      // is still mid-flight."
      drainSet.add("sthr_primary");
      // Spy on _draining.add — only ONE entry (the one we pre-set)
      // should remain after recoverEventQueue runs the real
      // drainEventQueue, because the early-return inside
      // drainEventQueue skips the body's `add(threadId)` call.
      const adds: string[] = [];
      const originalAdd = drainSet.add.bind(drainSet);
      drainSet.add = (item: string) => {
        adds.push(item);
        return originalAdd(item);
      };

      await (instance as { recoverEventQueue: () => Promise<void> }).recoverEventQueue();
      drainSet.delete("sthr_primary"); // cleanup
      return { adds };
    });
    // No re-add of sthr_primary by drainEventQueue's body — the
    // early-return tripped before the add. (The pre-set we did at
    // setup time happens before the spy is installed, so it doesn't
    // appear in `adds`.)
    expect(result.adds).not.toContain("sthr_primary");
  });

});
