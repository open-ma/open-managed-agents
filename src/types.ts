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
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
  archived_at?: string;
}

// --- Session ---

export type SessionStatus = "idle" | "running" | "rescheduling" | "terminated" | "processing" | "error";

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

export type ContentBlock = TextBlock;

// --- Session Events ---

export interface UserMessageEvent {
  type: "user.message";
  content: ContentBlock[];
}

export interface UserInterruptEvent {
  type: "user.interrupt";
}

export interface UserToolConfirmationEvent {
  type: "user.tool_confirmation";
  tool_use_id: string;
  result: "allow" | "deny";
  deny_message?: string;
}

export interface UserCustomToolResultEvent {
  type: "user.custom_tool_result";
  custom_tool_use_id: string;
  content: ContentBlock[];
  is_error?: boolean;
}

export interface AgentMessageEvent {
  type: "agent.message";
  content: ContentBlock[];
}

export interface AgentThinkingEvent {
  type: "agent.thinking";
}

export interface AgentCustomToolUseEvent {
  type: "agent.custom_tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentToolUseEvent {
  type: "agent.tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  evaluated_permission?: "allow" | "ask";
}

export interface AgentToolResultEvent {
  type: "agent.tool_result";
  tool_use_id: string;
  content: string;
}

export interface SessionRunningEvent {
  type: "session.status_running";
}

export interface SessionTerminatedEvent {
  type: "session.status_terminated";
  reason?: string;
}

export interface SessionStatusEvent {
  type: "session.status_idle";
  stop_reason?: {
    type: "user.message_required" | "tool_confirmation_required" | "custom_tool_result_required";
    event_ids?: string[];
  };
}

export interface AgentMcpToolUseEvent {
  type: "agent.mcp_tool_use";
  id: string;
  mcp_server_name: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentMcpToolResultEvent {
  type: "agent.mcp_tool_result";
  mcp_tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface UserDefineOutcomeEvent {
  type: "user.define_outcome";
  outcome: {
    description: string;
    criteria?: string[];
    max_iterations?: number; // default 3, max 20
  };
}

export interface OutcomeEvaluationEvent {
  type: "outcome.evaluation_end";
  result: "satisfied" | "needs_revision" | "max_iterations_reached" | "failed";
  iteration: number;
  feedback?: string;
}

export interface SessionErrorEvent {
  type: "session.error";
  error: string;
}

export interface SessionThreadCreatedEvent {
  type: "session.thread_created";
  thread_id: string;
  agent_id: string;
  agent_name: string;
}

export interface AgentThreadMessageEvent {
  type: "agent.thread_message";
  thread_id: string;
  content: ContentBlock[];
}

// Agent thread events (multi-agent)
export interface AgentThreadMessageSentEvent {
  type: "agent.thread_message_sent";
  thread_id: string;
  content: ContentBlock[];
}

export interface AgentThreadMessageReceivedEvent {
  type: "agent.thread_message_received";
  thread_id: string;
  content: ContentBlock[];
}

export interface AgentThreadContextCompactedEvent {
  type: "agent.thread_context_compacted";
  original_message_count: number;
  compacted_message_count: number;
}

// Session events
export interface SessionRescheduledEvent {
  type: "session.status_rescheduled";
  reason?: string;
}

export interface SessionOutcomeEvaluatedEvent {
  type: "session.outcome_evaluated";
  result: "satisfied" | "needs_revision" | "max_iterations_reached" | "failed";
  iteration: number;
  feedback?: string;
}

export interface SessionThreadIdleEvent {
  type: "session.thread_idle";
  thread_id: string;
}

// Span events (observability)
export interface SpanModelRequestStartEvent {
  type: "span.model_request_start";
  model?: string;
}

export interface SpanModelRequestEndEvent {
  type: "span.model_request_end";
  model?: string;
  model_usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
  };
}

export interface SpanOutcomeEvaluationStartEvent {
  type: "span.outcome_evaluation_start";
  iteration: number;
}

export interface SpanOutcomeEvaluationOngoingEvent {
  type: "span.outcome_evaluation_ongoing";
  iteration: number;
}

export interface SpanOutcomeEvaluationEndEvent {
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
  type: "mcp_oauth" | "static_bearer";
  mcp_server_url: string;
  // mcp_oauth fields
  access_token?: string;
  refresh_token?: string;
  token_endpoint?: string;
  client_id?: string;
  client_secret?: string;
  // static_bearer fields
  token?: string;
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
  filename: string;
  media_type: string;
  size_bytes: number;
  scope_id?: string;
  created_at: string;
}

// --- Session Resource ---

export interface SessionResource {
  id: string;
  session_id: string;
  type: "file" | "memory_store" | "github_repository";
  file_id?: string;
  memory_store_id?: string;
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
