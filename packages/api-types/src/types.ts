// --- Model Card ---

export interface ModelCard {
  id: string;
  name: string;
  provider: string;             // API compat: "ant" | "oai" | "ant-compatible" | "oai-compatible"
  model_id: string;        // e.g. "claude-sonnet-4-6", "gpt-4o", "deepseek-chat"
  api_key_preview?: string; // last 4 chars only, for display
  base_url?: string;        // custom base URL (compatible providers)
  custom_headers?: Record<string, string>; // custom HTTP headers (compatible providers)
  is_default?: boolean;
  created_at: string;
  updated_at?: string;
  archived_at?: string;
}

// --- Agent ---

export interface ToolsetConfig {
  type: string; // "agent_toolset_20260401"
  default_config?: {
    enabled: boolean;
    permission_policy?: { type: "always_allow" | "always_ask" };
  };
  configs?: Array<{
    name: string;
    enabled: boolean;
    permission_policy?: { type: "always_allow" | "always_ask" };
  }>;
}

export interface CustomToolConfig {
  type: "custom";
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type ToolConfig = ToolsetConfig | CustomToolConfig;

export interface AgentConfig {
  id: string;
  name: string;
  model: string | { id: string; speed?: "standard" | "fast" };
  system: string;
  tools: ToolConfig[];
  mcp_servers?: Array<{
    name: string;
    type: string;
    /** Required for remote (HTTP/SSE) servers. Optional when `stdio` is set —
     *  in that case the URL is derived from the spawned process's localhost port. */
    url?: string;
    authorization_token?: string;
    /** Spawn this MCP server in the sandbox container. The process binds to
     *  127.0.0.1:port using its built-in SSE transport, and OMA routes the
     *  existing HTTP-based MCP tool wiring at it. Lets us host stdio-only
     *  third-party MCP servers without a separate gateway. */
    stdio?: {
      command: string;             // e.g. "uvx"
      args?: string[];             // e.g. ["my-mcp-server", "--transport", "sse", "--port", "8765"]
      env?: Record<string, string>;
      port: number;                // port the server listens on inside the sandbox
      sse_path?: string;           // default "/sse"
      ready_timeout_ms?: number;   // default 60000 — how long to wait for the port to bind
    };
  }>;
  skills?: Array<{ skill_id: string; type: string; version?: string }>;
  callable_agents?: Array<{ type: "agent"; id: string; version?: number }>;
  model_card_id?: string;
  /**
   * Optional auxiliary model used by tools for in-process LLM work
   * (e.g. web_fetch summarization). Same shape as `model`.
   * When unset, tools that would benefit from summarization fall back to
   * returning raw content. Set this to opt into compressed tool results.
   */
  aux_model?: string | { id: string; speed?: "standard" | "fast" };
  /** Companion to aux_model — explicit model card binding when needed. */
  aux_model_card_id?: string;
  harness?: string;
  /**
   * When set, agent runs on a user-registered local ACP runtime instead of
   * OMA's cloud SessionDO loop. `harness` MUST be "acp-proxy" for this to
   * take effect; SessionDO routes the AcpProxyHarness which proxies via the
   * RuntimeRoom DO addressed by `runtime_id` to the daemon, which spawns the
   * ACP child identified by `acp_agent_id` (matching KNOWN_ACP_AGENTS).
   */
  runtime_binding?: {
    runtime_id: string;
    acp_agent_id: string;
    /**
     * Skill ids the user wants HIDDEN from this agent's ACP child. Default
     * (omitted / empty) = all locally-detected skills allowed. Each id matches
     * a skill the daemon reported in the runtime hello manifest's
     * `local_skills[acp_agent_id]`. Daemon enforces by NOT symlinking the
     * blocked dir into spawn cwd's CLAUDE_CONFIG_DIR.
     */
    local_skill_blocklist?: string[];
  };
  description?: string;
  metadata?: Record<string, unknown>;
  /**
   * Opt-in registry of prompt IDs (managed by appendable-prompts subsystem)
   * to inject as additional system prompt segments at session/turn start.
   * Resolved by session-do at init; empty/missing = no extra segments.
   */
  appendable_prompts?: string[];
  version: number;
  created_at: string;
  updated_at?: string;
  archived_at?: string;
}

// --- Environment ---

export interface EnvironmentConfig {
  id: string;
  name: string;
  description?: string;
  config: {
    type: string; // "cloud"
    packages?: {
      pip?: string[];
      npm?: string[];
      apt?: string[];
      cargo?: string[];
      gem?: string[];
      go?: string[];
    };
    networking?: {
      type: "unrestricted" | "limited";
      allowed_hosts?: string[];
      allow_mcp_servers?: boolean;
      allow_package_managers?: boolean;
    };
    /** Free-form Dockerfile body — RUN/COPY/ENV lines only. Required
     *  when `image_strategy === "dockerfile"`. The platform PREPENDS
     *  `FROM openma/sandbox-base:latest` and REJECTS user-supplied
     *  FROM/WORKDIR/USER/ENTRYPOINT/CMD (it owns those to keep the
     *  harness runtime hooks intact). */
    dockerfile?: string;
  };
  status?: "building" | "ready" | "error";
  build_error?: string;
  sandbox_worker_name?: string;
  /** How this env's sandbox image is produced.
   *
   *  - `base_snapshot` (default for new envs): packages installed once
   *    into a CF Sandbox snapshot, restored on every session boot. All
   *    envs share the `sandbox-default` worker. Fast cold-create
   *    (~30-60s once, then 1-2s per session). REJECTS apt packages —
   *    they install system-wide and can't snapshot under /home.
   *
   *  - `dockerfile` (opt-in): per-env GitHub Actions build of a
   *    Dockerfile (always FROM openma/sandbox-base) that gets deployed
   *    as its own `sandbox-<env_id>` worker. Use when you need apt
   *    packages, custom binaries, or full image control. Slower
   *    create (~90s CI) but no per-session install.
   *
   *  Omitted = legacy (pre-migration) — readers should treat as
   *  `dockerfile` for back-compat.
   */
  image_strategy?: "base_snapshot" | "dockerfile";
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
  archived_at?: string;
}

// --- Session ---

export type SessionStatus = "idle" | "running" | "rescheduled" | "terminated";

export interface SessionMeta {
  id: string;
  agent_id: string;
  environment_id: string;
  title: string;
  status: SessionStatus;
  metadata?: Record<string, unknown>;
  vault_ids?: string[];
  archived_at?: string;
  updated_at?: string;
  created_at: string;
}

// --- Content Blocks ---

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  source: {
    type: "base64" | "url" | "file";
    media_type?: string; // e.g. "image/jpeg", "image/png", "image/gif", "image/webp"
    data?: string;       // base64 data (when type=base64)
    url?: string;        // URL (when type=url)
    file_id?: string;    // reference to uploaded file (when type=file)
  };
}

export interface DocumentBlock {
  type: "document";
  source: {
    type: "base64" | "url" | "file" | "text";
    media_type?: string; // e.g. "application/pdf", "text/plain"
    data?: string;       // base64 data or plain text content
    url?: string;        // URL (when type=url)
    file_id?: string;    // reference to uploaded file (when type=file)
  };
  title?: string;        // optional document title
  context?: string;      // optional context about the document
  citations?: { enabled: boolean }; // optional citation support
}

export type ContentBlock = TextBlock | ImageBlock | DocumentBlock;

// --- Event Base ---

export interface EventBase {
  id?: string;
  processed_at?: string;
  parent_event_id?: string; // optional causal predecessor in product domain (e.g. tool_result → tool_use, outcome.evaluation_end → agent.message it evaluated)
  /**
   * Free-form harness/platform metadata. Wire-compatible extension point —
   * existing consumers ignore unknown fields. Use to namespace harness-emitted
   * sub-types without inventing new top-level event types (which would break
   * the wire format). Convention: include `harness: "<harness-name>"` plus
   * a `kind: "..."` discriminator inside.
   *
   * Example: a custom RAG marker reuses `user.message` as wire type and
   * tags `metadata: { harness: "rag", kind: "chunk", chunk_id: "..." }`.
   */
  metadata?: Record<string, unknown>;
}

// --- Session Events ---

export interface UserMessageEvent extends EventBase {
  type: "user.message";
  content: ContentBlock[];
}

export interface UserInterruptEvent extends EventBase {
  type: "user.interrupt";
}

export interface UserToolConfirmationEvent extends EventBase {
  type: "user.tool_confirmation";
  tool_use_id: string;
  result: "allow" | "deny";
  deny_message?: string;
}

export interface UserCustomToolResultEvent extends EventBase {
  type: "user.custom_tool_result";
  custom_tool_use_id: string;
  content: ContentBlock[];
  is_error?: boolean;
}

export interface AgentMessageEvent extends EventBase {
  type: "agent.message";
  content: ContentBlock[];
  /** Identifier shared with the in-flight stream events
   *  (`agent.message_chunk` / `_stream_start` / `_stream_end`) that
   *  produced this final committed message. Clients group all four
   *  event types by this id to render a single message. Set when the
   *  message came from a streaming step (the common case); legacy /
   *  non-streamed messages may omit it. */
  message_id?: string;
}

export interface AgentMessageStreamStartEvent extends EventBase {
  type: "agent.message_stream_start";
  message_id: string;
}

/** A token-level delta emitted while an LLM step's text is being
 *  generated. NOT persisted to the events log (`runtime.broadcastChunk`
 *  bypasses `history.append`); only broadcast over WS/SSE and buffered
 *  in the streams table for restart recovery. Clients append `delta` to
 *  the in-progress text for `message_id`; once the matching
 *  `agent.message` (same id) lands, replace the in-progress text with
 *  the final canonical content. */
export interface AgentMessageChunkEvent extends EventBase {
  type: "agent.message_chunk";
  message_id: string;
  delta: string;
}

export interface AgentMessageStreamEndEvent extends EventBase {
  type: "agent.message_stream_end";
  message_id: string;
  /** completed = LLM finished cleanly. aborted = explicit abort
   *  (user.interrupt or harness retry). interrupted = recovery scan on
   *  cold start detected the runtime was killed mid-stream. */
  status: "completed" | "aborted" | "interrupted";
  error_text?: string;
}

/** Live thinking-block streaming. Anthropic's extended-thinking can sit
 *  for 5–30s before the canonical `agent.thinking` lands; these
 *  lifecycle + delta events let the client render reasoning as it
 *  arrives. NOT persisted to the events log — only `agent.thinking`
 *  with the same `thinking_id` is canonical history. */
export interface AgentThinkingStreamStartEvent extends EventBase {
  type: "agent.thinking_stream_start";
  thinking_id: string;
}

export interface AgentThinkingChunkEvent extends EventBase {
  type: "agent.thinking_chunk";
  thinking_id: string;
  delta: string;
}

export interface AgentThinkingStreamEndEvent extends EventBase {
  type: "agent.thinking_stream_end";
  thinking_id: string;
  status: "completed" | "aborted" | "interrupted";
}

/** Live tool-input streaming. `tool_use_id` is the same id the eventual
 *  `agent.tool_use` / `agent.mcp_tool_use` / `agent.custom_tool_use`
 *  carries, so the client can swap the in-flight bubble for the
 *  canonical tool widget once the model commits the call. NOT persisted. */
export interface AgentToolUseInputStreamStartEvent extends EventBase {
  type: "agent.tool_use_input_stream_start";
  tool_use_id: string;
  tool_name?: string;
}

export interface AgentToolUseInputChunkEvent extends EventBase {
  type: "agent.tool_use_input_chunk";
  tool_use_id: string;
  delta: string;
}

export interface AgentToolUseInputStreamEndEvent extends EventBase {
  type: "agent.tool_use_input_stream_end";
  tool_use_id: string;
  status: "completed" | "aborted" | "interrupted";
}

export interface AgentThinkingEvent extends EventBase {
  type: "agent.thinking";
  /** Reasoning text emitted by the model. Must be preserved verbatim when
   *  reconstructing assistant turns — some providers validate cryptographic
   *  signatures and reject modified blocks; others require thinking blocks
   *  in history to keep planning context. */
  text?: string;
  /** Provider-specific metadata round-tripped with the reasoning. For
   *  Anthropic: { anthropic: { signature: "...", redactedData: "..." } }.
   *  Other providers may store opaque token IDs. Pass through verbatim. */
  providerOptions?: Record<string, unknown>;
  /** Same id as the matching `agent.thinking_chunk` /
   *  `_stream_start` / `_stream_end` events. Lets the renderer swap the
   *  in-flight reasoning bubble for the canonical event. Set when the
   *  thinking came from a streaming step; legacy/non-streamed
   *  thinking events may omit it. */
  thinking_id?: string;
}

export interface AgentCustomToolUseEvent extends EventBase {
  type: "agent.custom_tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentToolUseEvent extends EventBase {
  type: "agent.tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  evaluated_permission?: "allow" | "ask";
}

export interface AgentToolResultEvent extends EventBase {
  type: "agent.tool_result";
  tool_use_id: string;
  // string for text/JSON results; ContentBlock[] for multimodal results
  // (e.g. Read tool returning an image). When ContentBlock[] is used,
  // downstream consumers (UI, scorers, projections) should extract a
  // text representation if they only need text.
  content: string | ContentBlock[];
}

export interface SessionRunningEvent extends EventBase {
  type: "session.status_running";
}

export interface SessionTerminatedEvent extends EventBase {
  type: "session.status_terminated";
  reason?: string;
}

export interface SessionStatusEvent extends EventBase {
  type: "session.status_idle";
  stop_reason?: {
    type: "end_turn" | "requires_action";
    event_ids?: string[];
    // requires_action sub-type for SDK routing
    action_type?: "tool_confirmation" | "custom_tool_result";
  };
}

export interface AgentMcpToolUseEvent extends EventBase {
  type: "agent.mcp_tool_use";
  id: string;
  mcp_server_name: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentMcpToolResultEvent extends EventBase {
  type: "agent.mcp_tool_result";
  mcp_tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface UserDefineOutcomeEvent extends EventBase {
  type: "user.define_outcome";
  outcome_id?: string;
  description: string;
  rubric?: string;  // text rubric or file reference
  max_iterations?: number; // default 3, max 20
}

export interface OutcomeEvaluationEvent extends EventBase {
  type: "outcome.evaluation_end";
  result: "satisfied" | "needs_revision" | "max_iterations_reached" | "failed";
  iteration: number;
  feedback?: string;
}

export interface SessionErrorEvent extends EventBase {
  type: "session.error";
  error: string | {
    type: string;
    message: string;
    retry_status?: "retryable" | "non_retryable";
  };
}

/**
 * Non-fatal warning surfaced to the session event stream — distinct from
 * `session.error` (which implies the harness aborted). Used for things like
 * pre-session credential refresh failures that may degrade later tool calls
 * but don't block session start.
 */
export interface SessionWarningEvent extends EventBase {
  type: "session.warning";
  /** Short category for grouping in UI / metrics (e.g. "credential_refresh"). */
  source: string;
  /** Human-readable warning text shown in the console. */
  message: string;
  /** Optional structured detail for debugging (provider, vault, http status). */
  details?: Record<string, unknown>;
}

export interface SessionThreadCreatedEvent extends EventBase {
  type: "session.thread_created";
  session_thread_id: string;
  agent_id: string;
  agent_name: string;
}

export interface AgentThreadMessageEvent extends EventBase {
  type: "agent.thread_message";
  session_thread_id: string;
  content: ContentBlock[];
}

// Agent thread events (multi-agent)
export interface AgentThreadMessageSentEvent extends EventBase {
  type: "agent.thread_message_sent";
  to_thread_id: string;
  content: ContentBlock[];
}

export interface AgentThreadMessageReceivedEvent extends EventBase {
  type: "agent.thread_message_received";
  from_thread_id: string;
  content: ContentBlock[];
}

export interface AgentThreadContextCompactedEvent extends EventBase {
  type: "agent.thread_context_compacted";
  original_message_count: number;
  compacted_message_count: number;
  /**
   * The summary that REPLACES the compacted region in model context.
   * Persisted in the event so derive() doesn't recompute (recomputation
   * would produce different bytes each turn → cache busts).
   *
   * When present, eventsToMessages() (and any custom deriveModelContext)
   * MUST: drop all model-context events before this boundary, inject the
   * summary as a synthesized user message at the boundary, then expand
   * subsequent model-context events normally.
   *
   * Optional for backward compat: an event without `summary` is a pure
   * notification (UI signal), and derive falls back to "no compaction
   * happened" — i.e. it shows the full pre-boundary history. New events
   * emitted by DefaultHarness always include `summary`.
   */
  summary?: ContentBlock[];
  /**
   * Optional: the seq range in the events table that this boundary
   * replaces. Helps with debug / replay. Not required for derive
   * (derive walks events forward from the boundary).
   */
  replaced_range?: { start_seq: number; end_seq: number };
  /** Why compaction fired. Telemetry only. */
  trigger?: "auto" | "manual";
  /** Token count before compaction (best-effort estimate). Telemetry only. */
  pre_tokens?: number;
}

// Session events
export interface SessionRescheduledEvent extends EventBase {
  type: "session.status_rescheduled";
  reason?: string;
}

export interface SessionOutcomeEvaluatedEvent extends EventBase {
  type: "session.outcome_evaluated";
  outcome_id?: string;
  result: "satisfied" | "needs_revision" | "max_iterations_reached" | "failed" | "interrupted";
  iteration: number;
  feedback?: string;
  explanation?: string;
  usage?: { input_tokens: number; output_tokens: number };
  outcome_evaluation_start_id?: string;
}

export interface SessionThreadIdleEvent extends EventBase {
  type: "session.thread_idle";
  session_thread_id: string;
}

// Span events (observability)
export interface SpanModelRequestStartEvent extends EventBase {
  type: "span.model_request_start";
  model?: string;
}

/**
 * OMA extension (not in Anthropic's wire spec). Fires at the first chunk of a
 * model response, between span.model_request_start and span.model_request_end.
 * Lets the timeline split TTFT (start → first_token) from generation
 * (first_token → end). Pair via model_request_start_id, same as
 * span.model_request_end.
 */
export interface SpanModelFirstTokenEvent extends EventBase {
  type: "span.model_first_token";
  model?: string;
  model_request_start_id?: string;
}

export interface SpanModelRequestEndEvent extends EventBase {
  type: "span.model_request_end";
  model?: string;
  /** Event id of the matching span.model_request_start. Mirrors the
   *  Anthropic Managed Agents wire field — explicit pairing instead of
   *  positional/FIFO matching. Optional for backwards compat with older
   *  events written before this field landed. */
  model_request_start_id?: string;
  /** Upstream provider's response id (Anthropic's `msg_01...`, OpenAI's
   *  `chatcmpl-...`, etc.). Useful for tracing back to provider dashboards
   *  / logs when investigating a specific call. */
  provider_response_id?: string;
  model_usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  /** Why the model stopped: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "aborted" | "other".
   *  Surfaces silent terminations (e.g. provider returns finish_reason="stop"
   *  with empty text mid-task) for debugging incomplete agent runs. */
  finish_reason?: string;
  /** Length of the final assistant text (may be 0 even when finish_reason="stop").
   *  Helps spot the case where the model claims to be done but emits no text. */
  final_text_length?: number;
  /** True if the model returned an error. Mirrors Anthropic's is_error wire field. */
  is_error?: boolean;
  /** Error message when is_error=true. Truncated to 500 chars. */
  error_message?: string;
}

export interface SpanOutcomeEvaluationStartEvent extends EventBase {
  type: "span.outcome_evaluation_start";
  iteration: number;
}

// Compaction summarize call — distinct span type so dashboards can attribute
// summarize cost separately from main-loop model calls. Same shape as
// SpanModelRequest{Start,End}.
export interface SpanCompactionSummarizeStartEvent extends EventBase {
  type: "span.compaction_summarize_start";
  model?: string;
}

export interface SpanCompactionSummarizeEndEvent extends EventBase {
  type: "span.compaction_summarize_end";
  model?: string;
  model_usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  finish_reason?: string;
  final_text_length?: number;
}

export interface SpanOutcomeEvaluationOngoingEvent extends EventBase {
  type: "span.outcome_evaluation_ongoing";
  iteration: number;
}

export interface SpanOutcomeEvaluationEndEvent extends EventBase {
  type: "span.outcome_evaluation_end";
  result: "satisfied" | "needs_revision" | "max_iterations_reached" | "failed";
  iteration: number;
  feedback?: string;
}

// Aux events — platform-internal LLM calls made on behalf of a tool
// (e.g. web_fetch summarization). Distinct from `span.model_request_*`,
// which track the main agent loop's model calls. These let consumers
// (cost dashboards, trajectory viewers) attribute aux usage separately.
export interface AuxModelCallEvent extends EventBase {
  type: "aux.model_call";
  /** Model card the aux call resolved through (if one was matched). */
  model_card_id?: string;
  /** Resolved model identifier (e.g. "claude-sonnet-4-6"). */
  model_id: string;
  /** What the aux model was used for. Extensible — first user is "web_summarize". */
  task: "web_summarize" | string;
  /** Tool-use event that triggered this aux call (for trajectory linking). */
  parent_tool_use_id?: string;
  duration_ms: number;
  tokens: { input: number; output: number; cache_read?: number };
  status: "ok" | "failed";
  error?: string;
}

export type SessionEvent =
  | UserMessageEvent
  | UserInterruptEvent
  | UserToolConfirmationEvent
  | UserCustomToolResultEvent
  | UserDefineOutcomeEvent
  | AgentMessageEvent
  | AgentMessageStreamStartEvent
  | AgentMessageChunkEvent
  | AgentMessageStreamEndEvent
  | AgentThinkingStreamStartEvent
  | AgentThinkingChunkEvent
  | AgentThinkingStreamEndEvent
  | AgentToolUseInputStreamStartEvent
  | AgentToolUseInputChunkEvent
  | AgentToolUseInputStreamEndEvent
  | AgentThinkingEvent
  | AgentCustomToolUseEvent
  | AgentToolUseEvent
  | AgentToolResultEvent
  | AgentMcpToolUseEvent
  | AgentMcpToolResultEvent
  | AgentThreadMessageEvent
  | AgentThreadMessageSentEvent
  | AgentThreadMessageReceivedEvent
  | AgentThreadContextCompactedEvent
  | OutcomeEvaluationEvent
  | SessionRunningEvent
  | SessionRescheduledEvent
  | SessionTerminatedEvent
  | SessionStatusEvent
  | SessionErrorEvent
  | SessionWarningEvent
  | SessionOutcomeEvaluatedEvent
  | SessionThreadCreatedEvent
  | SessionThreadIdleEvent
  | SpanModelRequestStartEvent
  | SpanModelFirstTokenEvent
  | SpanModelRequestEndEvent
  | SpanOutcomeEvaluationStartEvent
  | SpanOutcomeEvaluationOngoingEvent
  | SpanOutcomeEvaluationEndEvent
  | SpanCompactionSummarizeStartEvent
  | SpanCompactionSummarizeEndEvent
  | AuxModelCallEvent;

// --- Vault ---

export interface VaultConfig {
  id: string;
  name: string;
  created_at: string;
  updated_at?: string;
  archived_at?: string;
}

// --- Credential ---

export interface CredentialAuth {
  type: "mcp_oauth" | "static_bearer" | "command_secret";
  // mcp_oauth / static_bearer: match by MCP server URL
  mcp_server_url?: string;
  // mcp_oauth fields
  access_token?: string;
  refresh_token?: string;
  token_endpoint?: string;
  client_id?: string;
  client_secret?: string;
  expires_at?: string;           // ISO 8601, when access_token expires
  authorization_server?: string; // cached OAuth authorization server URL
  // static_bearer fields
  token?: string;
  // command_secret: inject env var only for matching command prefixes
  command_prefixes?: string[];    // e.g. ["wrangler", "npx wrangler"]
  env_var?: string;               // e.g. "CLOUDFLARE_API_TOKEN"
  // Provider tag: when set, the outbound proxy can request a token refresh
  // via the integrations gateway (which holds the secrets needed to mint a
  // fresh token — e.g. GitHub App private key). Used to support short-lived
  // upstream tokens (GitHub installation tokens, ~1hr TTL).
  provider?: "github" | "linear";
}

export interface CredentialConfig {
  id: string;
  vault_id: string;
  display_name: string;
  auth: CredentialAuth;
  created_at: string;
  updated_at?: string;
  archived_at?: string;
}

// --- Memory Store ---

export interface MemoryStoreConfig {
  id: string;
  name: string;
  description?: string;
  created_at: string;
  updated_at?: string;
  archived_at?: string;
}

export interface MemoryItem {
  id: string;
  store_id: string;
  path: string;
  content: string;
  content_sha256?: string;
  size_bytes: number;
  created_at: string;
  updated_at?: string;
}

export interface MemoryVersion {
  id: string;
  memory_id: string;
  store_id: string;
  operation: "created" | "modified" | "deleted";
  path: string;
  content?: string;
  content_sha256?: string;
  size_bytes?: number;
  actor?: { type: string; id: string };
  created_at: string;
  redacted?: boolean;
}

// --- File ---

export interface FileRecord {
  id: string;
  type?: "file";
  filename: string;
  media_type: string;
  size_bytes: number;
  scope_id?: string;
  downloadable?: boolean;
  created_at: string;
}

// --- Session Resource ---

export interface SessionResource {
  id: string;
  session_id: string;
  // `env` is the canonical name for environment-variable resources. The
  // legacy alias `env_secret` is still accepted on writes (so older API
  // clients keep working) but is normalized to `env` before persistence.
  // The rename was intentional: there is no application-level encryption
  // on these values today (only Cloudflare's at-rest layer), and the
  // "secret" suffix was overpromising — see the type=text + mask toggle
  // in the New Session UI for the matching change.
  type: "file" | "memory_store" | "github_repository" | "github_repo" | "env" | "env_secret";
  file_id?: string;
  memory_store_id?: string;
  url?: string;
  repo_url?: string;
  checkout?: { type?: string; name?: string; sha?: string };
  name?: string;
  // authorization_token and value are NEVER stored in resource metadata
  // They go to separate KV keys: secret:{sessionId}:{resourceId}
  credential_id?: string;
  mount_path?: string;
  access?: "read_write" | "read_only";
  /**
   * Per-attachment guidance the agent receives alongside the store's
   * description. Anthropic-aligned: capped at 4096 characters. Replaces
   * the legacy `prompt` field name (hard cutover, no shim).
   */
  instructions?: string;
  created_at: string;
}

// --- Stored Event ---

export interface StoredEvent {
  seq: number;
  type: string;
  data: string; // JSON-serialized SessionEvent
  ts: string;
}
