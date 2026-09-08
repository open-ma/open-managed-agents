import type { JsonObject } from "../json";
import type {
  MonetaryAmount,
  SessionAgent,
  SessionUsage,
} from "./session";

type SessionAgentView = SessionAgent;
type SessionUsageView = SessionUsage;
type SpendLimit = MonetaryAmount;

export interface TextContentBlock {
  type: "text";
  text: string;
}

export type ImageSource =
  | { type: "base64"; data: string; mediaType: string }
  | { type: "url"; url: string }
  | { type: "file"; fileId: string };

export interface ImageContentBlock {
  type: "image";
  source: ImageSource;
}

export type DocumentSource =
  | { type: "base64"; data: string; mediaType: string }
  | { type: "text"; data: string; mediaType: "text/plain" }
  | { type: "url"; url: string }
  | { type: "file"; fileId: string };

export interface DocumentContentBlock {
  type: "document";
  source: DocumentSource;
  context?: string | null;
  title?: string | null;
}

export interface RedactedContentBlock {
  type: "redacted";
}

export interface SearchResultContentBlock {
  type: "search_result";
  citations: { enabled: boolean };
  content: TextContentBlock[];
  source: string;
  title: string;
}

export type UserMessageContentBlock =
  | TextContentBlock
  | ImageContentBlock
  | DocumentContentBlock
  | RedactedContentBlock;

export type ToolResultContentBlock =
  | TextContentBlock
  | ImageContentBlock
  | DocumentContentBlock
  | SearchResultContentBlock;

export type OutcomeRubric =
  | { type: "text"; content: string }
  | { type: "file"; fileId: string };

export type SendableSessionEvent =
  | { type: "user.message"; content: UserMessageContentBlock[] }
  | { type: "user.interrupt"; sessionThreadId?: string | null }
  | {
      type: "user.tool_confirmation";
      result: "allow" | "deny";
      toolUseId: string;
      denyMessage?: string | null;
    }
  | {
      type: "user.custom_tool_result";
      customToolUseId: string;
      content?: ToolResultContentBlock[];
      isError?: boolean | null;
    }
  | {
      type: "user.define_outcome";
      description: string;
      rubric: OutcomeRubric;
      maxIterations?: number | null;
    }
  | {
      type: "user.tool_result";
      toolUseId: string;
      content?: ToolResultContentBlock[];
      isError?: boolean | null;
    }
  | { type: "system.message"; content: TextContentBlock[] };

interface SentEventBase {
  id: string;
  processedAt?: string | null;
}

export type SentSessionEvent =
  | (SentEventBase & {
      type: "user.message";
      content: UserMessageContentBlock[];
      sessionThreadId?: string | null;
    })
  | (SentEventBase & {
      type: "user.interrupt";
      sessionThreadId?: string | null;
    })
  | (SentEventBase & {
      type: "user.tool_confirmation";
      result: "allow" | "deny";
      toolUseId: string;
      denyMessage?: string | null;
      sessionThreadId?: string | null;
    })
  | (SentEventBase & {
      type: "user.custom_tool_result";
      customToolUseId: string;
      content?: ToolResultContentBlock[];
      isError?: boolean | null;
      sessionThreadId?: string | null;
    })
  | (SentEventBase & {
      type: "user.define_outcome";
      description: string;
      rubric: OutcomeRubric;
      maxIterations: number | null;
      outcomeId: string;
      processedAt: string;
    })
  | (SentEventBase & {
      type: "user.tool_result";
      toolUseId: string;
      content?: ToolResultContentBlock[];
      isError?: boolean | null;
      sessionThreadId?: string | null;
    })
  | (SentEventBase & {
      type: "system.message";
      content: TextContentBlock[];
    });

export interface SessionUsageEventView {
  id: string;
  type: "session.usage";
  processedAt: string;
  usage: SessionUsageView;
  budget?: SpendLimit | null;
}

export type AgentMessageContentBlock = TextContentBlock | RedactedContentBlock;

export type SessionStopReason =
  | { type: "end_turn" }
  | { type: "requires_action"; eventIds: string[] }
  | { type: "retries_exhausted" }
  | { type: "budget_reached" };

export type SessionEventRetryStatus = "retrying" | "exhausted" | "terminal";

interface SessionExecutionErrorBase {
  message: string;
  retryStatus: SessionEventRetryStatus;
}

export type SessionExecutionError =
  | (SessionExecutionErrorBase & { type: "unknown_error" })
  | (SessionExecutionErrorBase & { type: "model_overloaded_error" })
  | (SessionExecutionErrorBase & { type: "model_rate_limited_error" })
  | (SessionExecutionErrorBase & { type: "model_request_failed_error" })
  | (SessionExecutionErrorBase & {
      type: "mcp_connection_failed_error";
      mcpServerName: string;
    })
  | (SessionExecutionErrorBase & {
      type: "mcp_authentication_failed_error";
      mcpServerName: string;
    })
  | (SessionExecutionErrorBase & { type: "billing_error" })
  | (SessionExecutionErrorBase & {
      type: "credential_host_unreachable_error";
      credentialId: string;
      vaultId: string;
    });

export interface SpanModelUsageView {
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  speed?: "standard" | "fast" | null;
}

export type HistorySessionEvent =
  | {
      id: string;
      type: "agent.custom_tool_use";
      input: JsonObject;
      name: string;
      processedAt: string;
      sessionThreadId?: string | null;
    }
  | {
      id: string;
      type: "agent.mcp_tool_result";
      mcpToolUseId: string;
      processedAt: string;
      content?: ToolResultContentBlock[];
      isError?: boolean | null;
    }
  | {
      id: string;
      type: "agent.mcp_tool_use";
      input: JsonObject;
      mcpServerName: string;
      name: string;
      processedAt: string;
      evaluatedPermission?: "allow" | "ask" | "deny";
      sessionThreadId?: string | null;
    }
  | {
      id: string;
      type: "agent.message";
      content: AgentMessageContentBlock[];
      processedAt: string;
    }
  | { id: string; type: "agent.thinking"; processedAt: string }
  | {
      id: string;
      type: "agent.thread_context_compacted";
      processedAt: string;
    }
  | {
      id: string;
      type: "agent.thread_message_received";
      content: UserMessageContentBlock[];
      fromSessionThreadId: string;
      processedAt: string;
      fromAgentName?: string | null;
    }
  | {
      id: string;
      type: "agent.thread_message_sent";
      content: UserMessageContentBlock[];
      processedAt: string;
      toSessionThreadId: string;
      toAgentName?: string | null;
    }
  | {
      id: string;
      type: "agent.tool_result";
      processedAt: string;
      toolUseId: string;
      content?: ToolResultContentBlock[];
      isError?: boolean | null;
    }
  | {
      id: string;
      type: "agent.tool_use";
      input: JsonObject;
      name: string;
      processedAt: string;
      evaluatedPermission?: "allow" | "ask" | "deny";
      sessionThreadId?: string | null;
    }
  | {
      id: string;
      type: "session.error";
      error: SessionExecutionError;
      processedAt: string;
    }
  | {
      id: string;
      type: "session.status_idle";
      processedAt: string;
      stopReason: SessionStopReason;
    }
  | { id: string; type: "session.status_rescheduled"; processedAt: string }
  | { id: string; type: "session.status_running"; processedAt: string }
  | { id: string; type: "session.status_terminated"; processedAt: string }
  | {
      id: string;
      type: "session.thread_created";
      agentName: string;
      processedAt: string;
      sessionThreadId: string;
    }
  | {
      id: string;
      type: "session.thread_status_idle";
      agentName: string;
      processedAt: string;
      sessionThreadId: string;
      stopReason: SessionStopReason;
    }
  | {
      id: string;
      type: "session.thread_status_rescheduled";
      agentName: string;
      processedAt: string;
      sessionThreadId: string;
    }
  | {
      id: string;
      type: "session.thread_status_running";
      agentName: string;
      processedAt: string;
      sessionThreadId: string;
    }
  | {
      id: string;
      type: "session.thread_status_terminated";
      agentName: string;
      processedAt: string;
      sessionThreadId: string;
    }
  | { id: string; type: "span.model_request_start"; processedAt: string }
  | {
      id: string;
      type: "span.model_request_end";
      isError: boolean | null;
      modelRequestStartId: string;
      modelUsage: SpanModelUsageView;
      processedAt: string;
    }
  | {
      id: string;
      type: "span.outcome_evaluation_start";
      iteration: number;
      outcomeId: string;
      processedAt: string;
    }
  | {
      id: string;
      type: "span.outcome_evaluation_ongoing";
      iteration: number;
      outcomeId: string;
      processedAt: string;
    }
  | {
      id: string;
      type: "span.outcome_evaluation_end";
      explanation: string;
      iteration: number;
      outcomeEvaluationStartId: string;
      outcomeId: string;
      processedAt: string;
      result: string;
      usage: SpanModelUsageView;
    }
  | { id: string; type: "session.deleted"; processedAt: string }
  | {
      id: string;
      type: "session.updated";
      processedAt: string;
      agent?: SessionAgentView | null;
      budget?: SpendLimit | null;
      metadata?: Record<string, string>;
      title?: string | null;
    };

export type SessionEventView =
  | SentSessionEvent
  | SessionUsageEventView
  | HistorySessionEvent;

export type SessionEventDeltaType = "agent.message" | "agent.thinking";

export type StreamSessionEvent =
  | SessionEventView
  | {
      type: "event_start";
      event: { id: string; type: SessionEventDeltaType };
    }
  | {
      type: "event_delta";
      eventId: string;
      delta: {
        type: "content_delta";
        content: TextContentBlock;
        index?: number;
      };
    };
