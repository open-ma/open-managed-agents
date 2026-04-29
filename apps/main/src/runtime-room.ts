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
 *
 * Auth: assumed enforced before fetch() reaches the DO. The /agents/runtime/
 * _attach upgrade route validates the runtime bearer token and forwards as
 * x-runtime-id / x-runtime-user headers; the harness internal route validates
 * the internal-secret header.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "@open-managed-agents/shared";
import { log, logWarn, logError } from "@open-managed-agents/shared";

type Side = "daemon" | "harness";

const HARNESS_TAG_PREFIX = "harness:";
function harnessTag(sid: string): string {
  return `${HARNESS_TAG_PREFIX}${sid}`;
}
function sessionFromTag(tag: string): string | null {
  return tag.startsWith(HARNESS_TAG_PREFIX) ? tag.slice(HARNESS_TAG_PREFIX.length) : null;
}

export class RuntimeRoom extends DurableObject<Env> {
  /** Cached on first attach so logs / DB writes don't need a fresh lookup. */
  private runtimeId = "";
  private userId = "";

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

    // One daemon per runtime. A reconnecting daemon needs the prior WS to be
    // reaped first — CF should fire `webSocketClose` on the old TCP long
    // before a fresh attempt arrives, but if not we 409 the new one and let
    // the daemon retry after the close finally lands.
    const existing = this.ctx.getWebSockets("daemon");
    if (existing.length > 0) {
      try {
        existing[0].send(JSON.stringify({ type: "ping" }));
        return new Response("daemon already attached", { status: 409 });
      } catch {
        try { existing[0].close(1011, "stale"); } catch { /* already closing */ }
      }
    }

    this.runtimeId = runtimeId;
    this.userId = userId;
    await this.ctx.storage.put("runtime_id", runtimeId);
    await this.ctx.storage.put("user_id", userId);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ["daemon"]);
    log({ op: "runtime_room.daemon_attach", runtime_id: runtimeId }, "daemon attached");

    await this.markOnline();
    return new Response(null, { status: 101, webSocket: client });
  }

  private async attachHarness(request: Request): Promise<Response> {
    const sid = request.headers.get("x-session-id") ?? "";
    if (!sid) return new Response("missing x-session-id", { status: 400 });

    await this.ensureIdentity();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [harnessTag(sid)]);

    const daemonUp = this.ctx.getWebSockets("daemon").length > 0;
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
      await this.onDaemonMessage(ws, parsed);
    } else {
      const sid = tags.map(sessionFromTag).find((s): s is string => !!s);
      if (!sid) return;
      this.onHarnessMessage(sid, parsed);
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
        await this.env.AUTH_DB
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
        await this.env.AUTH_DB
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
    if (typeof parsed.type === "string" && parsed.type.startsWith("session.")) {
      const sid = parsed.session_id as string | undefined;
      if (!sid) {
        logWarn({ op: "runtime_room.daemon_msg_no_sid", type: parsed.type }, "daemon message missing session_id");
        return;
      }
      // Persist transition states so a harness opening its WS *after* the
      // daemon already replied still receives the message. Per-event /
      // per-complete are streamed and lost-on-late-attach is acceptable for v1.
      if (parsed.type === "session.ready" || parsed.type === "session.error") {
        await this.ctx.storage.put(this.sessionStateKey(sid), parsed);
      }
      if (parsed.type === "session.disposed") {
        await this.ctx.storage.delete(this.sessionStateKey(sid));
      }
      this.broadcastToHarness(sid, parsed);
      return;
    }

    log({ op: "runtime_room.unhandled_daemon_msg", type: parsed.type }, "unhandled daemon message");
  }

  private onHarnessMessage(sid: string, parsed: { type?: string; [k: string]: unknown }): void {
    // Harness side speaks the canonical clash protocol verbatim — daemon
    // doesn't need a translation step.
    //   { type: "session.start", agent_id, cwd?, resume? }   → forwards as-is
    //   { type: "session.prompt", turn_id, text }            → forwards as-is
    //   { type: "session.cancel", turn_id }                  → forwards as-is
    //   { type: "session.dispose" }                          → forwards as-is
    const daemon = this.ctx.getWebSockets("daemon")[0];
    if (!daemon) {
      this.broadcastToHarness(sid, {
        type: "session.error",
        session_id: sid,
        message: "runtime daemon offline",
      });
      return;
    }
    const out = { ...parsed, session_id: sid };
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
    const daemon = this.ctx.getWebSockets("daemon")[0];
    if (!daemon) return false;
    try { daemon.send(JSON.stringify(msg)); return true; }
    catch { return false; }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    await this.ensureIdentity();
    const tags = this.ctx.getTags(ws);
    if (tags.includes("daemon")) {
      log({ op: "runtime_room.daemon_close", code, reason: reason || "—", runtime_id: this.runtimeId }, "daemon closed");
      await this.markOffline();
      return;
    }
    const sid = tags.map(sessionFromTag).find((s): s is string => !!s);
    if (sid) {
      log({ op: "runtime_room.harness_close", session_id: sid, code }, "harness closed");
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    await this.ensureIdentity();
    logError({ op: "runtime_room.ws_error", err: String(error), runtime_id: this.runtimeId }, "ws error");
    try { ws.close(1011, "ws error"); } catch { /* already closed */ }
    const tags = this.ctx.getTags(ws);
    if (tags.includes("daemon")) await this.markOffline();
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

  private async markOnline(): Promise<void> {
    try {
      await this.env.AUTH_DB
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
      await this.env.AUTH_DB
        .prepare(`UPDATE "runtimes" SET status = 'offline' WHERE id = ?`)
        .bind(this.runtimeId)
        .run();
    } catch (e) {
      logError({ op: "runtime_room.mark_offline", err: String(e), runtime_id: this.runtimeId }, "markOffline failed");
    }
  }
}
