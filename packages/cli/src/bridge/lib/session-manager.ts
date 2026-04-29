/**
 * SessionManager — owns the ACP child processes the daemon is currently
 * running on this machine. Slice-2 minimum: one ACP runtime per session
 * (i.e. one child process per session).
 *
 * Wire protocol (over the daemon ↔ control-plane WS, see daemon.ts):
 *
 *   Server → Daemon
 *     session.start    { session_id, agent_id, cwd?, resume? }
 *     session.prompt   { session_id, turn_id, text }
 *     session.cancel   { session_id, turn_id }
 *     session.dispose  { session_id }
 *
 *   Daemon → Server
 *     session.ready    { session_id, acp_session_id }
 *     session.event    { session_id, turn_id, event }
 *     session.complete { session_id, turn_id }
 *     session.error    { session_id, turn_id?, message }
 *     session.disposed { session_id }
 *
 * Idempotency: session.start is idempotent. If a session is already running
 * for the given session_id, we reply with session.ready immediately and skip
 * the spawn. This lets the harness on the cloud side fire session.start at
 * the top of every turn without keeping its own "first turn" state.
 *
 * OMA-specific:
 *   - On session.start we fetch the spawn-cwd bundle (AGENTS.md + skills)
 *     from main's `/v1/internal/runtime-session-bundle?sid=&agent_id=` and
 *     materialize files into the session cwd before issuing session/new.
 *   - The OMA `oma_*` PAT is passed to the ACP child as `mcpServers[].
 *     authorization_token` for each remote MCP server in the agent config.
 *     URLs in the bundle are already rewritten to point at OMA's mcp-proxy.
 */

import { AcpRuntimeImpl } from "@open-managed-agents/acp-runtime";
import { NodeSpawner } from "@open-managed-agents/acp-runtime/node-spawner";
import { KNOWN_ACP_AGENTS } from "@open-managed-agents/acp-runtime/registry";
import type { AcpSession } from "@open-managed-agents/acp-runtime";
import { ensureSessionCwd, removeSessionCwd, writeBundle } from "./session-cwd.js";

export interface SessionStartParams {
  session_id: string;
  agent_id: string;
  cwd?: string;
  resume?: { acp_session_id: string };
}

export interface SessionPromptParams {
  session_id: string;
  turn_id: string;
  text: string;
}

export type ManagerOut =
  | { type: "session.ready"; session_id: string; acp_session_id: string }
  | { type: "session.event"; session_id: string; turn_id: string; event: unknown }
  | { type: "session.complete"; session_id: string; turn_id: string }
  | { type: "session.error"; session_id: string; turn_id?: string; message: string }
  | { type: "session.disposed"; session_id: string };

export type Sender = (msg: ManagerOut) => void;

interface ActiveSession {
  acp: AcpSession;
  acpSessionId: string;
  turns: Map<string, AbortController>;
}

export interface SessionManagerEnv {
  /** OMA `oma_*` PAT — server-side auth for /v1/* calls and as the bearer
   *  the spawned ACP child sends to OMA's mcp-proxy. */
  apiKey: string;
  /** OMA server URL, e.g. https://app.openma.dev. Used to fetch session
   *  bundle and as the base for mcp-proxy URLs we send into mcpServers. */
  apiUrl: string;
  /** Runtime token (`sk_machine_*`) — daemon's bearer for /agents/runtime/*
   *  endpoints. The bundle fetch authenticates with this. */
  runtimeToken: string;
}

interface BundleFile { path: string; content: string }
interface SessionBundle { files: BundleFile[] }

export class SessionManager {
  #send: Sender;
  #spawner = new NodeSpawner();
  #runtime = new AcpRuntimeImpl(this.#spawner);
  #sessions = new Map<string, ActiveSession>();
  #env: SessionManagerEnv = { apiKey: "", apiUrl: "", runtimeToken: "" };

  constructor(send: Sender) {
    this.#send = send;
  }

  setSpawnEnv(env: SessionManagerEnv): void {
    this.#env = env;
  }

  setSender(send: Sender): void {
    this.#send = send;
  }

  has(session_id: string): boolean {
    return this.#sessions.has(session_id);
  }

  /** Re-announce alive sessions to the server (used after WS reconnect). */
  announceAll(): void {
    for (const [session_id, sess] of this.#sessions) {
      this.#send({ type: "session.ready", session_id, acp_session_id: sess.acpSessionId });
    }
  }

  async start(p: SessionStartParams): Promise<void> {
    // Idempotent: if we already have this session, just re-ack ready.
    const existing = this.#sessions.get(p.session_id);
    if (existing) {
      this.#send({
        type: "session.ready",
        session_id: p.session_id,
        acp_session_id: existing.acpSessionId,
      });
      return;
    }

    const agent = KNOWN_ACP_AGENTS.find((a) => a.id === p.agent_id);
    if (!agent) {
      this.#send({
        type: "session.error",
        session_id: p.session_id,
        message: `unknown ACP agent: ${p.agent_id}`,
      });
      return;
    }

    const sessionCwd = await ensureSessionCwd(p.session_id);

    // Fetch spawn-cwd bundle (AGENTS.md + .claude/skills/...) from main and
    // materialize before starting the ACP child. Bundle errors are non-fatal
    // — we still spawn; the agent just won't see OMA's prompt/skills.
    try {
      const bundle = await this.#fetchBundle(p.session_id, p.agent_id);
      if (bundle) await writeBundle(sessionCwd, bundle.files);
    } catch (e) {
      process.stderr.write(`  ! bundle fetch failed (non-fatal): ${(e as Error).message}\n`);
    }

    process.stderr.write(
      `  → SessionManager.start ${agent.spec.command} cwd=${sessionCwd}\n`,
    );

    try {
      const session = await this.#runtime.start({
        agent: {
          ...agent.spec,
          cwd: sessionCwd,
          env: scrubAcpSpawnEnv({ ...(agent.spec.env ?? {}) }),
        },
        resumeAcpSessionId: p.resume?.acp_session_id,
      });
      this.#sessions.set(p.session_id, {
        acp: session,
        acpSessionId: session.acpSessionId,
        turns: new Map(),
      });
      this.#send({
        type: "session.ready",
        session_id: p.session_id,
        acp_session_id: session.acpSessionId,
      });
    } catch (e) {
      this.#send({
        type: "session.error",
        session_id: p.session_id,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async prompt(p: SessionPromptParams): Promise<void> {
    const sess = this.#sessions.get(p.session_id);
    if (!sess) {
      this.#send({
        type: "session.error",
        session_id: p.session_id,
        turn_id: p.turn_id,
        message: "no such session",
      });
      return;
    }
    const ctrl = new AbortController();
    sess.turns.set(p.turn_id, ctrl);
    let promptErr: string | null = null;
    try {
      for await (const ev of sess.acp.prompt(p.text, { abortSignal: ctrl.signal })) {
        if (ctrl.signal.aborted) break;
        const t = (ev as { type?: string; error?: string } | null | undefined)?.type;
        // AcpSession yields sentinel events at the end of the stream:
        //   { type: "promptComplete", response }  → ACP returned cleanly
        //   { type: "promptError", error }        → ACP returned a JSON-RPC error
        // The latter often carries the *only* signal that the turn failed
        // (e.g. wrong model id, auth missing) — silently skipping it would
        // make session.complete arrive as if everything worked.
        if (t === "promptComplete") continue;
        if (t === "promptError") {
          promptErr = (ev as { error?: string }).error ?? "ACP prompt error (no message)";
          continue;
        }
        this.#send({
          type: "session.event",
          session_id: p.session_id,
          turn_id: p.turn_id,
          event: ev,
        });
      }
      if (promptErr) {
        this.#send({
          type: "session.error",
          session_id: p.session_id,
          turn_id: p.turn_id,
          message: promptErr,
        });
      } else {
        this.#send({ type: "session.complete", session_id: p.session_id, turn_id: p.turn_id });
      }
    } catch (e) {
      this.#send({
        type: "session.error",
        session_id: p.session_id,
        turn_id: p.turn_id,
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      sess.turns.delete(p.turn_id);
    }
  }

  cancel(session_id: string, turn_id: string): void {
    const sess = this.#sessions.get(session_id);
    if (!sess) return;
    sess.turns.get(turn_id)?.abort();
  }

  async dispose(session_id: string): Promise<void> {
    await this.#killChild(session_id);
    // Drop the spawn cwd — session is dead at the platform; transcripts /
    // AGENTS.md / .claude/skills/ are no longer load-bearing.
    await removeSessionCwd(session_id);
    this.#send({ type: "session.disposed", session_id });
  }

  /** Best-effort cleanup on daemon shutdown. KEEPS spawn cwds — sessions are
   *  still live at the platform; the daemon coming back tomorrow needs the
   *  same dirs to spawn fresh ACP children with the same transcripts. */
  async disposeAll(): Promise<void> {
    const ids = [...this.#sessions.keys()];
    await Promise.all(ids.map((id) => this.#killChild(id)));
  }

  /** Kill the ACP child + drop in-memory state. Does NOT touch the spawn
   *  cwd — caller decides whether the cwd should outlive this. */
  async #killChild(session_id: string): Promise<void> {
    const sess = this.#sessions.get(session_id);
    if (!sess) return;
    for (const ctrl of sess.turns.values()) ctrl.abort();
    await sess.acp.dispose().catch(() => undefined);
    this.#sessions.delete(session_id);
  }

  async #fetchBundle(sid: string, acpAgentId: string): Promise<SessionBundle | null> {
    if (!this.#env.apiUrl || !this.#env.runtimeToken) return null;
    const url = new URL(
      `${this.#env.apiUrl.replace(/\/$/, "")}/agents/runtime/sessions/${encodeURIComponent(sid)}/bundle`,
    );
    url.searchParams.set("agent_id", acpAgentId);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${this.#env.runtimeToken}` },
    });
    if (!res.ok) {
      throw new Error(`bundle ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return (await res.json()) as SessionBundle;
  }
}

/**
 * Strip env vars that signal "you're already inside another Claude-flavored
 * session". claude-code-acp aborts session/new with "cannot be launched
 * inside another Claude Code session" when CLAUDECODE is inherited (e.g.
 * user runs `oma bridge daemon` from a Claude Code terminal). The same
 * precaution applies to other ACP agents that may detect parent shells.
 *
 * Sets the keys to `undefined` rather than deleting from the object so
 * NodeSpawner's "undefined → unset inherited" semantics removes them from
 * the child's process.env (the parent already has them set, and a normal
 * delete would fall back to inheritance).
 */
function scrubAcpSpawnEnv(
  base: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    ...base,
    CLAUDECODE: undefined,
    CLAUDE_CODE_ENTRYPOINT: undefined,
    CLAUDE_CODE_SSE_PORT: undefined,
  };
}
