// Wire types — kept self-contained so npm consumers don't need to
// pull the workspace api-types package. The wire format is stable;
// drift between this file and packages/api-types/src/types.ts is a
// release-blocking bug. Audit-and-bump: when api-types adds a new
// SessionEvent member, mirror it here, bump the SDK minor, ship.

// ─── Content blocks ────────────────────────────────────────────────

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  source: {
    type: "base64" | "url" | "file";
    media_type?: string;
    data?: string;
    url?: string;
    file_id?: string;
  };
}

export interface DocumentBlock {
  type: "document";
  source: {
    type: "base64" | "url" | "file";
    media_type?: string;
    data?: string;
    url?: string;
    file_id?: string;
  };
}

export type ContentBlock = TextBlock | ImageBlock | DocumentBlock;

// ─── Session events ────────────────────────────────────────────────
//
// Every event the platform broadcasts. Discriminated by `type`. The
// chunk-level events (`agent.message_chunk`, `agent.thinking_chunk`,
// `agent.tool_use_input_chunk`) are LIVE-ONLY — broadcast over SSE
// but never persisted; correlate with the canonical event of the
// same id (message_id / thinking_id / tool_use_id).

interface EventBase {
  id?: string;
  processed_at?: string;
  session_thread_id?: string;
}

export interface UserMessageEvent extends EventBase {
  type: "user.message";
  content: ContentBlock[];
}

export interface UserInterruptEvent extends EventBase {
  type: "user.interrupt";
}

export interface UserCustomToolResultEvent extends EventBase {
  type: "user.custom_tool_result";
  id: string;
  content: string | ContentBlock[];
}

export interface AgentMessageEvent extends EventBase {
  type: "agent.message";
  content: ContentBlock[];
  message_id?: string;
}

export interface AgentMessageStreamStartEvent extends EventBase {
  type: "agent.message_stream_start";
  message_id: string;
}

export interface AgentMessageChunkEvent extends EventBase {
  type: "agent.message_chunk";
  message_id: string;
  delta: string;
}

export interface AgentMessageStreamEndEvent extends EventBase {
  type: "agent.message_stream_end";
  message_id: string;
  status: "completed" | "aborted" | "interrupted";
  error_text?: string;
}

export interface AgentThinkingEvent extends EventBase {
  type: "agent.thinking";
  text?: string;
  providerOptions?: Record<string, unknown>;
  thinking_id?: string;
}

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

export interface AgentToolUseEvent extends EventBase {
  type: "agent.tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentMcpToolUseEvent extends EventBase {
  type: "agent.mcp_tool_use";
  id: string;
  mcp_server_name: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentCustomToolUseEvent extends EventBase {
  type: "agent.custom_tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

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

export interface AgentToolResultEvent extends EventBase {
  type: "agent.tool_result";
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

export interface AgentMcpToolResultEvent extends EventBase {
  type: "agent.mcp_tool_result";
  mcp_tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

export interface SessionStatusRunningEvent extends EventBase {
  type: "session.status_running";
}

export interface SessionStatusIdleEvent extends EventBase {
  type: "session.status_idle";
  stop_reason?: { type: string };
}

export interface SessionErrorEvent extends EventBase {
  type: "session.error";
  error: string;
}

export interface SessionWarningEvent extends EventBase {
  type: "session.warning";
  source: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface SpanModelRequestStartEvent extends EventBase {
  type: "span.model_request_start";
  model: string;
}

export interface SpanModelRequestEndEvent extends EventBase {
  type: "span.model_request_end";
  model: string;
  model_usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  finish_reason?: string;
  final_text_length?: number;
}

/**
 * Discriminated union of every wire event. The chunk-level streaming
 * events are NOT persisted to the events log — only the canonical
 * agent.message / agent.thinking / agent.tool_use of the same id is.
 * Live SSE subscribers see both; replay clients see only canonical.
 *
 * Note: this union is closed for narrowing (no index-signature
 * fallback). The platform may add new event types between SDK
 * releases — handle that case at the call site with a default
 * branch and treat unknowns as `Record<string, unknown>`.
 */
export type SessionEvent =
  | UserMessageEvent
  | UserInterruptEvent
  | UserCustomToolResultEvent
  | AgentMessageEvent
  | AgentMessageStreamStartEvent
  | AgentMessageChunkEvent
  | AgentMessageStreamEndEvent
  | AgentThinkingEvent
  | AgentThinkingStreamStartEvent
  | AgentThinkingChunkEvent
  | AgentThinkingStreamEndEvent
  | AgentToolUseEvent
  | AgentMcpToolUseEvent
  | AgentCustomToolUseEvent
  | AgentToolUseInputStreamStartEvent
  | AgentToolUseInputChunkEvent
  | AgentToolUseInputStreamEndEvent
  | AgentToolResultEvent
  | AgentMcpToolResultEvent
  | SessionStatusRunningEvent
  | SessionStatusIdleEvent
  | SessionErrorEvent
  | SessionWarningEvent
  | SpanModelRequestStartEvent
  | SpanModelRequestEndEvent;

// ─── Resource shapes (minimal — extend per resource as needed) ────

export interface AgentSummary {
  id: string;
  name: string;
  model: { id: string; speed?: string };
  created_at: string;
  updated_at: string;
}

export interface AgentDetail extends AgentSummary {
  system: string;
  tools: unknown[];
  skills?: string[];
  mcp_servers?: unknown[];
  description?: string | null;
  metadata?: Record<string, unknown>;
}

export interface SessionSummary {
  id: string;
  agent_id: string;
  environment_id: string;
  title: string;
  status: "idle" | "running" | "error";
  created_at: string;
  updated_at?: string | null;
  archived_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface EnvironmentSummary {
  id: string;
  name: string;
  config: { type: string; [k: string]: unknown };
  status: string;
  created_at: string;
  updated_at?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  has_more?: boolean;
  next_page?: string | null;
}

export interface StoredEvent {
  seq: number;
  type: string;
  data: SessionEvent;
  ts: number;
}
