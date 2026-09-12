/**
 * RuntimeRoom — Durable Object for one user-registered local runtime.
 *
 * Addressed by `idFromName(runtime_id)` so the daemon and the ACP-proxy
 * harness inside SessionDO always land on the same instance.
 *
 * Two kinds of WS attached, distinguished by hibernation tag:
 *   - "daemon"           — the long-running `oma bridge daemon` process. Exactly
 *                          one. Reattaches with the same runtime token after WS
 *                          drops (network blips, isolate evictions); the DO
 *                          accepts the new attach and re-binds.
 *   - "harness:<sid>"    — the AcpProxyHarness inside SessionDO listening for
 *                          ACP events for a single in-flight turn. One per
 *                          (sid, turn). Closes when the turn ends.
 *
 * Routing:
 *   harness → DO   {type: session.start | session.prompt | session.cancel | session.dispose}
 *                  → forwarded to daemon
 *   daemon  → DO   {type: session.event | session.complete | session.error |
 *                        session.ready | session.disposed | hello | ping}
 *                  → fan-out to "harness:<sid>"
 *
 * Storage:
 *   "session_state:<sid>"  — JSON of last terminal state (ready/error/disposed)
 *                            so a harness that opens its WS *after* daemon
 *                            already replied still gets the message.
 *   "acp_session:<sid>"    — the ACP-side session id last advertised by the
 *                            daemon for this oma session_id. Survives daemon
 *                            restarts (no session.disposed = the user still
 *                            owns the session). Injected as `resume.acp_session_id`
 *                            on every session.start the harness sends, so the
 *                            new daemon's `session/load` recovers conversation
 *                            history instead of spawning a fresh session that
 *                            "forgets everything." Cleared on session.disposed.
 *                            See drain() in cli/src/bridge/lib/session-manager.ts
 *                            for the daemon-side recovery counterpart.
 *
 * Auth: assumed enforced before fetch() reaches the DO. The /agents/runtime/
 * _attach upgrade route validates the runtime bearer token and forwards as
 * x-runtime-id / x-runtime-user headers; the harness internal route validates
 * the internal-secret header.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "@open-managed-agents/shared";
import { log, logWarn, logError } from "@open-managed-agents/shared";
import {
  decodeSessionCommand,
  decodeSessionHostEvent,
  encodeSessionCommand,
  encodeSessionHostEvent,
} from "@openma/common/session-kernel";
import {
  authorizeRuntimeHostEvent,
  planRuntimeHostEventEffects,
  selectRuntimeCommandTenant,
} from "@open-managed-agents/runtime-relay";

type Side = "daemon" | "harness";

const HARNESS_TAG_PREFIX = "harness:";
const DAEMON_OWNER_TAG_PREFIX = "daemon-owner:";
const ACTIVE_DAEMON_OWNER_KEY = "active_daemon_owner";
const DAEMON_LEASE_TIMEOUT_SECONDS = 90;
function harnessTag(sid: string): string {
  return `${HARNESS_TAG_PREFIX}${sid}`;
}
function sessionFromTag(tag: string): string | null {
  return tag.startsWith(HARNESS_TAG_PREFIX) ? tag.slice(HARNESS_TAG_PREFIX.length) : null;
}
function daemonOwnerTag(ownerId: string): string {
  return `${DAEMON_OWNER_TAG_PREFIX}${ownerId}`;
}
function daemonOwnerFromTags(tags: string[]): string | null {
  const tag = tags.find((candidate) => candidate.startsWith(DAEMON_OWNER_TAG_PREFIX));
  return tag ? tag.slice(DAEMON_OWNER_TAG_PREFIX.length) : null;
}

export class RuntimeRoom extends DurableObject<Env> {
  /** Cached on first attach so logs / DB writes don't need a fresh lookup. */
  private runtimeId = "";
  private userId = "";

  /**
   * Authorized-tenants cache for `runtime_tenants WHERE revoked_at IS NULL`.
   * Primed lazily on first need (attach + first WS message after isolate
   * restart) and invalidated by the `refreshAuthorizedTenants()` RPC the
   * /refresh route fires after committing membership changes.
   *
   * Step 2 of the rollout: VALIDATION ONLY WHEN PRESENT. A v1 daemon that
   * omits `tenant_id` on every message still flows through unchanged.
   * Enforcement (drop on absent) flips in step 4 after v2 adoption ≥95%.
   */
  #authorizedTenants: Set<string> | null = null;

  /**
   * Per-session tenant pin, set by `attachHarness` from the
   * `x-harness-tenant` header the agent worker injects. Read on the daemon
   * → broadcast hot path to validate inbound `tenant_id` matches what the
   * cloud side believes for this session, and on the harness → daemon hot
   * path to inject the right `tenant_id` into the forwarded frame.
   *
   * Cleared when the harness WS closes.
   */
  #sessionTenant = new Map<string, string>();

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket only", { status: 400 });
    }
    const role = request.headers.get("x-attach-role"); // "daemon" | "harness"
    if (role === "daemon") return this.attachDaemon(request);
    if (role === "harness") return this.attachHarness(request);
    return new Response("missing or invalid x-attach-role", { status: 400 });
  }

  private async attachDaemon(request: Request): Promise<Response> {
    const runtimeId = request.headers.get("x-runtime-id") ?? "";
    const userId = request.headers.get("x-runtime-user") ?? "";
    if (!runtimeId || !userId) {
      return new Response("missing runtime headers", { status: 400 });
    }

    // One daemon per runtime. HibernatableWebSocket.send() only proves that
    // workerd still owns a socket object; it does not prove the peer TCP is
    // alive. Use the heartbeat observed by this control plane as the lease.
    const existing = this.ctx.getWebSockets("daemon");
    if (existing.length > 0) {
      const leaseFresh = await this.isDaemonLeaseFresh(runtimeId);
      if (leaseFresh !== false) {
        return new Response("daemon already attached", { status: 409 });
      }
      for (const socket of existing) {
        try { socket.close(1012, "daemon heartbeat lease expired"); } catch { /* already closing */ }
      }
    }

    this.runtimeId = runtimeId;
    this.userId = userId;
    await this.ctx.storage.put("runtime_id", runtimeId);
    await this.ctx.storage.put("user_id", userId);

    // Prime the authorized-tenants cache eagerly on daemon attach so the
    // first inbound message after handshake doesn't pay the lookup cost.
    // Tolerant of failure — `ensureAuthorizedTenants` retries lazily on use.
    try {
      await this.ensureAuthorizedTenants();
    } catch (e) {
      logWarn({ op: "runtime_room.prime_authorized_tenants_failed", err: String(e), runtime_id: runtimeId }, "authorized-tenants prime failed");
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const daemonOwnerId = crypto.randomUUID();
    this.ctx.acceptWebSocket(server, ["daemon", daemonOwnerTag(daemonOwnerId)]);
    await this.ctx.storage.put(ACTIVE_DAEMON_OWNER_KEY, daemonOwnerId);
    log({ op: "runtime_room.daemon_attach", runtime_id: runtimeId }, "daemon attached");

    await this.markOnline();
    return new Response(null, { status: 101, webSocket: client });
  }

  private async isDaemonLeaseFresh(runtimeId: string): Promise<boolean | null> {
    try {
      const row = await this.env.MAIN_DB
        .prepare(`SELECT status, last_heartbeat FROM "runtimes" WHERE id = ?`)
        .bind(runtimeId)
        .first<{ status: string; last_heartbeat: number | null }>();
      if (row?.status !== "online") return false;
      if (row.last_heartbeat === null) return false;
      return Math.floor(Date.now() / 1000) - row.last_heartbeat < DAEMON_LEASE_TIMEOUT_SECONDS;
    } catch (error) {
      logWarn(
        { op: "runtime_room.daemon_lease_lookup_failed", err: String(error), runtime_id: runtimeId },
        "daemon heartbeat lease lookup failed",
      );
      return null;
    }
  }

  private async attachHarness(request: Request): Promise<Response> {
    const sid = request.headers.get("x-session-id") ?? "";
    if (!sid) return new Response("missing x-session-id", { status: 400 });
    // x-harness-tenant — agent worker (SessionDO has tenant_id in scope) tells
    // us which tenant this session belongs to. ABSENT from older callers; left
    // as undefined in the map (validation tolerates absence in this step).
    const harnessTenant = request.headers.get("x-harness-tenant");
    if (harnessTenant) this.#sessionTenant.set(sid, harnessTenant);

    await this.ensureIdentity();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [harnessTag(sid)]);

    const daemonUp = await this.activeDaemonSocket() !== null;
    try {
      server.send(JSON.stringify({ type: "attached", daemon_online: daemonUp }));
    } catch { /* race: harness already closed */ }

    // Replay last terminal/transition state for this session if any. The
    // harness might open its WS *after* daemon already responded with
    // session.ready / session.error.
    const replay = await this.ctx.storage.get<Record<string, unknown>>(this.sessionStateKey(sid));
    if (replay) {
      try { server.send(JSON.stringify(replay)); } catch { /* harness closed */ }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  private sessionStateKey(sid: string): string {
    return `session_state:${sid}`;
  }

  /** Storage key for the daemon-reported acp_session_id of an oma session.
   *  Persists across daemon restarts; cleared on session.disposed. */
  private acpSessionKey(sid: string): string {
    return `acp_session:${sid}`;
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let parsed: { type?: string; [k: string]: unknown };
    try {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      parsed = JSON.parse(text);
    } catch (e) {
      logWarn({ op: "runtime_room.bad_message", err: String(e) }, "bad ws message");
      return;
    }

    await this.ensureIdentity();
    const tags = this.ctx.getTags(ws);
    const isDaemon = tags.includes("daemon");

    if (isDaemon) {
      if (!(await this.isActiveDaemonSocket(tags))) {
        logWarn(
          { op: "runtime_room.evicted_daemon_message", runtime_id: this.runtimeId },
          "dropped message from evicted daemon",
        );
        try { ws.close(1008, "daemon lease lost"); } catch { /* already closed */ }
        return;
      }
      await this.onDaemonMessage(ws, parsed);
    } else {
      const sid = tags.map(sessionFromTag).find((s): s is string => !!s);
      if (!sid) return;
      await this.onHarnessMessage(sid, parsed);
    }
  }

  private async onDaemonMessage(ws: WebSocket, parsed: { type?: string; [k: string]: unknown }): Promise<void> {
    if (parsed.type === "hello") {
      const agents = Array.isArray(parsed.agents) ? parsed.agents : [];
      const version = typeof parsed.version === "string" ? parsed.version : "unknown";
      const hostname = typeof parsed.hostname === "string" ? parsed.hostname : null;
      const os = typeof parsed.os === "string" ? parsed.os : null;
      // local_skills is the daemon's scan of ~/.claude/skills/ +
      // ~/.claude/plugins/*/skills/, keyed by acp agent id. Default {} when
      // older daemons don't send it — column has DEFAULT '{}' too so writes
      // either way produce valid JSON.
      const localSkills = (parsed.local_skills && typeof parsed.local_skills === "object")
        ? parsed.local_skills
        : {};
      try {
        const cols = ["agents_json = ?", "version = ?", "local_skills_json = ?", "status = 'online'", "last_heartbeat = unixepoch()"];
        const args: unknown[] = [JSON.stringify(agents), version, JSON.stringify(localSkills)];
        if (hostname) { cols.push("hostname = ?"); args.push(hostname); }
        if (os) { cols.push("os = ?"); args.push(os); }
        args.push(this.runtimeId);
        await this.env.MAIN_DB
          .prepare(`UPDATE "runtimes" SET ${cols.join(", ")} WHERE id = ?`)
          .bind(...args)
          .run();
      } catch (e) {
        logError({ op: "runtime_room.hello_db", err: String(e), runtime_id: this.runtimeId }, "hello DB update failed");
      }
      try { ws.send(JSON.stringify({ type: "welcome", runtime_id: this.runtimeId })); } catch { /* */ }
      return;
    }

    if (parsed.type === "ping") {
      try {
        await this.env.MAIN_DB
          .prepare(`UPDATE "runtimes" SET last_heartbeat = unixepoch(), status = 'online' WHERE id = ?`)
          .bind(this.runtimeId)
          .run();
      } catch (e) {
        logError({ op: "runtime_room.ping_db", err: String(e), runtime_id: this.runtimeId }, "ping DB update failed");
      }
      try { ws.send(JSON.stringify({ type: "pong" })); } catch { /* */ }
      return;
    }

    // Session-related daemon messages — fan out to the harness for that sid.
    //   session.ready    { session_id, acp_session_id }
    //   session.event    { session_id, turn_id, event }
    //   session.complete { session_id, turn_id }
    //   session.error    { session_id, turn_id?, message }
    //   session.disposed { session_id }
    const event = decodeSessionHostEvent(parsed);
    if (event !== null) {
      const sid = event.sessionId;
      // Tenant validation (additive — step 2 of rollout). When the daemon
      // sends a `tenant_id` field, two checks fire:
      //   1. is it in this runtime's authorized set?
      //   2. does it match the cloud-side session.tenant_id (the pin set by
      //      attachHarness from x-harness-tenant)?
      // A failure on either drops the message — no broadcast, no persist —
      // so a tampered or stale daemon can't fan out frames into a
      // different tenant's harness. Absent tenant_id (v1 daemon) flows
      // through unchanged; enforcement of presence flips in step 4.
      const reportedTenant = typeof parsed.tenant_id === "string" ? parsed.tenant_id : null;
      if (reportedTenant !== null) {
        try {
          await this.ensureAuthorizedTenants();
        } catch (e) {
          logWarn({ op: "runtime_room.ensure_authorized_failed", err: String(e), runtime_id: this.runtimeId }, "authorized-tenants lazy load failed; allowing for back-compat");
        }
      }
      const pinnedTenant = this.#sessionTenant.get(sid);
      const authorization = authorizeRuntimeHostEvent({
        authorizedTenantIds: this.#authorizedTenants === null
          ? null
          : [...this.#authorizedTenants],
        ...(reportedTenant !== null && { reportedTenantId: reportedTenant }),
        ...(pinnedTenant !== undefined && { pinnedTenantId: pinnedTenant }),
      });
      if (authorization.type === "rejected") {
        if (authorization.reason === "tenant_not_authorized") {
          logWarn(
            { op: "runtime_room.daemon_tenant_not_authorized", type: parsed.type, session_id: sid, runtime_id: this.runtimeId, reported_tenant: reportedTenant },
            "daemon reported tenant_id not in authorized set — dropping",
          );
        } else {
          logWarn(
            { op: "runtime_room.daemon_tenant_session_mismatch", type: parsed.type, session_id: sid, reported_tenant: reportedTenant, pinned_tenant: pinnedTenant },
            "daemon reported tenant_id does not match session's pinned tenant — dropping",
          );
        }
        return;
      }
      // Persist transition states so a harness opening its WS *after* the
      // daemon already replied still receives the message. Per-event /
      // per-complete are streamed and lost-on-late-attach is acceptable for v1.
      const forwarded = encodeSessionHostEvent(event, {
        ...(reportedTenant !== null && { tenantId: reportedTenant }),
      });
      const effects = planRuntimeHostEventEffects(event);
      if (effects.replay === "put") {
        await this.ctx.storage.put(this.sessionStateKey(sid), forwarded);
      } else if (effects.replay === "delete") {
        await this.ctx.storage.delete(this.sessionStateKey(sid));
      }
      // Persist the acp_session_id whenever the daemon advertises one — both
      // first-time session.ready (after session/new) and re-attach session.ready
      // (after session/load on a recovered session). The next session.start
      // for this sid will inject this as resume.acp_session_id, which is how
      // we survive daemon restarts without losing conversation history (the
      // ACP child's persisted state is in its cwd; session/load tells it
      // which conversation to reopen). See onHarnessMessage below.
      if (effects.acpSession.type === "put") {
        await this.ctx.storage.put(
          this.acpSessionKey(sid),
          effects.acpSession.acpSessionId,
        );
      } else if (effects.acpSession.type === "delete") {
        await this.ctx.storage.delete(this.acpSessionKey(sid));
      }
      this.broadcastToHarness(sid, forwarded);
      return;
    }

    log({ op: "runtime_room.unhandled_daemon_msg", type: parsed.type }, "unhandled daemon message");
  }

  private async onHarnessMessage(sid: string, parsed: { type?: string; [k: string]: unknown }): Promise<void> {
    // Relay wire conversion is owned by openma-common/session-kernel.
    //   { type: "session.start", agent_id, cwd?, resume? }   → forwards as-is
    //   { type: "session.prompt", turn_id, text }            → forwards as-is
    //   { type: "session.cancel", turn_id }                  → forwards as-is
    //   { type: "session.dispose" }                          → forwards as-is
    const daemon = await this.activeDaemonSocket();
    if (!daemon) {
      this.broadcastToHarness(sid, encodeSessionHostEvent({
        type: "session.error",
        sessionId: sid,
        message: "runtime daemon offline",
      }));
      return;
    }
    const wire: { [k: string]: unknown } = { ...parsed, session_id: sid };
    // Inject tenant_id from the session pin (set by attachHarness from the
    // x-harness-tenant header). v2-aware daemons read this on every
    // session.start / .prompt / .cancel / .dispose to pick the right
    // per-tenant API key for the spawned ACP child. Absent when the harness
    // didn't supply the header (legacy server-side path or test) — the
    // daemon falls back to its single legacy key in that case (step 2 is
    // additive, not enforcing). A cloud-side pin wins over a caller-supplied
    // tenant_id; without a pin the legacy supplied value is preserved.
    const pinnedTenant = this.#sessionTenant.get(sid);
    const suppliedTenant = typeof parsed.tenant_id === "string"
      ? parsed.tenant_id
      : undefined;
    const selectedTenant = selectRuntimeCommandTenant({
      ...(pinnedTenant !== undefined && { pinnedTenantId: pinnedTenant }),
      ...(suppliedTenant !== undefined && { suppliedTenantId: suppliedTenant }),
    });
    // session.start carries an optional `resume.acp_session_id`. Today no
    // harness builds that — the cloud-side AcpProxyHarness sends bare
    // session.start. We inject it here from DO storage so daemon restarts
    // (npm upgrade, machine reboot, manual setup re-run) don't appear as
    // "agent forgot the conversation" to the user. The daemon already
    // honors `resume.acp_session_id` via ACP `session/load` (see
    // packages/acp-runtime/src/session.ts:108). Skipped when the harness
    // already supplied a resume payload — never overwrite caller intent.
    if (parsed.type === "session.start") {
      const existing = (wire.resume as { acp_session_id?: string } | undefined)?.acp_session_id;
      if (!existing) {
        const acpSid = await this.ctx.storage.get<string>(this.acpSessionKey(sid));
        if (acpSid) {
          wire.resume = { acp_session_id: acpSid };
          log({ op: "runtime_room.inject_resume", session_id: sid, acp_session_id: acpSid }, "injected resume.acp_session_id for recovery");
        }
      }
    }
    const command = decodeSessionCommand(wire);
    if (command === null) {
      logWarn(
        { op: "runtime_room.invalid_harness_message", type: parsed.type, session_id: sid },
        "invalid harness relay message",
      );
      return;
    }
    const out = encodeSessionCommand(command, {
      ...(selectedTenant !== undefined && { tenantId: selectedTenant }),
    });
    try {
      daemon.send(JSON.stringify(out));
    } catch (e) {
      logWarn({ op: "runtime_room.forward_daemon_failed", err: String(e), session_id: sid }, "forward to daemon failed");
    }
  }

  /** Send a message to all harness WSs subscribed to one session. */
  private broadcastToHarness(sid: string, msg: Record<string, unknown>): void {
    const payload = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets(harnessTag(sid))) {
      try { ws.send(payload); } catch { /* dead harness; will close soon */ }
    }
  }

  /** Tell the daemon to dispose a session. Called from internal route. */
  async sendToDaemon(msg: Record<string, unknown>): Promise<boolean> {
    await this.ensureIdentity();
    const daemon = await this.activeDaemonSocket();
    if (!daemon) return false;
    try { daemon.send(JSON.stringify(msg)); return true; }
    catch { return false; }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    await this.ensureIdentity();
    const tags = this.ctx.getTags(ws);
    if (tags.includes("daemon")) {
      const activeOwnerId = await this.ctx.storage.get<string>(ACTIVE_DAEMON_OWNER_KEY);
      const closingOwnerId = daemonOwnerFromTags(tags);
      if (activeOwnerId && closingOwnerId !== activeOwnerId) {
        log(
          { op: "runtime_room.evicted_daemon_close", code, runtime_id: this.runtimeId },
          "ignored close from evicted daemon",
        );
        return;
      }
      await this.ctx.storage.delete(ACTIVE_DAEMON_OWNER_KEY);
      log({ op: "runtime_room.daemon_close", code, reason: reason || "—", runtime_id: this.runtimeId }, "daemon closed");
      await this.markOffline();
      return;
    }
    const sid = tags.map(sessionFromTag).find((s): s is string => !!s);
    if (sid) {
      // Drop the per-session tenant pin so a future re-attach for the same
      // sid (rare — happens if the cloud side closes and re-opens) re-reads
      // the header. Authorized-tenants cache stays put; it's runtime-scoped.
      this.#sessionTenant.delete(sid);
      log({ op: "runtime_room.harness_close", session_id: sid, code }, "harness closed");
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    await this.ensureIdentity();
    logError({ op: "runtime_room.ws_error", err: String(error), runtime_id: this.runtimeId }, "ws error");
    const tags = this.ctx.getTags(ws);
    const activeDaemon = tags.includes("daemon") && await this.isActiveDaemonSocket(tags);
    try { ws.close(1011, "ws error"); } catch { /* already closed */ }
    if (activeDaemon) await this.markOffline();
  }

  private async isActiveDaemonSocket(tags: string[]): Promise<boolean> {
    const activeOwnerId = await this.ctx.storage.get<string>(ACTIVE_DAEMON_OWNER_KEY);
    if (!activeOwnerId) return true;
    return daemonOwnerFromTags(tags) === activeOwnerId;
  }

  private async activeDaemonSocket(): Promise<WebSocket | null> {
    const sockets = this.ctx.getWebSockets("daemon");
    if (sockets.length === 0) return null;

    const activeOwnerId = await this.ctx.storage.get<string>(ACTIVE_DAEMON_OWNER_KEY);
    // Preserve compatibility with daemon sockets accepted before owner tags
    // were introduced. A newly attached daemon always records an owner id.
    if (!activeOwnerId) return sockets[0] ?? null;

    return sockets.find((socket) =>
      daemonOwnerFromTags(this.ctx.getTags(socket)) === activeOwnerId
    ) ?? null;
  }

  private async ensureIdentity(): Promise<void> {
    if (this.runtimeId && this.userId) return;
    const stored = await this.ctx.storage.get(["runtime_id", "user_id"] as never);
    const m = stored as unknown as Map<string, string> | undefined;
    if (m) {
      this.runtimeId = m.get("runtime_id") ?? "";
      this.userId = m.get("user_id") ?? "";
    }
  }

  /**
   * Lazy-prime `#authorizedTenants` from `runtime_tenants WHERE
   * revoked_at IS NULL`. Called eagerly on daemon attach and lazily on the
   * first daemon message that carries a `tenant_id`. Skipped when already
   * populated; cleared via `refreshAuthorizedTenants()` after a /refresh
   * mutates membership.
   *
   * Failure mode: returns silently with the cache still null. The caller
   * treats null as "couldn't load, accept the message" to avoid hard-failing
   * legit traffic on a transient DB hiccup — this is additive-validation
   * territory, not enforcement. Step 4 will tighten this.
   */
  private async ensureAuthorizedTenants(): Promise<void> {
    if (this.#authorizedTenants !== null) return;
    await this.ensureIdentity();
    if (!this.runtimeId) return;
    const { results } = await this.env.MAIN_DB
      .prepare(`SELECT tenant_id FROM "runtime_tenants" WHERE runtime_id = ? AND revoked_at IS NULL`)
      .bind(this.runtimeId)
      .all<{ tenant_id: string }>();
    this.#authorizedTenants = new Set((results ?? []).map((r) => r.tenant_id));
  }

  /**
   * RPC invoked by `POST /agents/runtime/:id/refresh` after it commits
   * membership add/revoke changes to `runtime_tenants`. Clears the cache so
   * the next inbound message re-reads — cheap (one SELECT) and avoids
   * stale-cache windows where a freshly-revoked tenant could still send
   * frames through. Best-effort: route handler tolerates RPC failure.
   */
  async refreshAuthorizedTenants(): Promise<void> {
    this.#authorizedTenants = null;
    await this.ensureAuthorizedTenants();
  }

  private async markOnline(): Promise<void> {
    try {
      await this.env.MAIN_DB
        .prepare(`UPDATE "runtimes" SET status = 'online', last_heartbeat = unixepoch() WHERE id = ?`)
        .bind(this.runtimeId)
        .run();
    } catch (e) {
      logError({ op: "runtime_room.mark_online", err: String(e), runtime_id: this.runtimeId }, "markOnline failed");
    }
  }

  private async markOffline(): Promise<void> {
    if (!this.runtimeId) return;
    try {
      await this.env.MAIN_DB
        .prepare(`UPDATE "runtimes" SET status = 'offline' WHERE id = ?`)
        .bind(this.runtimeId)
        .run();
    } catch (e) {
      logError({ op: "runtime_room.mark_offline", err: String(e), runtime_id: this.runtimeId }, "markOffline failed");
    }
  }
}
