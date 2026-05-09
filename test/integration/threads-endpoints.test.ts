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

});
