// @ts-nocheck
//
// Integration tests for the multi-tenant CLI bridge daemon — step 2.
//
// Covers:
//   1. authenticateRuntimeToken returns `authorized_tenants` Set populated
//      from runtime_tenants (regression on step 1).
//   2. POST /agents/runtime/:id/refresh:
//        - add path: user gains tenant membership → /refresh returns it in
//          `added` + an `agent_api_key` plaintext for the new row.
//        - revoke path: membership removed → row's revoked_at flipped, KV
//          cleaned up, response says `revoked`.
//        - no-op (stable membership): all live tenants returned with fresh
//          rotated keys (always-rotate policy documented in route comment),
//          neither `added` nor `revoked` populated.
//        - cross-runtime guard: token bound to runtime A → /refresh on B 404s.
//   3. RuntimeRoom tenant_id validation (additive, non-enforcing):
//        - daemon-side inbound: tenant_id in authorized set + matching
//          session pin → forwarded; not-in-set → dropped silently.
//        - v1 daemon (absent tenant_id) → message flows unchanged.
//        - harness-side outbound: x-harness-tenant header → forwarded
//          tenant_id injected on session.start/.prompt.
//   4. GET /agents/runtime/me — daemon-facing alternative to the absent
//      /v1/oma/runtimes/:id, used by daemon-side v1→v2 migration.

import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";

function api(path: string, init?: RequestInit) {
  return exports.default.fetch(new Request(`http://localhost${path}`, init));
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// One-shot per-test setup: clean + seed AUTH_DB rows for a fresh runtime
// with the given memberships, mint a runtime_token, return the bearer.
async function seedRuntime(opts: {
  runtimeId: string;
  userId: string;
  ownerTenantId: string;
  memberships: Array<{ tenant_id: string; role: string; name?: string }>;
}): Promise<{ tokenPlain: string }> {
  const { runtimeId, userId, ownerTenantId, memberships } = opts;
  const now = Math.floor(Date.now() / 1000);

  // Ensure tenants exist (FK-less — schema just needs the rows for the
  // /me + /refresh join with tenant.name).
  for (const m of memberships) {
    await env.AUTH_DB
      .prepare(
        `INSERT OR IGNORE INTO "tenant" (id, name, createdAt, updatedAt) VALUES (?, ?, ?, ?)`,
      )
      .bind(m.tenant_id, m.name ?? m.tenant_id, now * 1000, now * 1000)
      .run();
  }

  // user row — better-auth schema. Tenant pinned to the owner tenant.
  await env.AUTH_DB
    .prepare(
      `INSERT OR REPLACE INTO "user" (id, name, email, emailVerified, tenantId, role, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(userId, "Test User", `${userId}@test.local`, 1, ownerTenantId, "owner", now * 1000, now * 1000)
    .run();

  // memberships rows
  for (const m of memberships) {
    await env.AUTH_DB
      .prepare(
        `INSERT OR REPLACE INTO "membership" (user_id, tenant_id, role, created_at) VALUES (?, ?, ?, ?)`,
      )
      .bind(userId, m.tenant_id, m.role, now)
      .run();
  }

  // runtimes row
  await env.AUTH_DB
    .prepare(
      `INSERT OR REPLACE INTO "runtimes"
        (id, owner_user_id, owner_tenant_id, machine_id, hostname, os, agents_json, version, status, last_heartbeat, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '[]', ?, 'offline', NULL, ?)`,
    )
    .bind(runtimeId, userId, ownerTenantId, `machine-${runtimeId}`, "test-host", "darwin", "0.0.1-test", now)
    .run();

  // backfill runtime_tenants like migration 0018 would
  for (const m of memberships) {
    await env.AUTH_DB
      .prepare(
        `INSERT OR IGNORE INTO "runtime_tenants" (runtime_id, tenant_id, agent_api_key_id, created_at) VALUES (?, ?, ?, ?)`,
      )
      .bind(runtimeId, m.tenant_id, "__legacy__", now)
      .run();
  }

  // runtime_token
  const tokenPlain = `sk_machine_${runtimeId}_token_${Math.random().toString(36).slice(2)}`;
  const tokenHash = await sha256Hex(tokenPlain);
  await env.AUTH_DB
    .prepare(
      `INSERT INTO "runtime_tokens" (id, runtime_id, token_hash, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(`tok_${runtimeId}_${Math.random().toString(36).slice(2)}`, runtimeId, tokenHash, userId, now)
    .run();

  return { tokenPlain };
}

describe("/agents/runtime/* — multi-tenant CLI bridge daemon (step 2)", () => {
  // ensureMigrations runs lazily on first fetch() into the worker — touch a
  // public endpoint so the AUTH_DB schema is in place before our seedRuntime
  // helper starts INSERTing into tables migrations create.
  beforeAll(async () => {
    await api("/health").catch(() => {});
  });

  describe("authenticateRuntimeToken (regression: still returns authorized_tenants)", () => {
    it("hits /me which depends on the function — exercises the join", async () => {
      const rid = `rt_auth_${Math.random().toString(36).slice(2, 8)}`;
      const uid = `u_${rid}`;
      const { tokenPlain } = await seedRuntime({
        runtimeId: rid,
        userId: uid,
        ownerTenantId: "tn_a",
        memberships: [
          { tenant_id: "tn_a", role: "owner", name: "Workspace A" },
          { tenant_id: "tn_b", role: "member", name: "Workspace B" },
        ],
      });
      const res = await api("/agents/runtime/me", {
        headers: { authorization: `Bearer ${tokenPlain}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      const ids = body.tenants.map((t: { id: string }) => t.id).sort();
      expect(ids).toEqual(["tn_a", "tn_b"]);
      // Tenant names join in
      const a = body.tenants.find((t: { id: string }) => t.id === "tn_a");
      expect(a.name).toBe("Workspace A");
      expect(a.role).toBe("owner");
    });

    it("/me rejects bogus token", async () => {
      const res = await api("/agents/runtime/me", {
        headers: { authorization: "Bearer sk_machine_garbage" },
      });
      expect(res.status).toBe(401);
    });
  });

  describe("POST /:id/refresh", () => {
    it("add path: new membership becomes a fresh runtime_tenants row with plaintext key", async () => {
      const rid = `rt_add_${Math.random().toString(36).slice(2, 8)}`;
      const uid = `u_${rid}`;
      const { tokenPlain } = await seedRuntime({
        runtimeId: rid,
        userId: uid,
        ownerTenantId: "tn_add_a",
        memberships: [{ tenant_id: "tn_add_a", role: "owner" }],
      });

      // Add second membership directly to DB (simulating user joining tenant B
      // via the console).
      await env.AUTH_DB
        .prepare(
          `INSERT INTO "tenant" (id, name, createdAt, updatedAt) VALUES (?, ?, ?, ?)`,
        )
        .bind("tn_add_b", "Workspace B", Date.now(), Date.now())
        .run();
      await env.AUTH_DB
        .prepare(
          `INSERT INTO "membership" (user_id, tenant_id, role, created_at) VALUES (?, ?, ?, ?)`,
        )
        .bind(uid, "tn_add_b", "member", Math.floor(Date.now() / 1000))
        .run();

      const res = await api(`/agents/runtime/${rid}/refresh`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenPlain}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.added).toEqual(["tn_add_b"]);
      expect(body.revoked).toEqual([]);
      const newRow = body.tenants.find((t: { id: string }) => t.id === "tn_add_b");
      expect(newRow).toBeTruthy();
      expect(typeof newRow.agent_api_key).toBe("string");
      expect(newRow.agent_api_key.startsWith("oma_")).toBe(true);

      // KV row + index updated
      const hash = await sha256Hex(newRow.agent_api_key);
      const kvRow = await env.CONFIG_KV.get(`apikey:${hash}`);
      expect(kvRow).toBeTruthy();
      const parsed = JSON.parse(kvRow!);
      expect(parsed.tenant_id).toBe("tn_add_b");
    });

    it("revoke path: removed membership flips revoked_at + deletes KV row", async () => {
      const rid = `rt_rev_${Math.random().toString(36).slice(2, 8)}`;
      const uid = `u_${rid}`;
      const { tokenPlain } = await seedRuntime({
        runtimeId: rid,
        userId: uid,
        ownerTenantId: "tn_rev_a",
        memberships: [
          { tenant_id: "tn_rev_a", role: "owner" },
          { tenant_id: "tn_rev_b", role: "member" },
        ],
      });

      // First refresh promotes the __legacy__ rows to real ids w/ KV entries.
      const r1 = await api(`/agents/runtime/${rid}/refresh`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenPlain}` },
      });
      const body1 = await r1.json();
      const revBKey = body1.tenants.find((t: { id: string }) => t.id === "tn_rev_b").agent_api_key;
      const revBHash = await sha256Hex(revBKey);
      expect(await env.CONFIG_KV.get(`apikey:${revBHash}`)).toBeTruthy();

      // Now remove the tn_rev_b membership.
      await env.AUTH_DB
        .prepare(`DELETE FROM "membership" WHERE user_id = ? AND tenant_id = ?`)
        .bind(uid, "tn_rev_b")
        .run();

      const r2 = await api(`/agents/runtime/${rid}/refresh`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenPlain}` },
      });
      expect(r2.status).toBe(200);
      const body2 = await r2.json();
      expect(body2.revoked).toEqual(["tn_rev_b"]);
      expect(body2.tenants.map((t: { id: string }) => t.id)).toEqual(["tn_rev_a"]);

      // runtime_tenants row soft-deleted
      const row = await env.AUTH_DB
        .prepare(
          `SELECT revoked_at FROM "runtime_tenants" WHERE runtime_id = ? AND tenant_id = ?`,
        )
        .bind(rid, "tn_rev_b")
        .first<{ revoked_at: number | null }>();
      expect(row!.revoked_at).not.toBeNull();

      // KV row gone
      expect(await env.CONFIG_KV.get(`apikey:${revBHash}`)).toBeNull();
    });

    it("no-op: stable membership returns rotated keys for every live tenant", async () => {
      const rid = `rt_noop_${Math.random().toString(36).slice(2, 8)}`;
      const uid = `u_${rid}`;
      const { tokenPlain } = await seedRuntime({
        runtimeId: rid,
        userId: uid,
        ownerTenantId: "tn_noop_a",
        memberships: [{ tenant_id: "tn_noop_a", role: "owner" }],
      });
      const r1 = await api(`/agents/runtime/${rid}/refresh`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenPlain}` },
      });
      const body1 = await r1.json();
      expect(body1.added).toEqual([]);
      expect(body1.revoked).toEqual([]);
      const firstKey = body1.tenants[0].agent_api_key;

      const r2 = await api(`/agents/runtime/${rid}/refresh`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenPlain}` },
      });
      const body2 = await r2.json();
      expect(body2.added).toEqual([]);
      expect(body2.revoked).toEqual([]);
      // Always-rotate policy: second call mints a fresh key (different
      // plaintext, old hash gone).
      expect(body2.tenants[0].agent_api_key).not.toBe(firstKey);
      const firstHash = await sha256Hex(firstKey);
      expect(await env.CONFIG_KV.get(`apikey:${firstHash}`)).toBeNull();
    });

    it("cross-runtime guard: token of runtime A → /refresh on B → 404", async () => {
      const ridA = `rt_xa_${Math.random().toString(36).slice(2, 8)}`;
      const ridB = `rt_xb_${Math.random().toString(36).slice(2, 8)}`;
      const uid = `u_${ridA}_${ridB}`;
      const { tokenPlain: tokA } = await seedRuntime({
        runtimeId: ridA,
        userId: uid,
        ownerTenantId: "tn_xa",
        memberships: [{ tenant_id: "tn_xa", role: "owner" }],
      });
      await seedRuntime({
        runtimeId: ridB,
        userId: uid,
        ownerTenantId: "tn_xa",
        memberships: [{ tenant_id: "tn_xa", role: "owner" }],
      });
      const res = await api(`/agents/runtime/${ridB}/refresh`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokA}` },
      });
      expect(res.status).toBe(404);
    });
  });

  describe("RuntimeRoom — accept + validate tenant_id (additive, non-enforcing)", () => {
    // Drives the DO directly via runInDurableObject so we can poke at private
    // state. We don't open real WS attaches here — DO message handling has
    // enough surface area to test through public hooks (sendToDaemon and
    // refreshAuthorizedTenants RPCs).

    async function freshRoom(memberships: string[]) {
      const rid = `rt_ws_${Math.random().toString(36).slice(2, 8)}`;
      const uid = `u_${rid}`;
      await seedRuntime({
        runtimeId: rid,
        userId: uid,
        ownerTenantId: memberships[0] ?? "tn_default",
        memberships: memberships.map((t) => ({ tenant_id: t, role: "owner" })),
      });
      const stub = env.RUNTIME_ROOM.get(env.RUNTIME_ROOM.idFromName(rid));
      // Seed runtimeId + userId on the DO (normally set by attachDaemon) so
      // ensureAuthorizedTenants knows what to look up. Also prime the
      // authorized-tenants cache for predictable behavior.
      await runInDurableObject(stub, async (instance, _state) => {
        (instance as { runtimeId: string }).runtimeId = rid;
        (instance as { userId: string }).userId = uid;
        await _state.storage.put("runtime_id", rid);
        await _state.storage.put("user_id", uid);
        await (instance as { refreshAuthorizedTenants(): Promise<void> }).refreshAuthorizedTenants();
      });
      return { stub, runtimeId: rid, userId: uid };
    }

    it("evicts a daemon socket whose server-observed heartbeat lease expired", async () => {
      const { stub, runtimeId, userId } = await freshRoom(["tn_ws_stale"]);
      await env.AUTH_DB
        .prepare(`UPDATE "runtimes" SET last_heartbeat = ? WHERE id = ?`)
        .bind(Math.floor(Date.now() / 1000) - 300, runtimeId)
        .run();

      let staleSocketClosed = false;
      await runInDurableObject(stub, async (instance) => {
        const room = instance as unknown as {
          ctx: { getWebSockets(tag?: string): WebSocket[] };
          attachDaemon(request: Request): Promise<Response>;
        };
        const originalGetWebSockets = room.ctx.getWebSockets.bind(room.ctx);
        const staleSocket = {
          send() {},
          close() { staleSocketClosed = true; },
        } as unknown as WebSocket;
        room.ctx.getWebSockets = (tag?: string) =>
          tag === "daemon" ? [staleSocket] : originalGetWebSockets(tag);

        const response = await room.attachDaemon(
          new Request("http://runtime-room/_attach_daemon", {
            headers: {
              Upgrade: "websocket",
              "x-runtime-id": runtimeId,
              "x-runtime-user": userId,
            },
          }),
        );

        expect(response.status).toBe(101);
      });
      expect(staleSocketClosed).toBe(true);
    });

    it("keeps the current daemon while its server-observed lease is fresh", async () => {
      const { stub, runtimeId, userId } = await freshRoom(["tn_ws_fresh"]);
      await env.AUTH_DB
        .prepare(`UPDATE "runtimes" SET status = 'online', last_heartbeat = ? WHERE id = ?`)
        .bind(Math.floor(Date.now() / 1000), runtimeId)
        .run();

      let currentSocketClosed = false;
      await runInDurableObject(stub, async (instance) => {
        const room = instance as unknown as {
          ctx: { getWebSockets(tag?: string): WebSocket[] };
          attachDaemon(request: Request): Promise<Response>;
        };
        const originalGetWebSockets = room.ctx.getWebSockets.bind(room.ctx);
        const currentSocket = {
          send() {},
          close() { currentSocketClosed = true; },
        } as unknown as WebSocket;
        room.ctx.getWebSockets = (tag?: string) =>
          tag === "daemon" ? [currentSocket] : originalGetWebSockets(tag);

        const response = await room.attachDaemon(
          new Request("http://runtime-room/_attach_daemon", {
            headers: {
              Upgrade: "websocket",
              "x-runtime-id": runtimeId,
              "x-runtime-user": userId,
            },
          }),
        );

        expect(response.status).toBe(409);
      });
      expect(currentSocketClosed).toBe(false);
    });

    it("evicts a daemon already marked offline even when its last heartbeat is recent", async () => {
      const { stub, runtimeId, userId } = await freshRoom(["tn_ws_offline"]);
      await env.AUTH_DB
        .prepare(`UPDATE "runtimes" SET status = 'offline', last_heartbeat = ? WHERE id = ?`)
        .bind(Math.floor(Date.now() / 1000), runtimeId)
        .run();

      let offlineSocketClosed = false;
      await runInDurableObject(stub, async (instance) => {
        const room = instance as unknown as {
          ctx: { getWebSockets(tag?: string): WebSocket[] };
          attachDaemon(request: Request): Promise<Response>;
        };
        const originalGetWebSockets = room.ctx.getWebSockets.bind(room.ctx);
        const offlineSocket = {
          send() {},
          close() { offlineSocketClosed = true; },
        } as unknown as WebSocket;
        room.ctx.getWebSockets = (tag?: string) =>
          tag === "daemon" ? [offlineSocket] : originalGetWebSockets(tag);

        const response = await room.attachDaemon(
          new Request("http://runtime-room/_attach_daemon", {
            headers: {
              Upgrade: "websocket",
              "x-runtime-id": runtimeId,
              "x-runtime-user": userId,
            },
          }),
        );

        expect(response.status).toBe(101);
      });
      expect(offlineSocketClosed).toBe(true);
    });

    it("does not let an evicted daemon close mark its replacement offline", async () => {
      const { stub, runtimeId, userId } = await freshRoom(["tn_ws_fenced"]);
      await env.AUTH_DB
        .prepare(`UPDATE "runtimes" SET last_heartbeat = ? WHERE id = ?`)
        .bind(Math.floor(Date.now() / 1000) - 300, runtimeId)
        .run();

      await runInDurableObject(stub, async (instance) => {
        const room = instance as unknown as {
          ctx: {
            getTags(socket: WebSocket): string[];
            getWebSockets(tag?: string): WebSocket[];
          };
          attachDaemon(request: Request): Promise<Response>;
          webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void>;
        };
        const originalGetTags = room.ctx.getTags.bind(room.ctx);
        const originalGetWebSockets = room.ctx.getWebSockets.bind(room.ctx);
        const staleSocket = {
          send() {},
          close() {},
        } as unknown as WebSocket;
        room.ctx.getWebSockets = (tag?: string) =>
          tag === "daemon" ? [staleSocket] : originalGetWebSockets(tag);
        room.ctx.getTags = (socket: WebSocket) =>
          socket === staleSocket ? ["daemon"] : originalGetTags(socket);

        const response = await room.attachDaemon(
          new Request("http://runtime-room/_attach_daemon", {
            headers: {
              Upgrade: "websocket",
              "x-runtime-id": runtimeId,
              "x-runtime-user": userId,
            },
          }),
        );
        expect(response.status).toBe(101);

        await room.webSocketClose(staleSocket, 1012, "lease expired");
      });

      const row = await env.AUTH_DB
        .prepare(`SELECT status FROM "runtimes" WHERE id = ?`)
        .bind(runtimeId)
        .first<{ status: string }>();
      expect(row?.status).toBe("online");
    });

    it("drops messages from a daemon that no longer owns the room", async () => {
      const { stub } = await freshRoom(["tn_ws_owner"]);
      await runInDurableObject(stub, async (instance, state) => {
        const sid = `sess_old_owner_${Math.random().toString(36).slice(2, 6)}`;
        const staleSocket = {} as WebSocket;
        const room = instance as unknown as {
          ctx: { getTags(socket: WebSocket): string[] };
          webSocketMessage(socket: WebSocket, message: string): Promise<void>;
        };
        const originalGetTags = room.ctx.getTags.bind(room.ctx);
        room.ctx.getTags = (socket: WebSocket) =>
          socket === staleSocket
            ? ["daemon", "daemon-owner:owner_old"]
            : originalGetTags(socket);
        await state.storage.put("active_daemon_owner", "owner_new");

        await room.webSocketMessage(
          staleSocket,
          JSON.stringify({
            type: "session.ready",
            session_id: sid,
            tenant_id: "tn_ws_owner",
            acp_session_id: "acp-from-stale-owner",
          }),
        );

        expect(await state.storage.get(`session_state:${sid}`)).toBeUndefined();
      });
    });

    it("does not let an evicted daemon error mark the active owner offline", async () => {
      const { stub, runtimeId } = await freshRoom(["tn_ws_error_fence"]);
      await env.AUTH_DB
        .prepare(`UPDATE "runtimes" SET status = 'online' WHERE id = ?`)
        .bind(runtimeId)
        .run();

      await runInDurableObject(stub, async (instance, state) => {
        const staleSocket = { close() {} } as unknown as WebSocket;
        const room = instance as unknown as {
          ctx: { getTags(socket: WebSocket): string[] };
          webSocketError(socket: WebSocket, error: unknown): Promise<void>;
        };
        const originalGetTags = room.ctx.getTags.bind(room.ctx);
        room.ctx.getTags = (socket: WebSocket) =>
          socket === staleSocket
            ? ["daemon", "daemon-owner:owner_old"]
            : originalGetTags(socket);
        await state.storage.put("active_daemon_owner", "owner_new");

        await room.webSocketError(staleSocket, new Error("late socket error"));
      });

      const row = await env.AUTH_DB
        .prepare(`SELECT status FROM "runtimes" WHERE id = ?`)
        .bind(runtimeId)
        .first<{ status: string }>();
      expect(row?.status).toBe("online");
    });

    it("routes harness commands only to the active daemon owner", async () => {
      const { stub } = await freshRoom(["tn_ws_route_owner"]);
      await runInDurableObject(stub, async (instance, state) => {
        const oldMessages: string[] = [];
        const newMessages: string[] = [];
        const oldSocket = { send: (message: string) => oldMessages.push(message) } as unknown as WebSocket;
        const newSocket = { send: (message: string) => newMessages.push(message) } as unknown as WebSocket;
        const room = instance as unknown as {
          ctx: {
            getTags(socket: WebSocket): string[];
            getWebSockets(tag?: string): WebSocket[];
          };
          onHarnessMessage(sessionId: string, message: Record<string, unknown>): Promise<void>;
        };
        const originalGetTags = room.ctx.getTags.bind(room.ctx);
        const originalGetWebSockets = room.ctx.getWebSockets.bind(room.ctx);
        room.ctx.getWebSockets = (tag?: string) =>
          tag === "daemon" ? [oldSocket, newSocket] : originalGetWebSockets(tag);
        room.ctx.getTags = (socket: WebSocket) => {
          if (socket === oldSocket) return ["daemon", "daemon-owner:owner_old"];
          if (socket === newSocket) return ["daemon", "daemon-owner:owner_new"];
          return originalGetTags(socket);
        };
        await state.storage.put("active_daemon_owner", "owner_new");

        await room.onHarnessMessage("sess_route_owner", {
          type: "session.prompt",
          turn_id: "turn_route_owner",
          text: "route to current owner",
        });

        expect(oldMessages).toEqual([]);
        expect(newMessages).toHaveLength(1);
      });
    });

    it("refreshAuthorizedTenants RPC: revoking a row mid-life → next inbound msg for that tenant drops", async () => {
      const { stub, runtimeId } = await freshRoom(["tn_rpc_a", "tn_rpc_b"]);
      // Before revoke: both tenants accepted.
      await runInDurableObject(stub, async (instance, state) => {
        const sid = `sess_rpc_pre_${Math.random().toString(36).slice(2, 6)}`;
        await (instance as unknown as {
          onDaemonMessage(ws: unknown, parsed: Record<string, unknown>): Promise<void>;
        }).onDaemonMessage(
          { send: () => {} } as unknown,
          { type: "session.ready", session_id: sid, tenant_id: "tn_rpc_b", acp_session_id: "acp-pre" },
        );
        expect(await state.storage.get(`session_state:${sid}`)).toBeTruthy();
      });

      // Revoke tn_rpc_b directly in DB (mimics what /refresh does internally)
      // then fire the RPC the route handler would fire.
      await env.AUTH_DB
        .prepare(
          `UPDATE "runtime_tenants" SET revoked_at = ? WHERE runtime_id = ? AND tenant_id = ?`,
        )
        .bind(Math.floor(Date.now() / 1000), runtimeId, "tn_rpc_b")
        .run();
      await (stub as unknown as { refreshAuthorizedTenants(): Promise<void> })
        .refreshAuthorizedTenants();

      // After revoke: tn_rpc_b drops, tn_rpc_a still flows.
      await runInDurableObject(stub, async (instance, state) => {
        const sidDropped = `sess_rpc_post_drop_${Math.random().toString(36).slice(2, 6)}`;
        await (instance as unknown as {
          onDaemonMessage(ws: unknown, parsed: Record<string, unknown>): Promise<void>;
        }).onDaemonMessage(
          { send: () => {} } as unknown,
          { type: "session.ready", session_id: sidDropped, tenant_id: "tn_rpc_b", acp_session_id: "acp-post" },
        );
        expect(await state.storage.get(`session_state:${sidDropped}`)).toBeUndefined();

        const sidOk = `sess_rpc_post_ok_${Math.random().toString(36).slice(2, 6)}`;
        await (instance as unknown as {
          onDaemonMessage(ws: unknown, parsed: Record<string, unknown>): Promise<void>;
        }).onDaemonMessage(
          { send: () => {} } as unknown,
          { type: "session.ready", session_id: sidOk, tenant_id: "tn_rpc_a", acp_session_id: "acp-ok" },
        );
        expect(await state.storage.get(`session_state:${sidOk}`)).toBeTruthy();
      });
    });

    it("inbound daemon msg with tenant_id ∉ authorized set → silent drop (no broadcast, no persist)", async () => {
      const { stub, runtimeId } = await freshRoom(["tn_ws_a"]);
      // Simulate the daemon webSocketMessage handler by calling it directly.
      // We don't have a real WS; the DO's onDaemonMessage path is invoked via
      // webSocketMessage with a tagged "daemon" socket. Easier: call the
      // private method via instance access (TypeScript can't see private
      // members at runtime).
      let dropped = true;
      await runInDurableObject(stub, async (instance, state) => {
        const sid = `sess_drop_${Math.random().toString(36).slice(2, 6)}`;
        const before = await state.storage.get(`session_state:${sid}`);
        expect(before).toBeUndefined();

        await (instance as unknown as {
          onDaemonMessage(ws: unknown, parsed: Record<string, unknown>): Promise<void>;
        }).onDaemonMessage(
          { send: () => {} } as unknown,
          { type: "session.ready", session_id: sid, tenant_id: "tn_does_not_belong", acp_session_id: "acp-x" },
        );

        const after = await state.storage.get(`session_state:${sid}`);
        if (after !== undefined) dropped = false;
      });
      expect(dropped).toBe(true);
      void runtimeId;
    });

    it("inbound daemon msg with tenant_id ∈ authorized set → broadcast + persist", async () => {
      const { stub } = await freshRoom(["tn_ws_ok"]);
      await runInDurableObject(stub, async (instance, state) => {
        const sid = `sess_ok_${Math.random().toString(36).slice(2, 6)}`;
        await (instance as unknown as {
          onDaemonMessage(ws: unknown, parsed: Record<string, unknown>): Promise<void>;
        }).onDaemonMessage(
          { send: () => {} } as unknown,
          { type: "session.ready", session_id: sid, tenant_id: "tn_ws_ok", acp_session_id: "acp-y" },
        );
        const after = await state.storage.get(`session_state:${sid}`);
        expect(after).toBeTruthy();
        expect((after as { tenant_id: string }).tenant_id).toBe("tn_ws_ok");
      });
    });

    it("inbound daemon msg without tenant_id (v1 daemon) → flows unchanged", async () => {
      const { stub } = await freshRoom(["tn_ws_v1"]);
      await runInDurableObject(stub, async (instance, state) => {
        const sid = `sess_v1_${Math.random().toString(36).slice(2, 6)}`;
        await (instance as unknown as {
          onDaemonMessage(ws: unknown, parsed: Record<string, unknown>): Promise<void>;
        }).onDaemonMessage(
          { send: () => {} } as unknown,
          { type: "session.ready", session_id: sid, acp_session_id: "acp-v1" },
        );
        const after = await state.storage.get(`session_state:${sid}`);
        expect(after).toBeTruthy();
      });
    });

    it("inbound daemon msg with tenant_id mismatching session pin → silent drop", async () => {
      const { stub } = await freshRoom(["tn_pin_a", "tn_pin_b"]);
      const sid = `sess_pin_${Math.random().toString(36).slice(2, 6)}`;
      // Pin the session by issuing a real attachHarness request — that's the
      // public path that populates #sessionTenant. The WebSocket upgrade
      // returns a client we discard; we just need the pin side-effect.
      await stub.fetch(
        new Request("http://runtime-room/_attach_harness", {
          headers: {
            Upgrade: "websocket",
            "x-attach-role": "harness",
            "x-session-id": sid,
            "x-harness-tenant": "tn_pin_a",
          },
        }),
      );

      await runInDurableObject(stub, async (instance, state) => {
        await (instance as unknown as {
          onDaemonMessage(ws: unknown, parsed: Record<string, unknown>): Promise<void>;
        }).onDaemonMessage(
          { send: () => {} } as unknown,
          // Daemon claims tenant tn_pin_b for a session pinned to tn_pin_a.
          // Both are in the authorized set, so the first gate would accept;
          // the pin cross-check must drop it.
          { type: "session.ready", session_id: sid, tenant_id: "tn_pin_b", acp_session_id: "acp-mis" },
        );
        const after = await state.storage.get(`session_state:${sid}`);
        expect(after).toBeUndefined();
      });
    });

    it("outbound harness msg: pinned tenant injected into forwarded frame", async () => {
      const { stub } = await freshRoom(["tn_inj"]);
      const sid = `sess_inj_${Math.random().toString(36).slice(2, 6)}`;
      // Public path: real attach with x-harness-tenant → pin populated.
      await stub.fetch(
        new Request("http://runtime-room/_attach_harness", {
          headers: {
            Upgrade: "websocket",
            "x-attach-role": "harness",
            "x-session-id": sid,
            "x-harness-tenant": "tn_inj",
          },
        }),
      );

      const collected: Array<Record<string, unknown>> = [];
      await runInDurableObject(stub, async (instance) => {
        // Stub out daemon WS lookup — onHarnessMessage early-returns if no
        // daemon ws is registered, so we intercept getWebSockets to inject a
        // fake daemon collector.
        const ctx = (instance as unknown as { ctx: { getWebSockets: (tag: string) => unknown[] } }).ctx;
        const orig = ctx.getWebSockets.bind(ctx);
        ctx.getWebSockets = (tag: string) => {
          if (tag === "daemon") {
            return [{ send: (s: string) => collected.push(JSON.parse(s)) }];
          }
          return orig(tag);
        };

        await (instance as unknown as {
          onHarnessMessage(sid: string, parsed: Record<string, unknown>): Promise<void>;
        }).onHarnessMessage(sid, { type: "session.prompt", turn_id: "t1", text: "hi" });
      });

      expect(collected.length).toBe(1);
      const f = collected[0];
      expect(f.type).toBe("session.prompt");
      expect(f.tenant_id).toBe("tn_inj");
    });
  });
});
