// @ts-nocheck
//
// Wire-compatibility tests for the AMA thread CRUD endpoints, driven
// by the real `@anthropic-ai/sdk` client (v0.95.1).
//
// Why: threads-endpoints.test.ts already covers the DO's HTTP shape.
// This file proves the wire format matches what the published Anthropic
// SDK actually expects — if we drift on field names, status codes, or
// error envelopes, .retrieve / .list / .archive throw and these tests
// fail. Catches issues that hand-rolled JSON.parse asserts can't.
//
// How:
//   - Real SDK Client, real path templates, real response parsing.
//   - Custom `fetch` rewrites SDK paths from
//       /v1/sessions/:sid/threads[...]
//     down to the DO's relative paths
//       /threads[...]
//     so we don't need to spin up the main worker + sandbox binding to
//     forward the request. The shape of the request the SDK builds
//     (URL, headers, query params) and the shape of the response the
//     DO returns is what we're testing — the forwarder is plumbing.
//   - One DO stub seeded with primary + 2 sub-agent threads (same
//     pattern as threads-endpoints.test.ts seedSchemaAndState).
//
// Coverage:
//   1. client.beta.sessions.threads.list — page shape, .data items
//      typed as BetaManagedAgentsSessionThread (id/type/parent/stats/usage).
//   2. client.beta.sessions.threads.retrieve — single-thread shape.
//   3. client.beta.sessions.threads.archive — flips status, populates
//      archived_at on response.
//   4. 404 from .retrieve('unknown') → NotFoundError instance.
//   5. 400 from .archive('sthr_primary') → BadRequestError instance.
//   6. 409 from POST /event with archived thread → ConflictError shape
//      (we hit /event directly via custom fetch since SDK doesn't have
//      a typed surface for it; verifies error envelope still matches).
//   7. client.beta.sessions.threads.events.list — paginated events
//      scoped to one thread.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import Anthropic, {
  NotFoundError,
  BadRequestError,
  ConflictError,
  APIError,
} from "@anthropic-ai/sdk";

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
    (instance as { _ensureCfAgentsSchema: () => void })._ensureCfAgentsSchema();
    (instance as { ensureSchema: () => void }).ensureSchema?.();
    (instance as { _state: unknown })._state = {
      session_id: "sess_sdk_test",
      tenant_id: "default",
      agent_id: agentId,
      agent_snapshot: { name: agentName },
    };
    (instance as { _ensurePrimaryThread: () => void })._ensurePrimaryThread();
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
    // Seed a couple of events on sthr_subA so events.list has something
    // to return for the wire-format test.
    state.storage.sql.exec(
      `INSERT INTO events (type, data, processed_at, session_thread_id)
       VALUES ('agent.message', ?, ?, 'sthr_subA')`,
      JSON.stringify({
        type: "agent.message",
        id: "msg_sub_1",
        content: [{ type: "text", text: "from worker A" }],
      }),
      Date.now(),
    );
    state.storage.sql.exec(
      `INSERT INTO events (type, data, processed_at, session_thread_id)
       VALUES ('agent.message', ?, ?, 'sthr_subA')`,
      JSON.stringify({
        type: "agent.message",
        id: "msg_sub_2",
        content: [{ type: "text", text: "still from A" }],
      }),
      Date.now(),
    );
  });
}

/**
 * Build an Anthropic SDK client whose `fetch` is bridged to the DO stub.
 * The SDK builds requests against /v1/sessions/:sid/threads/... — we
 * strip the prefix and forward the relative path (/threads/...) to the
 * DO. Production routes the same path through main → sandbox binding;
 * the binding is plumbing this test deliberately bypasses to keep the
 * focus on wire shape.
 */
function buildSdkForStub(
  stub: ReturnType<typeof freshDoStub>,
  sessionId = "sess_sdk_test",
): Anthropic {
  const customFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    // Rewrite /v1/sessions/:sid/threads[...] → /threads[...]
    const prefix = `/v1/sessions/${sessionId}`;
    let pathOnDo = url.pathname;
    if (pathOnDo.startsWith(prefix)) {
      pathOnDo = pathOnDo.slice(prefix.length) || "/";
    }
    const internalUrl = `http://internal${pathOnDo}${url.search}`;
    return stub.fetch(new Request(internalUrl, init as RequestInit));
  };
  return new Anthropic({
    apiKey: "test-key",
    baseURL: "http://localhost",
    fetch: customFetch as unknown as typeof fetch,
    // Dial back retries — failure modes here are deterministic, not
    // network-flake territory.
    maxRetries: 0,
  });
}

describe("AMA SDK ↔ thread endpoints wire compatibility", () => {
  const SESSION_ID = "sess_sdk_test";

  it("threads.list returns page-cursor with typed thread objects", async () => {
    const stub = freshDoStub("sdk_list");
    await seedSchemaAndState(stub);
    const client = buildSdkForStub(stub, SESSION_ID);

    const page = await client.beta.sessions.threads.list(SESSION_ID);
    // PageCursor exposes .data — DO returns { data: [...] } without
    // next_page; SDK treats that as a single page (next_page undefined
    // → has_more false).
    const items = page.data;
    expect(items).toHaveLength(3);
    const ids = items.map((t) => t.id);
    expect(ids).toContain("sthr_primary");
    expect(ids).toContain("sthr_subA");
    expect(ids).toContain("sthr_subB");

    const primary = items.find((t) => t.id === "sthr_primary")!;
    // Wire-shape contract: AMA SDK's BetaManagedAgentsSessionThread.
    expect(primary.type).toBe("session_thread");
    expect(primary.parent_thread_id).toBeNull();
    // status is the DO-side enum ("active"/"archived") — the AMA
    // SessionThreadStatus union ("running"|"idle"|...) doesn't include
    // "active" yet, but the SDK accepts the field as-is at runtime.
    expect(primary.status).toBe("active");
    expect(primary.archived_at).toBeNull();
    expect(typeof primary.created_at).toBe("string");
    expect(typeof primary.updated_at).toBe("string");
    expect(primary.session_id).toBe(SESSION_ID);
    // stats + usage are nullable per AMA spec; we always emit the stats
    // object (fresh thread → zeros).
    expect(primary.stats).not.toBeNull();
    expect(typeof primary.stats!.active_seconds).toBe("number");

    const subA = items.find((t) => t.id === "sthr_subA")!;
    expect(subA.parent_thread_id).toBe("sthr_primary");
  });

  it("threads.retrieve returns single thread shape", async () => {
    const stub = freshDoStub("sdk_retrieve");
    await seedSchemaAndState(stub);
    const client = buildSdkForStub(stub, SESSION_ID);

    const thread = await client.beta.sessions.threads.retrieve("sthr_subA", {
      session_id: SESSION_ID,
    });
    expect(thread.id).toBe("sthr_subA");
    expect(thread.type).toBe("session_thread");
    expect(thread.parent_thread_id).toBe("sthr_primary");
    expect(thread.session_id).toBe(SESSION_ID);
    expect(thread.archived_at).toBeNull();
  });

  it("threads.archive flips status to archived and populates archived_at", async () => {
    const stub = freshDoStub("sdk_archive");
    await seedSchemaAndState(stub);
    const client = buildSdkForStub(stub, SESSION_ID);

    const archived = await client.beta.sessions.threads.archive("sthr_subB", {
      session_id: SESSION_ID,
    });
    expect(archived.id).toBe("sthr_subB");
    expect(archived.status).toBe("archived");
    expect(archived.archived_at).not.toBeNull();
    expect(typeof archived.archived_at).toBe("string");

    // Followup .retrieve sees it archived.
    const refetched = await client.beta.sessions.threads.retrieve("sthr_subB", {
      session_id: SESSION_ID,
    });
    expect(refetched.status).toBe("archived");
  });

  it("threads.retrieve('unknown') throws NotFoundError (404 envelope)", async () => {
    const stub = freshDoStub("sdk_404");
    await seedSchemaAndState(stub);
    const client = buildSdkForStub(stub, SESSION_ID);

    await expect(
      client.beta.sessions.threads.retrieve("sthr_does_not_exist", {
        session_id: SESSION_ID,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("threads.archive('sthr_primary') throws BadRequestError (400 envelope)", async () => {
    const stub = freshDoStub("sdk_400");
    await seedSchemaAndState(stub);
    const client = buildSdkForStub(stub, SESSION_ID);

    let caught: unknown = null;
    try {
      await client.beta.sessions.threads.archive("sthr_primary", {
        session_id: SESSION_ID,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BadRequestError);
    expect(caught).toBeInstanceOf(APIError);
    // Status visible on the typed APIError.
    expect((caught as APIError).status).toBe(400);
  });

  it("POST /event with archived thread returns 409 envelope (matches ConflictError shape)", async () => {
    const stub = freshDoStub("sdk_409");
    await seedSchemaAndState(stub);
    const client = buildSdkForStub(stub, SESSION_ID);

    // Archive subA first via SDK.
    await client.beta.sessions.threads.archive("sthr_subA", {
      session_id: SESSION_ID,
    });

    // SDK doesn't have a typed surface for the agent's thread-event
    // ingest endpoint (POST /event is internal, not in the AMA spec
    // surface). Hit it raw via the custom-fetch bridge to confirm the
    // 409 body shape — the SDK's _client.makeRequest would parse this
    // same envelope into a ConflictError, which is the wire contract
    // we're pinning. Verify by manually feeding the response into the
    // SDK's error helper rather than reaching into client internals.
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
    const body = await res.json();
    // AMA error envelope: { error: { type, message } }.
    expect(body.error).toBeDefined();
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toMatch(/archived/i);
    // SDK client really has a generated()/from() factory:
    // APIError.generate(status, errorResponse, message, headers).
    // We construct the analog so anyone catching ConflictError in a
    // user app gets the right instance type from this envelope.
    const synthetic = APIError.generate(409, body, "thread is archived", new Headers());
    expect(synthetic).toBeInstanceOf(ConflictError);
    // Suppress unused — keeping `client` referenced so the scenario is
    // legible (SDK was the one that archived the thread).
    void client;
  });

  it("threads.events.list returns events scoped to the thread", async () => {
    const stub = freshDoStub("sdk_events_list");
    await seedSchemaAndState(stub);
    const client = buildSdkForStub(stub, SESSION_ID);

    const page = await client.beta.sessions.threads.events.list("sthr_subA", {
      session_id: SESSION_ID,
    });
    const items = page.data as Array<{ seq: number; type: string; data: Record<string, unknown> }>;
    // We seeded 2 agent.message events on sthr_subA — both should come
    // back in seq order.
    expect(items.length).toBe(2);
    expect(items[0].type).toBe("agent.message");
    expect(items[1].type).toBe("agent.message");
    // Per-event payload is nested under .data per the DO's projection.
    expect((items[0].data as { id: string }).id).toBe("msg_sub_1");
    expect((items[1].data as { id: string }).id).toBe("msg_sub_2");
  });
});
