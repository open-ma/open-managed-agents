import { DurableObject } from "cloudflare:workers";
import { nanoid } from "nanoid";
import { parseCronExpression } from "cron-schedule";
import {
  runAgentTurn,
  recoverAgentTurn,
  clearTurnRecoveryCount,
  TurnAborted,
  type TurnRuntimeAgent,
  type RecoveryDecision,
  type PartialStream,
} from "./turn-runtime";
import type { Env } from "@open-managed-agents/shared";
import {
  logWarn,
  log,
  generateEventId,
  generateOutcomeId,
  classifyExternalError,
  AuthError,
  BillingError,
  ConfigError,
  ModelError,
  TransientInfraError,
} from "@open-managed-agents/shared";
import {
  CfDoStreamRepo,
  CfDoEventLog,
  CfDoPendingQueue,
  ensureSchema as ensureEventLogSchema,
} from "@open-managed-agents/event-log/cf-do";
import type {
  EventLogRepo,
  PendingQueueRepo,
  PendingRow,
  StreamRepo,
} from "@open-managed-agents/event-log";
import { recoverInterruptedState as runRecovery } from "./recovery";
import {
  RuntimeAdapterImpl,
  type RuntimeAdapter,
} from "@open-managed-agents/session-runtime";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { cfWorkersAiToMarkdown } from "@open-managed-agents/markdown";
import { isSpecEvent } from "@open-managed-agents/api-types";
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
  AgentMessageEvent,
  AgentToolUseEvent,
  SystemUserMessagePendingEvent,
  SystemUserMessagePromotedEvent,
  SystemUserMessageCancelledEvent,
} from "@open-managed-agents/shared";
import type { HarnessContext, HarnessInterface, HistoryStore, SandboxExecutor, ProcessHandle } from "../harness/interface";
import { resolveHarness } from "../harness/registry";
import { composeSystemPrompt } from "../harness/platform-guidance";
import { resolveModel } from "../harness/provider";
import type { ApiCompat } from "../harness/provider";
import type { LanguageModel } from "ai";
import { generateText } from "ai";
import { extractTextFromContent } from "@open-managed-agents/shared";
import {
  runOutcomeSupervisor,
  type ActiveOutcomeState,
  type OutcomeEvaluationRecord,
} from "./outcome-supervisor";
import { buildTools } from "../harness/tools";
import { MemoryStoreService } from "@open-managed-agents/memory-store";
import { buildCfServices, buildCfTenantDbProvider, getCfServicesForTenant } from "@open-managed-agents/services";
import { toEnvironmentConfig } from "@open-managed-agents/environments-store";
import { ensureSetupApplied } from "./setup-on-warmup";
import { resolveSkills, resolveCustomSkills, getSkillFiles } from "../harness/skills";
import { resolveAppendablePrompts } from "./appendable-prompts";
import { createCfBrowserHarness } from "@open-managed-agents/browser-harness/cf";
import type { BrowserHarness, BrowserBillingHook, BrowserSession } from "@open-managed-agents/browser-harness";
import { SqliteHistory, InMemoryHistory } from "./history";
import { createSandbox, CloudflareSandbox } from "./sandbox";
import { mountResources } from "./resource-mounter";
import { spawnStdioMcpServers, type StdioMcpConfig } from "./mcp-spawner";
import {
  findLatestBackup as findWorkspaceBackup,
} from "./workspace-backups";

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
/**
 * `ActiveOutcomeState` (one slot — only one outcome supported at a time,
 * per AMA spec) and `OutcomeEvaluationRecord` (the aggregate row written
 * to `state.outcome_evaluations[]` on every terminal verdict) are
 * defined in outcome-supervisor.ts so the supervisor unit-test fixture
 * has a single source of truth. Re-exported here as the local aliases
 * the SessionState below uses.
 */
type ActiveOutcome = ActiveOutcomeState;
type PersistedOutcomeEvaluation = OutcomeEvaluationRecord;

interface SessionState {
  agent_id: string;
  environment_id: string;
  session_id: string;
  tenant_id: string;
  title: string;
  /**
   * Stored only as a back-compat read for sessions written before status
   * became derived. New code MUST NOT write to this field. The runtime
   * status comes from `deriveStatus()`, which checks the in-memory
   * inflight-turn hint counter (mirrored from D1's `sessions.turn_id`
   * via the RuntimeAdapter callbacks) + `terminated_at` for the destroy
   * gate. See docs/contribute/recovery-and-idempotency.mdx for the
   * rationale.
   */
  status?: "idle" | "running" | "terminated";
  /** ms timestamp when /destroy ran. Replaces the persistent `terminated`
   *  status — the only state value that needed to survive in storage; the
   *  rest are derivable from cf_agents_runs row presence. */
  terminated_at: number | null;
  /**
   * Session-wide token totals. Kept in sync with the per-thread breakdown
   * in `thread_usage` so existing reads (POST /usage echo, /full-status)
   * keep working without a refactor at every call site. New code should
   * prefer `thread_usage` for per-thread granularity (AMA SessionThread
   * .usage shape).
   */
  input_tokens: number;
  output_tokens: number;
  /**
   * Per-thread cumulative usage. Keyed by session_thread_id
   * ("sthr_primary" or sub-agent "sthr_*"). Mirrors the AMA
   * BetaManagedAgentsSessionThreadUsage shape minus the cache_creation
   * sub-breakdown by lifetime (we only have one bucket today).
   * Optional: pre-thread-usage sessions read as `undefined` and the
   * serializer falls back to null; new sessions populate it.
   */
  thread_usage?: Record<
    string,
    {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    }
  >;
  vault_ids: string[];
  pending_tool_calls: PendingToolCall[];
  outcome: ActiveOutcome | null;
  outcome_iteration: number;
  /**
   * Phase 4: AMA-aligned aggregate of every terminal `span.outcome_evaluation_end`
   * for this session. Returned as-is by GET /v1/sessions/:id under
   * `outcome_evaluations`. Sequential outcomes (each kicked off by a fresh
   * `user.define_outcome`) append here in iteration order.
   */
  outcome_evaluations?: PersistedOutcomeEvaluation[];
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
  /**
   * Wall-clock create timestamp (Unix ms). Used by the hybrid-billing
   * `session_alive_seconds` emit at terminate time. Set lazily on /init —
   * pre-billing sessions read undefined and the emit is skipped (the
   * cost would be 0 cents anyway after the rate cap).
   */
  created_at_ms?: number;
  /**
   * Idempotency guard for the session_alive_seconds emit. Set once at
   * terminate; the second terminate call (DO restart hits the same
   * /destroy) checks this and skips the duplicate emit.
   */
  session_alive_billed?: boolean;
}

const INITIAL_SESSION_STATE: SessionState = {
  agent_id: "",
  environment_id: "",
  session_id: "",
  tenant_id: "default",
  title: "",
  terminated_at: null,
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

// Per-session cap on pending schedule-tool wakeups. Each pending wakeup, when
// it fires, injects a user.message and spawns a model turn — without a cap a
// runaway agent (cron loop, repeated tight delays) burns token quota until
// human intervention. 20 is comfortably above legitimate use (handful of
// reminders + a couple of cron schedules) and low enough that wedging it is
// obvious within seconds of the first model call.
const MAX_PENDING_WAKEUPS = 20;

// ── Constants inherited from cf-agents v0.11.2 schema ──────────────────
//
// We replaced `extends Agent` with `extends DurableObject` and reimplemented
// the small surface SessionDO actually used (state, schedule+alarm). Phase 3
// (this codebase) further dropped the runFiber/keepAlive primitives in favor
// of the unified RuntimeAdapter (begin/end on the shared `sessions` table).
// The cf_agents_state + cf_agents_schedules table NAMES are kept verbatim
// so existing prod DOs migrate transparently — schedule rows in flight at
// deploy time keep their SQL rows readable by the new code path. The
// cf_agents_runs table was dropped in Phase 4; orphan markers now live on
// `sessions.turn_id`. See _ensureCfAgentsSchema() below.
const STATE_ROW_ID = "cf_state_row_id";
const KEEP_ALIVE_INTERVAL_MS = 30_000;
const HUNG_SCHEDULE_TIMEOUT_SECONDS = 30;

export class SessionDO extends DurableObject<Env> {
  // ── cf-agents-replacement state (see _ensureCfAgentsSchema below) ─────
  private _state: SessionState | undefined;
  private _initialized = false;
  // Lazy-built runtime adapter (the unified one Node also uses). Built
  // on first turn so we can read this.state.tenant_id, which isn't set
  // until /init writes the row. _runtimeAdapter is the cached adapter
  // instance scoped to this DO's session.
  private _runtimeAdapter: RuntimeAdapter | null = null;

  /**
   * Set of turn ids currently in flight in THIS DO isolate.
   * Maintained via RuntimeAdapter.hintTurnInFlight / hintTurnEnded
   * callbacks (port contract; see ports.ts:111+). Each entry's
   * lifetime is exactly one runAgentTurn invocation.
   *
   * Sole consumer: `_checkOrphanTurns` filters out `o.turn_id ∈
   * _activeTurnIds` — exact match like Node SessionStateMachine's
   * `if (o.turn_id === this.activeTurnId) continue` (machine.ts:183).
   * Replaces a defensive `_inflightTurnHints + 90s grace period`
   * filter in the orphan check that was needed because earlier the
   * shell had no handle on the turnId minted inside runAgentTurn —
   * the hint callbacks now carry it (port v2).
   *
   * `deriveStatus()` also reads `.size > 0` — single source of truth
   * for "is anything running" replaces the prior `_inflightTurnHints`
   * counter.
   *
   * Lost on eviction; cold-start sees empty set, so a D1 row from a
   * dead incarnation is correctly identified as orphan.
   */
  private _activeTurnIds = new Set<string>();

  /**
   * Cold-start flush guard. The first fetch() after DO activation
   * triggers _finalizeStaleTurns() once; subsequent fetch()es skip it
   * (alarm() takes over for ongoing detection). false → not yet done.
   * Set to true synchronously at fetch() entry so concurrent first
   * requests don't double-fire.
   */
  private _coldStartFlushDone = false;

  /**
   * Synchronous re-entry guard for drainEventQueue, keyed by
   * session_thread_id. Single-isolate JS single-thread makes Set add/has
   * a true mutex within the same thread. Cross-thread drains run
   * concurrently — drainEventQueue('sthr_primary') and
   * drainEventQueue('sthr_xyz') don't block each other; that's the
   * whole point of per-thread parallelism.
   *
   * Distinct from _activeTurnIds: _draining is the *entry guard*,
   * checked synchronously before any await. _activeTurnIds is the
   * *active set*, populated asynchronously after beginTurn returns.
   * Both signals together cover the gap between "drain entered" and
   * "turn registered via hintTurnInFlight".
   */
  private _draining = new Set<string>();

  /**
   * Per-thread abort controllers — replaces the single
   * `currentAbortController` we used pre-thread-aware. Set by
   * processUserMessage / sub-agent runs at turn start, cleared at
   * turn end. user.interrupt with `session_thread_id` uses this to
   * abort exactly that thread's in-flight turn without touching
   * siblings (AMA spec semantics). /destroy iterates the map.
   *
   * Distinct from _activeTurnIds — that one is for orphan
   * detection (keyed by turnId, the runAgentTurn nanoid), this one
   * is for caller-initiated abort (keyed by session_thread_id, the
   * AMA-spec thread id the SDK speaks). The two signals never
   * overlap; merging would force one consumer to scan the other's
   * key shape.
   */
  private _threadAbortControllers = new Map<string, AbortController>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this._ensureCfAgentsSchema();
    this._loadStateFromSql();
    this._initialized = true;
  }

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
        } catch (err) {
          // skip malformed — but flag because vault data corruption silently
          // disables outbound auth injection for whatever this credential covered.
          logWarn(
            { op: "session_do.vault_cred_parse", session_id: this.state.session_id, vault_id: vaultId, kv_key: k.name, err },
            "skipping malformed credential entry",
          );
        }
      }
    }
    return out;
  }

  // observability stub kept as a defensive no-op slot — was set to null when
  // we used cf-agents Agent (which auto-instantiated an observability sink that
  // tripped SpanParent I/O isolation errors in vitest-pool-workers). After
  // dropping cf-agents the field is unused but harmless to keep so any
  // straggler `this.observability?.foo()` call elsewhere stays a no-op.
  observability: { emit?: (event: unknown) => void } | null = null;
  private initialized = false;
  private sandbox: SandboxExecutor | null = null;
  private wrappedSandbox: SandboxExecutor | null = null;
  private sandboxWarmupPromise: Promise<void> | null = null;
  /** Per-warmup random tag mirrored to /tmp/.oma-warm in the container.
   *  Lets the wrapSandboxWithLazyWarmup proxy detect a recycled container
   *  (CF Sandbox can die independently of SessionDO via OOM, sleepAfter,
   *  host migration). On mismatch we re-warm so restoreWorkspaceBackup
   *  runs and /workspace gets repopulated from the latest backup. */
  private currentWarmupGen: string | null = null;
  /**
   * Per-turn dedup of `agent.message` broadcasts. Recovery's
   * `loadRecoveryContext` reads prior agent messages out of SQL so the
   * next streamText resumes with the right context, but each recovery
   * attempt also calls `persistAgentMessage` for any partial streams it
   * found — without this Set, every recovery re-`broadcastEvent`s the
   * same message_id, producing the duplicate-broadcast storm we saw on
   * `sess-lyh1t4ilelc87ypk` 2026-05-02 (12 dupes at 5x recovery cap fire).
   * Reset at the START of each new turn (drainEventQueue loop) so a
   * legitimately re-emitted message_id in a new turn isn't suppressed.
   */
  private broadcastedMessageIds: Set<string> = new Set();
  /**
   * Browser session backed by Cloudflare Browser Rendering binding. Lazy-created
   * on first browser_* tool call (in-memory only — recreated if DO hibernates).
   * Closed on /destroy.
   */
  private browserSession: BrowserSession | null = null;
  /**
   * Per-DO BrowserHarness wrapper. Caches the BrowserSession across turns
   * so cookies/state persist within the DO lifetime (until hibernate or
   * /destroy). Built lazily on first getBrowserHarness() call.
   */
  private browserHarness: BrowserHarness | null = null;
  /**
   * Localhost URLs of stdio MCP servers spawned in the sandbox during warmup.
   * Indexed by mcp_servers[].name. Used to fix up the agent.mcp_servers entry
   * before each buildTools() call so the curl-based MCP wiring talks to the
   * right port.
   */
  private spawnedMcpUrls: Map<string, string> = new Map();
  private threads = new Map<string, { agentId: string; agentConfig: AgentConfig }>();
  /** In-flight LLM stream state — separate from the events log so chunk
   *  deltas don't pollute history (the eventual `agent.message` is the
   *  source of truth). Lazy-initialized in ensureSchema(). */
  private streams: StreamRepo | null = null;
  /** AMA-spec pending queue. Holds user.message / user.tool_confirmation /
   *  user.custom_tool_result events between events.send() and drain
   *  picking them up. Lazy-initialized in ensureSchema(). */
  private pending: PendingQueueRepo | null = null;

  private ensureSchema() {
    if (this.initialized) return;
    // Schema lives in the cf-do adapter so OMA's SessionDO doesn't have
    // to know SQLite syntax. Adapter is idempotent — CREATE TABLE IF NOT
    // EXISTS — so calling on every fetch hot path is fine.
    ensureEventLogSchema(this.ctx.storage.sql);
    this.streams = new CfDoStreamRepo(this.ctx.storage.sql);
    this.pending = new CfDoPendingQueue(this.ctx.storage.sql);
    this.initialized = true;
    // Recovery scan: any in-flight state from before this cold start is
    // stale by definition (the runtime that owned it is gone). Reconcile
    // both kinds of orphans now so the events log is consistent before
    // drainEventQueue runs and the harness rebuilds messages.
    void this.recoverInterruptedState();
    // Pending-queue cold start: any thread that had queued events when
    // the previous incarnation died still has them in pending_events.
    // Re-fire drainEventQueue per affected thread so they don't sit
    // forever waiting for a fresh user.message to retrigger drain.
    try {
      const threads = this.pending!.threadsWithPending();
      if (threads.length > 0) {
        console.log(`[ensureSchema] cold-start drain for threads: ${threads.join(",")}`);
        for (const t of threads) {
          void this.drainEventQueue(t);
        }
      }
    } catch (err) {
      console.warn(`[ensureSchema] threadsWithPending failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Stream runtime helpers — broadcast lifecycle/chunk events AND
   * persist into the streams table (separate from the events log).
   * Sub-agent runtimes pass `threadId` so events get tagged with the
   * sub-agent's thread context, matching the existing `broadcast`
   * pattern in `runSubAgent`.
   */
  private buildStreamRuntimeMethods(threadId?: string): {
    broadcastStreamStart: (messageId: string) => Promise<void>;
    broadcastChunk: (messageId: string, delta: string) => Promise<void>;
    broadcastStreamEnd: (
      messageId: string,
      status: "completed" | "aborted",
      errorText?: string,
    ) => Promise<void>;
    broadcastThinkingStart: (thinkingId: string) => Promise<void>;
    broadcastThinkingChunk: (thinkingId: string, delta: string) => Promise<void>;
    broadcastThinkingEnd: (thinkingId: string, status: "completed" | "aborted") => Promise<void>;
    broadcastToolInputStart: (toolUseId: string, toolName?: string) => Promise<void>;
    broadcastToolInputChunk: (toolUseId: string, delta: string) => Promise<void>;
    broadcastToolInputEnd: (toolUseId: string, status: "completed" | "aborted") => Promise<void>;
  } {
    const tag = (event: SessionEvent): SessionEvent =>
      threadId ? ({ ...event, session_thread_id: threadId } as SessionEvent) : event;
    const fire = (event: SessionEvent) => {
      this.broadcastEvent(event);
      this.fanOutToHooks(event);
    };
    return {
      broadcastStreamStart: async (messageId: string) => {
        if (!this.streams) this.ensureSchema();
        await this.streams!.start(messageId, Date.now());
        fire(tag({ type: "agent.message_stream_start", message_id: messageId } as SessionEvent));
      },
      broadcastChunk: async (messageId: string, delta: string) => {
        if (!this.streams) this.ensureSchema();
        await this.streams!.appendChunk(messageId, delta);
        fire(tag({ type: "agent.message_chunk", message_id: messageId, delta } as SessionEvent));
      },
      broadcastStreamEnd: async (messageId: string, status, errorText?: string) => {
        if (!this.streams) this.ensureSchema();
        // Aborted streams need their partial text persisted as a
        // canonical agent.message before we lose access to the
        // streams row. Without this, mid-stream aborts (user.interrupt,
        // model timeout, MCP cancel) leave the streams row stuck at
        // status='streaming' until cold-start recovery — meanwhile
        // eventsToMessages doesn't see the partial text and the next
        // turn's LLM context is missing what the model just said.
        //
        // Mirrors recovery.ts:69-78. Same dedup + placeholder fallback.
        // Done before finalize so a concurrent reader never observes
        // a stream that's both finalized AND missing from history.
        if (status === "aborted" && !this.broadcastedMessageIds.has(messageId)) {
          const row = await this.streams!.get(messageId);
          const partial = row?.chunks?.join("") ?? "";
          const partialEvent = tag({
            type: "agent.message",
            id: messageId,
            content: [{ type: "text", text: partial || "(interrupted before any tokens streamed)" }],
          } as unknown as SessionEvent);
          // Append directly to the events table — broadcastEvent's
          // dedup hits the broadcastedMessageIds set, but the persist
          // path is what matters most (Console replay, LLM context).
          const history = new SqliteHistory(
            this.ctx.storage.sql,
            this.env.FILES_BUCKET ?? null,
            `t/${this.state.tenant_id ?? "default"}/sessions/${this.state.session_id ?? "unknown"}`,
          );
          history.append(partialEvent);
          this.broadcastedMessageIds.add(messageId);
          fire(partialEvent);
        }
        await this.streams!.finalize(messageId, status, errorText);
        fire(tag({
          type: "agent.message_stream_end",
          message_id: messageId,
          status,
          error_text: errorText,
        } as SessionEvent));
      },
      // Thinking + tool-input streams are broadcast-only — see notes
      // in interface.ts. No streams-table writes; if the runtime dies
      // before the canonical event lands, the harness retry path
      // produces a fresh attempt with new ids.
      broadcastThinkingStart: async (thinkingId: string) => {
        fire(tag({ type: "agent.thinking_stream_start", thinking_id: thinkingId } as SessionEvent));
      },
      broadcastThinkingChunk: async (thinkingId: string, delta: string) => {
        fire(tag({ type: "agent.thinking_chunk", thinking_id: thinkingId, delta } as SessionEvent));
      },
      broadcastThinkingEnd: async (thinkingId: string, status) => {
        fire(tag({ type: "agent.thinking_stream_end", thinking_id: thinkingId, status } as SessionEvent));
      },
      broadcastToolInputStart: async (toolUseId: string, toolName?: string) => {
        fire(tag({
          type: "agent.tool_use_input_stream_start",
          tool_use_id: toolUseId,
          tool_name: toolName,
        } as SessionEvent));
      },
      broadcastToolInputChunk: async (toolUseId: string, delta: string) => {
        fire(tag({ type: "agent.tool_use_input_chunk", tool_use_id: toolUseId, delta } as SessionEvent));
      },
      broadcastToolInputEnd: async (toolUseId: string, status) => {
        fire(tag({ type: "agent.tool_use_input_stream_end", tool_use_id: toolUseId, status } as SessionEvent));
      },
    };
  }

  /** Cold-start reconciliation. Pure logic lives in `recoverInterruptedState`
   *  (see ./recovery.ts) so it's testable end-to-end with in-memory adapters.
   *  This wrapper just glues it to DO storage + WS broadcast. */
  private async recoverInterruptedState(): Promise<void> {
    if (!this.streams) return;
    const history = new SqliteHistory(this.ctx.storage.sql, this.env.FILES_BUCKET ?? null, `t/${this.state.tenant_id ?? "default"}/sessions/${this.state.session_id ?? "unknown"}`);
    try {
      const { warnings } = await runRecovery(this.streams, history);
      for (const w of warnings) {
        this.broadcastEvent({
          type: "session.warning",
          source: w.source,
          message: w.message,
          details: w.details,
        } as SessionEvent);
      }
    } catch (err) {
      logWarn(
        { op: "session_do.recover", err },
        "recovery scan failed; continuing",
      );
    }
  }

  /**
   * Scheduled recovery callback: called by Agent's schedule system
   * 5 seconds after an event is received. If the primary waitUntil
   * path already drained the queue, this is a no-op.
   *
   * Drains every thread that has pending events. Cheap — the partial
   * pending-index makes "list distinct thread_ids with pending rows"
   * an O(log n) scan, and per-thread mutex (_draining set) means a
   * thread that's already draining returns immediately.
   */
  async recoverEventQueue(): Promise<void> {
    this.ensureSchema();
    // Canonical source of pending state: the pending_events table.
    // Pre-3a3e7ec sessions may have stuck `processed_at IS NULL` rows
    // in `events` from before the dual-table refactor; those are NOT
    // re-run by drain (the legacy queue semantics moved to
    // pending_events). Sessions active at deploy time lose their
    // in-flight queue state — acceptable for the small window.
    const threads = this.pending!.threadsWithPending();
    if (threads.length === 0) {
      // Nothing pending anywhere; defensive primary drain (cheap, returns
      // immediately when pending_events is empty).
      await this.drainEventQueue("sthr_primary");
      return;
    }
    await Promise.all(threads.map((t) => this.drainEventQueue(t)));
  }

  /**
   * Schedule a future wake-up of THIS session. Backed by the agents framework's
   * durable scheduler (SQLite-persisted, survives DO eviction). When the timer
   * fires, `onScheduledWakeup` injects a synthetic user.message tagged with
   * `metadata.harness="schedule"`, which kicks the harness loop back into
   * "running" via the same path /event POST takes for user messages
   * (lines 721-730).
   *
   * Exactly one of delay_seconds | at | cron must be supplied. Cron schedules
   * recur until cancelled via cancelWakeup(id).
   */
  async scheduleWakeup(args: {
    delay_seconds?: number;
    at?: string;
    cron?: string;
    prompt: string;
  }): Promise<{ id: string; fire_at?: string; cron?: string; kind: "one_shot" | "cron" }> {
    if (this.deriveStatus() === "terminated") {
      throw new Error("session is terminated; cannot schedule wakeup");
    }
    const provided = [args.delay_seconds, args.at, args.cron].filter((x) => x != null);
    if (provided.length !== 1) {
      throw new Error("must provide exactly one of delay_seconds | at | cron");
    }
    if (!args.prompt || !args.prompt.trim()) {
      throw new Error("prompt is required");
    }

    // Failsafe vs runaway cron loops: cap pending wakeups per session.
    // Without this, an agent that misuses cron (`*/1 * * * *` repeated, or a
    // tight delay_seconds=5 loop) can pile up unbounded schedules — each
    // fire injects a user.message + spawns a model turn, burning token quota
    // until someone notices. Filter to onScheduledWakeup callbacks so the
    // framework's internal recoverEventQueue / pollBackgroundTasks rows
    // don't count against the budget.
    const pending = this.getSchedules().filter((s) => s.callback === "onScheduledWakeup").length;
    if (pending >= MAX_PENDING_WAKEUPS) {
      throw new Error(
        `pending wakeup cap reached (${pending}/${MAX_PENDING_WAKEUPS}); ` +
        `call list_schedules to inspect, cancel_schedule to free a slot`,
      );
    }

    let when: number | Date | string;
    let kind: "one_shot" | "cron";
    if (typeof args.delay_seconds === "number") {
      when = args.delay_seconds;
      kind = "one_shot";
    } else if (args.at) {
      const d = new Date(args.at);
      if (Number.isNaN(d.getTime())) throw new Error(`invalid 'at' timestamp: ${args.at}`);
      when = d;
      kind = "one_shot";
    } else {
      when = args.cron!;
      kind = "cron";
    }

    const sched = await this.schedule(when, "onScheduledWakeup" as keyof this, {
      prompt: args.prompt,
      scheduled_at: new Date().toISOString(),
      kind,
      // Mint the span event id up front so the eventual wakeup user.message
      // can set parent_event_id = this id. EventBase.parent_event_id is the
      // existing causal-predecessor field (tool_result→tool_use uses it the
      // same way) — Console / SDK / dashboards that already understand it
      // get correct schedule→wakeup linking for free.
      parent_event_id: generateEventId(),
    });

    const fireAt = typeof sched.time === "number" ? new Date(sched.time * 1000).toISOString() : undefined;

    // Trajectory event mirroring span.background_task_scheduled. Use the
    // persisting variant so the event lands in the events table — the agent
    // (and operators) can later see when wakeups were registered, without
    // relying on WS subscribers being attached at schedule time.
    this.persistAndBroadcastEvent({
      type: "span.wakeup_scheduled",
      // Pre-minted id so onScheduledWakeup can stamp this on the wakeup
      // user.message's parent_event_id. The schedule_id (framework's) is
      // exposed separately for cancel/list addressing.
      id: (sched.payload as { parent_event_id?: string } | undefined)?.parent_event_id,
      schedule_id: sched.id,
      fire_at: fireAt,
      cron: kind === "cron" ? args.cron : undefined,
      kind,
    } as unknown as SessionEvent);

    return {
      id: sched.id,
      fire_at: fireAt,
      cron: kind === "cron" ? args.cron : undefined,
      kind,
    };
  }

  /**
   * Callback invoked by the agents framework when a wakeup schedule fires.
   * Mirrors the /event POST handler's user.message path (lines 721-730):
   * persist the synthetic message, arm a recoverEventQueue safety net, and
   * kick drain (no-await — drain handles its own concurrency guard).
   */
  async onScheduledWakeup(payload: {
    prompt: string;
    scheduled_at: string;
    kind: "one_shot" | "cron";
    parent_event_id?: string;
  }): Promise<void> {
    if (this.deriveStatus() === "terminated") {
      // Skip silently — terminated sessions should not be resurrected.
      // For cron schedules the row stays in agents-fw storage; ops can
      // cancel via list/cancel tools or a future REST surface.
      return;
    }
    const event: UserMessageEvent = {
      type: "user.message",
      content: [{ type: "text", text: payload.prompt }],
      // Causal link back to the span.wakeup_scheduled event whose alarm
      // just fired. Same field tool_result→tool_use uses; Console waterfall
      // pairs with it to draw the schedule-waiting bar (and any future
      // consumer that walks event ancestry gets it for free).
      ...(payload.parent_event_id ? { parent_event_id: payload.parent_event_id } : {}),
      metadata: {
        harness: "schedule",
        kind: "wakeup",
        wakeup_kind: payload.kind,
        scheduled_at: payload.scheduled_at,
        fired_at: new Date().toISOString(),
      },
    };
    // Wakeups go through the pending queue so the harness sees them in
    // the same order as real user.message events. Mirrors the POST /event
    // user.message path: stamp id + clear processed_at, enqueue, then
    // broadcast the system.user_message_pending frame.
    this.ensureSchema();
    this._stampEventForPending(event);
    this.pending!.enqueue(event);
    this._broadcastPendingFrame(event, "sthr_primary");
    try { await this.schedule(5, "recoverEventQueue" as keyof this); } catch {}
    this.drainEventQueue();
  }

  /**
   * Cancel a previously scheduled wakeup by id. Returns whether a row was
   * actually removed (false = id not found / already fired / not a wakeup).
   */
  async cancelWakeup(id: string): Promise<{ cancelled: boolean }> {
    if (!id) return { cancelled: false };
    // Defense: only cancel if it's a wakeup schedule, so an agent can't
    // cancel internal recoverEventQueue / pollBackgroundTasks rows.
    const sched = this.getSchedule(id);
    if (!sched || sched.callback !== "onScheduledWakeup") {
      return { cancelled: false };
    }
    const ok = await this.cancelSchedule(id);
    return { cancelled: !!ok };
  }

  /**
   * List pending wakeup schedules for THIS session. Filters on
   * `callback === "onScheduledWakeup"` so the agent never sees the
   * framework's internal recoverEventQueue / pollBackgroundTasks rows.
   */
  listWakeups(): Array<{
    id: string;
    fire_at?: string;
    cron?: string;
    prompt: string;
    kind: "one_shot" | "cron";
  }> {
    type WakeupPayload = { prompt?: string; kind?: "one_shot" | "cron" };
    const schedules = this.getSchedules();
    return schedules
      .filter((s) => s.callback === "onScheduledWakeup")
      .map((s) => {
        const payload = (s.payload ?? {}) as WakeupPayload;
        return {
          id: s.id,
          fire_at: typeof s.time === "number" ? new Date(s.time * 1000).toISOString() : undefined,
          cron: s.type === "cron" ? s.cron : undefined,
          prompt: payload.prompt ?? "",
          kind: payload.kind ?? "one_shot",
        };
      });
  }

  /**
   * Called by _checkOrphanTurns when an orphan turn (sessions row marked
   * status='running' with a turn_id we don't own) is detected at alarm
   * wake or cold-start. Historically this was wired into the cf-agents
   * runFiber/onFiberRecovered hook; Phase 3 unified the trigger via the
   * RuntimeAdapter, so the entry shape is identical to what the old
   * fiber API produced — { id, name, snapshot:null }. Recovery itself
   * works the same way: emit a session.status_rescheduled marker so
   * observers see what happened, reset stale state.status, and re-drain.
   * The unprocessed user.message at seq is still pending (we never
   * emitted status_idle for it) so drain re-runs the harness; generateText
   * sees prior tool_use/tool_result rows in history and continues from
   * roughly where it left off (at-least-once semantics — a tool may be
   * re-decided once, but no tool effect is lost since each result is in
   * SQL).
   */
  async onFiberRecovered(ctx: { id: string; name: string; snapshot: unknown }): Promise<void> {
    if (!ctx.name.startsWith("turn:")) {
      console.warn(`[orphan-recover] unknown turn name: ${ctx.name}`);
      return;
    }
    console.warn(
      `[orphan-recover] turn ${ctx.name} (id=${ctx.id}) interrupted; routing through recoverAgentTurn`,
    );
    this.ensureSchema();

    // Status is derived from cf_agents_runs row presence — onFiberRecovered
    // is invoked AFTER _checkRunFibers DELETEs the orphan, so deriveStatus
    // automatically reads "idle" here. No manual state mutation needed.

    const history = new SqliteHistory(
      this.ctx.storage.sql,
      this.env.FILES_BUCKET ?? null,
      `t/${this.state.tenant_id ?? "default"}/sessions/${this.state.session_id ?? "unknown"}`,
    );

    const decision = await recoverAgentTurn(
      this.turnRuntimeAdapter(),
      ctx,
      // loadRecoveryContext: read SQL events + streams to reconstruct the
      // state at the moment of interruption. We deliberately do NOT use
      // ctx.snapshot from cf-agents stash — OMA's events table already
      // carries richer canonical state.
      async () => {
        const lastUserMsgSeq = this.getLastEventSeq("user.message");
        const eventsAfter = this.getEventsBetween(lastUserMsgSeq, Number.MAX_SAFE_INTEGER);
        const partialStreams: PartialStream[] = [];
        try {
          const cursor = this.ctx.storage.sql.exec(
            `SELECT message_id, status, chunks_json FROM streams WHERE status IN ('streaming', 'interrupted') ORDER BY started_at`,
          );
          for (const row of cursor) {
            try {
              const chunks = JSON.parse(row.chunks_json as string) as string[];
              partialStreams.push({
                message_id: row.message_id as string,
                partial_text: chunks.join(""),
                status: (row.status as "streaming" | "interrupted"),
              });
            } catch {}
          }
        } catch {
          // streams table might not exist yet (older session); fine, return empty
        }
        return { history: eventsAfter, partialStreams };
      },
      // Resume policy: always continue. recoverAgentTurn caps at 5 attempts;
      // on the 6th the cap fires and we get a session.error + force-idle
      // automatically (no need to track it here). Persist partial agent
      // messages so the trajectory shows what was streamed before the cut.
      async (rctx) => {
        const reschedEvent: SessionEvent = {
          type: "session.status_rescheduled",
          reason: `Recovered after DO eviction (turn ${ctx.name}, recovery ${rctx.recoveryCount}/5)`,
        };
        history.append(reschedEvent);
        this.broadcastEvent(reschedEvent);
        return { continue: true, persistPartial: true };
      },
      {
        emitEvent: (e) => {
          history.append(e);
          this.broadcastEvent(e);
        },
        persistAgentMessage: (text, message_id) => {
          // Recovery's loadRecoveryContext seeds streamText with prior
          // partials; each recovery iteration also passes those same
          // (text, message_id) tuples through this callback. Without
          // dedup we'd re-append + re-broadcast each one per recovery
          // attempt — observed as 12 duplicate agent.message events at
          // 5x cap fire. Set is in-memory + per-turn (cleared at the
          // start of each drainEventQueue iteration).
          if (this.broadcastedMessageIds.has(message_id)) return;
          this.broadcastedMessageIds.add(message_id);
          const ev: SessionEvent = {
            type: "agent.message",
            id: message_id,
            content: [{ type: "text", text }],
          } as unknown as SessionEvent;
          history.append(ev);
          this.broadcastEvent(ev);
        },
        forceIdle: () => {
          // Status auto-derives to "idle" once recoverAgentTurn returns
          // and cf_agents_runs is empty. Just emit the trajectory event.
          const idleEvent: SessionEvent = { type: "session.status_idle" };
          history.append(idleEvent);
          this.broadcastEvent(idleEvent);
        },
        maxRecoveries: 5,
      },
    );

    if (decision.continue) {
      await this.drainEventQueue();
    }
  }

  /**
   * Read events strictly between two seq values (exclusive on both ends).
   * Helper used by recoverAgentTurn's loadRecoveryContext.
   */
  private getEventsBetween(afterSeq: number, beforeSeq: number): SessionEvent[] {
    const out: SessionEvent[] = [];
    try {
      const cursor = this.ctx.storage.sql.exec(
        `SELECT data FROM events WHERE seq > ? AND seq < ? ORDER BY seq`,
        afterSeq,
        beforeSeq,
      );
      for (const row of cursor) {
        try {
          out.push(JSON.parse(row.data as string) as SessionEvent);
        } catch {
          // Skip rows that fail to parse (read-side resilience).
        }
      }
    } catch {
      // events table may not exist yet
    }
    return out;
  }

  /**
   * Drain the event queue for one thread: pull pending user events
   * (processed_at IS NULL AND cancelled_at IS NULL) in seq order and
   * run the harness for each. Loops until the thread's queue is empty.
   *
   * Per-thread mutex via _draining set: two callers for the same
   * thread early-return; cross-thread drains run in parallel.
   *
   * Pending boundary: each row's `processed_at` column is the
   * authoritative "this event has been ingested" marker. On successful
   * (or failed) turn completion we UPDATE events SET processed_at=now
   * for the row. Old behavior (lastIdleSeq window) lost any user.message
   * appended between turn start and turn-end status_idle (5 messages
   * sent during a long-running turn would all be skipped).
   */
  private async drainEventQueue(threadId: string = "sthr_primary"): Promise<void> {
    // Sync re-entry mutex per thread — two callers for the same thread
    // can't both reach the SQL pending lookup before either marks a
    // row as processed.
    if (this._draining.has(threadId)) return;
    if (this.deriveStatus() === "terminated") return;
    this._draining.add(threadId);

    try {
    const history = new SqliteHistory(this.ctx.storage.sql, this.env.FILES_BUCKET ?? null, `t/${this.state.tenant_id ?? "default"}/sessions/${this.state.session_id ?? "unknown"}`);

    // Legacy backfill (one-shot per drain): pre-3a3e7ec sessions had
    // user.* rows sitting in `events` with processed_at IS NULL. The
    // refactor stops producing those. New code will never enqueue
    // through `events`, so this query returns zero rows in steady state.
    // We promote any stragglers in-place (UPDATE processed_at +
    // re-stamp data.processed_at + broadcast _promoted) so the events
    // log isn't visually wrong. The harness DOES NOT auto-run them —
    // accepting that any session active at deploy boundary loses its
    // in-flight queue state. Cheap (indexed; zero rows in steady state).
    // TODO(dual-table-followup): remove this block after a soak window
    // confirms no production session has had this trigger.
    {
      const cursor = this.ctx.storage.sql.exec(
        `SELECT seq, data FROM events
           WHERE session_thread_id = ?
             AND processed_at IS NULL AND cancelled_at IS NULL
             AND (type = 'user.message' OR type = 'user.tool_confirmation' OR type = 'user.custom_tool_result')
           ORDER BY seq ASC`,
        threadId,
      );
      const legacyRows: Array<{ seq: number; data: string }> = [];
      for (const row of cursor) {
        legacyRows.push({ seq: row.seq as number, data: row.data as string });
      }
      for (const lr of legacyRows) {
        const nowMs = Date.now();
        const nowIso = new Date(nowMs).toISOString();
        let event: SessionEvent;
        try {
          event = JSON.parse(lr.data) as SessionEvent;
        } catch {
          continue;
        }
        event.processed_at = nowIso;
        this.ctx.storage.sql.exec(
          `UPDATE events SET processed_at = ?, data = ? WHERE seq = ?`,
          nowMs, JSON.stringify(event), lr.seq,
        );
        const eventId = (event as { id?: string }).id;
        this.broadcastEvent({
          type: "system.user_message_promoted",
          event_id: eventId ?? "",
          // pending_seq absent — these never lived in pending_events.
          seq: lr.seq,
          processed_at: nowIso,
          session_thread_id: threadId,
        } as SystemUserMessagePromotedEvent);
      }
    }

    while (true) {
      // Peek the next active row from `pending_events` (no DELETE).
      // Crash-safety: we INSERT into events first, then DELETE here.
      // If the DO dies between INSERT and DELETE, the next drain will
      // peek the same row — the dedup check below detects it via
      // event_id and skips the re-INSERT, just deleting the stale row.
      const row = this.pending!.peek(threadId);
      if (!row) break;

      // Fresh per-turn dedup window for agent.message broadcasts. See
      // broadcastedMessageIds field doc for the recovery-replay context.
      this.broadcastedMessageIds.clear();

      // Parse the queued event and stamp processed_at = now (ISO).
      // AMA spec: processed_at = "wall-clock ingestion time, when the
      // agent picks the event up — not when the turn finishes". The
      // INSERT below carries this value verbatim into the events row.
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const event = JSON.parse(row.data) as SessionEvent;
      event.processed_at = nowIso;
      const eventId = (event as { id?: string }).id;

      // Dedup-by-event-id: if a previous drain crashed between INSERT
      // and DELETE, the event is already in `events` for this id.
      // Skip the re-INSERT but still delete the stale pending row so
      // the loop progresses and the harness doesn't re-run a turn that
      // already happened. Cheap — events.id has an expression index
      // (idx_events_event_id) so the lookup is O(log n).
      let alreadyPromoted = false;
      let promotedSeq: number | null = null;
      if (eventId) {
        for (const r of this.ctx.storage.sql.exec(
          `SELECT seq FROM events WHERE json_extract(data, '$.id') = ? LIMIT 1`,
          eventId,
        )) {
          alreadyPromoted = true;
          promotedSeq = r.seq as number;
        }
      }

      if (!alreadyPromoted) {
        // INSERT into events: history.append uses the cf-do adapter
        // which writes (type, data, processed_at, session_thread_id)
        // and returns the AUTOINCREMENT seq via the RETURNING clause
        // when reachable; here we re-read MAX(seq) for the broadcast.
        history.append(event);
        for (const r of this.ctx.storage.sql.exec(
          `SELECT seq FROM events WHERE json_extract(data, '$.id') = ? ORDER BY seq DESC LIMIT 1`,
          eventId ?? "",
        )) {
          promotedSeq = r.seq as number;
        }
      }

      // Now safe to delete from pending_events. Idempotent: a DO restart
      // before this DELETE leaves the dedup path above to handle the
      // duplicate-promote case on the next drain.
      this.pending!.delete(row.pending_seq);

      // Broadcast the canonical user.* event (now with processed_at
      // filled) so live consumers that key on user.message see the
      // promoted copy with the right wall-clock. Mirror what the
      // pre-refactor broadcastEvent path did at append time.
      this.broadcastEvent(event);
      // Promotion notification — lets new clients drop the outbox bubble
      // and render the new events-log row. Includes the assigned seq so
      // the client can correlate without polling.
      this.broadcastEvent({
        type: "system.user_message_promoted",
        event_id: eventId ?? "",
        pending_seq: row.pending_seq,
        seq: promotedSeq ?? undefined,
        processed_at: nowIso,
        session_thread_id: row.session_thread_id,
      } as SystemUserMessagePromotedEvent);

      const turnName = `turn:${promotedSeq ?? row.pending_seq}`;
      try {
        // Run the turn through the unified runtime: adapter.beginTurn /
        // endTurn write the marker on `sessions.turn_id`, hintTurnInFlight
        // wires CF's setAlarm-30s keep-alive, backup/persist runs
        // synchronously at end (no waitUntil race). Same shape Node's
        // SessionStateMachine uses; the body here stays in SessionDO
        // because DO has CF-only features (DO state push, schedule API,
        // sandbox warmup, sub-agents) the machine doesn't speak.
        await runAgentTurn(
          this.turnRuntimeAdapter(),
          turnName,
          async () => {
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
                // v1-additive (docs/trajectory-v1-spec.md "Causality"):
                // matching agent.custom_tool_use's EventBase.id IS the
                // custom_tool_use_id (AgentCustomToolUseEvent.id overrides
                // EventBase.id with `id: string`).
                parent_event_id: customResult.custom_tool_use_id,
              };
              history.append(toolResultEvent);
              this.broadcastEvent(toolResultEvent);
              const resumeMsg: UserMessageEvent = {
                type: "user.message",
                content: [{ type: "text", text: "" }],
              };
              await this.processUserMessage(resumeMsg, 0, true);
            }
          },
          {},
        );
        // Turn finished cleanly — clear any prior recovery counter so the
        // next turn doesn't inherit stale state.
        await clearTurnRecoveryCount(this.turnRuntimeAdapter(), turnName);
      } catch (err) {
        if (err instanceof TurnAborted) {
          console.warn(`[drain] turn ${turnName} aborted: ${err.cause.kind}`);
        }
        // User-initiated interrupt is not a session.error — the
        // POST /event handler for user.interrupt has already
        // appended `user.interrupt` + `session.status_idle`, and
        // the harness's stream-end fixup persisted any partial
        // agent.message. Writing session.error here would just
        // pollute the timeline with a misleading "error" frame.
        // Other TurnAborted causes (model_error 402/403, MCP
        // timeout, manual destroy) still surface as session.error
        // since the user didn't trigger them.
        const isUserInterrupt =
          err instanceof TurnAborted && err.cause.kind === "user_aborted";
        if (!isUserInterrupt) {
          const errorMsg = this.describeError(err);
          const errorEvent: SessionEvent = { type: "session.error", error: errorMsg };
          history.append(errorEvent);
          this.broadcastEvent(errorEvent);
        }

        // AMA RetryStatusTerminal: certain model errors are unrecoverable
        // and must transition the session to `terminated` state. Today we
        // catch the billing-fatal HTTP statuses (402 payment required,
        // 403 forbidden — Anthropic returns these when an org is out of
        // credit / over spend cap; retrying the same key won't succeed).
        // Other terminal sources (MCP auth refresh failure) live in the
        // tools.ts / main proxy path and are not visible here.
        if (
          err instanceof TurnAborted &&
          err.cause.kind === "model_error" &&
          (err.cause.status === 402 || err.cause.status === 403)
        ) {
          this.terminate("billing");
        }
        // The promoted events row already exists (we INSERTed it before
        // running the turn), and pending_events is already cleared.
        // Status auto-derives from sessions.turn_id once the
        // RuntimeAdapter.endTurn callback fires.
        break; // Stop draining on error — let the client decide what to do
      }
      // Promoted row is in events with processed_at set; pending row is
      // deleted. Loop back for the next pending event on this thread.
    }
    } finally {
      this._draining.delete(threadId);
    }
  }

  /**
   * Build the adapter turn-runtime needs from this DO. Returns a
   * RuntimeAdapter (the unified adapter Node also uses) wrapped in the
   * thin TurnRuntimeAgent shape that pins it to this DO's sessionId
   * and exposes ctx.storage for the recovery counter.
   *
   * The RuntimeAdapter's `hintTurnInFlight` callback is wired here to
   * setAlarm(now+30s) — this is CF's keep-alive: the alarm rearms
   * itself in alarm() so the DO doesn't get evicted while a turn is
   * in flight. Cheap; setAlarm cost is one storage write.
   */
  private turnRuntimeAdapter(): TurnRuntimeAgent {
    return {
      adapter: this.runtimeAdapter,
      sessionId: this.state.session_id,
      storage: {
        get: <T = unknown,>(key: string) => this.ctx.storage.get<T>(key),
        put: <T = unknown,>(key: string, value: T) => this.ctx.storage.put(key, value),
        delete: (key: string) => this.ctx.storage.delete(key).then(() => undefined),
      },
    };
  }

  /**
   * Lazily-built unified RuntimeAdapter for this session. Reused across
   * turns. The adapter holds:
   *   - sql: per-tenant D1 (resolved via buildCfTenantDbProvider) for
   *     beginTurn/endTurn/listOrphanTurns against the unified `sessions`
   *     table.
   *   - eventLog/streams: this DO's CfDoEventLog/CfDoStreamRepo (per-DO
   *     storage SQL — fast, transactional with the rest of DO state).
   *   - hintTurnInFlight: setAlarm(now+30s). The alarm() handler
   *     rearms itself while a turn is still in flight (sessions row
   *     status='running'), so an LLM streaming call lasting > 30s
   *     keeps the DO warm.
   */
  private get runtimeAdapter(): RuntimeAdapter {
    if (this._runtimeAdapter) return this._runtimeAdapter;
    if (!this._state) {
      throw new Error("runtimeAdapter accessed before state loaded");
    }
    const tenantId = this._state.tenant_id;
    // Lazy-resolve the per-tenant D1 binding. buildCfTenantDbProvider
    // returns the AUTH_DB shard the routing table maps this tenant to.
    // We construct the SqlClient eagerly and cache the adapter — the
    // tenant doesn't change for the lifetime of a SessionDO instance.
    const provider = buildCfTenantDbProvider(this.env);
    // provider.resolve is async; we synchronously construct using a
    // wrapper SqlClient that resolves on first call. Simpler: just hold
    // a Promise-backed SqlClient. Even simpler: assume the synchronous
    // path (env.AUTH_DB) since most deploys are single-shard. Fall back
    // to async resolve via a thin wrapper when sharded.
    const db = (this.env as unknown as { AUTH_DB?: D1Database }).AUTH_DB;
    if (!db) {
      throw new Error(
        "runtimeAdapter: env.AUTH_DB binding missing — required for unified sessions table writes",
      );
    }
    const sql = new CfD1SqlClient(db);
    if (!this.streams) this.ensureSchema();
    const eventLog: EventLogRepo = new CfDoEventLog(
      this.ctx.storage.sql,
      (e) => {
        const ev = e as SessionEvent & { id?: string; processed_at?: string };
        if (!ev.id) ev.id = `sevt_${generateEventId()}`;
        if (!ev.processed_at) ev.processed_at = new Date().toISOString();
      },
      this.env.MEMORY_BUCKET ?? null,
      `t/${tenantId}/sessions/${this._state.session_id}/events/`,
    );
    const streams = this.streams!;
    this._runtimeAdapter = new RuntimeAdapterImpl({
      sql,
      eventLog,
      streams,
      // No sandbox at adapter level — turn-runtime doesn't use it; the
      // legacy sandbox getter (this.getOrCreateSandbox()) stays as-is
      // for the harness path which constructs its own ctx.
      onTurnInFlight: (_sessionId, turnId) => {
        // Fire-and-forget setAlarm. CF's alarm queue de-dupes, so back-
        // to-back calls are fine. The alarm() handler re-arms while a
        // turn is still in flight.
        void this.ctx.storage.setAlarm(Date.now() + KEEP_ALIVE_INTERVAL_MS);
        // Register this turn id so _checkOrphanTurns + deriveStatus
        // see it. Lost on eviction → cold-start sees empty set → real
        // orphans (D1 row from a dead incarnation) get recovered on
        // the first alarm pass.
        this._activeTurnIds.add(turnId);
      },
      onTurnEnded: (_sessionId, turnId) => {
        // Idempotent: turn-runtime.ts also fires hintTurnEnded as a
        // safety net in its outer finally if endTurn itself throws.
        // Set.delete on missing key is a no-op.
        this._activeTurnIds.delete(turnId);
      },
    });
    // Provider call only used if sharding is in play; today the lazy
    // env.AUTH_DB path covers the single-shard default. Keep the
    // import live so future per-tenant shards plug in here.
    void provider;
    return this._runtimeAdapter;
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
    // Cold-start orphan flush: first request after DO activation triggers
    // a one-shot scan of unpaired tool_use + stale 'running' turns and
    // emits abort events for them. Idempotent (cheap when there's nothing
    // stale). Captures the case where a previous incarnation died
    // mid-stream — the alarm path catches the same condition but only
    // after the first alarm tick fires, which can be many seconds after
    // the user's first request lands.
    //
    // Guard semantics: the boolean is set BEFORE the async flush so two
    // concurrent first-fetches don't both fire the flush. On flush
    // failure the guard resets to false so a subsequent fetch retries —
    // a permanently-sticky guard would leave the recovery primitive
    // dead after a transient error.
    if (!this._coldStartFlushDone) {
      this._coldStartFlushDone = true;
      void this._finalizeStaleTurns().catch((err) => {
        console.warn(`[cold-start-flush] failed:`, err);
        this._coldStartFlushDone = false;
      });
    }
    try {
      return await this.fetchInner(request);
    } catch (err) {
      // Top-level catch so a single bad row / parse / unhandled throw doesn't
      // collapse to opaque "Internal Server Error" text from the runtime.
      // Caller gets structured JSON + the route they hit + a stable shape.
      const url = new URL(request.url);
      const msg = err instanceof Error ? (err.message || err.name) : String(err);
      const stack = err instanceof Error && err.stack ? err.stack.split("\n").slice(0, 5).join("\n") : undefined;
      console.error(`[session-do.fetch] ${request.method} ${url.pathname} → 500: ${msg}\n${stack ?? ""}`);
      return new Response(
        JSON.stringify({
          error: "internal_error",
          message: msg.slice(0, 500),
          method: request.method,
          path: url.pathname,
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }

  private async fetchInner(request: Request): Promise<Response> {
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
        terminated_at: null,
        // Stamp wall-clock create on first /init only — re-init shouldn't
        // reset the alive-seconds counter mid-session. (D1's
        // sessions.created_at is the canonical source; this DO copy lets
        // terminate compute elapsed without an async D1 read on the way out.)
        created_at_ms: this.state.created_at_ms ?? Date.now(),
        session_alive_billed: false,
      });

      // Outbound credential snapshot — DELETED. The legacy path published
      // a per-session KV blob containing plaintext vault credentials so the
      // outbound interceptor (apps/agent/src/outbound.ts) could look them
      // up by sessionId without going back to D1. That blob lived in the
      // agent worker's KV namespace and contained OAuth tokens / API keys
      // — i.e. plaintext secrets visible to anyone with KV-read access in
      // the agent worker scope. Post-refactor the interceptor RPCs into
      // main on each call (apps/agent/src/oma-sandbox.ts → env.MAIN_MCP
      // .outboundForward), main does the live vault lookup, and the agent
      // worker never holds plaintext credentials. See file-level comment
      // on apps/agent/src/oma-sandbox.ts for the full rationale.

      // Seed the primary thread row in DO SQLite. Done after setState so
      // _ensurePrimaryThread can read agent_id / agent_snapshot from
      // this.state. Idempotent (INSERT OR IGNORE) — safe across re-init.
      this._ensurePrimaryThread();

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

      // NO ctx.waitUntil(this.warmUpSandbox()) — that pattern dies on
      // DO reset (which happens regularly under our concurrent traffic
      // pattern). Let warmUp fire lazily on the first /event handler
      // below, where it runs as part of the user's request and holds the
      // DO alive for the full duration. First user
      // message pays the cold-start cost (~1-3 min for an env that
      // needs install + snapshot); subsequent messages restore in
      // seconds from the persisted handle.

      return new Response("ok");
    }

    // DELETE /destroy — tear down sandbox and clean up
    if (request.method === "DELETE" && url.pathname === "/destroy") {
      // Abort every in-flight thread (primary + any sub-agents).
      for (const ctrl of this._threadAbortControllers.values()) {
        ctrl.abort();
      }
      this._threadAbortControllers.clear();
      // Snapshot /workspace BEFORE we destroy the container — once destroy()
      // runs the container is gone and we can't read its filesystem.
      // CF's "persist across sessions" pattern (changelog 2026-02-23):
      // squashfs of /workspace lands in BACKUP_BUCKET; the handle goes into
      // D1 keyed by (tenant, env). Next session in the same scope's warmup
      // looks it up and restoreBackup's it. Force=true bypasses the
      // turn-end debounce so we always get a final snapshot.
      //
      // Force-create the sandbox wrapper if this.sandbox is null (SessionDO
      // was hibernated, in-memory ref lost). Without this, a hibernated
      // SessionDO that gets a /destroy request would skip both the backup
      // AND the actual container destroy, leaving the container running
      // until sleepAfter SIGTERM (with no final snapshot).
      if (!this.sandbox) {
        try { this.getOrCreateSandbox(); } catch {}
      }
      // Final snapshot — awaited so the squashfs lands in BACKUP_BUCKET
      // before sandbox.destroy() wipes the container. Implementation lives
      // on OmaSandbox.snapshotWorkspaceNow (single source of truth, also
      // used by the sleepAfter onActivityExpired hook). Best-effort: any
      // failure logs and we proceed with destroy.
      if (this.sandbox?.snapshotWorkspaceNow) {
        try { await this.sandbox.snapshotWorkspaceNow(); } catch {}
      }
      // Emit sandbox_active_seconds BEFORE destroy. CF's onStop callback
      // runs async to destroy() and can be dropped if the OmaSandbox DO
      // gets evicted before it fires (observed empirically on staging).
      // The explicit emit here puts the write in SessionDO's request
      // lifecycle — synchronous and reliable. onStop still wired as a
      // fallback for non-/destroy teardowns (sleepAfter, OOM); the
      // emit is idempotent (storage delete after success).
      const sandboxBilling = this.sandbox as unknown as {
        emitSandboxActiveNow?: () => Promise<void>;
      } | null;
      if (sandboxBilling?.emitSandboxActiveNow) {
        try { await sandboxBilling.emitSandboxActiveNow(); } catch (err) {
          logWarn({ op: "session_do.destroy.sandbox_emit", session_id: this.state.session_id, err }, "sandbox usage emit failed");
        }
      }
      // Destroy the sandbox container (kills processes, unmounts, stops container)
      if (this.sandbox?.destroy) {
        try { await this.sandbox.destroy(); } catch (err) {
          logWarn({ op: "session_do.destroy.sandbox", session_id: this.state.session_id, err }, "sandbox destroy failed");
        }
      }
      this.sandbox = null;
      this.wrappedSandbox = null;
      this.sandboxWarmupPromise = null;
      // Close the browser session if one was created
      if (this.browserSession) {
        try { await this.browserSession.close(); } catch (err) {
          logWarn({ op: "session_do.destroy.browser", session_id: this.state.session_id, err }, "browser session close failed");
        }
        this.browserSession = null;
      }
      this.browserHarness = null;
      // Outbound snapshot delete — DROPPED. The publish at session init
      // is gone too (see comment above), so there's nothing here to clean
      // up. The outbound interceptor RPCs into main on each call and main
      // re-checks session.archived_at, so an archived session's outbound
      // calls naturally fail without any KV cleanup needed.
      this.terminate("session_deleted");

      return new Response("ok");
    }

    // POST /event — receive user event, kick off harness
    if (request.method === "POST" && url.pathname === "/event") {
      // AMA semantics: a terminated session is one-way; reject new
      // events at the door so callers see a clean 409 envelope rather
      // than appending a dead-letter event the harness will never run.
      // Mirrors the main worker's archived_at check on POST /v1/sessions/:id/events.
      if (this._state?.terminated_at != null || this._state?.status === "terminated") {
        return new Response(
          JSON.stringify({
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "Session is terminated and cannot receive new events",
            },
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        );
      }
      const raw = (await request.json()) as SessionEvent & { _mount_file_ids?: string[] };
      // Sidecar field set by main worker's events POST resolver. Strip it
      // before persisting — it is delivery metadata, not part of the canonical
      // event schema.
      const mountFileIds = raw._mount_file_ids;
      delete (raw as { _mount_file_ids?: string[] })._mount_file_ids;
      const body = raw as SessionEvent;
      // Reject events targeting an archived thread before any side effects
      // (history.append, broadcastEvent, drainEventQueue). Primary thread
      // can't be archived (handler at /threads/:tid/archive enforces 400),
      // so 'sthr_primary' is always allowed without a SQL lookup.
      const targetThreadId =
        (body as unknown as { session_thread_id?: string }).session_thread_id ??
        "sthr_primary";
      if (targetThreadId !== "sthr_primary") {
        let archived = false;
        for (const row of this.ctx.storage.sql.exec(
          `SELECT archived_at FROM threads WHERE id = ? LIMIT 1`,
          targetThreadId,
        )) {
          archived = row.archived_at != null;
        }
        if (archived) {
          return new Response(
            JSON.stringify({
              type: "error",
              error: {
                type: "invalid_request_error",
                message: `Thread ${targetThreadId} is archived and cannot receive new events`,
              },
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          );
        }
      }
      const history = new SqliteHistory(this.ctx.storage.sql, this.env.FILES_BUCKET ?? null, `t/${this.state.tenant_id ?? "default"}/sessions/${this.state.session_id ?? "unknown"}`);

      // Auto-mount referenced files into the sandbox FS so agent's bash/read
      // tools see them at /mnt/session/uploads/{file_id}, while the model
      // already sees the inline base64 from the resolver. Mirrors Anthropic
      // managed-agents dual path. Best-effort — failure does not block the
      // event from being processed.
      if (mountFileIds && mountFileIds.length > 0 && this.env.FILES_BUCKET) {
        // Wrapped sandbox: first .exec/.writeFileBytes will await warmup.
        const sandbox = this.getOrCreateSandbox();
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
            logWarn(
              { op: "session_do.auto_mount.file", session_id: this.state.session_id, file_id: fid, err },
              "auto-mount file write failed",
            );
          }
        }
      }

      if (body.type === "user.message") {
        const um = body as UserMessageEvent;
        const umThread =
          (um as unknown as { session_thread_id?: string })
            .session_thread_id ?? "sthr_primary";
        // Stamp id + processed_at = null on the canonical event before
        // enqueue. The pending row carries the same JSON; drain will
        // overwrite processed_at to the wall-clock when promoting.
        this._stampEventForPending(um);
        this.pending!.enqueue(um);
        // Broadcast the AMA-spec "pending" notification so live
        // consumers can render the outbox bubble immediately. Carries
        // pending_seq so the matching `system.user_message_promoted`
        // frame can correlate the bubble with the eventual events-log
        // row at drain time.
        this._broadcastPendingFrame(um, umThread);
        try {
          await this.schedule(5, "recoverEventQueue");
        } catch {}
        // Fire-and-forget the drain. ctx.waitUntil is a no-op inside DO classes
        // (Workers Context API is stateless-only — see CF docs), so don't try
        // to use it. The DO is kept alive instead by:
        //   (a) the unified RuntimeAdapter's hintTurnInFlight callback —
        //       wired in this DO's constructor to setAlarm(now+30s). The
        //       alarm() handler rearms itself while a turn is still in
        //       flight (sessions row status='running'), AND
        //   (b) the keepAliveWhile no-op the harness still receives in
        //       its HarnessRuntime — purely a stub today; the alarm-
        //       rearm path covers what it used to defend.
        // The 5s recoverEventQueue schedule above is the safety-net
        // re-trigger if this background promise dies before drain runs.
        console.log(`[post /event] user.message enqueued (thread=${umThread}), firing drainEventQueue`);
        this.drainEventQueue(umThread);
        return new Response(null, { status: 202 });
      }

      if (body.type === "user.interrupt") {
        // AMA-spec semantics for user.interrupt:
        //   1. Abort the in-flight turn for the target thread (only that
        //      thread — siblings keep running). If no session_thread_id
        //      is set, defaults to primary.
        //   2. Flush queued user.* events for that thread (mark
        //      cancelled_at). AMA's BetaManagedAgentsRetryStatusExhausted
        //      doc says "queued inputs are flushed and the session
        //      returns to idle"; user.interrupt mirrors that semantic.
        //      eventsToMessages skips cancelled events so they never
        //      reach the LLM context.
        //   3. Append the user.interrupt event itself + idle marker.
        const targetThread =
          (body as unknown as { session_thread_id?: string })
            .session_thread_id ?? "sthr_primary";
        const ctrl = this._threadAbortControllers.get(targetThread);
        const hadActiveTurn = !!ctrl;
        if (ctrl) {
          ctrl.abort();
          this._threadAbortControllers.delete(targetThread);
        }
        const cancelTs = Date.now();
        // Cancel rows in the AMA-spec pending_events queue and broadcast
        // a per-row notification so live consumers can strike-through the
        // outbox bubble.
        const cancelledRows = this.pending!.cancelAllForThread(
          targetThread,
          cancelTs,
        );
        for (const row of cancelledRows) {
          this.broadcastEvent({
            type: "system.user_message_cancelled",
            pending_seq: row.pending_seq,
            event_id: row.event_id,
            session_thread_id: row.session_thread_id,
            cancelled_at: cancelTs,
          } as SystemUserMessageCancelledEvent);
        }
        // Legacy back-compat: pre-3a3e7ec sessions may still have user.*
        // rows sitting in `events` with processed_at IS NULL. The legacy
        // partial pending-index on `events` would otherwise pick them up
        // on the next drain. Mark them cancelled so they never run.
        const cancelResult = this.ctx.storage.sql.exec(
          `UPDATE events SET cancelled_at = ?
             WHERE session_thread_id = ?
               AND processed_at IS NULL AND cancelled_at IS NULL
               AND (type = 'user.message' OR type = 'user.tool_confirmation' OR type = 'user.custom_tool_result')`,
          cancelTs, targetThread,
        );
        const legacyCancelledCount = (cancelResult as { rowsWritten?: number }).rowsWritten ?? 0;
        const cancelledCount = cancelledRows.length + legacyCancelledCount;
        history.append(body as UserInterruptEvent);
        // Emit status_idle when interrupt actually changed thread state:
        // either an active turn was aborted, or queued events were
        // cancelled. Skip when both are false (no-op interrupt) — that
        // case had been emitting a duplicate status_idle right after a
        // natural-end one, observed 2026-05-11 sess-y5saq (seq 93 idle
        // stop_reason=end_turn, seq 95 idle stop_reason=None).
        const shouldEmitIdle = hadActiveTurn || cancelledCount > 0;
        if (shouldEmitIdle) {
          // stop_reason is required on session.status_idle per Anthropic
          // spec — pydantic v2 in @anthropic-ai/sdk-python rejects events
          // without it. Anthropic's StopReason union has no `interrupted`
          // variant, so use `end_turn` (the closest semantic — agent
          // stopped, user can send the next message). The accompanying
          // user.interrupt event in the log carries the actual cause.
          const idleEvent: SessionEvent = {
            type: "session.status_idle",
            stop_reason: { type: "end_turn" },
            ...(targetThread !== "sthr_primary" ? { session_thread_id: targetThread } : {}),
          };
          history.append(idleEvent);
          this.broadcastEvent(idleEvent);
        }
        return new Response(null, { status: 202 });
      }

      if (body.type === "user.tool_confirmation") {
        const tc = body as UserToolConfirmationEvent;
        const tcThread =
          (tc as unknown as { session_thread_id?: string }).session_thread_id ??
          "sthr_primary";
        this._stampEventForPending(tc);
        this.pending!.enqueue(tc);
        this._broadcastPendingFrame(tc, tcThread);
        try {
          await this.schedule(5, "recoverEventQueue");
        } catch {}
        console.log("[post /event] tool_confirmation enqueued, firing drainEventQueue (no await)");
        this.drainEventQueue(tcThread);
        return new Response(null, { status: 202 });
      }

      if (body.type === "user.custom_tool_result") {
        const customResult = body as UserCustomToolResultEvent;
        const ctrThread =
          (customResult as unknown as { session_thread_id?: string })
            .session_thread_id ?? "sthr_primary";
        this._stampEventForPending(customResult);
        this.pending!.enqueue(customResult);
        this._broadcastPendingFrame(customResult, ctrThread);
        try {
          await this.schedule(5, "recoverEventQueue");
        } catch {}
        console.log("[post /event] custom_tool_result enqueued, firing drainEventQueue (no await)");
        this.drainEventQueue(ctrThread);
        return new Response(null, { status: 202 });
      }

      if (body.type === "user.define_outcome") {
        const e = body as UserDefineOutcomeEvent;
        // AMA-spec: validate at-least-one-of(rubric|verifier). Reject the
        // event before persisting so callers get a clean 400 instead of a
        // silently degraded supervisor loop.
        const hasRubric =
          typeof e.rubric === "string"
            ? e.rubric.trim().length > 0
            : !!e.rubric && (
                (e.rubric.type === "text" && !!e.rubric.content) ||
                (e.rubric.type === "file" && !!e.rubric.file_id)
              );
        if (!hasRubric && !e.verifier) {
          return new Response(
            "user.define_outcome requires at least one of `rubric` or `verifier`",
            { status: 400 },
          );
        }
        // Mint outcome_id server-side (AMA-style `outc_…` prefix). Honour
        // a client-supplied id only when it's already prefixed (used by
        // tests / replays); otherwise mint fresh.
        const outcome_id =
          e.outcome_id && e.outcome_id.startsWith("outc_")
            ? e.outcome_id
            : generateOutcomeId();
        const echoed: UserDefineOutcomeEvent = { ...e, outcome_id };
        // Sequential outcomes: any prior `state.outcome` is dropped (it
        // either already terminated and was nulled by the supervisor, or
        // we're explicitly replacing it). Existing `outcome_evaluations`
        // history stays intact.
        this.setState({
          ...this.state,
          outcome: {
            outcome_id,
            description: echoed.description,
            rubric: echoed.rubric,
            verifier: echoed.verifier,
            max_iterations: echoed.max_iterations,
          },
          outcome_iteration: 0,
        });
        history.append(echoed);
        this.broadcastEvent(echoed);
        return new Response(null, { status: 202 });
      }

      return new Response("Unknown event type", { status: 400 });
    }

    // POST /__debug_recovery__ — gated test endpoint that lets ops verify
    // recoverInterruptedState fires correctly against a real production
    // SessionDO. Body lists orphan rows to inject (streaming row with
    // chunks, builtin/mcp/custom tool_use), then the recovery scan runs
    // synchronously and the report is returned in the response. The next
    // GET /events shows the resulting reconciliation events.
    //
    // Auth: requires the X-Debug-Token header to match env.DEBUG_TOKEN
    // (set as a wrangler secret in environments where this should work).
    // 401s if either side is unset, so prod-without-secret is safe.
    if (request.method === "POST" && url.pathname === "/__debug_recovery__") {
      const expected = (this.env as { DEBUG_TOKEN?: string }).DEBUG_TOKEN;
      const provided = request.headers.get("x-debug-token");
      if (!expected || !provided || expected !== provided) {
        return new Response("Forbidden", { status: 403 });
      }
      this.ensureSchema();
      if (!this.streams) {
        return new Response("streams unavailable", { status: 500 });
      }
      type Seed =
        | { kind: "stream"; message_id: string; chunks?: string[] }
        | { kind: "tool_use"; id: string; name?: string; tool_kind?: "builtin" | "mcp" | "custom" };
      const body = (await request.json().catch(() => ({}))) as { seed?: Seed[] };
      const seeds = body.seed ?? [];
      const history = new SqliteHistory(this.ctx.storage.sql, this.env.FILES_BUCKET ?? null, `t/${this.state.tenant_id ?? "default"}/sessions/${this.state.session_id ?? "unknown"}`);
      for (const s of seeds) {
        if (s.kind === "stream") {
          await this.streams.start(s.message_id, Date.now());
          for (const ch of s.chunks ?? []) await this.streams.appendChunk(s.message_id, ch);
        } else {
          const k = s.tool_kind ?? "builtin";
          const evType =
            k === "mcp" ? "agent.mcp_tool_use" :
            k === "custom" ? "agent.custom_tool_use" :
            "agent.tool_use";
          history.append({ type: evType, id: s.id, name: s.name ?? "test_tool" } as SessionEvent);
        }
      }
      const report = await runRecovery(this.streams, history);
      // Broadcast warnings same as the cold-start path.
      for (const w of report.warnings) {
        this.broadcastEvent({
          type: "session.warning",
          source: w.source,
          message: w.message,
          details: w.details,
        } as SessionEvent);
      }
      return Response.json({ seeded: seeds.length, ...report });
    }

    // GET /ws — WebSocket upgrade
    if (request.method === "GET" && url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }
      const pair = new WebSocketPair();

      // Wire-protocol opt-ins forwarded by cf-session-router.ts. Defaults
      // (no headers) = Anthropic-spec behavior: no replay, only spec event
      // types broadcast. `Last-Event-ID` is SSE-native resume — its
      // presence implies replay-from-seq regardless of x-oma-replay.
      const includeChunks =
        (request.headers.get("x-oma-include") ?? "")
          .split(",")
          .map((s) => s.trim())
          .includes("chunks");
      const replayHeader = request.headers.get("x-oma-replay") === "1";
      const lastEventIdRaw = request.headers.get("Last-Event-ID");
      const lastEventId = lastEventIdRaw !== null
        ? Number.parseInt(lastEventIdRaw, 10)
        : NaN;
      const wantsReplay = replayHeader || Number.isFinite(lastEventId);

      // Tag the socket so broadcastEvent (line ~3120) can filter per-ws.
      // Chunks-opted sockets get the "chunks" tag → broadcastEvent routes
      // OMA extension events only to them; spec events go to all sockets.
      // Pass undefined (not []) when no tags so the runtime skips the
      // tag-array path entirely — empty-tags semantics differ across CF
      // runtime versions and the cleanest contract is "no tags arg".
      if (includeChunks) {
        this.ctx.acceptWebSocket(pair[1], ["chunks"]);
      } else {
        this.ctx.acceptWebSocket(pair[1]);
      }

      // Conditional history replay. Skip entirely when neither flag set —
      // this is the spec-default ("only events after open"). When set,
      // filter by seq > lastEventId for clean SSE resume semantics.
      if (wantsReplay) {
        const history = new SqliteHistory(
          this.ctx.storage.sql,
          this.env.FILES_BUCKET ?? null,
          `t/${this.state.tenant_id ?? "default"}/sessions/${this.state.session_id ?? "unknown"}`,
        );
        // Use the repo-level afterSeq filter — the SQL layer drops rows
        // server-side, which is the only place that can see `seq` (the
        // returned SessionEvent objects are bare wire payloads with no
        // `seq` field stitched on).
        const events = history.getEvents(
          Number.isFinite(lastEventId) ? lastEventId : undefined,
        );
        for (const event of events) {
          // Same spec-vs-extension filter applied to the live broadcast
          // path (broadcastEvent below); replayed history must respect the
          // same wire contract or a spec-only client would silently get
          // OMA extension events on reconnect.
          if (!includeChunks && !isSpecEvent(event.type)) continue;
          pair[1].send(JSON.stringify(event));
        }
      }

      // Pending queue replay — emit a system.user_message_pending frame
      // for every active row across every thread, so a fresh client sees
      // the outbox state without an extra GET /pending. `system.*` is an
      // OMA extension type, so this is gated by the chunks opt-in. Old
      // SDK consumers (no opt-in) can fetch /pending directly.
      if (includeChunks) {
        try {
          for (const threadId of this.pending!.threadsWithPending()) {
            for (const row of this.pending!.list(threadId)) {
              let parsed: SessionEvent;
              try {
                parsed = JSON.parse(row.data) as SessionEvent;
              } catch {
                continue;
              }
              const pendingFrame: SystemUserMessagePendingEvent = {
                type: "system.user_message_pending",
                event_id: row.event_id,
                pending_seq: row.pending_seq,
                enqueued_at: row.enqueued_at,
                session_thread_id: row.session_thread_id,
                event: parsed,
              };
              pair[1].send(JSON.stringify(pendingFrame));
            }
          }
        } catch (err) {
          console.warn(
            `[ws-replay] pending queue replay failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // GET /status
    if (request.method === "GET" && url.pathname === "/status") {
      return Response.json({
        status: this.deriveStatus(),
        agent_id: this.state.agent_id,
        environment_id: this.state.environment_id,
        usage: {
          input_tokens: this.state.input_tokens,
          output_tokens: this.state.output_tokens,
        },
      });
    }

    // GET /pending — AMA-spec pending queue surface. Lists user.* events
    // that have been enqueued but not yet drained.
    //
    // Query params:
    //   ?session_thread_id=…    → filter to one thread (default sthr_primary)
    //   ?include_cancelled=true → include rows flushed by user.interrupt
    //
    // Response shape:
    //   { data: [ { pending_seq, enqueued_at, type, event_id,
    //               session_thread_id, cancelled_at, data } ] }
    // Ordered by pending_seq ASC. Cancelled rows omitted by default.
    if (request.method === "GET" && url.pathname === "/pending") {
      const threadId =
        url.searchParams.get("session_thread_id") ?? "sthr_primary";
      const includeCancelled =
        url.searchParams.get("include_cancelled") === "true";
      const rows = this.pending!.list(threadId, includeCancelled);
      const data = rows.map((r) => {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(r.data);
        } catch (err) {
          parsed = {
            _parse_error: err instanceof Error ? err.message : String(err),
            _raw_preview: r.data.slice(0, 200),
          };
        }
        return {
          pending_seq: r.pending_seq,
          enqueued_at: r.enqueued_at,
          session_thread_id: r.session_thread_id,
          type: r.type,
          event_id: r.event_id,
          cancelled_at: r.cancelled_at,
          data: parsed,
        };
      });
      return Response.json({ data });
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
      // Retry the SQL exec on transient "Durable Object storage operation
      // exceeded timeout" errors only — these surface during write-contention
      // storms (e.g. 49+ concurrent model_request_start events), and a
      // 100-ms-backoff retry window is enough to clear them. All other
      // errors (parse, schema, NULL row) propagate untouched to the
      // top-level 500 handler so real bugs aren't swallowed.
      let rows: ReturnType<ReturnType<typeof this.ctx.storage.sql.exec>["toArray"]>;
      {
        let lastErr: unknown;
        let attempt = 0;
        const maxAttempts = 3;
        for (;;) {
          try {
            rows = this.ctx.storage.sql.exec(query, afterSeq, limit + 1).toArray();
            break;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const transient = /storage operation exceeded timeout|object to be reset/i.test(msg);
            attempt++;
            if (!transient || attempt >= maxAttempts) {
              lastErr = err;
              break;
            }
            await new Promise((r) => setTimeout(r, 100 * attempt));
          }
        }
        if (!rows!) throw lastErr;
      }

      const hasMore = rows.length > limit;
      const resultRows = hasMore ? rows.slice(0, limit) : rows;

      const events = resultRows.map((row) => {
        let data: unknown;
        try {
          data = JSON.parse(row.data as string);
        } catch (err) {
          // One bad row used to throw and 500 the whole endpoint, hiding all
          // valid events for the session. Surface the parse failure in-band
          // so callers can still iterate the rest of the trajectory.
          const msg = err instanceof Error ? err.message : String(err);
          data = { _parse_error: msg, _raw_preview: String(row.data ?? "").slice(0, 200) };
        }
        return {
          seq: row.seq,
          type: row.type,
          data,
          ts: row.ts,
        };
      });

      // Resolve any spilled events back from R2 so callers see full payloads.
      // Lazy + parallel — small events skip the R2 fetch entirely.
      if (this.env.FILES_BUCKET) {
        await Promise.all(
          events.map(async (e) => {
            const meta = (e.data as { _spilled?: { r2_key: string; original_bytes: number } } | null)?._spilled;
            if (!meta) return;
            try {
              const obj = await this.env.FILES_BUCKET!.get(meta.r2_key);
              if (!obj) {
                (e.data as Record<string, unknown>)._spill_lost = true;
                return;
              }
              const text = await obj.text();
              try {
                e.data = JSON.parse(text);
              } catch (parseErr) {
                (e.data as Record<string, unknown>)._spill_parse_error = (parseErr instanceof Error ? parseErr.message : String(parseErr)).slice(0, 200);
              }
            } catch (err) {
              (e.data as Record<string, unknown>)._spill_get_error = (err instanceof Error ? err.message : String(err)).slice(0, 200);
            }
          }),
        );
      }

      const lastSeq = resultRows.length > 0 ? resultRows[resultRows.length - 1].seq : null;
      return Response.json({
        data: events,
        has_more: hasMore,
        next_page: hasMore && lastSeq !== null ? `seq_${lastSeq}` : null,
      });
    }

    // POST /usage — increment token usage counters. Now thread-aware:
    // body may carry session_thread_id (defaults to sthr_primary) and
    // optional cache_creation_input_tokens / cache_read_input_tokens for
    // the per-thread breakdown that GET /threads/:id surfaces. The
    // session-wide echo (input_tokens / output_tokens) stays unchanged
    // for back-compat with existing /full-status consumers.
    if (request.method === "POST" && url.pathname === "/usage") {
      const body = (await request.json()) as {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
        session_thread_id?: string;
      };
      const threadId = body.session_thread_id ?? "sthr_primary";
      this.creditUsageToThread(threadId, {
        input_tokens: body.input_tokens ?? 0,
        output_tokens: body.output_tokens ?? 0,
        cache_creation_input_tokens: body.cache_creation_input_tokens,
        cache_read_input_tokens: body.cache_read_input_tokens,
      });
      return Response.json({
        input_tokens: this.state.input_tokens,
        output_tokens: this.state.output_tokens,
      });
    }

    // POST /exec — run a raw shell command in this session's sandbox
    // WITHOUT going through the agent. Designed for eval / verifier
    // workflows where the harness needs to run pytest (or similar) on
    // post-agent state without trusting the agent to invoke a tool.
    // Returns { exit_code, output } where output is the combined
    // stdout+stderr text. Body:
    //   { command: string, timeout_ms?: number (default 60000) }
    if (request.method === "POST" && url.pathname === "/exec") {
      const body = (await request.json()) as { command?: string; timeout_ms?: number };
      const command = body.command;
      const timeoutMs = body.timeout_ms ?? 60_000;
      if (!command || typeof command !== "string") {
        return new Response(JSON.stringify({ error: "command (string) required" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      try {
        const sandbox = this.getOrCreateSandbox();
        // Wrap multi-line / set-e style scripts in a subshell `( ... )` so
        // they run in a child process. Otherwise commands like `set -e`
        // followed by a failing step (e.g. pytest exit 1) terminate the
        // underlying persistent shell session — every subsequent exec
        // fails with SessionTerminatedError. Subshell parens preserve
        // newlines verbatim (unlike `bash -c "<json-stringified>"` which
        // would escape \n as a literal backslash-n).
        const needsSubshell = command.includes("\n") || /\bset\s+-[a-z]*e[a-z]*\b/.test(command);
        const wrapped = needsSubshell ? `( ${command}\n)` : command;
        const raw = await sandbox.exec(wrapped, timeoutMs);
        // sandbox.exec returns "exit=N\n<merged-output>"
        const m = raw.match(/^exit=(-?\d+)\n([\s\S]*)$/);
        const exit_code = m ? parseInt(m[1], 10) : -1;
        const output = m ? m[2] : raw;
        return Response.json({
          exit_code,
          output: output.length > 100_000 ? output.slice(0, 100_000) + "\n...(truncated)" : output,
          truncated: output.length > 100_000,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return Response.json(
          { exit_code: -1, output: `sandbox exec error: ${msg}`, error: true },
          { status: 500 },
        );
      }
    }

    // GET /threads — list session threads (AMA shape).
    //
    // Reads from the `threads` SQL table (DO storage), not the in-memory
    // Map — that one only holds sub-agent threads spawned in the current
    // isolate; the SQL table survives DO eviction and includes the
    // primary thread (seeded on /init).
    //
    // Query params:
    //   ?include_archived=true  → include archived rows (default off)
    //
    // Response shape mirrors BetaManagedAgentsSessionThread minimally:
    // id / agent_id / agent_name / parent_thread_id / created_at /
    // archived_at / status / stats. usage stays null until per-thread
    // token accounting lands (today tokens are session-wide on
    // state.input_tokens / state.output_tokens — no thread breakdown).
    if (request.method === "GET" && url.pathname === "/threads") {
      const includeArchived = url.searchParams.get("include_archived") === "true";
      const cursor = includeArchived
        ? this.ctx.storage.sql.exec(
            `SELECT id, agent_id, agent_name, parent_thread_id, created_at, archived_at
               FROM threads ORDER BY created_at`,
          )
        : this.ctx.storage.sql.exec(
            `SELECT id, agent_id, agent_name, parent_thread_id, created_at, archived_at
               FROM threads WHERE archived_at IS NULL ORDER BY created_at`,
          );
      const data = [] as Array<Record<string, unknown>>;
      for (const row of cursor) {
        data.push(this._serializeThreadRow(row));
      }
      return Response.json({ data });
    }

    // GET /threads/:thread_id — single thread metadata.
    const threadGetMatch = url.pathname.match(/^\/threads\/([^/]+)$/);
    if (request.method === "GET" && threadGetMatch) {
      const threadId = threadGetMatch[1];
      let row: Record<string, unknown> | undefined;
      for (const r of this.ctx.storage.sql.exec(
        `SELECT id, agent_id, agent_name, parent_thread_id, created_at, archived_at
           FROM threads WHERE id = ? LIMIT 1`,
        threadId,
      )) {
        row = r;
      }
      if (!row) {
        return Response.json(
          { error: { type: "not_found", message: `thread ${threadId} not found` } },
          { status: 404 },
        );
      }
      return Response.json(this._serializeThreadRow(row));
    }

    // POST /threads/:thread_id/archive — soft-delete (status flips to
    // archived; subsequent POST /event for this thread should 409).
    // Idempotent — re-archive returns the existing archived_at.
    const threadArchiveMatch = url.pathname.match(/^\/threads\/([^/]+)\/archive$/);
    if (request.method === "POST" && threadArchiveMatch) {
      const threadId = threadArchiveMatch[1];
      // Refuse archiving the primary thread — the session itself is the
      // primary thread's lifecycle, not the thread row's.
      if (threadId === "sthr_primary") {
        return Response.json(
          { error: { type: "invalid_request", message: "cannot archive the primary thread" } },
          { status: 400 },
        );
      }
      let exists = false;
      for (const _ of this.ctx.storage.sql.exec(
        `SELECT 1 FROM threads WHERE id = ? LIMIT 1`,
        threadId,
      )) {
        exists = true;
      }
      if (!exists) {
        return Response.json(
          { error: { type: "not_found", message: `thread ${threadId} not found` } },
          { status: 404 },
        );
      }
      // Set archived_at only if not already set — preserves the original
      // archive timestamp on idempotent re-archive.
      this.ctx.storage.sql.exec(
        `UPDATE threads SET archived_at = ? WHERE id = ? AND archived_at IS NULL`,
        Date.now(), threadId,
      );
      // Drop the in-memory config map entry — future agent calls referencing
      // this thread should fail loudly rather than silently spawn against an
      // archived row.
      this.threads.delete(threadId);
      // Echo the (now archived) thread back so the caller can read the
      // archived_at timestamp without an extra GET.
      let row: Record<string, unknown> | undefined;
      for (const r of this.ctx.storage.sql.exec(
        `SELECT id, agent_id, agent_name, parent_thread_id, created_at, archived_at
           FROM threads WHERE id = ? LIMIT 1`,
        threadId,
      )) {
        row = r;
      }
      return Response.json(this._serializeThreadRow(row!));
    }

    // GET /threads/:thread_id/events — paginated event list scoped to
    // one thread. Filter happens at the SQL level via the
    // session_thread_id column populated by CfDoEventLog.append.
    const threadEventsMatch = url.pathname.match(/^\/threads\/([^/]+)\/events$/);
    if (request.method === "GET" && threadEventsMatch) {
      const threadId = threadEventsMatch[1];
      const limit = Math.min(
        parseInt(url.searchParams.get("limit") ?? "200", 10) || 200,
        1000,
      );
      const afterSeq = parseInt(url.searchParams.get("after_seq") ?? "0", 10) || 0;
      const order = url.searchParams.get("order") === "desc" ? "DESC" : "ASC";
      const cursor = this.ctx.storage.sql.exec(
        `SELECT seq, type, data, ts, processed_at, cancelled_at, session_thread_id
           FROM events
           WHERE session_thread_id = ? AND seq > ?
           ORDER BY seq ${order} LIMIT ?`,
        threadId, afterSeq, limit,
      );
      const data = [] as Array<Record<string, unknown>>;
      for (const row of cursor) {
        const ev = JSON.parse(row.data as string);
        if (row.processed_at != null) ev.processed_at_ms = row.processed_at;
        if (row.cancelled_at != null) ev.cancelled_at_ms = row.cancelled_at;
        if (row.session_thread_id != null) ev.session_thread_id = row.session_thread_id;
        data.push({
          seq: row.seq,
          type: row.type,
          ts: row.ts,
          data: ev,
        });
      }
      return Response.json({ data });
    }

    // GET /full-status — session status with usage and outcome evaluations.
    //
    // Phase 4 / AMA alignment: outcome_evaluations is now sourced from
    // `state.outcome_evaluations` (written by the supervisor loop on every
    // terminal `span.outcome_evaluation_end`). Falls back to scanning the
    // event log for legacy spellings (`session.outcome_evaluated`,
    // `outcome.evaluation_end`, `span.outcome_evaluation_end`) so sessions
    // written before this change still surface their verdicts.
    if (request.method === "GET" && url.pathname === "/full-status") {
      const history = new SqliteHistory(this.ctx.storage.sql, this.env.FILES_BUCKET ?? null, `t/${this.state.tenant_id ?? "default"}/sessions/${this.state.session_id ?? "unknown"}`);

      const stateEvaluations = this.state.outcome_evaluations ?? [];
      let outcomeEvaluations: PersistedOutcomeEvaluation[] = stateEvaluations;
      if (outcomeEvaluations.length === 0) {
        // Back-compat scan. Only runs for sessions whose supervisor never
        // wrote into state.outcome_evaluations[] (pre-Phase-4 emit
        // sites). Cheap because the event scan is local to this DO.
        const allEvents = history.getEvents();
        outcomeEvaluations = allEvents
          .filter(
            (e) =>
              e.type === "session.outcome_evaluated" ||
              e.type === "outcome.evaluation_end" ||
              e.type === "span.outcome_evaluation_end",
          )
          .map((e: SessionEvent) => {
            const ev = e as Partial<PersistedOutcomeEvaluation> & {
              feedback?: string;
            };
            return {
              outcome_id: ev.outcome_id ?? "",
              result: (ev.result ?? "needs_revision") as PersistedOutcomeEvaluation["result"],
              iteration: typeof ev.iteration === "number" ? ev.iteration : 0,
              explanation: ev.explanation ?? ev.feedback,
              feedback: ev.feedback ?? ev.explanation,
              usage: ev.usage,
              processed_at: (e as { processed_at?: string }).processed_at,
            };
          });
      }

      return Response.json({
        status: this.deriveStatus(),
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
    this.ensureSandboxCreated();
    return this.wrappedSandbox!;
  }

  /** Used inside warmup itself to avoid the wrap → warmup → wrap recursion. */
  private getRawSandbox(): SandboxExecutor {
    this.ensureSandboxCreated();
    return this.sandbox!;
  }

  private ensureSandboxCreated() {
    if (!this.sandbox) {
      // Sandbox ID must be 1-63 chars; DO hex ID is 64 chars — truncate to fit
      const sandboxId = this.ctx.id.toString().slice(0, 63);
      this.sandbox = createSandbox(this.env, sandboxId);
      this.wrappedSandbox = this.wrapSandboxWithLazyWarmup(this.sandbox);
    }
  }

  /**
   * Returns a Proxy of the sandbox where any "real-work" method (exec,
   * readFile, etc.) awaits sandboxWarmupPromise before delegating. Lets us
   * remove the blocking `await warmUpSandbox()` from the user-message hot
   * path: turns that never touch the sandbox (e.g. cron-only flows, pure
   * answer turns) skip the 3s container cold-start entirely; turns that do
   * use tools overlap the warmup with model fetch/TTFT.
   *
   * Container-recycle detection: CF Sandbox container has its own idle
   * lifecycle independent of SessionDO. If it dies (sleepAfter, OOM, host
   * migration), our cached sandboxWarmupPromise still resolves but the
   * underlying /workspace is empty. We probe a per-warmup marker file
   * (/tmp/.oma-warm) — if missing or value-mismatched, invalidate cache
   * and re-warmup so restoreWorkspaceBackup runs again. Probe is one
   * `cat`, throttled to once per 30s to bound steady-state cost.
   *
   * The non-method properties and helpers like setEnvVars are passed
   * through synchronously — they don't talk to the container itself.
   */
  private wrapSandboxWithLazyWarmup(raw: SandboxExecutor): SandboxExecutor {
    const needsWarm = new Set<string>([
      "exec",
      "startProcess",
      "readFile",
      "writeFile",
      "writeFileBytes",
      "readFileBytes",
      "mountWorkspace",
      "gitCheckout",
    ]);
    // Methods we additionally want to run through classifyExternalError on
    // throw — covers the workspace-backup R2 path (createWorkspaceBackup /
    // restoreWorkspaceBackup) that doesn't go through warmup but still
    // raises CF-shaped errors ("version rollout", "Sandbox error", 503).
    // exec / startProcess / readFile / writeFile already classify via the
    // needsWarm wrapper below; everything in this set additionally
    // classifies even though it doesn't need warmup.
    const classifyOnly = new Set<string>([
      "createWorkspaceBackup",
      "restoreWorkspaceBackup",
      "snapshotWorkspaceNow",
      "mountSessionOutputs",
    ]);
    const ensureWarm = async (): Promise<void> => {
      // Cold path — warmup never ran or was reset by a recycle below.
      if (!this.sandboxWarmupPromise) {
        await this.warmUpSandbox();
        return;
      }
      // Warm path — wait for the cached promise (handles concurrent calls).
      await this.sandboxWarmupPromise;
      // Probe marker every call. Container can recycle (OOM, sleepAfter,
      // host migration) between any two calls; throttling the probe
      // misses fast-cluster-then-die patterns. ~5ms cost per tool call.
      let probed: string | null = null;
      try {
        const raw_out = await raw.exec("cat /tmp/.oma-warm 2>/dev/null");
        const m = /^exit=(-?\d+)\n([\s\S]*)$/.exec(raw_out);
        probed = (m && m[1] === "0") ? m[2].trim() : "";
      } catch { probed = null; }
      if (probed === this.currentWarmupGen) return; // alive, marker matches
      // Container recycled — reset cache and re-warm now (which includes
      // restoreWorkspaceBackup) so the upcoming user call sees /workspace
      // restored, not an empty fresh container.
      logWarn(
        { op: "session_do.warmup.recycle_detected", session_id: this.state.session_id, expected: this.currentWarmupGen, got: probed },
        "container marker mismatch — re-warming",
      );
      this.sandboxWarmupPromise = null;
      this.currentWarmupGen = null;
      await this.warmUpSandbox();
    };
    return new Proxy(raw, {
      get: (target, prop, receiver) => {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        const name = prop as string;
        const wantsWarm = needsWarm.has(name);
        const wantsClassify = wantsWarm || classifyOnly.has(name);
        if (!wantsWarm && !wantsClassify) return value.bind(target);
        return async (...args: unknown[]) => {
          if (wantsWarm) await ensureWarm();
          try {
            return await (value as (...a: unknown[]) => unknown).apply(target, args);
          } catch (err) {
            // Boundary: turn raw CF Containers / SDK errors into typed
            // OmaErrors (TransientInfraError for "version rollout",
            // RateLimitedError for 429, etc.) so processUserMessage's
            // retry switch can dispatch via instanceof. Falls back to
            // re-throwing the original error if no pattern matches.
            // TODO: extend wrapper coverage to other boundaries as new
            // failure modes surface (D1 client, KV ops, MCP transport).
            throw classifyExternalError(err);
          }
        };
      },
    }) as SandboxExecutor;
  }

  /**
   * Lazy-build a per-DO BrowserHarness. Wraps the package's
   * createCfBrowserHarness with caching so launch() always returns the
   * same BrowserSession across turns within the DO lifetime — preserving
   * the cross-turn cookie/state behaviour from before the package split.
   * Returns null if the BROWSER binding isn't configured.
   */
  private getBrowserHarness(): BrowserHarness | null {
    if (!this.env.BROWSER) return null;
    if (!this.browserHarness) {
      const tenantId = this.state.tenant_id;
      const sessionId = this.state.session_id;
      const agentId = this.state.agent_id || null;
      // Hybrid-billing hook: emit one browser_active_seconds row when the
      // BrowserSession closes (DELETE /destroy path or hibernation
      // teardown). Skipped when tenant/session aren't set yet (early-init
      // edge — no usage to attribute).
      const hook: BrowserBillingHook | null = tenantId && sessionId
        ? {
            tenantId,
            sessionId,
            agentId,
            onClose: async (elapsedSeconds: number) => {
              try {
                const { getCfServicesForTenant } = await import("@open-managed-agents/services");
                const services = await getCfServicesForTenant(this.env, tenantId);
                await services.usage.recordUsage({
                  tenantId,
                  sessionId,
                  agentId,
                  kind: "browser_active_seconds",
                  value: elapsedSeconds,
                });
                console.log(
                  `[session_do] usage emit browser_active_seconds=${elapsedSeconds} session=${sessionId.slice(0, 12)}`,
                );
              } catch (err) {
                console.error(
                  `[session_do] browser usage emit failed: ${(err as Error).message ?? err}`,
                );
              }
            },
          }
        : null;
      const inner = createCfBrowserHarness(
        this.env.BROWSER as unknown as { fetch: typeof fetch },
      );
      this.browserHarness = {
        launch: async () => {
          if (!this.browserSession) {
            this.browserSession = await inner.launch({ hook });
          }
          return this.browserSession;
        },
      };
    }
    return this.browserHarness;
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
        // Clear cached promise on failure so next call retries.
        this.sandboxWarmupPromise = null;
        throw err;
      });
    }
    return this.sandboxWarmupPromise;
  }

  private async doWarmUpSandbox(): Promise<void> {

    try {
      // Raw sandbox — wrapped one would recurse back into warmUpSandbox here.
      const sandbox = this.getRawSandbox();

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

      // Restore the most recent workspace backup for (tenant, environment)
      // BEFORE mountResources runs, so the agent picks up where it left
      // off. Per CF's recommended pattern (changelog 2026-02-23, "pick up
      // where you left off, even after days of inactivity").
      //
      // Skip when the session attaches a github_repository resource: that
      // resource git-clones into /workspace, and `git clone` requires the
      // target dir to be empty. Restore-then-clone would fail; the user
      // explicitly asked for a clone so they want clone semantics, not
      // restore semantics. (Future: smarter merge — restore then `git pull`.)
      if (
        sandbox instanceof CloudflareSandbox &&
        this.state.tenant_id &&
        this.state.environment_id &&
        this.env.AUTH_DB
      ) {
        try {
          // If /tmp/.oma-warm is present, the container survived since a
          // previous warmup — /workspace is already populated by whoever
          // wrote the marker. Skip restore: re-running it would download
          // the latest backup over a live /workspace, throwing away any
          // writes since that backup. This is the path that lets a verify
          // exec arriving N minutes after the agent turn just see the
          // files the agent wrote, no D1 round-trip needed.
          let containerWarmAlready = false;
          try {
            const probed = await sandbox.exec("cat /tmp/.oma-warm 2>/dev/null");
            const m = /^exit=(-?\d+)\n([\s\S]*)$/.exec(probed);
            if (m && m[1] === "0" && m[2].trim().length > 0) {
              containerWarmAlready = true;
              this.currentWarmupGen = m[2].trim();
              logWarn(
                { op: "session_do.warmup.skip_restore_container_alive", session_id: this.state.session_id, marker: this.currentWarmupGen },
                "skipping workspace restore — container still warm with previous /workspace",
              );
            }
          } catch { /* probe failed → fall through to normal restore path */ }

          let hasGitRepo = false;
          if (this.state.session_id) {
            const services = await getCfServicesForTenant(this.env, this.state.tenant_id);
            const rows = await services.sessions.listResourcesBySession({ sessionId: this.state.session_id });
            hasGitRepo = rows.some(
              (r) => r.type === "github_repository" || r.type === "github_repo",
            );
          }
          if (containerWarmAlready) {
            // already short-circuited above with a warning log
          } else if (hasGitRepo) {
            logWarn(
              { op: "session_do.warmup.skip_restore_github_repo", session_id: this.state.session_id },
              "skipping workspace restore — session attaches github_repository (git clone needs empty /workspace)",
            );
          } else {
            // Route to the tenant's shard — workspace_backups is per-tenant
            // data, so the row lives wherever this tenant was sharded.
            const provider = buildCfTenantDbProvider(this.env);
            const backupDb = await provider.resolve(this.state.tenant_id);
            const handle = await findWorkspaceBackup(
              backupDb,
              this.state.tenant_id,
              this.state.environment_id,
              this.state.session_id ?? "unknown",
              Date.now(),
            );
            if (handle) {
              const restoreStart = Date.now();
              const result = await sandbox.restoreWorkspaceBackup(handle);
              const restoreMs = Date.now() - restoreStart;
              const ok = result.ok;
              const restoreError = result.error;
              try {
                this.persistAndBroadcastEvent({
                  type: "session.warning",
                  message: ok
                    ? `workspace_restored backup_id=${handle.id} elapsed_ms=${restoreMs}`
                    : `workspace_restore_failed backup_id=${handle.id} elapsed_ms=${restoreMs} error=${(restoreError ?? "unknown").slice(0, 300)}`,
                } as unknown as SessionEvent);
              } catch {}
              if (!ok) {
                logWarn(
                  {
                    op: "session_do.warmup.restore_backup",
                    session_id: this.state.session_id,
                    tenant_id: this.state.tenant_id,
                    environment_id: this.state.environment_id,
                    backup_id: handle.id,
                    elapsed_ms: restoreMs,
                    error: restoreError,
                  },
                  "workspace backup restore failed — continuing with empty workspace",
                );
              }
            } else {
              // No backup found — fresh session, expected case. Log
              // for ops/debugging only; don't emit as session.warning
              // because a "warning" event leaks into the trajectory
              // and confuses operators reading session timelines (it's
              // not actually a problem). Failed restore (above) and
              // successful restore (above) are different — those ARE
              // worth a session event.
              log(
                {
                  op: "session_do.warmup.no_backup",
                  session_id: this.state.session_id,
                  tenant_id: this.state.tenant_id,
                  environment_id: this.state.environment_id,
                },
                "no workspace backup found for this session — starting fresh",
              );
            }
          }
        } catch (err) {
          // Best-effort. Workspace persistence shouldn't block session
          // warmup — agent still works with empty /workspace.
          logWarn(
            { op: "session_do.warmup.restore_backup", session_id: this.state.session_id, err },
            "workspace backup restore failed; continuing with empty /workspace",
          );
        }
      }

      // image_strategy fast path REMOVED. Was a base_snapshot lazy-prepare
      // path that ran a multi-minute install + tar + R2 upload via a single
      // sandbox.exec — the SDK wraps each exec in blockConcurrencyWhile,
      // which CF cancels at ~10-15s. Every retry restarted the install
      // from scratch, zombie SessionDOs alarmed in a loop, and the
      // container pool capped at max_instances starved real sessions.
      //
      // Until the platform exposes a primitive for "snapshot a container
      // filesystem outside the DO request loop," base_snapshot envs fall
      // through to the install-on-every-boot loop below — same path as
      // dockerfile/null. The base image already has python/uv/requests/
      // httpx/pandas/pytest/Go/Rust pre-baked, so envs without extra
      // packages skip install entirely.
      const envId = this.state.environment_id;
      const imagePathHandled = false;

      // Install environment packages if configured. Replaces the old
      // "always re-install everything every cold start" loop with a
      // marker-aware 3-path flow (warm/restored/fresh) — see
      // ./setup-on-warmup.ts for the full design.
      //
      // Lang packages (pip/npm/cargo/go) install to /workspace/.<lang>/
      // so they're captured by the workspace backup just restored above.
      // On the next cold restart the "restored" path skips them and only
      // re-runs apt (which can't be backed up via SDK whitelist).
      if (envId && !imagePathHandled) {
        const envConfig = await this.getEnvConfig(envId);
        const pkgs = envConfig?.config?.packages;
        if (pkgs) {
          const result = await ensureSetupApplied(
            { exec: (cmd: string, timeout?: number) => sandbox.exec(cmd, timeout) },
            pkgs,
            (event) => {
              // Best-effort: emit a console line per step so it shows up
              // in CF tail. A future commit threads this into the session
              // event_log so the frontend can render the AMA-style ticker
              // inline in chat (see demo/env-prep README for the design).
              if (event.kind === "step") {
                console.log(`[setup-on-warmup] step=${event.step}${event.reason ? ` reason=${event.reason}` : ""}`);
              } else {
                console.log(`[setup-on-warmup] done path=${event.path} duration_ms=${event.durationMs}`);
              }
            },
          );
          if (result.error) {
            console.error(`[setup-on-warmup] failed path=${result.path}: ${result.error}`);
            // Don't throw — the agent can still try to run with whatever
            // packages survived. Surfaced via tool exec failure if a
            // missing dep is needed.
          }
        }
      }

      // Mount FILES_BUCKET at /mnt/session/outputs/ so any file the agent
      // writes there immediately appears via the caller-facing
      // GET /v1/sessions/:id/outputs endpoint. Mirrors AMA's `/mnt/session
      // /outputs/` magic dir contract — agent uses the standard `write` tool,
      // platform takes care of persistence + listing. Best-effort: mount
      // failure logs but doesn't block warmup; agent can still write to
      // /workspace, just not callable-retrievable.
      if (this.state.session_id && this.state.tenant_id && sandbox.mountSessionOutputs) {
        try {
          await sandbox.mountSessionOutputs({
            tenantId: this.state.tenant_id,
            sessionId: this.state.session_id,
          });
        } catch (err) {
          console.warn(
            `[session-do] mountSessionOutputs failed: ${(err as Error).message ?? err}`,
          );
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
            // Memory-store name lookup for mount paths (Anthropic mounts as
            // /mnt/memory/<name>/, not /mnt/memory/<id>/). The lookup falls
            // back to the id if the store can't be resolved.
            async (storeId: string) => {
              try {
                const memSvc = (await getCfServicesForTenant(this.env, this.state.tenant_id)).memory;
                const store = await memSvc.getStore({
                  tenantId: this.state.tenant_id,
                  storeId,
                });
                return store ? { name: store.name } : null;
              } catch {
                return null;
              }
            },
          );
        }
      }

      // CLI auth lives in main worker via cap_cli credentials — sandbox
      // outbound handler RPCs to MAIN_MCP.lookupOutboundCredential on
      // every HTTPS request, main resolves cap spec + token, injects
      // Bearer at proxy. Sandbox never holds plaintext token in env or
      // memory. Sentinel env vars (e.g. GITHUB_TOKEN=__cap_managed__) are
      // set here from the cap spec's bootstrap.env so CLIs that refuse to
      // dial out without a token-shaped env value still try; the proxy
      // replaces the sentinel-bearing Authorization header at HTTPS time.
      const vaultIds = this.state.vault_ids;
      if (vaultIds.length && sandbox.setEnvVars) {
        try {
          const { builtinSpecs, createSpecRegistry } = await import("@open-managed-agents/cap");
          const registry = createSpecRegistry(builtinSpecs);
          const sentinelEnv: Record<string, string> = {};
          const creds = await this.getVaultCredentials(vaultIds);
          for (const cred of creds) {
            if (cred.auth?.type !== "cap_cli" || !cred.auth.cli_id) continue;
            const spec = registry.byCliId(cred.auth.cli_id);
            if (!spec?.bootstrap?.env) continue;
            for (const [k, v] of Object.entries(spec.bootstrap.env)) {
              // First cap_cli for a given env var wins. Sentinels are
              // identical across credentials anyway (all `__cap_managed__`),
              // so collisions are no-op in practice.
              if (!(k in sentinelEnv)) sentinelEnv[k] = v;
            }
          }
          if (Object.keys(sentinelEnv).length > 0) {
            await sandbox.setEnvVars(sentinelEnv);
          }
        } catch (err) {
          console.error(
            `[session-do] cap sentinel env injection failed (continuing without): ${(err as Error).message}`,
          );
        }
      }

      // Bind the outbound handler with this session's identifying context.
      // Per-call vault lookup happens in main via env.MAIN_MCP.lookupOutboundCredential
      // — the agent worker briefly holds the bearer token to inject the
      // Authorization header. Container never sees plaintext (auth is
      // added on agent worker side; SDK's TLS-MITM re-encrypts to
      // container). The handler is a transparent HTTP proxy: body
      // streams through, response is returned unchanged.
      //
      // **MUST call this for every session, vault or not.** Cloudflare's
      // sandbox-container PID 1 runs trustRuntimeCert() at startup which
      // polls /etc/cloudflare/certs/cloudflare-containers-ca.crt for 5s.
      // The cert is only pushed by the platform once `setOutboundHandler`
      // has been called from the worker side. Skipping this call for
      // no-vault sessions made every such container exit(1) at the 5s
      // mark with "Certificate not found, refusing to start without
      // HTTPS interception enabled" — see cf-sandbox-cert-demo bisection
      // 2026-05-04. The handler itself is a no-op transparent proxy when
      // no vault credentials match the request host (oma-sandbox.ts:82-97).
      //
      // R2 traffic (createBackup / restoreBackup squashfs PUT/GET/HEAD)
      // is routed away from this catch-all by the static `outboundByHost`
      // entry in oma-sandbox.ts — without that bypass the materialize-and-
      // re-PUT flow corrupts the squashfs blob (sandbox-sdk#619).
      if (sandbox.setOutboundContext && this.state.session_id && this.state.tenant_id) {
        await sandbox.setOutboundContext({
          tenantId: this.state.tenant_id,
          sessionId: this.state.session_id,
        });
      }

      // Per-host github handler binding. Without this, the static
      // `outboundByHost` map only carries the function reference — CF
      // Containers SDK invokes it with `ctx.params = undefined`, so
      // githubAuthHandler's `if (params.tenantId && ...)` guard always
      // fails, MAIN_MCP credential lookups never fire, and gh / git
      // requests sail past unauthenticated. setOutboundByHost binds the
      // params for this specific (host, methodName) pair at runtime.
      // Wrapped in optional check because older sandbox SDK versions
      // don't expose this method (self-host running 0.8.x). On those,
      // github cap_cli still won't work, but neither did it before.
      const sandboxHost = sandbox as unknown as {
        setOutboundByHost?: (
          hostname: string,
          methodName: string,
          params: { tenantId: string; sessionId: string },
        ) => Promise<void>;
      };
      if (sandboxHost.setOutboundByHost && this.state.session_id && this.state.tenant_id) {
        const ctx = { tenantId: this.state.tenant_id, sessionId: this.state.session_id };
        await Promise.all([
          sandboxHost.setOutboundByHost("api.github.com", "github_auth", ctx),
          sandboxHost.setOutboundByHost("github.com", "github_auth", ctx),
        ]);
      }

      // Hand backup context to OmaSandbox so its onActivityExpired hook
      // (sleepAfter teardown) writes the final /workspace snapshot scoped
      // to this (tenant, env, session). Container DO is keyed by sessionId,
      // so this only needs to land once per warmup. Restoration on the
      // next session uses (tenant, env) — see findWorkspaceBackup above.
      if (sandbox.setBackupContext && this.state.session_id && this.state.tenant_id && this.state.environment_id) {
        await sandbox.setBackupContext({
          tenantId: this.state.tenant_id,
          environmentId: this.state.environment_id,
          sessionId: this.state.session_id,
        });
      }

      // Hand billing context to OmaSandbox so its onStop hook (sleepAfter
      // teardown OR explicit destroy) emits one sandbox_active_seconds
      // row scoped to this (tenant, session, agent). Same idempotency
      // story as setBackupContext — same-session rewarms keep the
      // original startedAt; new-session containers mint a fresh one.
      const sandboxAny = sandbox as unknown as {
        setBillingContext?: (c: {
          tenantId: string;
          sessionId: string;
          agentId: string | null;
        }) => Promise<void>;
      };
      if (sandboxAny.setBillingContext && this.state.session_id && this.state.tenant_id) {
        await sandboxAny.setBillingContext({
          tenantId: this.state.tenant_id,
          sessionId: this.state.session_id,
          agentId: this.state.agent_id || null,
        });
      }

      // Drop a per-warmup marker so the proxy can detect a recycled
      // container later (just check `cat /tmp/.oma-warm` matches the
      // gen we set). /tmp clears on restart so the absence IS the signal.
      const gen = crypto.randomUUID().slice(0, 12);
      try {
        await sandbox.exec(`echo ${gen} > /tmp/.oma-warm`);
        this.currentWarmupGen = gen;
      } catch (err) {
        logWarn(
          { op: "session_do.warmup.write_marker", session_id: this.state.session_id, err },
          "warmup marker write failed; proxy will pessimistically re-warm",
        );
        this.currentWarmupGen = null;
      }
    } catch (err) {
      this.currentWarmupGen = null;
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
    // Per-socket spec-vs-extension routing. Sockets that opted into chunks
    // (tagged "chunks" in the /ws handler) receive everything; others
    // receive only Anthropic-spec event types. Keeps the spec-default
    // wire contract clean for clients using the official Anthropic SDK
    // against an OMA server.
    const sockets = isSpecEvent(event.type)
      ? this.ctx.getWebSockets()
      : this.ctx.getWebSockets("chunks");
    for (const ws of sockets) {
      try {
        ws.send(data);
      } catch {
        // Connection already closed
      }
    }
  }

  /**
   * Stamp `id` and clear `processed_at` on a pending-bound event before
   * enqueue. The event will sit in `pending_events.data` verbatim until
   * `drainEventQueue` peeks it; drain then sets `processed_at` to the
   * wall-clock and INSERTs into `events` with the next AUTOINCREMENT seq.
   *
   * AMA-spec semantics: `processed_at` MUST be null on the wire while
   * the event is queued ("null if not yet processed by the agent").
   * The stamp helper in event-log/cf-do skips stamping processed_at for
   * the three queue-input types, so the value stays absent until drain
   * stamps it explicitly.
   */
  private _stampEventForPending(event: SessionEvent): void {
    const e = event as SessionEvent & { id?: string; processed_at?: string };
    if (!e.id) {
      e.id = `sevt_${generateEventId()}`;
    }
    // Defensive: clear any pre-set processed_at on inbound user.* events
    // (clients should never set it, but if they do, drain owns the stamp).
    delete e.processed_at;
  }

  /**
   * Broadcast `system.user_message_pending` over WS so live consumers
   * can render the outbox bubble immediately. Carries the canonical
   * event payload (so older clients that key on `user.message` still
   * see the content) AND `pending_seq` (so the matching `_promoted`
   * frame at drain time can correlate the bubble with the events-log
   * row that lands at INSERT).
   */
  private _broadcastPendingFrame(event: SessionEvent, threadId: string): void {
    // Look up the just-enqueued row's pending_seq so the client has a
    // stable correlation key. The peek returns the lowest-seq pending
    // row for the thread; since we just enqueued and the per-thread
    // mutex (_draining) hasn't yet picked it up, this row IS the one
    // we just wrote (FIFO within a thread).
    const row = this.pending!.peek(threadId);
    const pendingSeq = row?.pending_seq ?? 0;
    const eventId = (event as unknown as { id?: string }).id ?? "";
    this.broadcastEvent({
      type: "system.user_message_pending",
      event_id: eventId,
      pending_seq: pendingSeq,
      enqueued_at: row?.enqueued_at ?? Date.now(),
      session_thread_id: threadId,
      event,
    } as SystemUserMessagePendingEvent);
  }

  /**
   * Inspect an outbound event for a `span.model_request_end` carrying
   * `model_usage` and credit cache tokens to the given thread. Input /
   * output token totals already arrive via reportUsage at the end of the
   * turn (default-loop step 10), so this only handles the cache-bucket
   * deltas reportUsage doesn't carry. Idempotent across primary +
   * sub-agent broadcast paths because each model_request_end event is
   * emitted exactly once per LLM step.
   */
  private maybeCreditCacheTokens(threadId: string, event: SessionEvent): void {
    if (event.type !== "span.model_request_end") return;
    const usage = (event as unknown as {
      model_usage?: {
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
    }).model_usage;
    if (!usage) return;
    const cc = usage.cache_creation_input_tokens || 0;
    const cr = usage.cache_read_input_tokens || 0;
    if (cc === 0 && cr === 0) return;
    this.creditUsageToThread(threadId, {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: cc,
      cache_read_input_tokens: cr,
    });
  }

  /**
   * Credit token usage to a specific thread AND keep the session-wide
   * `state.input_tokens` / `state.output_tokens` in sync. Cache token
   * fields are tracked per-thread only — the session-wide totals just
   * cover input/output (their existing meaning).
   *
   * Called from the `reportUsage` closures wired into HarnessRuntime
   * for both the primary turn and sub-agent turns; threadId is the
   * session_thread_id the closure was bound to ("sthr_primary" or a
   * sub-agent "sthr_*").
   */
  private creditUsageToThread(
    threadId: string,
    delta: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    },
  ): void {
    const existing = this.state.thread_usage ?? {};
    const prior = existing[threadId] ?? {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    const next = {
      input_tokens: prior.input_tokens + (delta.input_tokens || 0),
      output_tokens: prior.output_tokens + (delta.output_tokens || 0),
      cache_creation_input_tokens:
        prior.cache_creation_input_tokens + (delta.cache_creation_input_tokens || 0),
      cache_read_input_tokens:
        prior.cache_read_input_tokens + (delta.cache_read_input_tokens || 0),
    };
    this.setState({
      ...this.state,
      input_tokens: (this.state.input_tokens ?? 0) + (delta.input_tokens || 0),
      output_tokens: (this.state.output_tokens ?? 0) + (delta.output_tokens || 0),
      thread_usage: { ...existing, [threadId]: next },
    });
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
      const history = new SqliteHistory(this.ctx.storage.sql, this.env.FILES_BUCKET ?? null, `t/${this.state.tenant_id ?? "default"}/sessions/${this.state.session_id ?? "unknown"}`);
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
   * Resolve credentials and the wire-level model string for an agent's
   * `model` value (which is a card.model_id handle, not the LLM API model).
   *
   * Lookup order:
   *   1. Card whose `model_id` (handle) matches the requested handle
   *   2. Env-var fallback (ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL)
   *
   * Returns:
   *   - `model` — the LLM string to send to the provider. card.model when a
   *     card is found; otherwise the input handle (env-only path assumes
   *     the user wrote a real LLM model name in agent.model).
   *   - `apiKey`, `baseURL`, `apiCompat`, `customHeaders` — same as before,
   *     source-of-truth depends on whether a card was matched.
   */
  private async resolveModelCardCredentials(
    handle: string,
  ): Promise<{
    model: string;
    apiKey: string;
    baseURL?: string;
    apiCompat: ApiCompat;
    customHeaders?: Record<string, string>;
  }> {
    let apiKey = this.env.ANTHROPIC_API_KEY;
    let baseURL = this.env.ANTHROPIC_BASE_URL;
    let provider: string | undefined;
    let customHeaders: Record<string, string> | undefined;
    let wireModel = handle;

    if (this.env.AUTH_DB) {
      try {
        const services = await getCfServicesForTenant(this.env, this.state.tenant_id);
        const tenantId = this.state.tenant_id;
        const card = await services.modelCards.findByModelId({ tenantId, modelId: handle });
        if (card && !card.archived_at) {
          const key = await services.modelCards.getApiKey({ tenantId, cardId: card.id });
          if (key) {
            apiKey = key;
            provider = card.provider;
            wireModel = card.model;
            if (card.base_url) baseURL = card.base_url;
            if (card.custom_headers) customHeaders = card.custom_headers;
            console.log(`[model-card] resolved from D1: id=${card.id} model_id=${card.model_id} model=${card.model} baseURL=${card.base_url ?? "(default)"} provider=${card.provider}`);
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

    return { model: wireModel, apiKey, baseURL, apiCompat, customHeaders };
  }

  /**
   * Resolve the agent's auxiliary model (when configured).
   *
   * Returns null when the agent has no aux_model set — callers should
   * skip aux features (e.g. web_fetch summarization) in that case.
   */
  private async resolveAuxModel(agent: AgentConfig): Promise<{
    model: LanguageModel;
    modelInfo: { model_id: string };
  } | null> {
    if (!agent.aux_model) return null;
    const handle = typeof agent.aux_model === "string" ? agent.aux_model : agent.aux_model.id;
    const creds = await this.resolveModelCardCredentials(handle);
    const model = resolveModel(creds.model, creds.apiKey, creds.baseURL, creds.apiCompat, creds.customHeaders);
    return { model, modelInfo: { model_id: handle } };
  }

  /**
   * Handle tool confirmation: execute the confirmed tool or inject denial,
   * then re-run the harness to continue the conversation.
   */
  private async handleToolConfirmation(
    confirmation: UserToolConfirmationEvent,
    history: HistoryStore
  ): Promise<void> {
    // Wrapped sandbox: per-method warmup happens inside any actual call.
    // Confirmation handlers may not even touch the sandbox depending on
    // tool type, so eager warmup is wasted; lazy is the right default.
    const sandbox = this.getOrCreateSandbox();
    void this.warmUpSandbox().catch(() => { /* surfaces via tool exec */ });

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
          toMarkdown: cfWorkersAiToMarkdown(this.env.AI),
          environmentConfig,
          mcpBinding: this.env.MAIN_MCP,
          tenantId: this.state.tenant_id,
          sessionId: this.state.session_id,
          browser: this.getBrowserHarness() ?? undefined,
          auxModel: auxResolved?.model,
          auxModelInfo: auxResolved?.modelInfo,
          broadcastEvent: (event) => this.persistAndBroadcastEvent(event),
          scheduleWakeup: (a) => this.scheduleWakeup(a),
          cancelWakeup: (id) => this.cancelWakeup(id),
          listWakeups: () => this.listWakeups(),
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
              // v1-additive (docs/trajectory-v1-spec.md "Causality"):
              // matching agent.tool_use's EventBase.id IS pending.toolCallId.
              parent_event_id: pending.toolCallId,
            };
            history.append(toolResultEvent);
            this.broadcastEvent(toolResultEvent);
          } catch (e) {
            const toolResultEvent: SessionEvent = {
              type: "agent.tool_result",
              tool_use_id: pending.toolCallId,
              content: `Error: ${e instanceof Error ? e.message : String(e)}`,
              parent_event_id: pending.toolCallId,
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
        // v1-additive: matching agent.tool_use's EventBase.id IS the
        // tool_use_id the confirmation references.
        parent_event_id: confirmation.tool_use_id,
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
      const history = new SqliteHistory(this.ctx.storage.sql, this.env.FILES_BUCKET ?? null, `t/${this.state.tenant_id ?? "default"}/sessions/${this.state.session_id ?? "unknown"}`);
      history.append({ type: "span.background_task_scheduled", task_id: taskId, schedule_id: sched?.id } as any);
      this.broadcastEvent({ type: "span.background_task_scheduled", task_id: taskId, schedule_id: sched?.id } as any);
    } catch (err) {
      const history = new SqliteHistory(this.ctx.storage.sql, this.env.FILES_BUCKET ?? null, `t/${this.state.tenant_id ?? "default"}/sessions/${this.state.session_id ?? "unknown"}`);
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
      `SELECT task_id, pid, output_file, created_at FROM background_tasks`
    ).toArray();

    if (!tasks.length) return;

    const sandbox = this.getOrCreateSandbox();
    let anyPending = false;
    const BG_TASK_MAX_LIFETIME_MS = 30 * 60 * 1000;

    for (const task of tasks) {
      const { task_id, pid, output_file, created_at } = task as { task_id: string; pid: string; output_file: string; created_at: string };
      try {
        // Hard lifetime cap — bg tasks can keep the container (and the
        // worker billing meter) alive forever otherwise. SIGKILL the pid,
        // inject a synthetic user.message so the agent sees the kill and
        // doesn't block on a notification that's never coming.
        const ageMs = Date.now() - Date.parse(created_at + "Z");
        const overCap = Number.isFinite(ageMs) && ageMs > BG_TASK_MAX_LIFETIME_MS;
        if (overCap) {
          let killNote = "";
          if (pid && /^\d+$/.test(pid)) {
            try { await sandbox.exec(`kill -9 ${pid} 2>/dev/null; true`, 5000); } catch (e) {
              killNote = ` (kill failed: ${(e as Error).message ?? e})`;
            }
          }
          let output = "";
          try { output = await sandbox.readFile(output_file); } catch {}
          const ageMin = Math.round(ageMs / 60000);
          const notifEvent: SessionEvent = {
            type: "user.message",
            content: [{
              type: "text",
              text: `<task_notification>\nBackground task ${task_id} exceeded the 30-minute lifetime cap and was killed${killNote}.\nRan for: ${ageMin} min\nOutput file (partial): ${output_file}\n\n${output.slice(0, 3000)}\n</task_notification>`,
            }],
          };
          // Route through pending queue so drain promotes it the same way
          // a real user.message does — ensures the harness actually runs
          // a turn for the notification.
          this._stampEventForPending(notifEvent);
          this.pending!.enqueue(notifEvent);
          this._broadcastPendingFrame(notifEvent, "sthr_primary");
          this.ctx.storage.sql.exec(`DELETE FROM background_tasks WHERE task_id = ?`, task_id);
          await this.drainEventQueue();
          continue;
        }

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

        const notifEvent: SessionEvent = {
          type: "user.message",
          content: [{
            type: "text",
            text: `<task_notification>\nBackground task ${task_id} completed.\nOutput file: ${output_file}\n\n${output.slice(0, 3000)}\n</task_notification>`,
          }],
        };
        // Route through pending queue so drain promotes it the same way
        // a real user.message does — ensures the harness actually runs
        // a turn for the notification.
        this._stampEventForPending(notifEvent);
        this.pending!.enqueue(notifEvent);
        this._broadcastPendingFrame(notifEvent, "sthr_primary");

        // Remove completed task
        this.ctx.storage.sql.exec(`DELETE FROM background_tasks WHERE task_id = ?`, task_id);

        // Re-trigger harness
        await this.drainEventQueue();
      } catch (err) {
        anyPending = true;
        logWarn(
          { op: "session_do.background_task.reap", session_id: this.state.session_id, task_id, err },
          "background task reap failed; will retry next poll",
        );
      }
    }

    // Schedule next poll if there are still pending tasks. Container
    // sleepAfter (20m) is comfortably longer than typical bg-task wait,
    // and each sandbox.exec() in the next poll auto-renews the timer.
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
   *
   * `parentThreadId` records which thread spawned this one — primary
   * for top-level call_agent_*, or a sub-agent's own threadId when one
   * sub-agent recursively delegates. Stored in the threads SQL row and
   * broadcast on session.thread_created so consumers can build the
   * full tree (Console renders nested when depth > 1).
   */
  private async runSubAgent(
    agentId: string,
    message: string,
    parentHistory: HistoryStore,
    sandbox: SandboxExecutor,
    parentThreadId: string = "sthr_primary",
  ): Promise<string> {
    // Generate a unique thread ID. Prefix `sthr_` matches AMA spec
    // (BetaManagedAgentsSessionThread.id is `sthr_*`); previous prefix
    // was `thread_*` and pre-existing live sessions may still hold those
    // in their in-memory Map — both work but new threads land on `sthr_`.
    const threadId = `sthr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

    // Reserved id "general" → opt-in built-in delegation tool. Uses a
    // synthesized config: parent's model + a generic system prompt + a
    // safe built-in tool subset. Bypasses getAgentConfig (no KV lookup,
    // no snapshot dependency — works around the staging-KV miss for
    // arbitrary sub-agent ids documented below).
    let subAgent: AgentConfig | null;
    if (agentId === "general") {
      const parentSnapshot = this.state.agent_snapshot;
      subAgent = {
        id: "general",
        name: "general",
        // Inherit parent's model so the delegation cost mirrors the
        // caller's per-token rate. aux_model isn't used here — the
        // sub-agent's full LLM call should match the caller.
        model: parentSnapshot?.model ?? "claude-sonnet-4-6",
        system:
          "You are a focused sub-agent. The user message contains a single " +
          "task delegated to you by another agent. Do exactly that task and " +
          "return a concise text result — no preamble, no follow-up questions, " +
          "no offers to do additional work. You share the same sandbox as the " +
          "calling agent (files persist) but cannot delegate further or use " +
          "MCP tools.",
        tools: [
          {
            type: "agent_toolset_20260401",
            // Explicit subset — bash + file ops only. No web tools (the
            // caller controls those). No schedule (sub-agents can't
            // outlive their parent turn). Permission inherited from the
            // toolset's default (always_allow) — no per-tool override
            // needed.
            configs: [
              { name: "bash", enabled: true },
              { name: "read", enabled: true },
              { name: "write", enabled: true },
              { name: "edit", enabled: true },
              { name: "grep", enabled: true },
              { name: "glob", enabled: true },
              // explicitly off:
              { name: "web_fetch", enabled: false },
              { name: "web_search", enabled: false },
            ],
          },
        ],
        // No callable_agents → can't delegate further (matches AMA spec
        // "Only one level of delegation"). No MCP. No skills. No
        // appendable_prompts. No schedule wakeup wiring.
        version: 1,
        created_at: new Date().toISOString(),
      } as AgentConfig;
    } else {
      // Fetch sub-agent config. Uses getAgentConfig so the parent agent's
      // snapshot is consulted when the sub-agent id matches the session's
      // agent_id; otherwise falls back to KV (broken in staging — sub-agents
      // with arbitrary ids aren't snapshotted).
      // TODO(staging-kv): pre-fetch sub-agent configs at /init when the agent
      // declares them in mcp_servers / sub_agents.
      subAgent = await this.getAgentConfig(agentId);
      if (!subAgent) {
        return `Sub-agent error: agent "${agentId}" not found`;
      }
    }

    // In-memory map (hot path config lookup) + persistent threads row
    // (Phase 1 — survives DO eviction, lets HTTP CRUD see this thread).
    // INSERT OR IGNORE for safety against rare ID collision.
    this.threads.set(threadId, { agentId, agentConfig: subAgent });
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO threads (id, agent_id, agent_name, parent_thread_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      threadId,
      agentId,
      subAgent.name,
      parentThreadId,
      Date.now(),
    );

    // Emit thread_created. Includes parent_thread_id so Console (and any
    // other SSE consumers) can build a tree without a follow-up GET
    // /threads round-trip. Mirrors the threads table column written
    // above.
    const threadCreatedEvent: SessionEvent = {
      type: "session.thread_created",
      session_thread_id: threadId,
      agent_id: agentId,
      agent_name: subAgent.name,
      parent_thread_id: parentThreadId,
    } as SessionEvent;
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
    } catch (err) {
      logWarn(
        { op: "session_do.subagent.harness_resolve", session_id: this.state.session_id, agent_id: subAgent.id, requested: subAgent.harness, err },
        "sub-agent harness unknown; falling back to default",
      );
      harness = resolveHarness("default");
    }

    // Build sub-agent tools and model (platform prepares context for sub-agent too)
    const subAuxResolved = await this.resolveAuxModel(subAgent);
    const subTools = await buildTools(this.applyMcpUrlFixups(subAgent), sandbox, {
      ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY,
      ANTHROPIC_BASE_URL: this.env.ANTHROPIC_BASE_URL,
      TAVILY_API_KEY: this.env.TAVILY_API_KEY,
      toMarkdown: cfWorkersAiToMarkdown(this.env.AI),
      mcpBinding: this.env.MAIN_MCP,
      tenantId: this.state.tenant_id,
      sessionId: this.state.session_id,
      browser: this.getBrowserHarness() ?? undefined,
      auxModel: subAuxResolved?.model,
      auxModelInfo: subAuxResolved?.modelInfo,
      broadcastEvent: (event) => this.persistAndBroadcastEvent(event),
      // Subagents do NOT get the schedule tool. onScheduledWakeup is a
      // SessionDO-level callback with no per-thread routing — a wakeup
      // injected by a subagent lands in the parent session's main event
      // stream, where the parent agent (different model + system prompt)
      // sees a user.message it didn't trigger and behaves erratically. If
      // we ever want subagent-scoped cron, the wakeup payload needs to
      // carry a thread_id and onScheduledWakeup needs to dispatch into
      // the right subHistory. Until then, omit the closures entirely so
      // tools.schedule / cancel_schedule / list_schedules don't get
      // registered into subTools at all.
      delegateToAgent: async (nestedAgentId: string, nestedMessage: string) => {
        // Nested delegate: this sub-agent's threadId becomes the new
        // child's parent. Lineage chain matches what Console renders.
        return this.runSubAgent(nestedAgentId, nestedMessage, parentHistory, sandbox, threadId);
      },
    });
    const subModelId = typeof subAgent.model === "string" ? subAgent.model : subAgent.model?.id;
    const subModel = resolveModel(subModelId || this.env.ANTHROPIC_MODEL || "claude-sonnet-4-6", this.env.ANTHROPIC_API_KEY, this.env.ANTHROPIC_BASE_URL);

    // Per-thread abort controller. Registered in _threadAbortControllers
    // so a `user.interrupt` with this thread's session_thread_id (handled
    // by the POST /event branch above) aborts exactly this sub-agent's
    // in-flight turn without touching siblings or the primary thread.
    // Cleared in finally with the same identity guard processUserMessage
    // uses — so a re-entrant runSubAgent on the same threadId (rare; nested
    // delegate) doesn't drop the inner controller's slot.
    const abortController = new AbortController();
    this._threadAbortControllers.set(threadId, abortController);

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
        // Sub-agent LLM calls share the same logging plumbing — span
        // events emitted via parent broadcast carry body_r2_key under
        // the SAME tenant + session keying. event_id stays unique per
        // call because each model_request_start mints a fresh sevt_*.
        ...(this.env.LLM_LOGS_DISABLED === "1"
          ? {}
          : {
              llmLog: {
                tenant_id: this.state.tenant_id,
                session_id: this.state.session_id,
                r2: this.env.FILES_BUCKET ?? null,
              },
            }),
        delegateToAgent: async (nestedAgentId: string, nestedMessage: string) => {
          // Nested delegate inside the env block; see runtime block
          // above for the same lineage rule.
          return this.runSubAgent(nestedAgentId, nestedMessage, parentHistory, sandbox, threadId);
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
          this.maybeCreditCacheTokens(threadId, taggedEvent);
        },
        ...this.buildStreamRuntimeMethods(threadId),
        reportUsage: async (input_tokens: number, output_tokens: number) => {
          this.creditUsageToThread(threadId, { input_tokens, output_tokens });
        },
        abortSignal: abortController.signal,
        // Sub-agent runs inside supervisor's harness.run, which is
        // wrapped by adapter.beginTurn → sessions.status='running' for
        // the entire nested-await chain. The supervisor's status
        // marker covers sub-agent execution — no separate keep-alive
        // needed. (Earlier we routed this through a dedicated
        // RuntimeAdapter.keepAliveWhile port, but it was redundant
        // with the supervisor marker; reverted 2026-05-10 after
        // root-cause analysis pointed at alarm body running LLM
        // streams as the actual eviction trigger.)
        keepAliveWhile: <T>(fn: () => Promise<T>) => fn(),
      },
    };

    let responseText = "";
    try {
      // Run the sub-agent harness
      await harness.run(subCtx);

      // Collect sub-agent response text from its history
      const subEvents = subHistory.getEvents();
      responseText = subEvents
        .filter((e: SessionEvent) => e.type === "agent.message")
        .map((e: SessionEvent) => {
          const msg = e as AgentMessageEvent;
          return msg.content?.map((b) => b.type === "text" ? b.text : "").join("") || "";
        })
        .join("\n");
    } finally {
      // Identity-guarded delete: a nested runSubAgent on the same threadId
      // would have replaced our slot — don't stomp on its controller.
      if (this._threadAbortControllers.get(threadId) === abortController) {
        this._threadAbortControllers.delete(threadId);
      }
    }

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
    // Resolved up front so closures built below (delegateToAgent in
    // env / runtime blocks) can capture it. Defaults to primary —
    // POST /event handler reads the same field for thread-scoped
    // routing, so a user.message tagged sthr_X lands on this turn.
    const turnThreadId =
      (userMessage as unknown as { session_thread_id?: string })
        .session_thread_id ?? "sthr_primary";

    const agentId = this.state.agent_id;
    if (!agentId) return;

    const agent = await this.getAgentConfig(agentId);
    if (!agent) {
      const history = new SqliteHistory(this.ctx.storage.sql, this.env.FILES_BUCKET ?? null, `t/${this.state.tenant_id ?? "default"}/sessions/${this.state.session_id ?? "unknown"}`);
      const errorEvent: SessionEvent = { type: "session.error", error: "Agent not found" };
      history.append(errorEvent);
      this.broadcastEvent(errorEvent);
      // Status auto-derives — no setState needed
      return;
    }

    const history = new SqliteHistory(this.ctx.storage.sql, this.env.FILES_BUCKET ?? null, `t/${this.state.tenant_id ?? "default"}/sessions/${this.state.session_id ?? "unknown"}`);

    // Status-pair invariant: every status_running emit (line ~3889
    // below) MUST be followed by exactly one status_idle emit before
    // this function returns. The success path emits at line ~4067; the
    // error paths historically didn't, leaving Console showing
    // "Running" forever even after adapter.endTurn flipped the D1 row
    // to 'idle' (Console derives the pill from SSE events, not D1
    // polling). Tracked via this flag — finally emits if no earlier
    // path did.
    let idleEmitted = false;

    // Reuse session-level sandbox (singleton) — files persist across turns.
    // Returned object is a lazy proxy: the underlying container is warmed up
    // on first method call, in parallel with model fetch / TTFT. Cron-only
    // turns or pure-answer turns skip the cold-start entirely. Errors from
    // warmup will surface from the first sandbox tool's execute().
    const sandbox = this.getOrCreateSandbox();

    // Kick off warmup so it overlaps with the rest of pre-streamText setup
    // and the first model fetch. Result is cached on sandboxWarmupPromise,
    // so the proxy's per-method `await this.warmUpSandbox()` becomes free
    // once this resolves. Catch detached so the unhandled-rejection logger
    // doesn't yell — the per-method await re-throws to the caller.
    void this.warmUpSandbox().catch(() => { /* surfaces via tool exec */ });

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
      instructions?: string;
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
            // Accept Anthropic-aligned `instructions` going forward.
            instructions:
              typeof (row.resource as { instructions?: unknown }).instructions === "string"
                ? ((row.resource as { instructions: string }).instructions)
                : undefined,
          });
        }
      }
    }
    const memoryStoreIds = memoryAttachments.map((a) => a.store_id);

    // Resolve harness via registry — SessionDO never imports a concrete harness
    let harness: HarnessInterface;
    try {
      harness = resolveHarness(agent.harness);
    } catch (err) {
      logWarn(
        { op: "session_do.harness_resolve", session_id: this.state.session_id, agent_id: agent.id, requested: agent.harness, err },
        "agent harness unknown; falling back to default",
      );
      harness = resolveHarness("default");
    }

    // --- Platform prepares WHAT is available ---

    // Build tools from agent config
    const auxResolved = await this.resolveAuxModel(agent);
    const allTools = await buildTools(this.applyMcpUrlFixups(agent), sandbox, {
      ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY,
      ANTHROPIC_BASE_URL: this.env.ANTHROPIC_BASE_URL,
      TAVILY_API_KEY: this.env.TAVILY_API_KEY,
      toMarkdown: cfWorkersAiToMarkdown(this.env.AI),
      environmentConfig,
      mcpBinding: this.env.MAIN_MCP,
      tenantId: this.state.tenant_id,
      sessionId: this.state.session_id,
      browser: this.getBrowserHarness() ?? undefined,
      auxModel: auxResolved?.model,
      auxModelInfo: auxResolved?.modelInfo,
      broadcastEvent: (event) => this.persistAndBroadcastEvent(event),
      scheduleWakeup: (a) => this.scheduleWakeup(a),
      cancelWakeup: (id) => this.cancelWakeup(id),
      listWakeups: () => this.listWakeups(),
      delegateToAgent: async (agentId: string, message: string) => {
        // turnThreadId is captured from the enclosing processUserMessage
        // scope (declared at the top of the function) — closure evals
        // lazily at harness.run time, so TDZ isn't a concern.
        return this.runSubAgent(agentId, message, history, sandbox, turnThreadId);
      },
      watchBackgroundTask: (taskId: string, pid: string, outputFile: string, proc: ProcessHandle | null) => {
        this.watchBackgroundTask(taskId, pid, outputFile, proc, sandbox);
      },
    });

    // Memory store mounts: per the Anthropic Managed Agents Memory contract,
    // each attached store appears as /mnt/memory/<store_name>/ inside the
    // sandbox. The agent reads/writes via the standard file tools (no
    // bespoke memory_* tools). The mount itself is set up further down in
    // the resource-mounter call. We only need MemoryStoreService here to
    // resolve store metadata for the system-prompt reminder block.
    let memoryStoreService: MemoryStoreService | null = null;
    if (memoryAttachments.length && this.env.AUTH_DB) {
      memoryStoreService = (await getCfServicesForTenant(this.env, this.state.tenant_id)).memory;
    }

    // Resolve model — `agent.model` is a card.model_id handle. The card
    // contains the wire-level LLM string we actually send to the provider.
    const handle = typeof agent.model === "string" ? agent.model : agent.model?.id;
    const effectiveHandle = handle || this.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
    const creds = await this.resolveModelCardCredentials(effectiveHandle);
    const model = resolveModel(creds.model, creds.apiKey, creds.baseURL, creds.apiCompat, creds.customHeaders);

    // Build system prompt: agent.system + platform guidance. Shared with the
    // self-host Node path via @open-managed-agents/agent/harness/platform-guidance
    // so the two surfaces stay byte-identical (prompt-cache prefix invariant).
    // Skill / memory_store / appendable_prompt content is NOT appended here —
    // those are collected as platformReminders and injected by the harness's
    // onSessionInit hook as <system-reminder> user.message events.
    const rawSystemPrompt = agent.system || "";
    const systemPrompt = composeSystemPrompt(rawSystemPrompt);

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
          const customSkills = await resolveCustomSkills(agent.skills, this.env.CONFIG_KV, this.env.FILES_BUCKET, this.state.tenant_id);
          for (const s of customSkills) {
            if (s.system_prompt_addition) {
              platformReminders.push({ source: `skill:${s.id}`, text: s.system_prompt_addition });
            }
          }
        } catch (err) {
          // Best-effort
          logWarn(
            { op: "session_do.custom_skills.resolve", session_id: this.state.session_id, agent_id: agent.id, err },
            "custom skill resolve failed; skipping skill prompt additions",
          );
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
              } catch (err) {
                // Best-effort: skip individual file write failures
                logWarn(
                  { op: "session_do.skill_file.write", session_id: this.state.session_id, skill: sf.skillName, filename: file.filename, err },
                  "skill file write failed; skipping",
                );
              }
            }
          }
        } catch (err) {
          // Best-effort
          logWarn(
            { op: "session_do.skill_files.mount", session_id: this.state.session_id, agent_id: agent.id, err },
            "skill files mount failed",
          );
        }
      }
    }

    // Memory store prompts → platformReminders (was: appended to systemPrompt
    // every turn, KV-list-order dependent → permanent cache miss). Build the
    // prompt strings on the fly from memory store metadata + per-attachment
    // instructions overrides. Format mirrors Anthropic's auto-injected mount
    // descriptors: `/mnt/memory/<name>/ (access)` so the agent knows where to
    // find the store and uses standard file tools to interact.
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
          const accessLabel = att.access === "read_only" ? "read-only" : "read-write";
          const lines = [
            `## Memory store: ${store.name}`,
            `Mounted at /mnt/memory/${store.name}/ (${accessLabel})`,
          ];
          if (store.description) lines.push(store.description);
          if (att.instructions) lines.push(att.instructions);
          if (att.access === "read_only") {
            lines.push("(read-only mount — write attempts to this directory will fail)");
          }
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

    // Create an abort controller for this execution. Stall detection now
    // lives inside default-loop.ts (in-closure setTimeout next to the
    // streamText call) so we no longer compose with a DO-instance
    // controller here. Registered under the thread id so user.interrupt
    // with `session_thread_id` aborts only the matching turn.
    //
    // Note: `turnThreadId` is also captured by the `delegateToAgent`
    // closures above (in env / runtime blocks) so a sub-agent spawned
    // from this turn records `parent_thread_id = turnThreadId` instead
    // of always 'sthr_primary'. Closures eval lazily at harness.run
    // time — TDZ for the const above is not a problem.
    const abortController = new AbortController();
    this._threadAbortControllers.set(turnThreadId, abortController);
    const effectiveAbortSignal = abortController.signal;

    // --- Harness receives a fully-prepared context ---
    const ctx: HarnessContext = {
      agent,
      userMessage,
      session_id: this.state.session_id,
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
        // Cross-script DO binding so AcpProxyHarness can attach to the
        // user's RuntimeRoom directly (no HTTP hop through main, no
        // shared INTEGRATIONS_INTERNAL_SECRET). Optional on the env type
        // — non-acp harnesses don't read it.
        RUNTIME_ROOM: this.env.RUNTIME_ROOM,
        // LLM full-body logging context. default-loop wraps each model
        // call in middleware that PUTs request + response to R2 keyed
        // by the per-step span event id. The matching
        // span.model_request_end event grows a body_r2_key field
        // pointing to the same key. r2 = null disables capture
        // (test harnesses, env without FILES_BUCKET).
        ...(this.env.LLM_LOGS_DISABLED === "1"
          ? {}
          : {
              llmLog: {
                tenant_id: this.state.tenant_id,
                session_id: this.state.session_id,
                r2: this.env.FILES_BUCKET ?? null,
              },
            }),
        delegateToAgent: async (agentId: string, message: string) => {
          return this.runSubAgent(agentId, message, history, sandbox, turnThreadId);
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
          this.maybeCreditCacheTokens(turnThreadId, event);
        },
        ...this.buildStreamRuntimeMethods(),
        reportUsage: async (input_tokens: number, output_tokens: number) => {
          this.creditUsageToThread(turnThreadId, { input_tokens, output_tokens });
        },
        pendingConfirmations: [],
        abortSignal: effectiveAbortSignal,
        keepAliveWhile: <T>(fn: () => Promise<T>) => fn(),
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

      // Outcome self-evaluation loop. Phase 4 / AMA-aligned: delegated
      // to the standalone supervisor module which builds a Verifier
      // (verifierForSpec for the OMA-superset rule-based path,
      // LlmJudgeVerifier for the AMA-default LLM-judge path), runs it
      // against a Trajectory built from the current event log, maps the
      // Score onto the AMA 5-result enum, emits
      // span.outcome_evaluation_{start,ongoing,end}, and persists each
      // terminal verdict to state.outcome_evaluations[]. The loop
      // re-injects the verifier's `reason` as a user.message + re-runs
      // the harness on `needs_revision`.
      const outcome = this.state.outcome;
      if (outcome) {
        const outcomeModelId =
          typeof agent.model === "string" ? agent.model : agent.model?.id;
        const judgeModel = resolveModel(
          outcomeModelId ||
            ctx.env.ANTHROPIC_MODEL ||
            "claude-sonnet-4-6",
          ctx.env.ANTHROPIC_API_KEY,
          ctx.env.ANTHROPIC_BASE_URL,
        );
        try {
          await runOutcomeSupervisor({
            outcome,
            initialIteration: this.state.outcome_iteration ?? 0,
            tenantId: this.state.tenant_id,
            filesBucket: this.env.FILES_BUCKET ?? null,
            abortSignal: effectiveAbortSignal,
            judgeModelId: outcomeModelId,
            getEvents: () => history.getEvents(),
            appendAndBroadcast: (event) => {
              history.append(event);
              this.broadcastEvent(event);
            },
            broadcastOnly: (event) => this.broadcastEvent(event),
            persistState: (delta) => {
              const next = { ...this.state };
              if ("outcome" in delta) next.outcome = delta.outcome ?? null;
              if (typeof delta.outcome_iteration === "number") {
                next.outcome_iteration = delta.outcome_iteration;
              }
              if (delta.outcome_evaluations) {
                next.outcome_evaluations = delta.outcome_evaluations;
              }
              this.setState(next);
            },
            readEvaluations: () => this.state.outcome_evaluations ?? [],
            makeVerifierContext: () => ({
              sessionId: this.state.session_id,
              runExec: async (cmd, opts) => {
                const sb = this.getOrCreateSandbox();
                const raw = await sb.exec(cmd, opts?.timeoutMs ?? 600_000);
                // sandbox.exec returns "exit=N\n<merged-output>"
                const m = raw.match(/^exit=(-?\d+)\n([\s\S]*)$/);
                return m
                  ? { exit_code: parseInt(m[1], 10), output: m[2] }
                  : { exit_code: -1, output: raw };
              },
            }),
            makeJudgeFn: () => async (prompt, signal) => {
              const result = await generateText({
                model: judgeModel,
                system: prompt.system,
                messages: [{ role: "user", content: prompt.user }],
                maxOutputTokens: 800,
                abortSignal: signal,
              });
              const text =
                result.text ||
                extractTextFromContent(
                  (result as unknown as { content?: unknown }).content,
                );
              const u = (result as unknown as {
                usage?: {
                  inputTokens?: number;
                  outputTokens?: number;
                  cachedInputTokens?: number;
                  cacheReadInputTokens?: number;
                  cacheCreationInputTokens?: number;
                };
              }).usage;
              const usage = u
                ? {
                    input_tokens: u.inputTokens ?? 0,
                    output_tokens: u.outputTokens ?? 0,
                    cache_creation_input_tokens:
                      u.cacheCreationInputTokens ?? u.cachedInputTokens,
                    cache_read_input_tokens: u.cacheReadInputTokens,
                  }
                : undefined;
              return { text, usage };
            },
            runHarnessTurn: async (msg) => {
              await harness.run({ ...ctx, userMessage: msg });
            },
          });
        } catch (err) {
          // Supervisor itself blew up (e.g. a persistState callback
          // threw). Surface as a session warning — the supervisor's own
          // failure path already handled verifier-internal errors and
          // emitted a `failed` end span.
          logWarn(
            { op: "outcome.supervisor", session_id: this.state.session_id, err },
            "outcome supervisor crashed",
          );
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
      idleEmitted = true;
    } catch (err) {
      const errorMessage = this.describeError(err);

      // Don't retry if aborted
      if (err instanceof Error && err.name === "AbortError") {
        // Interrupt handler (POST /event user.interrupt branch) already
        // appended its own session.status_idle synchronously before
        // the abort propagated, so the finally block must NOT emit a
        // second one — this flag suppresses the duplicate.
        idleEmitted = true;
        return;
      }

      // Retry-by-default policy. Specific fatal classes short-circuit;
      // everything else (including unclassified errors) re-runs once
      // before surfacing. The previous shape was a TRANSIENT allowlist
      // of substrings ("timeout", "ECONNREFUSED"...); every new transient
      // class (CF "version rollout", container OOM, future infra wording)
      // silently fell off the list and the user saw a hard failure.
      //
      // Boundary wrappers (wrapSandboxWithLazyWarmup, the streamText
      // boundary, the USAGE_METER boundary) re-throw native errors as
      // typed OmaErrors via classifyExternalError, so most well-known
      // fatal conditions arrive here as the right class already.
      // For errors that escaped the boundaries (D1, KV, future SDKs),
      // run classifyExternalError once more inline as belt-and-braces.
      const classified = classifyExternalError(err);
      const isFatal =
        classified instanceof BillingError ||
        classified instanceof ConfigError ||
        classified instanceof AuthError ||
        // ModelError = deterministic LLM-side condition (silent_stop,
        // refused, malformed). Same prompt → same fail. Retrying just
        // burns tokens. Caught 2026-05-11 sess-y2bfxm1de4e1zqxm: 4
        // failed messages × 3 retries = 12 wasted LLM calls.
        classified instanceof ModelError;
      const isTransient = !isFatal;

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
        // Recursive call owns the next idle emit (success or its own
        // finally). Suppress this frame's catch-all so we don't get
        // two status_idle events on a successful retry.
        idleEmitted = true;
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
      // Only delete if it's still ours — a sub-agent run within the same
      // thread may have temporarily replaced it. Same-thread re-entry is
      // mutex'd by _draining so this is theoretical safety only.
      if (this._threadAbortControllers.get(turnThreadId) === abortController) {
        this._threadAbortControllers.delete(turnThreadId);
      }
      // Catch-all status_idle emit. Pairs with the status_running emit
      // at the start of this function so Console's status pill never
      // hangs at "Running" after the turn dies in any non-AbortError
      // way (model crash, transient retries exhausted, anything that
      // hits the catch block above without already setting idleEmitted).
      // No stop_reason — error paths don't have a meaningful one and
      // the field is optional in SessionStatusEvent.
      if (!idleEmitted) {
        try {
          const idleEvent: SessionEvent = { type: "session.status_idle" };
          history.append(idleEvent);
          this.broadcastEvent(idleEvent);
        } catch (err) {
          console.warn(`[processUserMessage] catch-all idle emit failed:`, err);
        }
      }
      // Status auto-derives — Workspace backup is fired by
      // OmaSandbox.onActivityExpired when the container's sleepAfter
      // elapses (see oma-sandbox.ts) — exactly one snapshot per quiet
      // period. Explicit /destroy snapshots eagerly via
      // sandbox.snapshotWorkspaceNow(). Per-turn backup is intentionally off.
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

  // ═══════════════════════════════════════════════════════════════════════
  // cf-agents replacement primitives (state, schedule, alarm). Schema +
  // algorithms inherited from cf-agents v0.11.2 so existing prod DOs
  // migrate transparently — SQL row layouts and callback-name conventions
  // match what cf-agents wrote. Phase 3 dropped runFiber/keepAlive in
  // favor of the unified RuntimeAdapter (begin/end on the shared
  // `sessions` table); orphan-turn detection in alarm() now reads
  // sessions.turn_id, not cf_agents_runs.
  // ═══════════════════════════════════════════════════════════════════════

  // ── State (cf_agents_state, single row) ────────────────────────────────

  get state(): SessionState {
    if (this._state === undefined) {
      // Defensive — constructor calls _loadStateFromSql before any user code
      // runs, so this should be impossible. If it fires, something called
      // .state before super() ran.
      throw new Error("SessionDO.state read before init");
    }
    return this._state;
  }

  /**
   * Live-derived session status. Single source of truth — replaces the old
   * mutable `state.status` field which had a race window between the
   * `setState({status:"running"})` write and the cf_agents_runs INSERT
   * inside runFiber. With derivation that race is impossible: status is
   * always consistent with whatever cf_agents_runs holds at query time.
   *
   * - `terminated_at` set → "terminated" (destroy is the only persistent
   *   state value that needs to survive restarts)
   * - any cf_agents_runs row → "running"
   * - else → "idle"
   *
   * Back-compat: if a session was written before this refactor, its
   * `state.status` may still be "terminated"; honor that as a fallback
   * gate so old sessions don't accept new events post-destroy.
   */
  deriveStatus(): "idle" | "running" | "terminated" {
    if (this._state?.terminated_at != null || this._state?.status === "terminated") {
      return "terminated";
    }
    // The unified-runtime marker for "is there an in-flight turn" lives
    // on D1's `sessions.turn_id`, which is async. _activeTurnIds is the
    // sync local mirror populated by RuntimeAdapter's onTurnInFlight /
    // onTurnEnded callbacks (turn ids minted in runAgentTurn). On cold
    // start the set is empty until the first alarm-fired
    // _checkOrphanTurns reconciles, but D1 is the source of truth so
    // orphan recovery still triggers from there.
    return this._activeTurnIds.size > 0 ? "running" : "idle";
  }

  /**
   * Drive the session to AMA's `terminated` lifecycle terminus.
   * Idempotent — second call no-ops if `terminated_at` already set.
   *
   * AMA semantics (BetaManagedAgentsSessionStatusTerminatedEvent):
   * "Indicates the session has terminated, either due to an error or
   * completion." Once terminated the session is one-way; the route layer
   * must reject POST /events with 409 going forward.
   *
   * Reasons currently emitted:
   *   - "session_deleted" — DELETE /v1/sessions/:id (destroy path)
   *   - "billing"         — model rejected request (402/403); not
   *                         recoverable without operator intervention
   *
   * Follow-up sources to wire (see AMA RetryStatusTerminal):
   *   - "mcp_auth"  — MCP server permanent-auth-failure path lives in
   *                   tools.ts / main proxy, separate from
   *                   the drainEventQueue catch
   *   - "completed" — explicit "session done" signal (no concept in
   *                   OMA today)
   */
  private terminate(reason: string): void {
    if (this._state?.terminated_at != null) return;
    this.setState({ ...this.state, terminated_at: Date.now() });
    for (const ctrl of this._threadAbortControllers.values()) {
      ctrl.abort();
    }
    this._threadAbortControllers.clear();
    // Hybrid-billing: emit session_alive_seconds covering wall-clock
    // (created_at_ms → now) on terminate. Idempotent via
    // session_alive_billed; fire-and-forget so the terminate path can
    // proceed if the usage_events write hiccups.
    //
    // TODO: 24h cron sweep — long-running session that never terminates
    // never emits. Schedule a SessionDO alarm every 24h to slice the
    // alive-seconds window, write an interim event with the partial
    // seconds, advance the cursor (created_at_ms = now). Out of scope
    // for v1.
    void this._recordSessionAliveOnTerminate();
    const event: SessionEvent = {
      type: "session.status_terminated",
      reason,
    };
    const history = new SqliteHistory(
      this.ctx.storage.sql,
      this.env.FILES_BUCKET ?? null,
      `t/${this.state.tenant_id ?? "default"}/sessions/${this.state.session_id ?? "unknown"}`,
    );
    history.append(event);
    this.broadcastEvent(event);

    // Mirror the terminus on D1 so list/get queries reflect it without
    // needing a sandbox-worker round-trip. Fire-and-forget — the DO-local
    // state above is the source of truth for the same-process gate; the
    // D1 write is for cross-process readers (Console list, cost reports,
    // recovery scans). Failure here is logged, not propagated.
    const sessionId = this.state.session_id;
    if (sessionId) {
      this.runtimeAdapter
        .terminate(sessionId, reason)
        .catch((err) => {
          console.warn(
            `[session_do] terminate writeback to D1 failed: ${(err as Error).message ?? err}`,
          );
        });
    }
  }

  /**
   * Hybrid-billing: emit one session_alive_seconds row spanning
   * created_at_ms → now. Idempotent — called from terminate() but skips
   * the write if session_alive_billed is already true (DO restart hits
   * /destroy a second time).
   */
  private async _recordSessionAliveOnTerminate(): Promise<void> {
    try {
      if (this._state?.session_alive_billed) return;
      const tenantId = this.state.tenant_id;
      const sessionId = this.state.session_id;
      const createdAt = this._state?.created_at_ms;
      if (!tenantId || !sessionId || !createdAt) return;
      const elapsedMs = Date.now() - createdAt;
      const seconds = Math.floor(elapsedMs / 1000);
      if (seconds <= 0) {
        // Mark as billed anyway so we don't keep retrying for a
        // sub-second session.
        this.setState({ ...this.state, session_alive_billed: true });
        return;
      }
      // getCfServicesForTenant resolves the per-tenant DB then builds
      // the Services container — the same path used for backup writes.
      const { getCfServicesForTenant } = await import("@open-managed-agents/services");
      const services = await getCfServicesForTenant(this.env, tenantId);
      await services.usage.recordUsage({
        tenantId,
        sessionId,
        agentId: this.state.agent_id || null,
        kind: "session_alive_seconds",
        value: seconds,
      });
      this.setState({ ...this.state, session_alive_billed: true });
      console.log(
        `[session_do] usage emit session_alive_seconds=${seconds} session=${sessionId.slice(0, 12)}`,
      );
    } catch (err) {
      console.error(
        `[session_do] _recordSessionAliveOnTerminate failed: ${(err as Error).message ?? err}`,
      );
    }
  }

  setState(next: SessionState): void {
    this._state = next;
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO cf_agents_state (id, state) VALUES (?, ?)`,
      STATE_ROW_ID,
      JSON.stringify(next),
    );
  }

  private _loadStateFromSql(): void {
    const rows = this.ctx.storage.sql
      .exec<{ state: string | null }>(
        `SELECT state FROM cf_agents_state WHERE id = ?`,
        STATE_ROW_ID,
      )
      .toArray();
    if (rows.length > 0 && rows[0].state) {
      try {
        this._state = JSON.parse(rows[0].state) as SessionState;
        return;
      } catch (err) {
        console.warn(
          `[session_do] failed to parse persisted state, falling back to INITIAL_SESSION_STATE: ${(err as Error).message}`,
        );
      }
    }
    // First boot, or corrupted — seed with INITIAL_SESSION_STATE and persist.
    this._state = { ...INITIAL_SESSION_STATE };
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO cf_agents_state (id, state) VALUES (?, ?)`,
      STATE_ROW_ID,
      JSON.stringify(this._state),
    );
  }

  // ── Schema bootstrap (cf_agents_state / cf_agents_schedules) ──

  private _ensureCfAgentsSchema(): void {
    // Idempotent. Schema lifted verbatim from cf-agents v0.11.2 so existing
    // prod rows survive the base-class swap. We don't bother with the
    // schema-version migration logic from cf-agents (CURRENT_SCHEMA_VERSION
    // tracking) because we're at the latest schema and only do create-IF-NOT-EXISTS.
    const sql = this.ctx.storage.sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS cf_agents_state (
        id TEXT PRIMARY KEY NOT NULL,
        state TEXT
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS cf_agents_schedules (
        id TEXT PRIMARY KEY NOT NULL,
        callback TEXT,
        payload TEXT,
        type TEXT NOT NULL CHECK(type IN ('scheduled', 'delayed', 'cron', 'interval')),
        time INTEGER,
        delayInSeconds INTEGER,
        cron TEXT,
        intervalSeconds INTEGER,
        running INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch()),
        execution_started_at INTEGER,
        retry_options TEXT
      )
    `);
    // cf_agents_runs is gone. Phase 3 stopped writing it; Phase 4 (this
    // commit) drops the table entirely on every cold-start, idempotent
    // because DROP TABLE IF EXISTS. Old prod DOs that booted the
    // previous code still had it; first cold-start under this code path
    // sweeps it. Any in-flight rows from before the deploy are
    // recovered via _checkOrphanTurns which now reads `sessions.turn_id`
    // (populated by the unified RuntimeAdapter.beginTurn). For sessions
    // that started under the old fiber path AND were mid-turn at deploy
    // time, the turn_id column is null — those sessions just silently
    // flip to "user must resend" which is the same UX as the old
    // 5-recovery cap exhausting.
    sql.exec(`DROP TABLE IF EXISTS cf_agents_runs`);
    // Stale-row cleanup: the alarm-based stall detector was removed in the
    // Gap 10 simplification, but live prod DOs still have its interval
    // schedule rows. Each alarm tick now logs "callback not found" and
    // force-resets the row, then re-fires — pure noise that masks real
    // errors in observability. One-shot delete clears it.
    sql.exec(`DELETE FROM cf_agents_schedules WHERE callback = '_oma_stallCheckHeartbeat'`);

    // Per-session thread directory (AMA `session_thread`-shaped). Lives
    // here in DO SQLite — same atomicity domain as `events`, no need for
    // D1 round-trip on the hot path. Spec note: AMA SDK exposes
    // `BetaManagedAgentsSessionThread` with `id` (sthr_*), `agent_name`,
    // `parent_thread_id` (NULL = primary), and `archived_at`. We mirror
    // those fields plus `agent_id` for our internal config lookup.
    //
    // Primary thread row (`sthr_primary`) is seeded lazily on first
    // turn — see _ensurePrimaryThread() — because at constructor time
    // the agent_id isn't known yet (set on /init).
    sql.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        agent_name TEXT,
        parent_thread_id TEXT,
        created_at INTEGER NOT NULL,
        archived_at INTEGER
      )
    `);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_threads_parent ON threads(parent_thread_id, created_at)`);
  }

  /**
   * Serialize a `threads` row into the AMA wire shape, including
   * stats computed at read-time from the events table. Single source
   * of truth for the /threads list, /threads/:tid get, and the
   * archive echo response — keeps shape drift impossible.
   *
   * stats.elapsed_seconds: now - created_at, frozen at archived_at.
   * stats.time_to_first_run_seconds: per AMA spec, 0 for child
   *   threads (which spawn already running) and computed for primary.
   * stats.active_seconds: SUM(end_ts - start_ts) over paired
   *   span.model_request_start / span.model_request_end events scoped
   *   to this thread. Whole-second resolution (events.ts is in
   *   seconds). In-flight pairs are skipped.
   * usage: read from state.thread_usage[id] (per-thread token counters,
   *   credited from reportUsage + span.model_request_end cache fields).
   *   Returns null for legacy sessions that pre-date the per-thread
   *   bucket — the AMA SDK accepts null and treats it as "no usage
   *   recorded yet."
   */
  private _serializeThreadRow(row: Record<string, unknown>): Record<string, unknown> {
    const id = row.id as string;
    const createdAt = row.created_at as number;
    const archivedAt = row.archived_at as number | null | undefined;
    const isPrimary = id === "sthr_primary";

    const endTs = archivedAt ?? Date.now();
    const elapsedSeconds = Math.max(0, Math.round((endTs - createdAt) / 1000));

    let timeToFirstRunSeconds: number | null = 0;
    if (isPrimary) {
      // First user.message in the primary thread — processed_at is the
      // ingestion time. Falls back to ts when processed_at is null
      // (e.g. queued but never drained — rare but possible if the user
      // archives before any turn runs).
      let firstAt: number | null = null;
      for (const r of this.ctx.storage.sql.exec(
        `SELECT processed_at, ts FROM events
           WHERE session_thread_id = ? AND type = 'user.message'
           ORDER BY seq ASC LIMIT 1`,
        id,
      )) {
        firstAt = (r.processed_at as number | null) ?? (r.ts as number);
      }
      timeToFirstRunSeconds = firstAt != null
        ? Math.max(0, Math.round((firstAt - createdAt) / 1000))
        : null;
    }

    // active_seconds: SUM(end_ts - start_ts) over paired
    // span.model_request_start / span.model_request_end events for this
    // thread. Pairs join on the start event's `id` ↔ end event's
    // `model_request_start_id` (set by default-loop's onStepFinish/onError/
    // onAbort). The SQL `ts` column is in seconds, so we get whole-second
    // resolution which is fine for a "time spent in the model" stat.
    //
    // Sub-agent spans get session_thread_id stamped at write time by the
    // tagged runtime.broadcast closure in runSubAgent; primary spans
    // default to 'sthr_primary' via the cf-do INSERT default. Unpaired
    // starts (turn still in flight) and unpaired ends (recovery edge
    // cases) are skipped.
    let activeSeconds = 0;
    {
      const starts = new Map<string, number>();
      // One pass: bucket starts by id, on end events accumulate the diff.
      for (const r of this.ctx.storage.sql.exec(
        `SELECT type, data, ts FROM events
           WHERE session_thread_id = ?
             AND (type = 'span.model_request_start' OR type = 'span.model_request_end')
           ORDER BY seq ASC`,
        id,
      )) {
        const ts = r.ts as number;
        let payload: Record<string, unknown> | null = null;
        try {
          payload = JSON.parse(r.data as string) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (r.type === "span.model_request_start") {
          const sid = payload?.id as string | undefined;
          if (sid) starts.set(sid, ts);
        } else {
          const sid = payload?.model_request_start_id as string | undefined;
          if (!sid) continue;
          const startTs = starts.get(sid);
          if (startTs == null) continue;
          starts.delete(sid);
          activeSeconds += Math.max(0, ts - startTs);
        }
      }
    }

    const updatedTs = archivedAt ?? createdAt;
    const threadUsage = this.state.thread_usage?.[id];
    const usage = threadUsage
      ? {
          input_tokens: threadUsage.input_tokens,
          output_tokens: threadUsage.output_tokens,
          cache_read_input_tokens: threadUsage.cache_read_input_tokens,
          // AMA spec exposes cache_creation as a sub-shape with per-lifetime
          // breakdown — we only have a single bucket so far, so emit it as
          // the unbucketed total under `cache_creation_input_tokens` for
          // back-compat with simpler readers; the AMA SDK accepts the extra
          // field. (Add the nested cache_creation shape when we get TTL data
          // from the provider.)
          cache_creation_input_tokens: threadUsage.cache_creation_input_tokens,
        }
      : null;
    return {
      id,
      type: "session_thread",
      session_id: this.state.session_id,
      agent_id: row.agent_id,
      agent_name: row.agent_name,
      parent_thread_id: row.parent_thread_id,
      status: archivedAt != null ? "archived" : "active",
      created_at: new Date(createdAt).toISOString(),
      archived_at: archivedAt != null ? new Date(archivedAt).toISOString() : null,
      updated_at: new Date(updatedTs).toISOString(),
      stats: {
        elapsed_seconds: elapsedSeconds,
        active_seconds: activeSeconds,
        time_to_first_run_seconds: timeToFirstRunSeconds,
      },
      usage,
    };
  }

  /**
   * Idempotent primary-thread seed. Called on first turn (lazy because
   * agent_id isn't known until /init). Subsequent calls no-op via
   * INSERT OR IGNORE.
   */
  private _ensurePrimaryThread(): void {
    const agentId = this.state.agent_id;
    if (!agentId) return; // pre-init; nothing to seed against
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO threads (id, agent_id, agent_name, parent_thread_id, created_at)
       VALUES ('sthr_primary', ?, ?, NULL, ?)`,
      agentId,
      this.state.agent_snapshot?.name ?? null,
      Date.now(),
    );
  }

  // ── Schedule API (mirrors cf-agents) ──────────────────────────────────

  /**
   * Schedule a method to run later. `when` accepts:
   *   - Date          → run at that absolute time
   *   - number        → run after this many seconds
   *   - cron string   → recurring (e.g. "0 9 * * *")
   * `callback` is the name of a method on `this` to invoke. Payload is
   * JSON-stringified into the row and JSON-parsed back into the first arg.
   * Returns a Schedule with at least `.id` and `.callback`.
   */
  async schedule<T = unknown>(
    when: Date | number | string,
    callback: keyof this | string,
    payload?: T,
  ): Promise<{ id: string; callback: string; type: SessionScheduleType; time: number; payload: T; cron?: string; delayInSeconds?: number }> {
    const callbackName = String(callback);
    if (typeof (this as unknown as Record<string, unknown>)[callbackName] !== "function") {
      throw new Error(`this.${callbackName} is not a function`);
    }
    const payloadJson = JSON.stringify(payload);
    const id = nanoid(9);

    let type: SessionScheduleType;
    let timestamp: number;
    let cron: string | undefined;
    let delayInSeconds: number | undefined;
    if (when instanceof Date) {
      type = "scheduled";
      timestamp = Math.floor(when.getTime() / 1000);
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO cf_agents_schedules (id, callback, payload, type, time) VALUES (?, ?, ?, 'scheduled', ?)`,
        id, callbackName, payloadJson, timestamp,
      );
    } else if (typeof when === "number") {
      type = "delayed";
      delayInSeconds = when;
      timestamp = Math.floor(Date.now() / 1000) + when;
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO cf_agents_schedules (id, callback, payload, type, delayInSeconds, time) VALUES (?, ?, ?, 'delayed', ?, ?)`,
        id, callbackName, payloadJson, when, timestamp,
      );
    } else if (typeof when === "string") {
      type = "cron";
      cron = when;
      const next = parseCronExpression(when).getNextDate(new Date());
      timestamp = Math.floor(next.getTime() / 1000);
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO cf_agents_schedules (id, callback, payload, type, cron, time) VALUES (?, ?, ?, 'cron', ?, ?)`,
        id, callbackName, payloadJson, when, timestamp,
      );
    } else {
      throw new Error(`Invalid schedule type: ${JSON.stringify(when)}(${typeof when}) for ${callbackName}`);
    }

    await this._scheduleNextAlarm();
    return { id, callback: callbackName, type, time: timestamp, payload: payload as T, cron, delayInSeconds };
  }

  async scheduleEvery<T = unknown>(
    intervalSeconds: number,
    callback: keyof this | string,
    payload?: T,
  ): Promise<{ id: string; callback: string; type: "interval"; intervalSeconds: number; time: number }> {
    if (typeof intervalSeconds !== "number" || intervalSeconds <= 0) {
      throw new Error("intervalSeconds must be a positive number");
    }
    const callbackName = String(callback);
    if (typeof (this as unknown as Record<string, unknown>)[callbackName] !== "function") {
      throw new Error(`this.${callbackName} is not a function`);
    }
    const payloadJson = JSON.stringify(payload);
    const existing = this.ctx.storage.sql
      .exec<{ id: string; intervalSeconds: number; time: number }>(
        `SELECT id, intervalSeconds, time FROM cf_agents_schedules WHERE type = 'interval' AND callback = ? AND intervalSeconds = ? AND payload IS ? LIMIT 1`,
        callbackName, intervalSeconds, payloadJson,
      )
      .toArray();
    if (existing.length > 0) {
      const row = existing[0];
      return { id: row.id, callback: callbackName, type: "interval", intervalSeconds: row.intervalSeconds, time: row.time };
    }
    const id = nanoid(9);
    const timestamp = Math.floor(Date.now() / 1000) + intervalSeconds;
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO cf_agents_schedules (id, callback, payload, type, intervalSeconds, time, running) VALUES (?, ?, ?, 'interval', ?, ?, 0)`,
      id, callbackName, payloadJson, intervalSeconds, timestamp,
    );
    await this._scheduleNextAlarm();
    return { id, callback: callbackName, type: "interval", intervalSeconds, time: timestamp };
  }

  getSchedule<T = unknown>(id: string): { id: string; callback: string; payload: T; type: string; time: number; cron?: string } | undefined {
    const row = this.ctx.storage.sql
      .exec<{ id: string; callback: string; payload: string; type: string; time: number; cron: string | null }>(
        `SELECT id, callback, payload, type, time, cron FROM cf_agents_schedules WHERE id = ? LIMIT 1`,
        id,
      )
      .toArray()[0];
    if (!row) return undefined;
    return {
      id: row.id,
      callback: row.callback,
      payload: this._safeParse(row.payload) as T,
      type: row.type,
      time: row.time,
      cron: row.cron ?? undefined,
    };
  }

  getSchedules(criteria: { type?: string; timeRange?: { start?: Date; end?: Date } } = {}): Array<{
    id: string;
    callback: string;
    payload: unknown;
    type: string;
    time: number;
    cron?: string;
  }> {
    let query = "SELECT id, callback, payload, type, time, cron FROM cf_agents_schedules WHERE 1=1";
    const params: Array<string | number> = [];
    if (criteria.type) { query += " AND type = ?"; params.push(criteria.type); }
    if (criteria.timeRange) {
      const start = criteria.timeRange.start ?? new Date(0);
      const end = criteria.timeRange.end ?? new Date(8.64e15);
      query += " AND time >= ? AND time <= ?";
      params.push(Math.floor(start.getTime() / 1000), Math.floor(end.getTime() / 1000));
    }
    return this.ctx.storage.sql
      .exec<{ id: string; callback: string; payload: string; type: string; time: number; cron: string | null }>(query, ...params)
      .toArray()
      .map((row) => ({
        id: row.id,
        callback: row.callback,
        payload: this._safeParse(row.payload),
        type: row.type,
        time: row.time,
        cron: row.cron ?? undefined,
      }));
  }

  async cancelSchedule(id: string): Promise<boolean> {
    const before = this.ctx.storage.sql
      .exec<{ id: string }>(`SELECT id FROM cf_agents_schedules WHERE id = ? LIMIT 1`, id)
      .toArray();
    if (before.length === 0) return false;
    this.ctx.storage.sql.exec(`DELETE FROM cf_agents_schedules WHERE id = ?`, id);
    await this._scheduleNextAlarm();
    return true;
  }

  private _safeParse(s: string | null | undefined): unknown {
    if (!s) return undefined;
    try { return JSON.parse(s); } catch { return undefined; }
  }

  /**
   * Pick the soonest alarm time across (a) ready due schedules, (b) hung
   * interval reset. Phase 3 dropped the keepAlive refcount branch — keep-
   * alive now flows through hintTurnInFlight (sets a 30s alarm at
   * beginTurn) plus the alarm() handler's rearm-while-inflight check.
   * Schedule logic itself is verbatim from cf-agents v0.11.2.
   */
  private async _scheduleNextAlarm(): Promise<void> {
    const nowMs = Date.now();
    const hungCutoffSec = Math.floor(nowMs / 1000) - HUNG_SCHEDULE_TIMEOUT_SECONDS;
    const readyRows = this.ctx.storage.sql
      .exec<{ time: number }>(
        `SELECT time FROM cf_agents_schedules WHERE type != 'interval' OR running = 0 OR coalesce(execution_started_at, 0) <= ? ORDER BY time ASC LIMIT 1`,
        hungCutoffSec,
      )
      .toArray();
    const recoveringRows = this.ctx.storage.sql
      .exec<{ execution_started_at: number | null }>(
        `SELECT execution_started_at FROM cf_agents_schedules WHERE type = 'interval' AND running = 1 AND coalesce(execution_started_at, 0) > ? ORDER BY execution_started_at ASC LIMIT 1`,
        hungCutoffSec,
      )
      .toArray();
    let nextMs: number | null = null;
    if (readyRows.length > 0) nextMs = Math.max(readyRows[0].time * 1000, nowMs + 1);
    if (recoveringRows.length > 0 && recoveringRows[0].execution_started_at !== null) {
      const recoveryMs = (recoveringRows[0].execution_started_at + HUNG_SCHEDULE_TIMEOUT_SECONDS) * 1000;
      nextMs = nextMs === null ? recoveryMs : Math.min(nextMs, recoveryMs);
    }
    // Heartbeat-merge: when a turn is in flight (sessions.status =
    // 'running' — covers supervisor + the entire nested sub-agent
    // call tree since beginTurn wraps the whole harness.run chain),
    // we want a heartbeat alarm KEEP_ALIVE_INTERVAL_MS out. Merge it
    // with any data-driven wakeup so a single setAlarm fires for the
    // earlier of the two — never two writes, never a stale deleteAlarm
    // clobbering the heartbeat.
    //
    // Pre-merge bug (caught by code review 2026-05-10): the heartbeat
    // setAlarm and the data-driven setAlarm/deleteAlarm were two
    // separate calls in sequence. When `cf_agents_schedules` was empty
    // (the common case for a session not running cron / interval
    // tasks) the second branch hit deleteAlarm() and silently undid
    // the heartbeat — DO would not get a wakeup and CF would evict
    // before the next external request arrived.
    const wantsHeartbeat = await this._hasInflightTurn();
    const heartbeatMs = wantsHeartbeat ? Date.now() + KEEP_ALIVE_INTERVAL_MS : null;
    let mergedNextMs: number | null = nextMs;
    if (heartbeatMs !== null) {
      mergedNextMs = mergedNextMs === null ? heartbeatMs : Math.min(mergedNextMs, heartbeatMs);
    }
    if (mergedNextMs !== null) {
      await this.ctx.storage.setAlarm(mergedNextMs);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  /**
   * Alarm entry point. Fired by CF runtime when setAlarm() time is reached.
   * Dispatches all due schedules in time order, then runs housekeeping
   * (orphan-fiber recovery), then re-arms the next alarm.
   */
  async alarm(): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000);
    const due = this.ctx.storage.sql
      .exec<{
        id: string;
        callback: string;
        payload: string;
        type: string;
        cron: string | null;
        intervalSeconds: number | null;
        running: number;
        execution_started_at: number | null;
      }>(`SELECT id, callback, payload, type, cron, intervalSeconds, running, execution_started_at FROM cf_agents_schedules WHERE time <= ?`, nowSec)
      .toArray();

    for (const row of due) {
      // Skip interval rows whose previous execution is still running unless
      // it's been hung past the timeout (then forcibly reset).
      if (row.type === "interval" && row.running === 1) {
        const startedAt = row.execution_started_at ?? 0;
        const elapsed = nowSec - startedAt;
        if (elapsed < HUNG_SCHEDULE_TIMEOUT_SECONDS) {
          continue;
        }
        console.warn(`[schedule] forcing reset of hung interval schedule ${row.id} (started ${elapsed}s ago)`);
      }
      if (row.type === "interval") {
        this.ctx.storage.sql.exec(
          `UPDATE cf_agents_schedules SET running = 1, execution_started_at = ? WHERE id = ?`,
          nowSec, row.id,
        );
      }

      const callback = (this as unknown as Record<string, unknown>)[row.callback];
      if (typeof callback !== "function") {
        console.error(`[schedule] callback ${row.callback} not found on SessionDO; skipping ${row.id}`);
        continue;
      }
      let parsedPayload: unknown;
      try { parsedPayload = JSON.parse(row.payload); }
      catch (err) {
        console.error(`[schedule] payload parse failed for ${row.id} (${row.callback}):`, err);
        // Delete the unparseable row so the alarm doesn't loop on it forever.
        this.ctx.storage.sql.exec(`DELETE FROM cf_agents_schedules WHERE id = ?`, row.id);
        continue;
      }
      try {
        await (callback as (p: unknown, r: unknown) => Promise<unknown>).call(this, parsedPayload, row);
      } catch (err) {
        console.error(`[schedule] callback "${row.callback}" (${row.id}) threw:`, err);
        // Don't crash the alarm — log and continue. cf-agents has retry options
        // but we don't use them in any current callsite.
      }

      // Reschedule cron / interval, delete one-shots
      if (row.type === "cron" && row.cron) {
        try {
          const nextTime = parseCronExpression(row.cron).getNextDate(new Date());
          const nextSec = Math.floor(nextTime.getTime() / 1000);
          this.ctx.storage.sql.exec(`UPDATE cf_agents_schedules SET time = ? WHERE id = ?`, nextSec, row.id);
        } catch (err) {
          console.error(`[schedule] cron parse failed during reschedule for ${row.id}:`, err);
          this.ctx.storage.sql.exec(`DELETE FROM cf_agents_schedules WHERE id = ?`, row.id);
        }
      } else if (row.type === "interval") {
        const interval = row.intervalSeconds ?? 0;
        const nextSec = Math.floor(Date.now() / 1000) + interval;
        this.ctx.storage.sql.exec(
          `UPDATE cf_agents_schedules SET running = 0, execution_started_at = NULL, time = ? WHERE id = ?`,
          nextSec, row.id,
        );
      } else {
        this.ctx.storage.sql.exec(`DELETE FROM cf_agents_schedules WHERE id = ?`, row.id);
      }
    }

    // Stale-turn cleanup. Replaces the old _checkOrphanTurns →
    // onFiberRecovered → recoverAgentTurn chain that re-ran the LLM
    // stream from inside alarm() — burned the 180s wall-time budget,
    // got the alarm canceled, and made the eviction problem worse.
    // _finalizeStaleTurns is SQL-only; appends aborted tool_results +
    // status_idle for stuck turns so Console + history are consistent
    // and the user can re-send to continue. (cloudflare/agents SDK's
    // documented stance: "LLM calls are NOT replayed.")
    await this._finalizeStaleTurns();

    // (Keep-alive rearm — sub-agent + supervisor heartbeat — folded
    // into _scheduleNextAlarm below so it can MERGE with data-driven
    // wakeups and not get clobbered by the deleteAlarm() branch when
    // cf_agents_schedules is empty. The merge picks min(heartbeat, next
    // schedule) so we never sleep past the heartbeat horizon.)

    // Container keepalive: while there's at least one background_tasks row,
    // ping the sandbox container to reset its sleepAfter timer. Means
    // long-running `python script.py &` jobs that the agent is waiting on
    // don't get killed by the 5-minute idle TTL. Cheap (~5 ms RPC).
    try {
      const rows = this.ctx.storage.sql
        .exec("SELECT 1 FROM background_tasks LIMIT 1")
        .toArray();
      if (rows.length > 0) {
        const sb = this.getOrCreateSandbox();
        if (typeof (sb as { renewActivityTimeout?: () => Promise<void> }).renewActivityTimeout === "function") {
          await (sb as { renewActivityTimeout: () => Promise<void> }).renewActivityTimeout();
        }
      }
    } catch {
      // background_tasks table missing or container down — alarm continues
    }

    await this._scheduleNextAlarm();
  }

  // ── Orphan-turn detection (replaces cf_agents_runs / runFiber API) ────

  /**
   * Scan the unified `sessions` table for rows marked status='running'
   * with a turn_id we don't recognise as our own active turn. For each,
   * call onFiberRecovered (which routes to recoverAgentTurn) so the
   * partial state gets reconciled and the next user.message starts
   * from clean events.
   *
   * Replaces the old _checkRunFibers (cf_agents_runs scan). The unified
   * adapter writes turn_id on beginTurn() and clears it on endTurn();
   * leftover rows after a process death are exactly the orphan set.
   */
  private async _checkOrphanTurns(): Promise<void> {
    if (!this._state) return;
    const orphans = await this.runtimeAdapter.listOrphanTurns(this.state.session_id);
    // ports.ts contract: caller MUST filter out its own active turn ids
    // before treating each row as an orphan. We track these in
    // _activeTurnIds (populated from RuntimeAdapter's hintTurnInFlight
    // callback the moment beginTurn lands the D1 write). Mirrors Node
    // SessionStateMachine.onWake's `if (o.turn_id === this.activeTurnId)
    // continue` (machine.ts:183), just generalized to a Set because
    // sub-agents can have concurrent turns.
    //
    // Pre-fix this loop iterated all rows blindly and the keep-alive
    // alarm regularly woke up mid-stream to "recover" our own active
    // turn — observed on staging sess-slqg7xf4kvm6s2j4 (2026-05-10
    // 07:01:43Z): emitted session.status_rescheduled + spawned a
    // parallel streamText racing the original. Then we patched it with
    // a 90s grace period; the proper fix is the explicit set check.
    for (const o of orphans) {
      if (this._activeTurnIds.has(o.turn_id)) continue;
      try {
        await this.onFiberRecovered({
          id: o.turn_id,
          name: `turn:${o.turn_id}`,
          snapshot: null,
        });
      } catch (err) {
        console.error(`[orphan-recovery] failed for turn ${o.turn_id}:`, err);
      }
      // Mark the orphan turn idle. recoverAgentTurn doesn't do this
      // (it ran before the unified table existed).
      await this.runtimeAdapter.endTurn(this.state.session_id, o.turn_id, "idle");
    }
  }

  /**
   * Lightweight stale-turn cleanup — replacement for the old
   * onFiberRecovered → recoverAgentTurn chain that re-ran the LLM
   * stream from inside alarm() and routinely burned the 180s
   * Workers wall-time budget (observed 2026-05-10 sess-slqg7xf4: 6
   * consecutive 180s alarm fires + 110s alarm gap = DO evicted).
   *
   * Aligns with cloudflare/agents SDK guidance: "LLM calls are NOT
   * replayed — if streaming mid-response when evicted, that stream is
   * lost permanently." Recovery == surface the interruption + clean
   * up state, not auto-replay.
   *
   * What this does:
   *   1. For every unpaired tool_use (no matching tool_result by id),
   *      append an aborted tool_result so Console pairing collapses
   *      the bubble + history is consistent for any future re-prompt.
   *   2. For every stuck `sessions.status='running'` row whose turn_id
   *      isn't in `_activeTurnIds` (i.e. dead from a prior incarnation),
   *      append `session.status_rescheduled` + `session.status_idle`
   *      then call adapter.endTurn to flip the row.
   *
   * All SQL writes; no LLM call, no harness re-run. Cheap enough to
   * call from alarm() AND first-fetch.
   */
  private async _finalizeStaleTurns(): Promise<void> {
    if (!this._state) return;
    // Ensure events table exists (alarm() runs without going through
    // fetchInner's ensureSchema). Cheap idempotent CREATE IF NOT EXISTS.
    try { this.ensureSchema(); } catch { /* schema already up-to-date */ }
    const sql = this.ctx.storage.sql;

    // 1. Unpaired tool_use detection. Three flavors per the wire spec
    //    in default-loop.ts:emitToolCallEvent:
    //      • agent.tool_use         → result keyed by tool_use_id
    //      • agent.custom_tool_use  → result keyed by tool_use_id
    //      • agent.mcp_tool_use     → result keyed by mcp_tool_use_id
    //    The pairing key for use→result is always the use's own `id`.
    //    Wrapped in try blocks so a missing events table (very early
    //    cold-start) doesn't short-circuit the sessions row cleanup
    //    below — that's the contract callers depend on.
    const usedIds = new Map<string, { type: string; thread?: string | null }>();
    try {
      const useCursor = sql.exec(
        `SELECT type, data, session_thread_id FROM events
          WHERE type IN ('agent.tool_use','agent.custom_tool_use','agent.mcp_tool_use')`,
      );
      for (const row of useCursor) {
        try {
          const d = JSON.parse(row.data as string) as { id?: string };
          if (d.id) usedIds.set(d.id, {
            type: row.type as string,
            thread: row.session_thread_id as string | null,
          });
        } catch { /* skip malformed */ }
      }
    } catch { /* events table missing — skip flush, do row cleanup below */ }
    if (usedIds.size > 0) {
      try {
        const resCursor = sql.exec(
          `SELECT data FROM events
            WHERE type IN ('agent.tool_result','agent.mcp_tool_result')`,
        );
        for (const row of resCursor) {
          try {
            const d = JSON.parse(row.data as string) as {
              tool_use_id?: string;
              mcp_tool_use_id?: string;
            };
            const id = d.tool_use_id ?? d.mcp_tool_use_id;
            if (id) usedIds.delete(id);
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
    let flushed = 0;
    for (const [id, meta] of usedIds) {
      const isMcp = meta.type === "agent.mcp_tool_use";
      const event = isMcp
        ? {
            type: "agent.mcp_tool_result" as const,
            mcp_tool_use_id: id,
            content: "Tool call interrupted (DO eviction or restart). Re-send your message to retry.",
            is_error: true,
          }
        : {
            type: "agent.tool_result" as const,
            tool_use_id: id,
            content: "Tool call interrupted (DO eviction or restart). Re-send your message to retry.",
            is_error: true,
          };
      const tagged = (meta.thread
        ? { ...event, session_thread_id: meta.thread }
        : event) as unknown as SessionEvent;
      try {
        await this.runtimeAdapter.eventLog.append(tagged);
        this.broadcastEvent(tagged);
        flushed++;
      } catch (err) {
        console.warn(`[finalize-stale] failed to flush tool_use ${id}:`, err);
      }
    }

    // 2. Force-end stale sessions rows. Skip turns currently held in
    //    _activeTurnIds (live work in this incarnation). Order matters:
    //    endTurn FIRST (the contract), events only on success. The
    //    earlier shape (rescheduled → endTurn → idle) emitted a
    //    rescheduled event even when endTurn threw, leaving Console
    //    showing "rescheduled" with no resolution and the row still
    //    'running'. Atomic-from-Console's-perspective: events appear
    //    iff the row actually flipped.
    const orphans = await this.runtimeAdapter.listOrphanTurns(this.state.session_id);
    let ended = 0;
    // Race window: cold-start flush is fire-and-forget from fetch();
    // the same fetch() may concurrently route a POST /event into
    // drainEventQueue → adapter.beginTurn (writes D1 row) →
    // hintTurnInFlight callback (populates _activeTurnIds). If we read
    // listOrphanTurns BETWEEN the D1 write landing and the in-memory
    // set add, the brand-new turn looks like an orphan and we'd
    // incorrectly emit rescheduled+idle for it (caught 2026-05-11
    // bench scenario 08, sess-hn5kmowudx42awm0). Filter by
    // turn_started_at age — anything that started < 30s ago is
    // necessarily either still in-flight or just-completed; not an
    // orphan worth reaping. Real orphans (DO eviction) have
    // turn_started_at from a previous incarnation, which is by
    // definition older than the current process's lifetime.
    const FRESH_TURN_GRACE_MS = 30_000;
    const now = Date.now();
    for (const o of orphans) {
      if (this._activeTurnIds.has(o.turn_id)) continue;
      if (now - o.turn_started_at < FRESH_TURN_GRACE_MS) continue;
      try {
        await this.runtimeAdapter.endTurn(this.state.session_id, o.turn_id, "idle");
      } catch (err) {
        console.warn(`[finalize-stale] endTurn failed for ${o.turn_id}:`, err);
        continue; // skip event emission — row is still in old state
      }
      ended++;
      const reschedEvent = {
        type: "session.status_rescheduled",
        reason: "DO eviction or restart — stream lost; re-send to continue.",
      } as unknown as SessionEvent;
      const idleEvent = { type: "session.status_idle" } as unknown as SessionEvent;
      // Events are best-effort post-cleanup; row is the source of truth.
      try { await this.runtimeAdapter.eventLog.append(reschedEvent); } catch {}
      try { this.broadcastEvent(reschedEvent); } catch {}
      try { await this.runtimeAdapter.eventLog.append(idleEvent); } catch {}
      try { this.broadcastEvent(idleEvent); } catch {}
    }
    if (flushed > 0 || ended > 0) {
      console.log(`[finalize-stale] flushed ${flushed} tool_uses, ended ${ended} stale turns`);
    }
  }

  /**
   * Has this DO got a turn currently in flight? Used by alarm() to
   * decide whether to rearm itself for keep-alive.
   */
  private async _hasInflightTurn(): Promise<boolean> {
    if (!this._state) return false;
    const orphans = await this.runtimeAdapter.listOrphanTurns(this.state.session_id);
    return orphans.length > 0;
  }
}

// ── Schedule type (cf-agents-compatible) ───────────────────────────────
type SessionScheduleType = "scheduled" | "delayed" | "cron" | "interval";