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

import { spawn as childSpawn } from "node:child_process";
import { AcpRuntimeImpl } from "@open-managed-agents/acp-runtime";
import { NodeSpawner } from "@open-managed-agents/acp-runtime/node-spawner";
import { resolveKnownAgent } from "@open-managed-agents/acp-runtime/registry";
import type { AcpSession } from "@open-managed-agents/acp-runtime";
import { ensureSessionCwd, removeSessionCwd, writeBundle } from "./session-cwd.js";
import { setupClaudeConfigDir } from "./claude-config-dir.js";

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
interface BundleMcpServer {
  name: string;
  type: "http" | "sse";
  url: string;
}
interface BundleEnvVar {
  name: string;
  value: string;
}
interface SessionBundle {
  files: BundleFile[];
  /** Per-agent local-skill blocklist — daemon hides any skill with id in
   *  this list from the spawn by NOT symlinking it into CLAUDE_CONFIG_DIR.
   *  Bare directory ids (no plugin prefix); a global skill and a plugin
   *  skill that share the same id are both hidden. */
  local_skill_blocklist?: string[];
  /** MCP servers the ACP child should connect to. URLs already point at
   *  OMA's mcp-proxy; SessionManager appends the Authorization header
   *  (Bearer agentApiKey) at spawn time so the PAT never round-trips
   *  through the bundle response. */
  mcp_servers?: BundleMcpServer[];
  /** Plain env vars (was env_secret pre-rename) merged into the spawned
   *  ACP child's process.env. Daemon never logs name or value. */
  env?: BundleEnvVar[];
}

export class SessionManager {
  #send: Sender;
  #spawner = new NodeSpawner();
  #runtime = new AcpRuntimeImpl(this.#spawner);
  #sessions = new Map<string, ActiveSession>();
  #env: SessionManagerEnv = { apiKey: "", apiUrl: "", runtimeToken: "" };
  /** Set by `drain()` to refuse new session.start while in-flight turns
   *  finish. Existing sessions keep accepting prompts so a user mid-turn
   *  doesn't hit "session not ready" mid-stream just because the daemon
   *  is on its way out. */
  #draining = false;

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

  /** Sum of in-flight turns across all sessions. A turn registers itself
   *  in `sess.turns` when `prompt()` starts and removes itself in the
   *  finally block when the ACP child finishes streaming. drain() polls
   *  this to know when it's safe to exit. */
  activeTurnCount(): number {
    let n = 0;
    for (const s of this.#sessions.values()) n += s.turns.size;
    return n;
  }

  sessionCount(): number {
    return this.#sessions.size;
  }

  /** Re-announce alive sessions to the server (used after WS reconnect). */
  announceAll(): void {
    for (const [session_id, sess] of this.#sessions) {
      this.#send({ type: "session.ready", session_id, acp_session_id: sess.acpSessionId });
    }
  }

  async start(p: SessionStartParams): Promise<void> {
    // Refuse new sessions while we're draining for shutdown — the
    // server will see the error, mark the runtime briefly offline, and
    // route the next session.start to whichever daemon comes up next.
    // Existing sessions in this.#sessions keep working until drain
    // either completes them or hits the deadline.
    if (this.#draining) {
      this.#send({
        type: "session.error",
        session_id: p.session_id,
        turn_id: "",
        message: "daemon draining for restart — retry in a few seconds",
      });
      return;
    }
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

    // Canonicalize: an AgentConfig row may carry a pre-A2 alias (e.g.
    // "claude-code-acp" or "codex-cli"); resolveKnownAgent maps it to
    // the current canonical entry so the rest of the spawn logic stays
    // alias-blind.
    const agent = resolveKnownAgent(p.agent_id);
    if (!agent) {
      this.#send({
        type: "session.error",
        session_id: p.session_id,
        message: `unknown ACP agent: ${p.agent_id}`,
      });
      return;
    }
    if (agent.id !== p.agent_id) {
      process.stderr.write(
        `  ↪ canonicalized acp_agent_id ${p.agent_id} → ${agent.id} (legacy alias)\n`,
      );
    }

    // Verify the canonical binary is on PATH before spawning. Pre-A2 we
    // also tried a `legacySpec` fallback; that's been removed because it
    // hid the real problem (deprecated wrapper packages have known
    // protocol bugs) and because the daemon's detect() now reports
    // honestly — if an agent isn't on PATH the user shouldn't have been
    // able to pick it in the Console at all. Defense in depth: still
    // surface a clean error here in case detection went stale (e.g.
    // user uninstalled mid-session).
    const onPath = await new Promise<boolean>((resolve) => {
      const probe = process.platform === "win32" ? "where" : "which";
      const p = childSpawn(probe, [agent.spec.command], { stdio: "ignore" });
      p.once("error", () => resolve(false));
      p.once("exit", (code) => resolve(code === 0));
    });
    if (!onPath) {
      this.#send({
        type: "session.error",
        session_id: p.session_id,
        message:
          `binary not on PATH for ${agent.id}: \`${agent.spec.command}\`` +
          (agent.installHint ? `. Install: ${agent.installHint}` : ""),
      });
      return;
    }

    const sessionCwd = await ensureSessionCwd(p.session_id);

    // Fetch spawn-cwd bundle (AGENTS.md + .claude/skills/...) from main and
    // materialize before starting the ACP child. Bundle errors are non-fatal
    // — we still spawn; the agent just won't see OMA's prompt/skills.
    let blocklist: string[] = [];
    let bundleMcpServers: BundleMcpServer[] = [];
    let bundleEnv: BundleEnvVar[] = [];
    try {
      // Send the canonical id to main so the bundle generator picks the
      // right per-agent layout (.claude/skills vs .opencode/agents vs
      // inline) regardless of which alias the AgentConfig row stores.
      const bundle = await this.#fetchBundle(p.session_id, agent.id);
      if (bundle) {
        await writeBundle(sessionCwd, bundle.files);
        blocklist = bundle.local_skill_blocklist ?? [];
        bundleMcpServers = bundle.mcp_servers ?? [];
        bundleEnv = bundle.env ?? [];
      }
    } catch (e) {
      process.stderr.write(`  ! bundle fetch failed (non-fatal): ${(e as Error).message}\n`);
    }

    // For Claude Code we redirect ~/.claude → <cwd>/.claude-config so
    // the user's per-agent local-skill blocklist actually filters what
    // the child sees. Other ACP agents don't share Claude Code's
    // filesystem layout — leave their env untouched. Match by canonical
    // id so the legacy alias still gets the CLAUDE_CONFIG_DIR treatment.
    const extraEnv: Record<string, string | undefined> = {};
    if (agent.id === "claude-acp") {
      try {
        const cfgDir = await setupClaudeConfigDir(sessionCwd, new Set(blocklist));
        extraEnv.CLAUDE_CONFIG_DIR = cfgDir;
      } catch (e) {
        process.stderr.write(
          `  ! CLAUDE_CONFIG_DIR setup failed (non-fatal, child sees real ~/.claude): ${(e as Error).message}\n`,
        );
      }
    }

    // Bundle-supplied env vars merged on top of agent.spec.env and
    // CLAUDE_CONFIG_DIR. Order matters: bundleEnv comes from the user's
    // session resources (type=env), so it should override the ACP
    // agent's defaults but stay below CLAUDE_CONFIG_DIR (which is a
    // session-cwd routing concern, not user data).
    const envFromBundle: Record<string, string> = {};
    for (const v of bundleEnv) envFromBundle[v.name] = v.value;

    // ACP McpServer schema requires a name + url + headers array. We add
    // the Authorization header here, on the daemon side, so the agent
    // PAT never travels back through the bundle response from main.
    // stdio servers are intentionally not supported in this path — they'd
    // need a daemon-side spawner that doesn't exist yet.
    const mcpServersForAcp = bundleMcpServers.map((s) => ({
      type: s.type,
      name: s.name,
      url: s.url,
      headers: this.#env.apiKey
        ? [{ name: "Authorization", value: `Bearer ${this.#env.apiKey}` }]
        : [],
    }));

    process.stderr.write(
      `  → SessionManager.start ${agent.spec.command} cwd=${sessionCwd}` +
        (extraEnv.CLAUDE_CONFIG_DIR ? ` cfg=${extraEnv.CLAUDE_CONFIG_DIR}` : "") +
        (blocklist.length ? ` blocklist=${blocklist.length}` : "") +
        (mcpServersForAcp.length ? ` mcp=${mcpServersForAcp.length}` : "") +
        (bundleEnv.length ? ` env=${bundleEnv.length}` : "") +
        // Intentionally NOT logging env names or values — these come from
        // user-supplied session resources and may be sensitive even if not
        // formally encrypted. Only the count is observable.
        "\n",
    );

    try {
      const session = await this.#runtime.start({
        agent: {
          ...agent.spec,
          cwd: sessionCwd,
          env: scrubAcpSpawnEnv({ ...(agent.spec.env ?? {}), ...envFromBundle, ...extraEnv }),
        },
        mcpServers: mcpServersForAcp,
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

  /**
   * Graceful drain for upgrade/restart. Caller (daemon SIGTERM handler)
   * awaits this before exiting so in-flight ACP turns get to finish
   * naturally instead of being SIGTERM'd mid-stream.
   *
   * Recovery model — mirrors the cloud agent's DO-eviction recovery
   * (apps/agent/src/runtime/turn-runtime.ts:268 recoverAgentTurn):
   *
   *   1. Set #draining → start() rejects new sessions; server retries.
   *   2. Poll activeTurnCount every 200ms until either:
   *        - all turns drained naturally (clean session.complete) → break
   *        - deadline elapsed → abort remaining turns. Their prompt()
   *          loops unwind, emit session.error, and the ACP children
   *          checkpoint their conversation state to disk (each ACP
   *          implementation owns its own persistence; e.g. claude-acp
   *          stores into ~/.claude/projects/...).
   *   3. disposeAll() — KEEPS spawn cwds. Same shape as a clean
   *      shutdown.
   *
   * The next time the server sends session.start for any of these ids
   * it includes `resume.acp_session_id`. The new daemon respawns a
   * fresh ACP child in the preserved cwd and calls session/load to
   * restore conversation history (session-manager.ts:311 →
   * session.ts:108). Worst case the user re-prompts the cut-off turn;
   * partial response on their screen is the only artifact.
   *
   * Idempotent: a second call while one is in progress no-ops past the
   * existing drain.
   */
  async drain(deadlineMs: number, opts?: { onProgress?: (active: number, msLeft: number) => void }): Promise<{ initialTurns: number; abortedTurns: number; sessions: number }> {
    if (this.#draining) {
      const t0 = Date.now();
      while (this.#sessions.size > 0 && Date.now() - t0 < deadlineMs) {
        await new Promise((r) => setTimeout(r, 200));
      }
      return { initialTurns: 0, abortedTurns: 0, sessions: 0 };
    }
    this.#draining = true;
    const initialTurns = this.activeTurnCount();
    const initialSessions = this.#sessions.size;
    const t0 = Date.now();
    while (this.activeTurnCount() > 0) {
      const elapsed = Date.now() - t0;
      if (elapsed >= deadlineMs) break;
      opts?.onProgress?.(this.activeTurnCount(), deadlineMs - elapsed);
      await new Promise((r) => setTimeout(r, 200));
    }
    // Anything still streaming at deadline: abort the model call. The
    // ACP child sees the cancellation, checkpoints whatever conversation
    // state it tracks to its own on-disk store, and is then disposed by
    // disposeAll below. Recovery happens on the next session.start with
    // resume.acp_session_id (see method-level docstring).
    let aborted = 0;
    for (const sess of this.#sessions.values()) {
      for (const ctrl of sess.turns.values()) {
        ctrl.abort();
        aborted += 1;
      }
    }
    if (aborted > 0) {
      // Brief grace so each ACP child can flush its checkpoint to disk
      // before its stdio gets torn down by dispose. ~2s is generous —
      // claude-acp / codex-acp / opencode all persist on every event,
      // not at end-of-turn, so the on-disk state is already current.
      await new Promise((r) => setTimeout(r, 2000));
    }
    await this.disposeAll();
    return { initialTurns, abortedTurns: aborted, sessions: initialSessions };
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
 * session". claude-agent-acp aborts session/new with "cannot be launched
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
