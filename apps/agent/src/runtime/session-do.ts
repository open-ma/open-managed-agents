import { Agent } from "agents";
import type { Env } from "@open-managed-agents/shared";
import type {
  AgentConfig,
  EnvironmentConfig,
  CredentialConfig,
  SessionEvent,
  UserMessageEvent,
  UserInterruptEvent,
  UserToolConfirmationEvent,
  UserCustomToolResultEvent,
  UserDefineOutcomeEvent,
  OutcomeEvaluationEvent,
  AgentMessageEvent,
  AgentToolUseEvent,
} from "@open-managed-agents/shared";
import type { HarnessContext, HarnessInterface, HistoryStore, SandboxExecutor, ProcessHandle } from "../harness/interface";
import { resolveHarness } from "../harness/registry";
import { resolveModel } from "../harness/provider";
import type { ApiCompat } from "../harness/provider";
import type { LanguageModel } from "ai";
import { evaluateOutcome } from "../harness/outcome-evaluator";
import { buildTools, buildMemoryTools } from "../harness/tools";
import { MemoryStoreService } from "@open-managed-agents/memory-store";
import { buildCfServices, getCfServicesForTenant } from "@open-managed-agents/services";
import { toEnvironmentConfig } from "@open-managed-agents/environments-store";
import { resolveSkills, resolveCustomSkills, getSkillFiles } from "../harness/skills";
import { resolveAppendablePrompts } from "./appendable-prompts";
import { createBrowserSession, type BrowserSession } from "../harness/browser-tools";
import { SqliteHistory, InMemoryHistory } from "./history";
import { createSandbox, CloudflareSandbox } from "./sandbox";
import { mountResources } from "./resource-mounter";
import { spawnStdioMcpServers, type StdioMcpConfig } from "./mcp-spawner";

interface SessionInitParams {
  agent_id: string;
  environment_id: string;
  title: string;
  session_id?: string;
  tenant_id?: string;
  vault_ids?: string[];
  /**
   * Pre-fetched tenant config snapshots passed in by the main worker. Lets
   * SessionDO avoid reading CONFIG_KV with `t:tenantId:...` keys directly —
   * which is wrong when the SessionDO worker is bound to a different KV
   * namespace than the writing worker (e.g. shared sandbox-default serving
   * both prod and staging mains). Optional for backward compat: when absent,
   * SessionDO falls back to its own CONFIG_KV.
   */
  agent_snapshot?: AgentConfig;
  environment_snapshot?: EnvironmentConfig;
  /**
   * Pre-fetched credentials grouped by vault id. Mirrors what SessionDO would
   * otherwise read via `CONFIG_KV.list({ prefix: t:tenantId:cred:vaultId: })`.
   */
  vault_credentials?: Array<{ vault_id: string; credentials: CredentialConfig[] }>;
  /**
   * Generic per-event POST hooks. Each hook gets the canonical SessionEvent
   * verbatim on every broadcast. Use for provider-specific side effects
   * (Linear AgentActivity mirror, Slack thread mirror, observability
   * pipelines). SessionDO is provider-agnostic — the main worker sets
   * these up at /init based on session metadata.
   */
  event_hooks?: Array<{
    name: string;
    url: string;
    auth?: string;
  }>;
  /**
   * Pre-flight events to seed the session event stream at /init time.
   * Used by the main worker to surface warnings (e.g. failed pre-session
   * credential refreshes) the user should see in the console without
   * hard-failing session start. Each event is appended to SQLite + WS-broadcast
   * + fan-out to event_hooks, in order, before /init returns.
   */
  init_events?: SessionEvent[];
}

/**
 * Pending tool call data stored in session metadata so that
 * tool confirmation/custom tool result events can resume execution.
 */
interface PendingToolCall {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

/**
 * Persistent session state managed by Agent's setState/state system.
 * Automatically persisted to SQLite and broadcast to WebSocket clients.
 */
interface SessionState {
  agent_id: string;
  environment_id: string;
  session_id: string;
  tenant_id: string;
  title: string;
  status: "idle" | "running" | "terminated";
  input_tokens: number;
  output_tokens: number;
  vault_ids: string[];
  pending_tool_calls: PendingToolCall[];
  outcome: { description: string; rubric?: string; max_iterations?: number } | null;
  outcome_iteration: number;
  /**
   * Tenant config snapshots provided at /init by main worker. Used by
   * getAgentConfig/getEnvConfig/getVaultCredentials so SessionDO doesn't
   * need to read tenant-scoped CONFIG_KV keys directly. Optional —
   * absence triggers KV fallback for backward compat with prod.
   */
  agent_snapshot?: AgentConfig;
  environment_snapshot?: EnvironmentConfig;
  vault_credentials?: Array<{ vault_id: string; credentials: CredentialConfig[] }>;
  /** Per-event POST hooks. See SessionInitParams.event_hooks. Currently
   *  unused in production — Linear's auto-mirror was removed in M7 — but
   *  the wiring stays so the harness fanout machinery stays compilable. */
  event_hooks?: Array<{ name: string; url: string; auth?: string }>;
  /**
   * One-shot guard: harness.onSessionInit must run exactly once, before the
   * first user-message-driven turn. Set true after the call lands so resumes
   * / restarts don't re-inject reminders (which would write duplicate cached
   * prefix bytes and bust the cache).
   */
  session_init_done?: boolean;
}

const INITIAL_SESSION_STATE: SessionState = {
  agent_id: "",
  environment_id: "",
  session_id: "",
  tenant_id: "default",
  title: "",
  status: "idle",
  input_tokens: 0,
  output_tokens: 0,
  vault_ids: [],
  pending_tool_calls: [],
  outcome: null,
  outcome_iteration: 0,
};

/**
 * SessionDO is the "meta-harness" — it owns the event log, WebSocket
 * connections, and runtime primitives. It resolves a concrete harness
 * via the registry and delegates message processing to it, without
 * knowing anything about the harness implementation.
 *
 * Sandbox lifecycle: one sandbox per session, created on first event,
 * reused across turns, destroyed on session delete/terminate.
 */
export class SessionDO extends Agent<Env, SessionState> {
  // 30s keepAlive heartbeat (also the agents-lib default) — held automatically
  // for the duration of any runFiber() callback. Prevents idle DO eviction
  // during long generateText turns.
  static options = { keepAliveIntervalMs: 30_000 };

  initialState = INITIAL_SESSION_STATE;

  /** Build a tenant-scoped KV key */
  private tk(...parts: string[]): string {
    return `t:${this.state.tenant_id}:${parts.join(":")}`;
  }

  /**
   * Resolve an agent config. Prefers the snapshot passed at /init; falls back
   * to a tenant-scoped CONFIG_KV read for backward compat or for agentIds that
   * weren't pre-snapshotted (e.g. sub-agents). Returns null on miss.
   *
   * Why this exists: sandbox-default's CONFIG_KV binding may point at a
   * different namespace than the worker that wrote the agent (e.g. shared
   * sandbox serving both prod-main and staging-main). Snapshots flow the
   * data through the init body and avoid the KV cross-binding issue.
   */
  private async getAgentConfig(agentId: string): Promise<AgentConfig | null> {
    if (this.state.agent_snapshot && agentId === this.state.agent_id) {
      return this.state.agent_snapshot;
    }
    // Cross-tenant lookup — DO has no tenant scope here. Trusts the caller.
    // Phase 1: still queries against the shared AUTH_DB. Phase 4: per-tenant
    // DB will scope this naturally — `WHERE id = ?` in the tenant's DB only
    // returns the tenant's row. Either way, this.state.tenant_id is the
    // right routing key.
    const services = await getCfServicesForTenant(this.env, this.state.tenant_id);
    const row = await services.agents.getById({ agentId });
    if (!row) return null;
    const { tenant_id: _t, ...config } = row;
    return config;
  }

  /** Same idea as getAgentConfig but for environments. */
  private async getEnvConfig(envId: string): Promise<EnvironmentConfig | null> {
    if (this.state.environment_snapshot && envId === this.state.environment_id) {
      return this.state.environment_snapshot;
    }
    const services = await getCfServicesForTenant(this.env, this.state.tenant_id);
    const row = await services.environments.get({
      tenantId: this.state.tenant_id,
      environmentId: envId,
    });
    return row ? toEnvironmentConfig(row) : null;
  }

  /**
   * Resolve all credentials for the listed vaults. Prefers the pre-fetched
   * snapshot from /init; falls back to KV list/get loops if absent.
   */
  private async getVaultCredentials(
    vaultIds: string[],
  ): Promise<CredentialConfig[]> {
    const fromSnapshot = this.state.vault_credentials;
    if (fromSnapshot) {
      const snapshotMap = new Map(fromSnapshot.map((v) => [v.vault_id, v.credentials]));
      const out: CredentialConfig[] = [];
      for (const vaultId of vaultIds) {
        const creds = snapshotMap.get(vaultId);
        if (creds) out.push(...creds);
      }
      return out;
    }
    // Fallback: KV list/get loop. Mirrors the original logic at the call sites.
    const out: CredentialConfig[] = [];
    for (const vaultId of vaultIds) {
      const credList = await this.env.CONFIG_KV.list({ prefix: this.tk("cred", vaultId) + ":" });
      for (const k of credList.keys) {
        const credData = await this.env.CONFIG_KV.get(k.name);
        if (!credData) continue;
        try {
          out.push(JSON.parse(credData) as CredentialConfig);
        } catch {
          // skip malformed
        }
      }
    }
    return out;
  }

  // Disable Agent's observability to avoid SpanParent I/O isolation
  // errors in vitest-pool-workers (multiple DOs share one isolate).
  observability = null as unknown as Agent<Env, SessionState>["observability"];
  private initialized = false;
  private sandbox: SandboxExecutor | null = null;
  private sandboxWarmupPromise: Promise<void> | null = null;
  /**
   * Browser session backed by Cloudflare Browser Rendering binding. Lazy-created
   * on first browser_* tool call (in-memory only — recreated if DO hibernates).
   * Closed on /destroy.
   */
  private browserSession: BrowserSession | null = null;
  /**
   * Localhost URLs of stdio MCP servers spawned in the sandbox during warmup.
   * Indexed by mcp_servers[].name. Used to fix up the agent.mcp_servers entry
   * before each buildTools() call so the curl-based MCP wiring talks to the
   * right port.
   */
  private spawnedMcpUrls: Map<string, string> = new Map();
  private threads = new Map<string, { agentId: string; agentConfig: AgentConfig }>();
  private currentAbortController: AbortController | null = null;

  private ensureSchema() {
    if (this.initialized) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        ts TEXT DEFAULT (datetime('now'))
      )
    `);
    this.initialized = true;
  }

  /**
   * Scheduled recovery callback: called by Agent's schedule system
   * 5 seconds after an event is received. If the primary waitUntil
   * path already drained the queue, this is a no-op.
   */
  async recoverEventQueue(): Promise<void> {
    this.ensureSchema();
    await this.drainEventQueue();
  }

  /**
   * Called by the agents library when a runFiber row in cf_agents_runs
   * survives DO restart (i.e. the fiber was interrupted by eviction). For
   * us, fibers are named "turn:{seq}" — one per drain iteration. Recovery
   * strategy: emit a status_rescheduled marker so observers can see a
   * recovery happened, reset stale state.status, then re-drain. The
   * unprocessed user.message at seq is still pending (we never emitted
   * status_idle for it) so drain re-runs the harness, and generateText
   * sees prior tool_use/tool_result rows in history and continues from
   * roughly where it left off (at-least-once semantics — a tool may be
   * re-decided once, but no tool effect is lost since each result is in
   * SQL).
   */
  async onFiberRecovered(ctx: { id: string; name: string; snapshot: unknown }): Promise<void> {
    if (!ctx.name.startsWith("turn:")) {
      console.warn(`[fiber-recover] unknown fiber: ${ctx.name}`);
      return;
    }
    console.warn(
      `[fiber-recover] turn fiber ${ctx.name} (id=${ctx.id}) interrupted; re-draining. ` +
        `snapshot=${JSON.stringify(ctx.snapshot)}`,
    );
    this.ensureSchema();

    // Persisted state from before eviction is stale — clear it so drain
    // doesn't see status="running" and skip.
    if (this.state.status === "running") {
      this.setState({ ...this.state, status: "idle" });
    }

    // Audit marker so the trajectory shows we recovered (vs silently
    // re-running). Doesn't change scoring.
    const history = new SqliteHistory(this.ctx.storage.sql);
    const reschedEvent: SessionEvent = {
      type: "session.status_rescheduled",
      reason: `Recovered after DO eviction (fiber ${ctx.name})`,
    };
    history.append(reschedEvent);
    this.broadcastEvent(reschedEvent);

    await this.drainEventQueue();
  }

  /**
   * Drain the event queue: check the events table for unprocessed user
   * events and run the harness for each one.
   *
   * The events table IS the queue — no separate pending flag needed.
   * After the harness completes a turn, we check again for new events
   * that arrived during execution, looping until the queue is drained.
   *
   * Concurrency guard: if status is already "running", skip — another
   * drainEventQueue is already active.
   */
  private async drainEventQueue(): Promise<void> {
    // Concurrency guard — only one drain loop at a time
    if (this.state.status === "running" || this.state.status === "terminated") {
      console.log(`[drain] skipped: status=${this.state.status}`);
      return;
    }

    console.log("[drain] starting");
    const history = new SqliteHistory(this.ctx.storage.sql);

    while (true) {
      const lastIdleSeq = Math.max(
        this.getLastEventSeq("session.status_idle"),
        this.getLastEventSeq("session.error"),
      );
      const pendingUserEvent = this.getFirstEventAfter(lastIdleSeq, [
        "user.message",
        "user.tool_confirmation",
        "user.custom_tool_result",
      ]);

      if (!pendingUserEvent) {
        console.log("[drain] queue empty, done");
        break;
      }

      console.log(`[drain] processing event seq=${pendingUserEvent.seq}`);
      this.setState({ ...this.state, status: "running" });

      try {
        const event = JSON.parse(pendingUserEvent.data) as SessionEvent;

        // Wrap each turn's work in a durable fiber so:
        //  - keepAlive() heartbeat protects against idle DO eviction
        //  - cf_agents_runs row is created at start, deleted on success
        //  - if interrupted, onFiberRecovered fires on DO restart and we
        //    re-drain (history-based replay — generateText sees prior
        //    tool_use/tool_result rows and continues)
        await this.runFiber(`turn:${pendingUserEvent.seq}`, async (ctx) => {
          ctx.stash({ user_event_seq: pendingUserEvent.seq, type: event.type });

          if (event.type === "user.message") {
            await this.processUserMessage(event as UserMessageEvent);
          } else if (event.type === "user.tool_confirmation") {
            await this.handleToolConfirmation(event as UserToolConfirmationEvent, history);
          } else if (event.type === "user.custom_tool_result") {
            const customResult = event as UserCustomToolResultEvent;
            const toolResultEvent: SessionEvent = {
              type: "agent.tool_result",
              tool_use_id: customResult.custom_tool_use_id,
              content: customResult.content.map(b => b.type === "text" ? b.text : "").join(""),
            };
            history.append(toolResultEvent);
            this.broadcastEvent(toolResultEvent);
            const resumeMsg: UserMessageEvent = {
              type: "user.message",
              content: [{ type: "text", text: "" }],
            };
            await this.processUserMessage(resumeMsg, 0, true);
          }
        });
      } catch (err) {
        const errorMsg = this.describeError(err);
        const errorEvent: SessionEvent = { type: "session.error", error: errorMsg };
        history.append(errorEvent);
        this.broadcastEvent(errorEvent);
        this.setState({ ...this.state, status: "idle" });
        break; // Stop draining on error — let the client decide what to do
      }
    }
  }

  /**
   * Get the sequence number of the last event of a given type.
   * Returns 0 if no such event exists.
   */
  private getLastEventSeq(type: string): number {
    const result = this.ctx.storage.sql.exec(
      "SELECT seq FROM events WHERE type = ? ORDER BY seq DESC LIMIT 1",
      type
    );
    for (const row of result) return row.seq as number;
    return 0;
  }

  /**
   * Get the first event after a given sequence number matching any of the given types.
   * Returns null if no matching event exists.
   */
  private getFirstEventAfter(afterSeq: number, types: string[]): { seq: number; data: string } | null {
    const placeholders = types.map(() => "?").join(", ");
    const result = this.ctx.storage.sql.exec(
      `SELECT seq, data FROM events WHERE seq > ? AND type IN (${placeholders}) ORDER BY seq ASC LIMIT 1`,
      afterSeq,
      ...types,
    );
    for (const row of result) return { seq: row.seq as number, data: row.data as string };
    return null;
  }

  /**
   * Override fetch to keep our custom HTTP routing.
   * Agent (via partyserver) auto-handles WebSocket upgrades and calls
   * onRequest() for HTTP — but we have custom routing for both, so we
   * handle everything here and only delegate alarm() to Agent's scheduler.
   */
  async fetch(request: Request): Promise<Response> {
    this.ensureSchema();
    const url = new URL(request.url);

    // PUT /init — initialize session
    if (request.method === "PUT" && url.pathname === "/init") {
      const params = (await request.json()) as SessionInitParams;
      this.setState({
        ...this.state,
        agent_id: params.agent_id,
        environment_id: params.environment_id,
        title: params.title,
        session_id: params.session_id || this.state.session_id,
        tenant_id: params.tenant_id ?? "default",
        vault_ids: params.vault_ids ?? [],
        agent_snapshot: params.agent_snapshot,
        environment_snapshot: params.environment_snapshot,
        vault_credentials: params.vault_credentials,
        event_hooks: params.event_hooks,
        status: "idle",
      });

      // Outbound proxy view: untenanted snapshot keyed only by sessionId.
      // The outbound worker only knows sessionId from the container context;
      // it can't construct the tenant-prefixed `t:{tenantId}:cred:...` keys
      // that prod uses, so without this side-write its lookups always miss
      // and credentials never get injected. See apps/agent/src/outbound.ts.
      //
      // 24h TTL (defaulted by the service) bounds the leftover when the
      // explicit /destroy cleanup below doesn't run (DO eviction, sandbox
      // crash, force-terminate). The blob contains plaintext OAuth material
      // so we don't want it lingering beyond a realistic max session lifetime.
      if (params.session_id && (params.vault_credentials?.length ?? 0) > 0) {
        // outboundSnapshots is KV-backed; AUTH_DB is fine.
        await buildCfServices(this.env, this.env.AUTH_DB).outboundSnapshots.publish({
          sessionId: params.session_id,
          snapshot: {
            tenant_id: params.tenant_id ?? "default",
            vault_ids: params.vault_ids ?? [],
            vault_credentials: params.vault_credentials!,
          },
        });
      }

      // Pre-flight events from main worker (e.g. credential refresh warnings).
      // Append in order so the console renders them as the first items in the
      // session timeline. Use persistAndBroadcastEvent so each event also
      // fans out to event_hooks (Linear panel mirror, etc.) — state was just
      // set above so event_hooks is populated by the time we get here.
      if (params.init_events?.length) {
        for (const ev of params.init_events) {
          this.persistAndBroadcastEvent(ev);
        }
      }

      // Pre-warm sandbox in background (container start + package install)
      // Errors are swallowed — warmup is best-effort
      this.ctx.waitUntil(this.warmUpSandbox());

      return new Response("ok");
    }

    // DELETE /destroy — tear down sandbox and clean up
    if (request.method === "DELETE" && url.pathname === "/destroy") {
      // Abort any running harness
      if (this.currentAbortController) {
        this.currentAbortController.abort();
        this.currentAbortController = null;
      }
      // Destroy the sandbox container (kills processes, unmounts, stops container)
      if (this.sandbox?.destroy) {
        try { await this.sandbox.destroy(); } catch {}
      }
      this.sandbox = null;
      this.sandboxWarmupPromise = null;
      // Close the browser session if one was created
      if (this.browserSession) {
        try { await this.browserSession.close(); } catch {}
        this.browserSession = null;
      }
      // Drop the outbound credential snapshot — its TTL would clean it up
      // eventually, but explicit deletion here keeps the keyspace tidy on
      // the normal teardown path and shrinks the leak window for plaintext
      // OAuth material.
      if (this.state.session_id) {
        try {
          // KV-backed; AUTH_DB is fine.
          await buildCfServices(this.env, this.env.AUTH_DB).outboundSnapshots.delete({
            sessionId: this.state.session_id,
          });
        } catch {}
      }
      this.setState({ ...this.state, status: "terminated" });

      const terminatedEvent: SessionEvent = {
        type: "session.status_terminated",
        reason: "session_deleted",
      };
      const history = new SqliteHistory(this.ctx.storage.sql);
      history.append(terminatedEvent);
      this.broadcastEvent(terminatedEvent);

      return new Response("ok");
    }

    // POST /event — receive user event, kick off harness
    if (request.method === "POST" && url.pathname === "/event") {
      const raw = (await request.json()) as SessionEvent & { _mount_file_ids?: string[] };
      // Sidecar field set by main worker's events POST resolver. Strip it
      // before persisting — it is delivery metadata, not part of the canonical
      // event schema.
      const mountFileIds = raw._mount_file_ids;
      delete (raw as { _mount_file_ids?: string[] })._mount_file_ids;
      const body = raw as SessionEvent;
      const history = new SqliteHistory(this.ctx.storage.sql);

      // Auto-mount referenced files into the sandbox FS so agent's bash/read
      // tools see them at /mnt/session/uploads/{file_id}, while the model
      // already sees the inline base64 from the resolver. Mirrors Anthropic
      // managed-agents dual path. Best-effort — failure does not block the
      // event from being processed.
      if (mountFileIds && mountFileIds.length > 0 && this.env.FILES_BUCKET) {
        const sandbox = this.getOrCreateSandbox();
        try { await this.warmUpSandbox(); } catch {}
        const tenantId = this.state.tenant_id;
        try { await sandbox.exec("mkdir -p /mnt/session/uploads", 5000); } catch {}
        for (const fid of mountFileIds) {
          try {
            const obj = await this.env.FILES_BUCKET.get(`t/${tenantId}/files/${fid}`);
            if (!obj) continue;
            const buf = await obj.arrayBuffer();
            const path = `/mnt/session/uploads/${fid}`;
            if (sandbox.writeFileBytes) {
              await sandbox.writeFileBytes(path, new Uint8Array(buf));
            } else {
              await sandbox.writeFile(
                path,
                new TextDecoder("utf-8").decode(new Uint8Array(buf)),
              );
            }
          } catch (err) {
            console.warn(`[auto-mount] file_id=${fid} failed:`, err);
          }
        }
      }

      if (body.type === "user.message") {
        history.append(body);
        this.broadcastEvent(body);
        try {
          await this.schedule(5, "recoverEventQueue");
        } catch {}
        console.log("[post /event] user.message appended, firing drainEventQueue (no await)");
        this.drainEventQueue();
        console.log("[post /event] returning 202");
        return new Response(null, { status: 202 });
      }

      if (body.type === "user.interrupt") {
        // Abort the running harness
        if (this.currentAbortController) {
          this.currentAbortController.abort();
          this.currentAbortController = null;
        }
        this.setState({ ...this.state, status: "idle" });
        const idleEvent: SessionEvent = { type: "session.status_idle" };
        history.append(body as UserInterruptEvent);
        history.append(idleEvent);
        this.broadcastEvent(idleEvent);
        return new Response(null, { status: 202 });
      }

      if (body.type === "user.tool_confirmation") {
        history.append(body as UserToolConfirmationEvent);
        this.broadcastEvent(body);
        try {
          await this.schedule(5, "recoverEventQueue");
        } catch {}
        console.log("[post /event] tool_confirmation appended, firing drainEventQueue (no await)");
        this.drainEventQueue();
        return new Response(null, { status: 202 });
      }

      if (body.type === "user.custom_tool_result") {
        const customResult = body as UserCustomToolResultEvent;
        history.append(customResult);
        this.broadcastEvent(customResult);
        try {
          await this.schedule(5, "recoverEventQueue");
        } catch {}
        console.log("[post /event] custom_tool_result appended, firing drainEventQueue (no await)");
        this.drainEventQueue();
        return new Response(null, { status: 202 });
      }

      if (body.type === "user.define_outcome") {
        const e = body as UserDefineOutcomeEvent;
        this.setState({ ...this.state, outcome: { description: e.description, rubric: e.rubric, max_iterations: e.max_iterations }, outcome_iteration: 1 });
        history.append(e);
        this.broadcastEvent(e);
        return new Response(null, { status: 202 });
      }

      return new Response("Unknown event type", { status: 400 });
    }

    // GET /ws — WebSocket upgrade
    if (request.method === "GET" && url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);

      // Replay existing events to new connection
      const history = new SqliteHistory(this.ctx.storage.sql);
      const events = history.getEvents();
      for (const event of events) {
        pair[1].send(JSON.stringify(event));
      }

      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // GET /status
    if (request.method === "GET" && url.pathname === "/status") {
      return Response.json({
        status: this.state.status,
        agent_id: this.state.agent_id,
        environment_id: this.state.environment_id,
        usage: {
          input_tokens: this.state.input_tokens,
          output_tokens: this.state.output_tokens,
        },
      });
    }

    // GET /events — paginated event list
    if (request.method === "GET" && url.pathname === "/events") {
      const limitParam = url.searchParams.get("limit");
      let limit = limitParam ? parseInt(limitParam, 10) : 100;
      if (isNaN(limit) || limit < 1) limit = 100;
      if (limit > 1000) limit = 1000;

      const order = url.searchParams.get("order") === "desc" ? "DESC" : "ASC";
      const afterSeqParam = url.searchParams.get("after_seq");
      const afterSeq = afterSeqParam ? parseInt(afterSeqParam, 10) : 0;

      // Fetch limit + 1 to determine has_more
      const query = `SELECT seq, type, data, ts FROM events WHERE seq > ? ORDER BY seq ${order} LIMIT ?`;
      const rows = this.ctx.storage.sql
        .exec(query, afterSeq, limit + 1)
        .toArray();

      const hasMore = rows.length > limit;
      const resultRows = hasMore ? rows.slice(0, limit) : rows;

      const events = resultRows.map((row) => ({
        seq: row.seq,
        type: row.type,
        data: JSON.parse(row.data as string),
        ts: row.ts,
      }));

      const lastSeq = resultRows.length > 0 ? resultRows[resultRows.length - 1].seq : null;
      return Response.json({
        data: events,
        has_more: hasMore,
        next_page: hasMore && lastSeq !== null ? `seq_${lastSeq}` : null,
      });
    }

    // POST /usage — increment token usage counters
    if (request.method === "POST" && url.pathname === "/usage") {
      const body = (await request.json()) as {
        input_tokens: number;
        output_tokens: number;
      };

      const newInput = this.state.input_tokens + (body.input_tokens || 0);
      const newOutput = this.state.output_tokens + (body.output_tokens || 0);
      this.setState({ ...this.state, input_tokens: newInput, output_tokens: newOutput });

      return Response.json({
        input_tokens: newInput,
        output_tokens: newOutput,
      });
    }

    // GET /threads — list all threads in this session
    if (request.method === "GET" && url.pathname === "/threads") {
      const threadList = Array.from(this.threads.entries()).map(([id, t]) => ({
        session_thread_id: id,
        agent_id: t.agentId,
        agent_name: t.agentConfig.name,
      }));
      return Response.json({ data: threadList });
    }

    // GET /threads/:thread_id/events — events for a specific thread
    const threadEventsMatch = url.pathname.match(/^\/threads\/([^/]+)\/events$/);
    if (request.method === "GET" && threadEventsMatch) {
      const threadId = threadEventsMatch[1];
      const history = new SqliteHistory(this.ctx.storage.sql);
      const allEvents = history.getEvents();
      const threadEvents = allEvents.filter((e: any) => e.thread_id === threadId);
      return Response.json({ data: threadEvents });
    }

    // GET /full-status — session status with usage and outcome evaluations
    if (request.method === "GET" && url.pathname === "/full-status") {
      const history = new SqliteHistory(this.ctx.storage.sql);
      const allEvents = history.getEvents();

      // Collect outcome evaluations
      const outcomeEvaluations = allEvents
        .filter((e) => e.type === "session.outcome_evaluated")
        .map((e: any) => ({
          result: e.result,
          iteration: e.iteration,
          feedback: e.feedback,
        }));

      return Response.json({
        status: this.state.status,
        usage: {
          input_tokens: this.state.input_tokens,
          output_tokens: this.state.output_tokens,
        },
        outcome_evaluations: outcomeEvaluations,
      });
    }

    // GET /file?path=... — read a file from the sandbox FS as raw bytes.
    // Used by main worker's POST /v1/sessions/:id/files (container_upload):
    // promotes an agent-emitted artefact to a first-class file_id.
    if (request.method === "GET" && url.pathname === "/file") {
      const path = url.searchParams.get("path");
      if (!path) return new Response("path query param required", { status: 400 });
      try {
        const sandbox = this.getOrCreateSandbox();
        // SandboxExecutor.readFile returns string (UTF-8 decoded). For binary
        // safety we call the underlying SDK's base64 read directly.
        // Workaround until we widen SandboxExecutor with readFileBytes:
        // ask sandbox to base64 the file via shell, then decode here.
        const out = await sandbox.exec(
          `base64 -w0 -- '${path.replace(/'/g, "'\\''")}' 2>&1`,
          15000,
        );
        // exec returns "exit=N\n<stdout>"
        const m = out.match(/^exit=(\d+)\n([\s\S]*)$/);
        if (!m || m[1] !== "0") {
          return new Response(`read failed: ${out.slice(0, 300)}`, { status: 404 });
        }
        const b64 = m[2].trim();
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Response(bytes, {
          headers: { "Content-Type": "application/octet-stream" },
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(`read error: ${msg}`, { status: 500 });
      }
    }

    return new Response("Not found", { status: 404 });
  }

  // WebSocket Hibernation API handlers
  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer) {
    // Client-to-DO messages not used in Phase 1
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean
  ) {
    ws.close();
  }

  /**
   * Get or create the session's sandbox. Singleton per session — reused
   * across turns so files persist within the session lifetime.
   */
  private getOrCreateSandbox(): SandboxExecutor {
    if (!this.sandbox) {
      // Sandbox ID must be 1-63 chars; DO hex ID is 64 chars — truncate to fit
      const sandboxId = this.ctx.id.toString().slice(0, 63);
      this.sandbox = createSandbox(this.env, sandboxId);
    }
    return this.sandbox;
  }

  /**
   * Lazy-create a single BrowserSession for this DO. Returns null if the
   * BROWSER binding isn't configured (no-op for non-browser environments).
   */
  private getBrowserSession(): BrowserSession | null {
    if (!this.env.BROWSER) return null;
    if (!this.browserSession) {
      this.browserSession = createBrowserSession(this.env.BROWSER as unknown as { fetch: typeof fetch });
    }
    return this.browserSession;
  }

  /**
   * Spawn any stdio-mode MCP servers declared on the session's agent config.
   * Idempotent — if the spawned URL is already recorded for a server name,
   * we skip. Records each spawned server's localhost URL on this.spawnedMcpUrls
   * so applyMcpUrlFixups can patch agent.mcp_servers before buildTools.
   */
  private async spawnSessionStdioMcps(sandbox: SandboxExecutor): Promise<void> {
    const agentId = this.state.agent_id;
    if (!agentId || !this.env.CONFIG_KV) return;
    const agent = await this.getAgentConfig(agentId);
    if (!agent) return;
    const mcps = agent.mcp_servers || [];
    const stdios: StdioMcpConfig[] = [];
    for (const s of mcps) {
      if (!s.stdio) continue;
      if (this.spawnedMcpUrls.has(s.name)) continue;
      stdios.push({ name: s.name, ...s.stdio });
    }
    if (stdios.length === 0) return;
    try {
      const spawned = await spawnStdioMcpServers(sandbox, stdios);
      for (const sp of spawned) this.spawnedMcpUrls.set(sp.name, sp.url);
    } catch (err) {
      // Best-effort: log but don't fail the whole warmup.
      console.error("[mcp-spawner]", err);
    }
  }

  /**
   * Mutate agent.mcp_servers in place so any stdio entry has its `url` set
   * to the localhost URL we spawned it on. No-op if no spawned URLs are
   * recorded yet (warmup hasn't run, or no stdio MCPs configured).
   */
  private applyMcpUrlFixups(agent: AgentConfig): AgentConfig {
    if (this.spawnedMcpUrls.size === 0) return agent;
    if (!agent.mcp_servers) return agent;
    const patched = agent.mcp_servers.map((s) => {
      const url = this.spawnedMcpUrls.get(s.name);
      return url ? { ...s, url } : s;
    });
    return { ...agent, mcp_servers: patched };
  }

  /**
   * Pre-warm the sandbox: run a no-op command to trigger container startup,
   * then install environment packages if configured.
   * Returns a promise that resolves when warmup is complete.
   * Multiple callers share the same promise — warmup runs exactly once.
   */
  private warmUpSandbox(): Promise<void> {
    if (!this.sandboxWarmupPromise) {
      this.sandboxWarmupPromise = this.doWarmUpSandbox().catch((err) => {
        // Clear cached promise on failure so next call retries
        this.sandboxWarmupPromise = null;
        throw err;
      });
    }
    return this.sandboxWarmupPromise;
  }

  private async doWarmUpSandbox(): Promise<void> {

    try {
      const sandbox = this.getOrCreateSandbox();

      // Trigger container startup with retries — local dev containers can take
      // 30-60s to start. SDK returns 503 while container port isn't listening.
      // See: https://github.com/cloudflare/containers/issues/155
      let ready = false;
      let lastError = "";
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          await sandbox.exec("true");
          ready = true;
          break;
        } catch (err: any) {
          lastError = err?.message || String(err);
          const delay = 3000 * Math.pow(1.5, attempt);
          await new Promise(r => setTimeout(r, Math.min(delay, 15000)));
        }
      }
      if (!ready) {
        throw new Error(`Sandbox container failed to start after 10 attempts. Last error: ${lastError}`);
      }

      // Mount R2-backed /workspace for persistent file storage
      if (sandbox instanceof CloudflareSandbox) {
        await sandbox.mountWorkspace();
      }

      // Install environment packages if configured
      const envId = this.state.environment_id;
      if (envId) {
        const envConfig = await this.getEnvConfig(envId);
        if (envConfig) {
          const pkgs = envConfig.config?.packages;
          if (pkgs) {
            const cmds: string[] = [];
            if (pkgs.apt?.length) cmds.push(`apt-get update -qq && apt-get install -y -qq ${pkgs.apt.join(" ")}`);
            if (pkgs.pip?.length) cmds.push(`pip install -q ${pkgs.pip.join(" ")}`);
            if (pkgs.npm?.length) cmds.push(`npm install -g ${pkgs.npm.join(" ")}`);
            if (pkgs.cargo?.length) cmds.push(`cargo install ${pkgs.cargo.join(" ")}`);
            if (pkgs.gem?.length) cmds.push(`gem install ${pkgs.gem.join(" ")}`);
            if (pkgs.go?.length) cmds.push(`go install ${pkgs.go.join(" ")}`);
            if (cmds.length > 0) {
              await sandbox.exec(cmds.join(" && "), 120000);
            }
          }
        }
      }

      // Spawn stdio MCP servers in the sandbox if the agent uses any. The
      // spawned process binds on 127.0.0.1 + records the URL so subsequent
      // buildTools calls point the curl-based MCP wiring at it.
      await this.spawnSessionStdioMcps(sandbox);

      // Mount all session resources (files, git repos, env secrets)
      const sessionId = this.state.session_id;
      if (sessionId) {
        // Sessions-store reads via the session_id PRIMARY KEY index, no
        // tenant prefix needed — fixes the staging-kv namespace mismatch
        // the legacy CONFIG_KV.list path tripped over.
        const services = await getCfServicesForTenant(this.env, this.state.tenant_id);
        const rows = await services.sessions.listResourcesBySession({ sessionId });
        const resources: Array<Record<string, unknown>> = [];
        const secretStore = new Map<string, string>();

        for (const row of rows) {
          resources.push(row.resource as unknown as Record<string, unknown>);
          // Secret payloads (env_secret.value, github_repository.token) live
          // in the per-session secret store, keyed by (tenant, session, resource).
          const secretData = await services.sessionSecrets.get({
            tenantId: this.state.tenant_id,
            sessionId,
            resourceId: row.id,
          });
          if (secretData) secretStore.set(row.id, secretData);
        }

        if (resources.length) {
          await mountResources(
            sandbox,
            resources,
            this.env.CONFIG_KV,
            secretStore,
            this.env.FILES_BUCKET,
            this.state.tenant_id,
          );
        }
      }

      // Register command_secret credentials from vaults
      const vaultIds = this.state.vault_ids;
      if (vaultIds.length && sandbox.registerCommandSecrets) {
        const creds = await this.getVaultCredentials(vaultIds);
        for (const cred of creds) {
          if (cred.auth?.type === "command_secret" && cred.auth.command_prefixes?.length && cred.auth.env_var && cred.auth.token) {
            for (const prefix of cred.auth.command_prefixes) {
              sandbox.registerCommandSecrets(prefix, { [cred.auth.env_var]: cred.auth.token });
            }
          }
        }
      }

      // Bind the outbound handler with vault credentials so MCP/static_bearer
      // tokens get injected into outbound HTTPS as Authorization headers.
      // See apps/agent/src/oma-sandbox.ts for the handler implementation.
      // Gate purely on vault_credentials presence — vaultIds can be empty
      // when callers (e.g. apps/main /sessions for Linear-triggered sessions)
      // synthesize a vault_id-less credential entry that still needs outbound
      // header injection.
      if (sandbox.setVaultCredentialsForOutbound && this.state.vault_credentials?.length) {
        await sandbox.setVaultCredentialsForOutbound(this.state.vault_credentials);
      }
    } catch (err) {
      // Warmup failed — broadcast error event and re-throw to prevent harness from running
      this.broadcastEvent({
        type: "agent.message",
        content: [{ type: "text", text: `Sandbox warmup failed: ${err instanceof Error ? err.message : String(err)}` }],
      });
      throw err;
    }
  }

  private broadcastEvent(event: SessionEvent) {
    const data = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // Connection already closed
      }
    }
  }

  /**
   * Persist a SessionEvent to the events table AND broadcast to WS subscribers.
   * Used by tools (e.g. web_fetch's aux summarize step) that need to emit
   * trajectory events from outside the harness loop. Inside the harness loop,
   * `runtime.broadcast` already does both — this is the equivalent for tool
   * code that doesn't receive a runtime context.
   */
  private persistAndBroadcastEvent(event: SessionEvent) {
    try {
      const history = new SqliteHistory(this.ctx.storage.sql);
      history.append(event);
    } catch (err) {
      console.warn(`[persistAndBroadcastEvent] history.append failed: ${(err as Error).message}`);
    }
    this.broadcastEvent(event);
    this.fanOutToHooks(event);
  }

  /** Fire-and-forget POST every event to each registered hook. Provider-
   *  specific consumers (Linear panel mirror, Slack thread mirror, etc.)
   *  live behind these URLs — SessionDO has no knowledge of them. Hooks
   *  are configured at /init via SessionInitParams.event_hooks.
   *
   *  Per-DO promise chain serializes the POSTs so they reach consumers in
   *  broadcast order. Without this, fast events (final agent.message) can
   *  outrun slower ones (earlier thoughts) and panel UIs render out of
   *  order. Each event waits for the previous fan-out to finish before
   *  kicking off, trading a few hundred ms of accumulated latency for
   *  strict ordering. */
  private hookChain: Promise<unknown> = Promise.resolve();

  private fanOutToHooks(event: SessionEvent): void {
    const hooks = this.state.event_hooks;
    if (!hooks?.length) return;
    const body = JSON.stringify(event);
    this.hookChain = this.hookChain
      .then(() =>
        Promise.all(
          hooks.map((hook) => {
            const headers: Record<string, string> = { "content-type": "application/json" };
            if (hook.auth) headers["x-internal-secret"] = hook.auth;
            return fetch(hook.url, { method: "POST", headers, body }).catch((err) => {
              console.warn(
                `[event-hook ${hook.name}] post failed: ${(err as Error).message}`,
              );
            });
          }),
        ),
      )
      .catch(() => {
        // chain swallows errors so a single bad hook can't break later
        // events from being delivered.
      });
  }

  /**
   * Resolve credentials for a model identifier (with optional explicit card).
   *
   * Lookup order:
   *   1. Explicit `cardId` → KV `modelcard:<id>` + `modelcard:<id>:key`
   *   2. Card whose `model_id` matches the requested model
   *   3. Env-var fallback (ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL)
   *
   * Used for both the agent's primary model and aux_model resolution
   * (web_fetch summarization, future tool internals).
   */
  private async resolveModelCardCredentials(
    modelId: string,
    cardId?: string,
  ): Promise<{
    apiKey: string;
    baseURL?: string;
    apiCompat: ApiCompat;
    customHeaders?: Record<string, string>;
    cardId?: string;
  }> {
    let apiKey = this.env.ANTHROPIC_API_KEY;
    let baseURL = this.env.ANTHROPIC_BASE_URL;
    let provider: string | undefined;
    let customHeaders: Record<string, string> | undefined;
    let resolvedCardId: string | undefined;

    if (this.env.AUTH_DB) {
      try {
        const services = await getCfServicesForTenant(this.env, this.state.tenant_id);
        const tenantId = this.state.tenant_id;
        let card = cardId
          ? await services.modelCards.get({ tenantId, cardId })
          : await services.modelCards.findByModelId({ tenantId, modelId });
        if (card && !card.archived_at) {
          const key = await services.modelCards.getApiKey({ tenantId, cardId: card.id });
          if (key) {
            apiKey = key;
            provider = card.provider;
            if (card.base_url) baseURL = card.base_url;
            if (card.custom_headers) customHeaders = card.custom_headers;
            resolvedCardId = card.id;
            console.log(`[model-card] resolved from D1: id=${card.id} model_id=${card.model_id} baseURL=${card.base_url ?? "(default)"} provider=${card.provider}`);
          }
        }
      } catch (err) {
        console.warn(`[model-card] D1 lookup failed, falling back to env: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const OAI_PROVIDERS = new Set(["oai", "oai-compatible"]);
    const ANT_PROVIDERS = new Set(["ant", "ant-compatible"]);
    let apiCompat: ApiCompat = "ant";
    if (provider && (OAI_PROVIDERS.has(provider) || ANT_PROVIDERS.has(provider))) {
      apiCompat = provider as ApiCompat;
    }

    return { apiKey, baseURL, apiCompat, customHeaders, cardId: resolvedCardId };
  }

  /**
   * Resolve the agent's auxiliary model (when configured).
   *
   * Returns null when the agent has no aux_model set — callers should
   * skip aux features (e.g. web_fetch summarization) in that case.
   */
  private async resolveAuxModel(agent: AgentConfig): Promise<{
    model: LanguageModel;
    modelInfo: { model_card_id?: string; model_id: string };
  } | null> {
    if (!agent.aux_model) return null;
    const modelId = typeof agent.aux_model === "string" ? agent.aux_model : agent.aux_model.id;
    const creds = await this.resolveModelCardCredentials(modelId, agent.aux_model_card_id);
    const model = resolveModel(modelId, creds.apiKey, creds.baseURL, creds.apiCompat, creds.customHeaders);
    return { model, modelInfo: { model_card_id: creds.cardId, model_id: modelId } };
  }

  /**
   * Handle tool confirmation: execute the confirmed tool or inject denial,
   * then re-run the harness to continue the conversation.
   */
  private async handleToolConfirmation(
    confirmation: UserToolConfirmationEvent,
    history: HistoryStore
  ): Promise<void> {
    const sandbox = this.getOrCreateSandbox();
    try {
      await this.warmUpSandbox();
    } catch {
      this.broadcastEvent({ type: "session.error", error: "Sandbox not available" });
      return;
    }

    // Retrieve the pending tool call from session metadata
    const pendingCalls = this.state.pending_tool_calls;
    const pending = pendingCalls.find(p => p.toolCallId === confirmation.tool_use_id);

    if (confirmation.result === "allow" && pending) {
      // Execute the tool
      const agentId = this.state.agent_id;
      const agent = agentId ? await this.getAgentConfig(agentId) : null;

      if (agent) {
        // Fetch environment config for networking restrictions
        const envId = this.state.environment_id;
        let environmentConfig: { networking?: { type: string; allowed_hosts?: string[] } } | undefined;
        if (envId) {
          const envCfg = await this.getEnvConfig(envId);
          if (envCfg) {
            environmentConfig = envCfg.config;
          }
        }

        // Build tools with execute functions intact (not stripped for always_ask)
        const auxResolved = await this.resolveAuxModel(agent);
        const allTools = await buildTools(this.applyMcpUrlFixups(agent), sandbox, {
          ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY,
          ANTHROPIC_BASE_URL: this.env.ANTHROPIC_BASE_URL,
          TAVILY_API_KEY: this.env.TAVILY_API_KEY,
          AI: this.env.AI,
          environmentConfig,
          browser: this.getBrowserSession() ?? undefined,
          auxModel: auxResolved?.model,
          auxModelInfo: auxResolved?.modelInfo,
          broadcastEvent: (event) => this.persistAndBroadcastEvent(event),
        });

        // Find the original tool definition (before always_ask stripping)
        // We need to re-build without permission stripping to get the execute function
        const originalTool = allTools[pending.toolName];
        if (originalTool?.execute) {
          try {
            const result = await originalTool.execute(pending.args, {
              toolCallId: pending.toolCallId,
              messages: [],
              abortSignal: undefined,
            });
            const resultStr = typeof result === "string" ? result : JSON.stringify(result);
            const toolResultEvent: SessionEvent = {
              type: "agent.tool_result",
              tool_use_id: pending.toolCallId,
              content: resultStr,
            };
            history.append(toolResultEvent);
            this.broadcastEvent(toolResultEvent);
          } catch (e) {
            const toolResultEvent: SessionEvent = {
              type: "agent.tool_result",
              tool_use_id: pending.toolCallId,
              content: `Error: ${e instanceof Error ? e.message : String(e)}`,
            };
            history.append(toolResultEvent);
            this.broadcastEvent(toolResultEvent);
          }
        }
      }
    } else {
      // Denied or not found — inject denial result
      const denyMsg = confirmation.deny_message || "Tool execution was denied by the user.";
      const toolResultEvent: SessionEvent = {
        type: "agent.tool_result",
        tool_use_id: confirmation.tool_use_id,
        content: `Denied: ${denyMsg}`,
      };
      history.append(toolResultEvent);
      this.broadcastEvent(toolResultEvent);
    }

    // Remove the confirmed/denied call from pending
    const remaining = pendingCalls.filter(p => p.toolCallId !== confirmation.tool_use_id);
    this.setState({ ...this.state, pending_tool_calls: remaining });

    // Re-run the harness to continue the conversation
    // Use an empty user message — the history already has the tool result
    const resumeMsg: UserMessageEvent = {
      type: "user.message",
      content: [{ type: "text", text: "" }],
    };
    await this.processUserMessage(resumeMsg, 0, true);
  }

  /**
   * Resolve a credential token from vault by credential ID.
   */
  private async resolveCredentialToken(credentialId?: string): Promise<string | null> {
    if (!credentialId) return null;
    const vaultIds = this.state.vault_ids;
    // Prefer snapshot — works in staging where CONFIG_KV is the wrong namespace.
    const snapshotCreds = await this.getVaultCredentials(vaultIds);
    for (const cred of snapshotCreds) {
      if (cred.id === credentialId) {
        return cred.auth?.token || cred.auth?.access_token || null;
      }
    }
    // Fallback: direct KV lookup. Already covered by getVaultCredentials when
    // the snapshot is absent, but we keep this exact-key get as a fast path.
    for (const vaultId of vaultIds) {
      const credData = await this.env.CONFIG_KV.get(this.tk("cred", vaultId, credentialId));
      if (credData) {
        const cred = JSON.parse(credData);
        return cred.auth?.token || cred.auth?.access_token || null;
      }
    }
    return null;
  }

  /**
   * Register a background task for completion tracking.
   * Starts a setInterval poller that checks process status every 2s.
   * When complete, injects a task_notification event and re-triggers harness.
   * Event-driven completion notification — but poll-based since we can't
   * get exit events from container processes.
   */
  /**
   * Watch a background task for completion. Uses Agent schedule system
   * instead of setInterval so it survives DO hibernation.
   *
   * Task metadata is stored in SQLite so it persists across hibernation.
   */
  private async watchBackgroundTask(
    taskId: string,
    pid: string,
    outputFile: string,
    _proc: ProcessHandle | null,
    _sandbox: SandboxExecutor,
  ): Promise<void> {
    // Persist task info to SQLite (survives hibernation)
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS background_tasks (
        task_id TEXT PRIMARY KEY,
        pid TEXT NOT NULL,
        output_file TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )`
    );
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO background_tasks (task_id, pid, output_file) VALUES (?, ?, ?)`,
      taskId, pid, outputFile
    );

    // Schedule first poll in 3 seconds (survives hibernation)
    try {
      const sched = await this.schedule(3, "pollBackgroundTasks");
      // Emit debug event so we can verify schedule was set
      const history = new SqliteHistory(this.ctx.storage.sql);
      history.append({ type: "span.background_task_scheduled", task_id: taskId, schedule_id: sched?.id } as any);
      this.broadcastEvent({ type: "span.background_task_scheduled", task_id: taskId, schedule_id: sched?.id } as any);
    } catch (err) {
      const history = new SqliteHistory(this.ctx.storage.sql);
      history.append({ type: "session.error", error: `watchBackgroundTask schedule failed: ${err}` });
      this.broadcastEvent({ type: "session.error", error: `watchBackgroundTask schedule failed: ${err}` });
    }
  }

  /**
   * Scheduled callback: poll all background tasks for completion.
   * Called by Agent schedule system — survives DO hibernation.
   */
  async pollBackgroundTasks(): Promise<void> {
    this.ensureSchema();
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS background_tasks (
        task_id TEXT PRIMARY KEY, pid TEXT NOT NULL,
        output_file TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))
      )`
    );

    const tasks = this.ctx.storage.sql.exec(
      `SELECT task_id, pid, output_file FROM background_tasks`
    ).toArray();

    if (!tasks.length) return;

    const sandbox = this.getOrCreateSandbox();
    let anyPending = false;

    for (const task of tasks) {
      const { task_id, pid, output_file } = task as { task_id: string; pid: string; output_file: string };
      try {
        // Check if process is still running
        let taskDone = false;
        if (!pid || pid === "undefined" || !/^\d+$/.test(pid)) {
          // Invalid pid — check if output file exists and has content
          try {
            const content = await sandbox.readFile(output_file);
            taskDone = content != null && content.trim().length > 0;
          } catch {
            taskDone = false;
          }
        } else {
          const check = await sandbox.exec(`kill -0 ${pid} 2>/dev/null && echo running || echo done`, 5000);
          taskDone = check.includes("done");
        }
        if (!taskDone) {
          anyPending = true;
          continue;
        }

        // Task completed — read output and inject notification
        let output = "";
        try { output = await sandbox.readFile(output_file); } catch {}

        const history = new SqliteHistory(this.ctx.storage.sql);
        const notifEvent: SessionEvent = {
          type: "user.message",
          content: [{
            type: "text",
            text: `<task_notification>\nBackground task ${task_id} completed.\nOutput file: ${output_file}\n\n${output.slice(0, 3000)}\n</task_notification>`,
          }],
        };
        history.append(notifEvent);
        this.broadcastEvent(notifEvent);

        // Remove completed task
        this.ctx.storage.sql.exec(`DELETE FROM background_tasks WHERE task_id = ?`, task_id);

        // Re-trigger harness
        await this.drainEventQueue();
      } catch {
        anyPending = true;
      }
    }

    // Schedule next poll if there are still pending tasks
    if (anyPending) {
      try {
        await this.schedule(5, "pollBackgroundTasks");
      } catch (err) {
        console.error("[pollBackgroundTasks] reschedule failed:", err);
      }
    }
  }

  /**
   * Run a sub-agent within the same session. Creates an isolated thread
   * with its own message history but shares the same sandbox. Events are
   * tagged with thread_id and written to the parent event log.
   */
  private async runSubAgent(
    agentId: string,
    message: string,
    parentHistory: HistoryStore,
    sandbox: SandboxExecutor,
  ): Promise<string> {
    // Generate a unique thread ID
    const threadId = `thread_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    // Fetch sub-agent config. Uses getAgentConfig so the parent agent's
    // snapshot is consulted when the sub-agent id matches the session's
    // agent_id; otherwise falls back to KV (broken in staging — sub-agents
    // with arbitrary ids aren't snapshotted).
    // TODO(staging-kv): pre-fetch sub-agent configs at /init when the agent
    // declares them in mcp_servers / sub_agents.
    const subAgent = await this.getAgentConfig(agentId);
    if (!subAgent) {
      return `Sub-agent error: agent "${agentId}" not found`;
    }

    // Store thread
    this.threads.set(threadId, { agentId, agentConfig: subAgent });

    // Emit thread_created
    const threadCreatedEvent: SessionEvent = {
      type: "session.thread_created",
      session_thread_id: threadId,
      agent_id: agentId,
      agent_name: subAgent.name,
    };
    parentHistory.append(threadCreatedEvent);
    this.broadcastEvent(threadCreatedEvent);

    // Create sub-agent's isolated history
    const subHistory = new InMemoryHistory();
    const userMsg: UserMessageEvent = {
      type: "user.message",
      content: [{ type: "text", text: message }],
    };
    subHistory.append(userMsg);

    // Resolve harness for the sub-agent
    let harness: HarnessInterface;
    try {
      harness = resolveHarness(subAgent.harness);
    } catch {
      harness = resolveHarness("default");
    }

    // Build sub-agent tools and model (platform prepares context for sub-agent too)
    const subAuxResolved = await this.resolveAuxModel(subAgent);
    const subTools = await buildTools(this.applyMcpUrlFixups(subAgent), sandbox, {
      ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY,
      ANTHROPIC_BASE_URL: this.env.ANTHROPIC_BASE_URL,
      TAVILY_API_KEY: this.env.TAVILY_API_KEY,
      AI: this.env.AI,
      browser: this.getBrowserSession() ?? undefined,
      auxModel: subAuxResolved?.model,
      auxModelInfo: subAuxResolved?.modelInfo,
      broadcastEvent: (event) => this.persistAndBroadcastEvent(event),
      delegateToAgent: async (nestedAgentId: string, nestedMessage: string) => {
        return this.runSubAgent(nestedAgentId, nestedMessage, parentHistory, sandbox);
      },
    });
    const subModelId = typeof subAgent.model === "string" ? subAgent.model : subAgent.model?.id;
    const subModel = resolveModel(subModelId || this.env.ANTHROPIC_MODEL || "claude-sonnet-4-6", this.env.ANTHROPIC_API_KEY, this.env.ANTHROPIC_BASE_URL);

    // Build sub-agent context: own history, shared sandbox, parent event log
    const subCtx: HarnessContext = {
      agent: subAgent,
      userMessage: userMsg,
      tools: subTools,
      model: subModel,
      systemPrompt: subAgent.system || "",
      env: {
        ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY,
        ANTHROPIC_BASE_URL: this.env.ANTHROPIC_BASE_URL,
        ANTHROPIC_MODEL: this.env.ANTHROPIC_MODEL,
        TAVILY_API_KEY: this.env.TAVILY_API_KEY,
        delegateToAgent: async (nestedAgentId: string, nestedMessage: string) => {
          return this.runSubAgent(nestedAgentId, nestedMessage, parentHistory, sandbox);
        },
      },
      runtime: {
        history: subHistory,
        sandbox,
        broadcast: (event) => {
          subHistory.append(event);
          const taggedEvent = { ...event, session_thread_id: threadId };
          parentHistory.append(taggedEvent);
          this.broadcastEvent(taggedEvent);
          this.fanOutToHooks(taggedEvent);
        },
        reportUsage: async (input_tokens: number, output_tokens: number) => {
          this.setState({ ...this.state, input_tokens: this.state.input_tokens + input_tokens, output_tokens: this.state.output_tokens + output_tokens });
        },
      },
    };

    // Run the sub-agent harness
    await harness.run(subCtx);

    // Collect sub-agent response text from its history
    const subEvents = subHistory.getEvents();
    const responseText = subEvents
      .filter((e: SessionEvent) => e.type === "agent.message")
      .map((e: SessionEvent) => {
        const msg = e as AgentMessageEvent;
        return msg.content?.map((b) => b.type === "text" ? b.text : "").join("") || "";
      })
      .join("\n");

    // Emit thread_idle
    const threadIdleEvent: SessionEvent = { type: "session.thread_idle", session_thread_id: threadId };
    parentHistory.append(threadIdleEvent);
    this.broadcastEvent(threadIdleEvent);

    return responseText || "(sub-agent produced no text output)";
  }

  /**
   * Process a user message: resolve agent, build context, run harness,
   * evaluate outcome, emit status.
   *
   * @param skipAppend — if true, the message is already in history (resume after tool confirmation)
   * @param retryCount — for transient error retries
   */
  private async processUserMessage(
    userMessage: UserMessageEvent,
    retryCount: number = 0,
    skipAppend: boolean = false
  ): Promise<void> {
    const agentId = this.state.agent_id;
    if (!agentId) return;

    const agent = await this.getAgentConfig(agentId);
    if (!agent) {
      const history = new SqliteHistory(this.ctx.storage.sql);
      const errorEvent: SessionEvent = { type: "session.error", error: "Agent not found" };
      history.append(errorEvent);
      this.broadcastEvent(errorEvent);
      this.setState({ ...this.state, status: "idle" });
      return;
    }

    const history = new SqliteHistory(this.ctx.storage.sql);

    // Reuse session-level sandbox (singleton) — files persist across turns
    const sandbox = this.getOrCreateSandbox();

    // Pre-warm sandbox on first use (container cold start + package install)
    try {
      await this.warmUpSandbox();
    } catch (err) {
      const errorEvent: SessionEvent = {
        type: "session.error",
        error: `Sandbox failed to start: ${err instanceof Error ? err.message : String(err)}`,
      };
      history.append(errorEvent);
      this.broadcastEvent(errorEvent);
      this.setState({ ...this.state, status: "terminated" });
      return;
    }

    // Fetch environment config for networking restrictions
    const envId = this.state.environment_id;
    let environmentConfig: { networking?: { type: string; allowed_hosts?: string[] } } | undefined;
    if (envId) {
      const envCfg = await this.getEnvConfig(envId);
      if (envCfg) {
        environmentConfig = envCfg.config;
      }
    }

    // Fetch memory store attachments from session resources
    const sessionId = this.state.session_id;
    const memoryAttachments: Array<{
      store_id: string;
      access: "read_write" | "read_only";
      prompt?: string;
    }> = [];
    if (sessionId) {
      // listResourcesBySession queries the session_id column directly — no
      // tenant-prefix mismatch, no JSON.parse loop. Replaces the prior
      // CONFIG_KV.list scan that tripped over staging KV namespaces.
      const services = await getCfServicesForTenant(this.env, this.state.tenant_id);
      const rows = await services.sessions.listResourcesBySession({ sessionId });
      for (const row of rows) {
        if (row.type === "memory_store" && row.resource.type === "memory_store" && row.resource.memory_store_id) {
          memoryAttachments.push({
            store_id: row.resource.memory_store_id,
            access: row.resource.access === "read_only" ? "read_only" : "read_write",
            prompt: typeof row.resource.prompt === "string" ? row.resource.prompt : undefined,
          });
        }
      }
    }
    const memoryStoreIds = memoryAttachments.map((a) => a.store_id);

    // Resolve harness via registry — SessionDO never imports a concrete harness
    let harness: HarnessInterface;
    try {
      harness = resolveHarness(agent.harness);
    } catch {
      harness = resolveHarness("default");
    }

    // --- Platform prepares WHAT is available ---

    // Build tools from agent config
    const auxResolved = await this.resolveAuxModel(agent);
    const allTools = await buildTools(this.applyMcpUrlFixups(agent), sandbox, {
      ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY,
      ANTHROPIC_BASE_URL: this.env.ANTHROPIC_BASE_URL,
      TAVILY_API_KEY: this.env.TAVILY_API_KEY,
      AI: this.env.AI,
      environmentConfig,
      browser: this.getBrowserSession() ?? undefined,
      auxModel: auxResolved?.model,
      auxModelInfo: auxResolved?.modelInfo,
      broadcastEvent: (event) => this.persistAndBroadcastEvent(event),
      delegateToAgent: async (agentId: string, message: string) => {
        return this.runSubAgent(agentId, message, history, sandbox);
      },
      watchBackgroundTask: (taskId: string, pid: string, outputFile: string, proc: ProcessHandle | null) => {
        this.watchBackgroundTask(taskId, pid, outputFile, proc, sandbox);
      },
    });

    // Add memory tools if session has memory store resources. The CF factory
    // wires Noop adapters when AI / VECTORIZE are unbound, so we only require
    // AUTH_DB to be present.
    let memoryStoreService: MemoryStoreService | null = null;
    if (memoryAttachments.length && this.env.AUTH_DB) {
      memoryStoreService = (await getCfServicesForTenant(this.env, this.state.tenant_id)).memory;
      const memTools = buildMemoryTools(
        memoryAttachments.map((a) => ({ store_id: a.store_id, access: a.access })),
        this.state.tenant_id,
        memoryStoreService,
        this.state.agent_id ?? "agent",
      );
      Object.assign(allTools, memTools);
    }

    // Resolve model — look up model card credentials, fall back to env vars
    const modelId = typeof agent.model === "string" ? agent.model : agent.model?.id;
    const effectiveModelId = modelId || this.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
    const creds = await this.resolveModelCardCredentials(effectiveModelId, agent.model_card_id);
    const model = resolveModel(effectiveModelId, creds.apiKey, creds.baseURL, creds.apiCompat, creds.customHeaders);

    // Build system prompt: ONLY agent.system + authenticatedCommandGuidance.
    // Skill / memory_store / appendable_prompt content is NOT appended here —
    // those are collected as platformReminders and injected by the harness's
    // onSessionInit hook as <system-reminder> user.message events. This keeps
    // the system field byte-stable across the session, which Anthropic's
    // prompt cache requires for the cached prefix to survive past turn 1.
    const rawSystemPrompt = agent.system || "";
    const authenticatedCommandGuidance =
      "For commands that may require authentication, prefer issuing a single command instead of a chained shell command. If an authenticated chained command fails, retry with a simpler single-command form.";
    const systemPrompt = rawSystemPrompt
      ? `${rawSystemPrompt}\n\n${authenticatedCommandGuidance}`
      : authenticatedCommandGuidance;

    // Collect platformReminders for harness.onSessionInit. These get
    // resolved ONCE at session-init and become part of the events stream.
    // KV reads happen here; the resulting bytes are frozen — no per-turn KV
    // race conditions, no per-turn iteration-order drift.
    const platformReminders: Array<{ source: string; text: string }> = [];

    // Platform-built-in appendable prompts the agent author opted into. Use
    // for provider-specific syntax (e.g. Linear's @-mention URL form) that
    // would pollute the base system prompt for agents that don't need it.
    // Routed through platformReminders so they participate in the new
    // harness.onSessionInit cache-stable injection model.
    const appendableIds = agent.appendable_prompts ?? [];
    const resolved = appendableIds.length ? resolveAppendablePrompts(appendableIds) : [];
    if (resolved.length) {
      console.log(
        `[session-do] appendable_prompts ids=[${appendableIds.join(",")}] resolved=${resolved.length}`,
      );
      for (const p of resolved) {
        platformReminders.push({ source: `appendable:${p.id}`, text: p.content });
      }
    }
    if (agent.skills?.length) {
      // Built-in (anthropic) skills from the in-memory registry
      const builtinSkills = resolveSkills(agent.skills);
      for (const s of builtinSkills) {
        if (s.system_prompt_addition) {
          platformReminders.push({ source: `skill:${s.id}`, text: s.system_prompt_addition });
        }
      }

      // Custom skills from KV — lightweight metadata
      if (this.env.CONFIG_KV) {
        try {
          const customSkills = await resolveCustomSkills(agent.skills, this.env.CONFIG_KV, this.state.tenant_id);
          for (const s of customSkills) {
            if (s.system_prompt_addition) {
              platformReminders.push({ source: `skill:${s.id}`, text: s.system_prompt_addition });
            }
          }
        } catch {
          // Best-effort
        }
      }

      // Mount custom skill files into sandbox (progressive disclosure).
      // Unrelated to systemPrompt — keeps the sandbox-side files for the
      // model to read on demand via skill tools.
      if (this.env.CONFIG_KV) {
        try {
          const skillFilesResults = await getSkillFiles(
            agent.skills,
            this.env.CONFIG_KV,
            this.env.FILES_BUCKET,
            this.state.tenant_id,
          );
          for (const sf of skillFilesResults) {
            const skillDir = `/home/user/.skills/${sf.skillName}`;
            try {
              await sandbox.exec(`mkdir -p ${skillDir}`, 5000);
            } catch {}
            for (const file of sf.files) {
              try {
                if (sandbox.writeFileBytes) {
                  await sandbox.writeFileBytes(
                    `${skillDir}/${file.filename}`,
                    file.bytes,
                  );
                } else {
                  await sandbox.writeFile(
                    `${skillDir}/${file.filename}`,
                    new TextDecoder("utf-8").decode(file.bytes),
                  );
                }
              } catch {
                // Best-effort: skip individual file write failures
              }
            }
          }
        } catch {
          // Best-effort
        }
      }
    }

    // Memory store prompts → platformReminders (was: appended to systemPrompt
    // every turn, KV-list-order dependent → permanent cache miss). Build the
    // prompt strings on the fly from memory store metadata + per-attachment
    // prompt overrides.
    const memoryPrompts: string[] = [];
    if (memoryAttachments.length && memoryStoreService) {
      try {
        for (const att of memoryAttachments) {
          const store = await memoryStoreService.getStore({
            tenantId: this.state.tenant_id,
            storeId: att.store_id,
          });
          if (!store) {
            memoryPrompts.push("");
            continue;
          }
          const lines = [`## Memory store: ${store.name}`];
          if (store.description) lines.push(store.description);
          if (att.prompt) lines.push(att.prompt);
          if (att.access === "read_only") lines.push("(read-only attachment — write tools are not available for this store)");
          memoryPrompts.push(lines.join("\n"));
        }
      } catch (err) {
        console.warn("memory store metadata fetch failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    for (let i = 0; i < memoryPrompts.length; i++) {
      if (!memoryPrompts[i]) continue;
      platformReminders.push({
        source: `memory:${memoryStoreIds[i] ?? `idx${i}`}`,
        text: memoryPrompts[i],
      });
    }

    // Create an abort controller for this execution
    const abortController = new AbortController();
    this.currentAbortController = abortController;

    // --- Harness receives a fully-prepared context ---
    const ctx: HarnessContext = {
      agent,
      userMessage,
      tools: allTools,
      model,
      systemPrompt,
      rawSystemPrompt,
      platformReminders,
      env: {
        ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY,
        ANTHROPIC_BASE_URL: this.env.ANTHROPIC_BASE_URL,
        ANTHROPIC_MODEL: this.env.ANTHROPIC_MODEL,
        TAVILY_API_KEY: this.env.TAVILY_API_KEY,
        CONFIG_KV: this.env.CONFIG_KV,
        memoryStoreIds,
        environmentConfig,
        delegateToAgent: async (agentId: string, message: string) => {
          return this.runSubAgent(agentId, message, history, sandbox);
        },
        watchBackgroundTask: (taskId: string, pid: string, outputFile: string, proc: ProcessHandle | null) => {
          this.watchBackgroundTask(taskId, pid, outputFile, proc, sandbox);
        },
      },
      runtime: {
        history,
        sandbox,
        broadcast: (event) => {
          history.append(event);
          this.broadcastEvent(event);
          this.fanOutToHooks(event);
        },
        reportUsage: async (input_tokens: number, output_tokens: number) => {
          this.setState({ ...this.state, input_tokens: this.state.input_tokens + input_tokens, output_tokens: this.state.output_tokens + output_tokens });
        },
        pendingConfirmations: [],
        abortSignal: abortController.signal,
      },
    };

    try {
      // Run harness.onSessionInit exactly once per session, BEFORE the first
      // running status. Default impl writes <system-reminder> user.message
      // events for skills/memory/appendable_prompts; custom harnesses can
      // substitute or skip. Idempotent across DO restarts via state flag.
      if (!this.state.session_init_done && harness.onSessionInit) {
        try {
          await harness.onSessionInit(ctx, ctx.runtime);
        } catch (err) {
          console.warn(`[onSessionInit] failed: ${(err as Error).message}`);
        }
        this.setState({ ...this.state, session_init_done: true });
      }

      // Broadcast running status
      const runningEvent: SessionEvent = { type: "session.status_running" };
      history.append(runningEvent);
      this.broadcastEvent(runningEvent);

      await harness.run(ctx);

      // Store any pending tool calls in session metadata for confirmation flow
      if (ctx.runtime.pendingConfirmations?.length) {
        // Collect pending tool call details from the last harness run events
        const recentEvents = history.getEvents();
        const pendingCalls: PendingToolCall[] = [];
        for (const eventId of ctx.runtime.pendingConfirmations) {
          // Find the matching agent.tool_use or agent.custom_tool_use event
          const toolUseEvent = recentEvents.find((e: SessionEvent) => {
            if (e.type === "agent.tool_use") {
              return (e as AgentToolUseEvent).id === eventId;
            }
            if (e.type === "agent.custom_tool_use") {
              return (e as import("@open-managed-agents/shared").AgentCustomToolUseEvent).id === eventId;
            }
            return false;
          });
          if (toolUseEvent) {
            if (toolUseEvent.type === "agent.tool_use") {
              const tue = toolUseEvent as AgentToolUseEvent;
              pendingCalls.push({ toolCallId: tue.id, toolName: tue.name, args: tue.input });
            } else if (toolUseEvent.type === "agent.custom_tool_use") {
              const cte = toolUseEvent as import("@open-managed-agents/shared").AgentCustomToolUseEvent;
              pendingCalls.push({ toolCallId: cte.id, toolName: cte.name, args: cte.input });
            }
          }
        }
        if (pendingCalls.length) {
          this.setState({ ...this.state, pending_tool_calls: pendingCalls });
        }
      }

      // Outcome self-evaluation loop (properly loops until satisfied or max iterations)
      const outcome = this.state.outcome;
      if (outcome) {
        let iteration = this.state.outcome_iteration || 1;
        const maxIterations = Math.min(outcome.max_iterations || 3, 20);
        const outcomeModelId = typeof agent.model === "string" ? agent.model : agent.model?.id;
        const model = resolveModel(outcomeModelId || ctx.env.ANTHROPIC_MODEL || "claude-sonnet-4-6", ctx.env.ANTHROPIC_API_KEY, ctx.env.ANTHROPIC_BASE_URL);

        while (iteration <= maxIterations) {
          // Collect agent output from recent events
          const recentEvents = history.getEvents();
          const agentOutput = recentEvents
            .filter((e: SessionEvent) => e.type === "agent.message")
            .map((e: SessionEvent) => {
              const msg = e as AgentMessageEvent;
              return msg.content?.map((b) => b.type === "text" ? b.text : "").join("") || "";
            })
            .join("\n");

          // Span: outcome evaluation start
          this.broadcastEvent({ type: "span.outcome_evaluation_start", iteration });

          const ongoingEvent: SessionEvent = {
            type: "span.outcome_evaluation_ongoing",
            iteration,
          };
          history.append(ongoingEvent);
          this.broadcastEvent(ongoingEvent);

          const evalResult = await evaluateOutcome(model, outcome, agentOutput);

          if (evalResult.result === "satisfied") {
            const evalEvent: OutcomeEvaluationEvent = {
              type: "outcome.evaluation_end",
              result: "satisfied",
              iteration,
              feedback: evalResult.feedback,
            };
            history.append(evalEvent);
            this.broadcastEvent(evalEvent);
            this.setState({ ...this.state, outcome: null });
            break;
          }

          if (iteration >= maxIterations) {
            const evalEvent: OutcomeEvaluationEvent = {
              type: "outcome.evaluation_end",
              result: "max_iterations_reached",
              iteration,
            };
            history.append(evalEvent);
            this.broadcastEvent(evalEvent);
            this.setState({ ...this.state, outcome: null });
            break;
          }

          // Needs revision — inject feedback and re-run
          const evalEvent: OutcomeEvaluationEvent = {
            type: "outcome.evaluation_end",
            result: "needs_revision",
            iteration,
            feedback: evalResult.feedback,
          };
          history.append(evalEvent);
          this.broadcastEvent(evalEvent);

          iteration += 1;
          this.setState({ ...this.state, outcome_iteration: iteration });

          const feedbackMsg: UserMessageEvent = {
            type: "user.message",
            content: [{
              type: "text",
              text: `[Outcome Evaluation - Iteration ${iteration - 1}] Needs revision:\n${evalResult.feedback}\n\nPlease address the feedback and try again.`,
            }],
          };
          history.append(feedbackMsg);
          this.broadcastEvent(feedbackMsg);
          await harness.run({ ...ctx, userMessage: feedbackMsg });
        }
      }

      // Determine stop reason based on pending tool confirmations or custom tool results
      const pendingConfirmations = ctx.runtime.pendingConfirmations || [];

      // Check if any pending are custom tool uses (no execute function, not always_ask built-in)
      const storedPendingCalls = this.state.pending_tool_calls;
      const hasCustomToolPending = storedPendingCalls.some(p =>
        !["bash", "read", "write", "edit", "glob", "grep", "web_fetch", "web_search"].includes(p.toolName) &&
        !p.toolName.startsWith("mcp_") &&
        !p.toolName.startsWith("call_agent_") &&
        !p.toolName.startsWith("memory_")
      );

      let stopReason: import("@open-managed-agents/shared").SessionStatusEvent["stop_reason"];
      if (hasCustomToolPending) {
        stopReason = {
          type: "requires_action" as const,
          action_type: "custom_tool_result" as const,
          event_ids: pendingConfirmations,
        };
      } else if (pendingConfirmations.length > 0) {
        stopReason = {
          type: "requires_action" as const,
          action_type: "tool_confirmation" as const,
          event_ids: pendingConfirmations,
        };
      } else {
        stopReason = { type: "end_turn" as const };
      }

      const idleEvent: SessionEvent = {
        type: "session.status_idle",
        stop_reason: stopReason,
      };
      history.append(idleEvent);
      this.broadcastEvent(idleEvent);
    } catch (err) {
      const errorMessage = this.describeError(err);

      // Don't retry if aborted
      if (err instanceof Error && err.name === "AbortError") {
        // Interrupt was handled — don't emit error
        return;
      }

      const TRANSIENT_PATTERNS = ["timeout", "network", "ECONNREFUSED", "fetch failed", "rate limit", "429", "503"];
      const isTransient = TRANSIENT_PATTERNS.some((p) => errorMessage.toLowerCase().includes(p.toLowerCase()));

      if (isTransient && retryCount < 2) {
        const rescheduledEvent: SessionEvent = {
          type: "session.status_rescheduled",
          reason: errorMessage,
        };
        history.append(rescheduledEvent);
        this.broadcastEvent(rescheduledEvent);

        // Exponential backoff: 1s, 2s
        const delay = 1000 * Math.pow(2, retryCount);
        await new Promise(r => setTimeout(r, delay));
        return this.processUserMessage(userMessage, retryCount + 1, skipAppend);
      }

      if (isTransient) {
        const rescheduledEvent: SessionEvent = {
          type: "session.status_rescheduled",
          reason: `${errorMessage} (exhausted ${retryCount} retries)`,
        };
        history.append(rescheduledEvent);
        this.broadcastEvent(rescheduledEvent);
      }

      const errorEvent: SessionEvent = {
        type: "session.error",
        error: errorMessage,
      };
      history.append(errorEvent);
      this.broadcastEvent(errorEvent);

      // Harness crashed — but session is recoverable.
      // The event log has everything up to the crash point.
      // The sandbox is still alive (container persists independently).
      // Client can send a new user.message to retry.
    } finally {
      this.currentAbortController = null;
      this.setState({ ...this.state, status: "idle" });
    }
  }

  /**
   * Extract a meaningful error description. Handles cases where err.message
   * is empty (e.g. network failures, non-standard API errors).
   */
  private describeError(err: unknown): string {
    if (err instanceof Error) {
      if (err.message) return err.message;
      const parts: string[] = [err.name || "Error"];
      if ("cause" in err && err.cause) parts.push(`cause: ${String(err.cause)}`);
      if ("status" in err) parts.push(`status: ${(err as Record<string, unknown>).status}`);
      if ("statusCode" in err) parts.push(`statusCode: ${(err as Record<string, unknown>).statusCode}`);
      if ("url" in err) parts.push(`url: ${(err as Record<string, unknown>).url}`);
      return parts.join(", ");
    }
    return String(err) || "Unknown error";
  }
}
