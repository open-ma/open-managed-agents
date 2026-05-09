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
});
