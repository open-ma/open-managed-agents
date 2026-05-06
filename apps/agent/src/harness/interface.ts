import type { ModelMessage, LanguageModel } from "ai";
import type { AgentConfig, SessionEvent, UserMessageEvent } from "@open-managed-agents/shared";

// SandboxExecutor + ProcessHandle live in @open-managed-agents/sandbox so
// non-CF runtimes (apps/main-node, future deployments) can implement the
// same shape without depending on apps/agent's CF-only modules. Imported
// for local use AND re-exported so existing imports keep working unchanged.
import type { SandboxExecutor, ProcessHandle } from "@open-managed-agents/sandbox";
export type { SandboxExecutor, ProcessHandle } from "@open-managed-agents/sandbox";

export interface HarnessInterface {
  /** Main agent loop. Required. Drives generateText and emits events. */
  run(ctx: HarnessContext): Promise<void>;

  /**
   * Called once per session, after sandbox warmup, before the first user
   * message is processed. Default behavior (DefaultHarness): inject
   * <system-reminder> user.message events for each skill / memory_prompt /
   * appendable_prompt the agent opted into. Override to substitute a custom
   * RAG layer, or to opt out of platform reminders entirely (no-op).
   *
   * Anything written here lands in the events stream BEFORE the first user
   * message — it becomes part of the cached prefix for every subsequent turn.
   */
  onSessionInit?(ctx: HarnessContext, runtime: HarnessRuntime): Promise<void>;

  /**
   * Decide whether to trigger compaction for this turn. Default behavior:
   * estimate tokens via deriveModelContext + heuristic, fire when > 75% of
   * the model's context window. Override for cooldown / business rules /
   * never-compact / always-compact.
   *
   * `ctx.contextWindowTokens` is the resolved model's window (best-effort —
   * may be a default if the model card doesn't expose it).
   */
  shouldCompact?(events: SessionEvent[], ctx: { contextWindowTokens: number }): boolean;

  /**
   * Execute compaction. Implementation MUST persist its product as a
   * agent.thread_context_compacted event with `summary: ContentBlock[]`
   * filled in (via runtime.broadcast). Default: send the FULL conversation
   * (same model + system + tools as main agent's last call) to the model
   * with a "summarize the above" user message appended — Anthropic's prompt
   * cache then reads the prefix instead of recomputing it.
   */
  compact?(
    events: SessionEvent[],
    runtime: HarnessRuntime,
    ctx: {
      model: LanguageModel;
      systemPrompt: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: Record<string, any>;
    },
  ): Promise<void>;

  /**
   * Project events → ModelMessage[] for the next generateText call. Default:
   * eventsToMessages — strict bijection inverse of writes, with
   * agent.thread_context_compacted boundary handling. Override for
   * sliding-window / RAG / hierarchical / no-compact strategies.
   *
   * Output MUST be byte-deterministic for any input — Anthropic's prompt
   * cache invalidates on any prefix byte drift.
   */
  deriveModelContext?(events: SessionEvent[]): ModelMessage[];
}

export interface HarnessRuntime {
  history: HistoryStore;
  sandbox: SandboxExecutor;
  /**
   * Append an event to history AND broadcast to WS subscribers. The single
   * write path for harness-emitted events (model output, system_reminder,
   * compaction marker, custom marker, etc.).
   */
  broadcast: (event: SessionEvent) => void;
  /**
   * Mark the start of an in-flight LLM stream and broadcast a lifecycle
   * event to subscribers. The runtime persists the stream state to the
   * `streams` table (separate from the events log) so a deploy mid-
   * stream can be detected and the partial finalized. Lifecycle events
   * are NOT persisted to the events log — the eventual `agent.message`
   * with the same `id` is the canonical record. Idempotent on duplicate
   * start with the same id (e.g. harness retry minted a fresh id).
   */
  broadcastStreamStart: (messageId: string) => Promise<void>;
  /**
   * Append a token delta to an in-flight stream's buffer and broadcast
   * an `agent.message_chunk` event with the same message_id. Chunks are
   * buffered for restart recovery; they are NOT persisted to the events
   * log (would pollute history — the final agent.message is the source
   * of truth).
   */
  broadcastChunk: (messageId: string, delta: string) => Promise<void>;
  /**
   * Mark a stream as finished and broadcast an end lifecycle event.
   * `completed` = LLM finished cleanly; `aborted` = explicit abort or
   * harness retry minting a new id. The recovery scan uses `interrupted`
   * for streams left dangling by a runtime restart — callers shouldn't
   * pass that themselves.
   */
  broadcastStreamEnd: (
    messageId: string,
    status: "completed" | "aborted",
    errorText?: string,
  ) => Promise<void>;
  /**
   * Live thinking-block streaming. Broadcast-only — the eventual
   * `agent.thinking` event with the same `thinking_id` is the
   * persisted record. If the runtime dies mid-thinking, the
   * agent.thinking never lands and the harness retries the step (no
   * recovery work needed because nothing was committed).
   */
  broadcastThinkingStart: (thinkingId: string) => Promise<void>;
  broadcastThinkingChunk: (thinkingId: string, delta: string) => Promise<void>;
  broadcastThinkingEnd: (
    thinkingId: string,
    status: "completed" | "aborted",
  ) => Promise<void>;
  /**
   * Live tool-input streaming. `toolUseId` matches the eventual
   * `agent.tool_use` / `agent.mcp_tool_use` / `agent.custom_tool_use`
   * id. Broadcast-only — the canonical tool_use event lands once the
   * model commits the call, and recovery handles missing tool_results
   * via the existing scan (see recovery.ts).
   */
  broadcastToolInputStart: (toolUseId: string, toolName?: string) => Promise<void>;
  broadcastToolInputChunk: (toolUseId: string, delta: string) => Promise<void>;
  broadcastToolInputEnd: (
    toolUseId: string,
    status: "completed" | "aborted",
  ) => Promise<void>;
  reportUsage?: (input_tokens: number, output_tokens: number) => Promise<void>;
  pendingConfirmations?: string[];
  abortSignal?: AbortSignal;
  /**
   * Wrap a long async operation (e.g. model fetch + stream consumption) so
   * the underlying Durable Object stays alive — refcounted keepAlive that
   * actually prevents CF eviction during the await. Without this the
   * 30s alarm-driven keepAlive heartbeat is the only thing reminding CF
   * the DO is busy, which is too coarse: CF can evict between heartbeats
   * if no request handler is on the stack and no fetch is pending in a
   * way the runtime credits.
   *
   * Implementation: SessionDO injects `(fn) => this.keepAliveWhile(fn)`
   * (cf-agents Agent.keepAliveWhile). Always returns whatever fn returns.
   */
  keepAliveWhile?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface HarnessContext {
  agent: AgentConfig;
  userMessage: UserMessageEvent;
  /**
   * The OMA session id this turn belongs to. Optional during the transition
   * for legacy harnesses; AcpProxyHarness needs it to address the
   * RuntimeRoom DO. SessionDO populates this on every harness.run call.
   */
  session_id?: string;

  /** Platform-prepared tools: built from agent config, ready to pass to generateText. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: Record<string, any>;

  /** Platform-prepared model: resolved from agent config with API key. */
  model: LanguageModel;

  /**
   * Platform-augmented system prompt: agent.system + platform guidance
   * (authenticatedCommandGuidance + loopStopGuidance).
   * Skill/memory/appendable_prompt content is NOT here — that's injected as
   * <system-reminder> user.message events via onSessionInit (default behavior).
   * Use this directly to inherit platform defaults; ignore and use
   * `rawSystemPrompt` if you want to take full control.
   */
  systemPrompt: string;

  /**
   * Just `agent.system` verbatim, no platform additions. Use this when
   * substituting a custom system prompt build path. Optional during the
   * transition; SessionDO will populate it once task #9 lands.
   */
  rawSystemPrompt?: string;

  /**
   * Platform-resolved reminders the default `onSessionInit` will inject as
   * `<system-reminder>` user.message events on first session run. Sources:
   * skill metadata, memory_store prompts, opted-in appendable_prompts.
   *
   * Custom harnesses can ignore this and inject differently — or skip
   * platform reminders entirely by overriding onSessionInit with a no-op.
   * Each reminder lands as ONE event, persisted in the events stream
   * before any user message, so it sits in the cached prefix forever.
   */
  platformReminders?: Array<{ source: string; text: string }>;

  env: {
    ANTHROPIC_API_KEY: string;
    ANTHROPIC_BASE_URL?: string;
    ANTHROPIC_MODEL?: string;
    TAVILY_API_KEY?: string;
    delegateToAgent?: (agentId: string, message: string) => Promise<string>;
    CONFIG_KV?: KVNamespace;
    memoryStoreIds?: string[];
    environmentConfig?: { networking?: { type: string; allowed_hosts?: string[] } };
    /** Register a background task for completion notification (CC-style task_notification). */
    watchBackgroundTask?: (taskId: string, pid: string, outputFile: string, proc: ProcessHandle | null) => void;
    /** Cross-script DO binding to RuntimeRoom (declared on main worker but
     *  bound here via wrangler.jsonc `script_name`). AcpProxyHarness uses
     *  this to attach to the daemon's room without going through main as
     *  an HTTP service. */
    RUNTIME_ROOM?: DurableObjectNamespace;
  };
  runtime: HarnessRuntime;
}

export interface HistoryStore {
  getMessages(): ModelMessage[];
  append(event: SessionEvent): void;
  getEvents(afterSeq?: number): SessionEvent[];
}

export interface ProcessHandle {
  id: string;
  pid: number;
  kill(signal: string): Promise<void>;
  getLogs(): Promise<{ stdout: string; stderr: string }>;
  getStatus(): Promise<string>;
}

export interface SandboxExecutor {
  exec(command: string, timeout?: number): Promise<string>;
  /** Start a process without blocking. Returns handle for kill/status/logs. */
  startProcess?(command: string): Promise<ProcessHandle | null>;
  /** Set global environment variables for all subsequent exec calls. */
  setEnvVars?(envVars: Record<string, string>): Promise<void>;
  /** Native git checkout (if supported by sandbox). */
  gitCheckout?(repoUrl: string, options: { branch?: string; targetDir?: string }): Promise<unknown>;
  /** Register secrets injected only for commands matching a prefix (e.g. "git", "gh"). */
  registerCommandSecrets?(commandPrefix: string, secrets: Record<string, string>): void;
  /**
   * Bind the outbound handler with this session's identifying context. The
   * sandbox's outbound interceptor uses (tenantId, sessionId) to RPC into
   * main on each outbound HTTPS call; main resolves the matching vault
   * credential live and injects the Authorization header. The agent worker
   * never holds plaintext credentials.
   */
  setOutboundContext?(opts: {
    tenantId: string;
    sessionId: string;
  }): Promise<void>;
  /**
   * Hand the (tenant, env, session) tuple to the OmaSandbox container DO so
   * its onActivityExpired hook (sleepAfter teardown) records the final
   * /workspace snapshot scoped to this session. See oma-sandbox.ts for
   * the actual backup logic.
   */
  setBackupContext?(opts: {
    tenantId: string;
    environmentId: string;
    sessionId: string;
  }): Promise<void>;
  /**
   * Trigger an immediate /workspace snapshot via OmaSandbox. Used by the
   * explicit-destroy path to capture state before sandbox.destroy() wipes
   * the container; the sleepAfter teardown handles itself via
   * onActivityExpired without needing this call.
   */
  snapshotWorkspaceNow?(): Promise<void>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<string>;
  /**
   * Write raw bytes to a sandbox path. Use this for binary files (PDFs,
   * images, archives) — the string-based writeFile would corrupt them via
   * UTF-8 round-tripping.
   */
  writeFileBytes?(path: string, bytes: Uint8Array): Promise<string>;
  /**
   * Mount a memory store into the sandbox at /mnt/memory/<storeName>/.
   * Backed by the MEMORY_BUCKET R2 binding with prefix scoping. Read-only
   * mounts reject writes. The agent uses standard file tools to interact;
   * no memory-specific tools are registered (Anthropic-aligned).
   */
  mountMemoryStore?(opts: {
    storeName: string;
    storeId: string;
    readOnly: boolean;
  }): Promise<void>;
  /**
   * Snapshot /workspace into R2 via squashfs. Returns a serializable
   * handle; null on failure. Used by session-do.ts to checkpoint the
   * workspace at session destroy. See workspace-backups.ts for the D1
   * persistence layer that survives the snapshot handle across sessions.
   */
  createWorkspaceBackup?(opts: {
    name?: string;
    ttlSec: number;
  }): Promise<{ id: string; dir: string; localBucket?: boolean } | null>;
  /**
   * Restore a previously-created backup into /workspace. Returns true on
   * success, false if the backup is missing/expired/etc. Best-effort: a
   * false return means the caller should treat /workspace as empty.
   */
  restoreWorkspaceBackup?(handle: {
    id: string;
    dir: string;
    localBucket?: boolean;
  }): Promise<{ ok: boolean; error?: string }>;
  /** Destroy the sandbox container — kills processes, unmounts, stops. */
  destroy?(): Promise<void>;
  /**
   * Tell the sandbox container "I'm still active". Resets the CF Container's
   * sleepAfter inactivity timer so it doesn't auto-stop while we have
   * long-running bg tasks waiting for results. Cheap (~RPC roundtrip).
   * No-op if the implementation doesn't support it.
   */
  renewActivityTimeout?(): Promise<void>;
}
