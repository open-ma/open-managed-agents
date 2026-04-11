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
  mcp_servers?: Array<{ name: string; type: string; url: string }>;
  skills?: Array<{ skill_id: string; type: string; version?: string }>;
  callable_agents?: Array<{ type: "agent"; id: string; version?: number }>;
  harness?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at?: string;
  archived_at?: string;
}

// --- Environment ---

export interface EnvironmentConfig {
  id: string;
  name: string;
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
  };
  status?: "building" | "ready" | "error";
  sandbox_worker_name?: string;
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
}

export interface AgentThinkingEvent extends EventBase {
  type: "agent.thinking";
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
  content: string;
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

export interface SpanModelRequestEndEvent extends EventBase {
  type: "span.model_request_end";
  model?: string;
  model_usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
  };
}

export interface SpanOutcomeEvaluationStartEvent extends EventBase {
  type: "span.outcome_evaluation_start";
  iteration: number;
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

export type SessionEvent =
  | UserMessageEvent
  | UserInterruptEvent
  | UserToolConfirmationEvent
  | UserCustomToolResultEvent
  | UserDefineOutcomeEvent
  | AgentMessageEvent
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
  | SessionOutcomeEvaluatedEvent
  | SessionThreadCreatedEvent
  | SessionThreadIdleEvent
  | SpanModelRequestStartEvent
  | SpanModelRequestEndEvent
  | SpanOutcomeEvaluationStartEvent
  | SpanOutcomeEvaluationOngoingEvent
  | SpanOutcomeEvaluationEndEvent;

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
  // static_bearer fields
  token?: string;
  // command_secret: inject env var only for matching command prefixes
  command_prefixes?: string[];    // e.g. ["wrangler", "npx wrangler"]
  env_var?: string;               // e.g. "CLOUDFLARE_API_TOKEN"
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
  type: "file" | "memory_store" | "github_repository" | "github_repo";
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
  prompt?: string;
  created_at: string;
}

// --- Stored Event ---

export interface StoredEvent {
  seq: number;
  type: string;
  data: string; // JSON-serialized SessionEvent
  ts: string;
}
