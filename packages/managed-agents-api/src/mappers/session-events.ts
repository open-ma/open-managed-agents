import type {
  SessionEventListQuery,
  SessionEventSendBody,
  SessionEventStreamQuery,
} from "../contracts/session-events";
import type {
  DocumentContentBlock,
  DocumentSource,
  ImageContentBlock,
  ImageSource,
  ListSessionEventsQuery,
  OutcomeRubric,
  SearchResultContentBlock,
  SendableSessionEvent,
  SendSessionEventsCommand,
  SessionExecutionError,
  SessionEventView,
  SessionStopReason,
  SpanModelUsageView,
  StreamSessionEvent,
  StreamSessionEventsQuery,
  SentSessionEvent,
  TextContentBlock,
  ToolResultContentBlock,
  UserMessageContentBlock,
} from "../ports/session-events";
import type { MonetaryAmount, SessionUsageView } from "../ports/sessions";
import { toSessionAgentResponse } from "./sessions";

type WireSendableEvent = SessionEventSendBody["events"][number];
type WireUserMessage = Extract<WireSendableEvent, { type: "user.message" }>;
type WireUserMessageContent = WireUserMessage["content"][number];
type WireToolResult = Extract<WireSendableEvent, { type: "user.tool_result" }>;
type WireToolResultContent = NonNullable<WireToolResult["content"]>[number];
type WireRubric = Extract<
  WireSendableEvent,
  { type: "user.define_outcome" }
>["rubric"];

function toImageSource(source: Extract<WireUserMessageContent, { type: "image" }>["source"]): ImageSource {
  switch (source.type) {
    case "base64":
      return { type: "base64", data: source.data, mediaType: source.media_type };
    case "url":
      return { type: "url", url: source.url };
    case "file":
      return { type: "file", fileId: source.file_id };
  }
}

function toDocumentSource(
  source: Extract<WireUserMessageContent, { type: "document" }>["source"],
): DocumentSource {
  switch (source.type) {
    case "base64":
      return { type: "base64", data: source.data, mediaType: source.media_type };
    case "text":
      return { type: "text", data: source.data, mediaType: source.media_type };
    case "url":
      return { type: "url", url: source.url };
    case "file":
      return { type: "file", fileId: source.file_id };
  }
}

function toUserMessageContent(block: WireUserMessageContent): UserMessageContentBlock {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return { type: "image", source: toImageSource(block.source) };
    case "document":
      return {
        type: "document",
        source: toDocumentSource(block.source),
        ...(block.context !== undefined && { context: block.context }),
        ...(block.title !== undefined && { title: block.title }),
      };
    case "redacted":
      return { type: "redacted" };
  }
}

function toToolResultContent(block: WireToolResultContent): ToolResultContentBlock {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return { type: "image", source: toImageSource(block.source) };
    case "document":
      return {
        type: "document",
        source: toDocumentSource(block.source),
        ...(block.context !== undefined && { context: block.context }),
        ...(block.title !== undefined && { title: block.title }),
      };
    case "search_result":
      return {
        type: "search_result",
        citations: { enabled: block.citations.enabled },
        content: block.content.map((content) => ({
          type: "text",
          text: content.text,
        })),
        source: block.source,
        title: block.title,
      };
  }
}

function toRubric(rubric: WireRubric): OutcomeRubric {
  return rubric.type === "file"
    ? { type: "file", fileId: rubric.file_id }
    : { type: "text", content: rubric.content };
}

export function toSendableSessionEvent(event: WireSendableEvent): SendableSessionEvent {
  switch (event.type) {
    case "user.message":
      return { type: event.type, content: event.content.map(toUserMessageContent) };
    case "user.interrupt":
      return {
        type: event.type,
        ...(event.session_thread_id !== undefined && {
          sessionThreadId: event.session_thread_id,
        }),
      };
    case "user.tool_confirmation":
      return {
        type: event.type,
        result: event.result,
        toolUseId: event.tool_use_id,
        ...(event.deny_message !== undefined && { denyMessage: event.deny_message }),
      };
    case "user.custom_tool_result":
      return {
        type: event.type,
        customToolUseId: event.custom_tool_use_id,
        ...(event.content !== undefined && {
          content: event.content.map(toToolResultContent),
        }),
        ...(event.is_error !== undefined && { isError: event.is_error }),
      };
    case "user.define_outcome":
      return {
        type: event.type,
        description: event.description,
        rubric: toRubric(event.rubric),
        ...(event.max_iterations !== undefined && {
          maxIterations: event.max_iterations,
        }),
      };
    case "user.tool_result":
      return {
        type: event.type,
        toolUseId: event.tool_use_id,
        ...(event.content !== undefined && {
          content: event.content.map(toToolResultContent),
        }),
        ...(event.is_error !== undefined && { isError: event.is_error }),
      };
    case "system.message":
      return {
        type: event.type,
        content: event.content.map((block) => ({
          type: "text",
          text: block.text,
        })),
      };
  }
}

export function toSendSessionEventsCommand(
  sessionId: string,
  body: SessionEventSendBody,
): SendSessionEventsCommand {
  return {
    sessionId,
    events: body.events.map(toSendableSessionEvent),
  };
}

export function toListSessionEventsQuery(
  sessionId: string,
  query: SessionEventListQuery,
): ListSessionEventsQuery {
  return {
    sessionId,
    ...(query.limit !== undefined && { pageSize: query.limit }),
    ...(query.page != null && { cursor: query.page }),
    ...(query["created_at[gt]"] !== undefined && {
      createdAfter: query["created_at[gt]"],
    }),
    ...(query["created_at[gte]"] !== undefined && {
      createdAtOrAfter: query["created_at[gte]"],
    }),
    ...(query["created_at[lt]"] !== undefined && {
      createdBefore: query["created_at[lt]"],
    }),
    ...(query["created_at[lte]"] !== undefined && {
      createdAtOrBefore: query["created_at[lte]"],
    }),
    ...(query.order !== undefined && { order: query.order }),
    ...(query.types !== undefined && { types: query.types }),
  };
}

export function toStreamSessionEventsQuery(
  sessionId: string,
  query: SessionEventStreamQuery,
): StreamSessionEventsQuery {
  return {
    sessionId,
    ...(query.event_deltas !== undefined && {
      deltaEventTypes: query.event_deltas,
    }),
  };
}

function fromImageSource(source: ImageSource): object {
  switch (source.type) {
    case "base64":
      return { type: source.type, data: source.data, media_type: source.mediaType };
    case "url":
      return { type: source.type, url: source.url };
    case "file":
      return { type: source.type, file_id: source.fileId };
  }
}

function fromDocumentSource(source: DocumentSource): object {
  switch (source.type) {
    case "base64":
      return { type: source.type, data: source.data, media_type: source.mediaType };
    case "text":
      return { type: source.type, data: source.data, media_type: source.mediaType };
    case "url":
      return { type: source.type, url: source.url };
    case "file":
      return { type: source.type, file_id: source.fileId };
  }
}

export function fromUserMessageContent(block: UserMessageContentBlock): object {
  switch (block.type) {
    case "text":
      return { type: block.type, text: block.text };
    case "image":
      return { type: block.type, source: fromImageSource(block.source) };
    case "document":
      return {
        type: block.type,
        source: fromDocumentSource(block.source),
        ...(block.context !== undefined && { context: block.context }),
        ...(block.title !== undefined && { title: block.title }),
      };
    case "redacted":
      return { type: block.type };
  }
}

function fromToolResultContent(block: ToolResultContentBlock): object {
  if (block.type !== "search_result") return fromUserMessageContent(block);
  return {
    type: block.type,
    citations: { enabled: block.citations.enabled },
    content: block.content.map((content) => ({
      type: "text",
      text: content.text,
    })),
    source: block.source,
    title: block.title,
  };
}

export function fromRubric(rubric: OutcomeRubric): object {
  return rubric.type === "file"
    ? { type: rubric.type, file_id: rubric.fileId }
    : { type: rubric.type, content: rubric.content };
}

function sentEventBase(event: SentSessionEvent): object {
  return {
    id: event.id,
    ...(event.processedAt !== undefined && { processed_at: event.processedAt }),
  };
}

export function toSentSessionEventResponse(event: SentSessionEvent): object {
  const base = sentEventBase(event);
  switch (event.type) {
    case "user.message":
      return {
        ...base,
        type: event.type,
        content: event.content.map(fromUserMessageContent),
      };
    case "user.interrupt":
      return {
        ...base,
        type: event.type,
        ...(event.sessionThreadId !== undefined && {
          session_thread_id: event.sessionThreadId,
        }),
      };
    case "user.tool_confirmation":
      return {
        ...base,
        type: event.type,
        result: event.result,
        tool_use_id: event.toolUseId,
        ...(event.denyMessage !== undefined && { deny_message: event.denyMessage }),
        ...(event.sessionThreadId !== undefined && {
          session_thread_id: event.sessionThreadId,
        }),
      };
    case "user.custom_tool_result":
      return {
        ...base,
        type: event.type,
        custom_tool_use_id: event.customToolUseId,
        ...(event.content !== undefined && {
          content: event.content.map(fromToolResultContent),
        }),
        ...(event.isError !== undefined && { is_error: event.isError }),
        ...(event.sessionThreadId !== undefined && {
          session_thread_id: event.sessionThreadId,
        }),
      };
    case "user.define_outcome":
      return {
        id: event.id,
        type: event.type,
        description: event.description,
        rubric: fromRubric(event.rubric),
        max_iterations: event.maxIterations,
        outcome_id: event.outcomeId,
        processed_at: event.processedAt,
      };
    case "user.tool_result":
      return {
        ...base,
        type: event.type,
        tool_use_id: event.toolUseId,
        ...(event.content !== undefined && {
          content: event.content.map(fromToolResultContent),
        }),
        ...(event.isError !== undefined && { is_error: event.isError }),
        ...(event.sessionThreadId !== undefined && {
          session_thread_id: event.sessionThreadId,
        }),
      };
    case "system.message":
      return {
        ...base,
        type: event.type,
        content: event.content.map((block: TextContentBlock) => ({
          type: "text",
          text: block.text,
        })),
      };
  }
}

function fromMonetaryAmount(amount: MonetaryAmount): object {
  return { amount: amount.amountMinor, currency: amount.currency };
}

function fromSessionUsage(usage: SessionUsageView): object {
  return {
    ...(usage.activeSeconds !== undefined && {
      active_seconds: usage.activeSeconds,
    }),
    ...(usage.cacheCreation !== undefined && {
      cache_creation: {
        ...(usage.cacheCreation.ephemeralOneHourInputTokens !== undefined && {
          ephemeral_1h_input_tokens:
            usage.cacheCreation.ephemeralOneHourInputTokens,
        }),
        ...(usage.cacheCreation.ephemeralFiveMinuteInputTokens !== undefined && {
          ephemeral_5m_input_tokens:
            usage.cacheCreation.ephemeralFiveMinuteInputTokens,
        }),
      },
    }),
    ...(usage.cacheReadInputTokens !== undefined && {
      cache_read_input_tokens: usage.cacheReadInputTokens,
    }),
    ...(usage.inputTokens !== undefined && {
      input_tokens: usage.inputTokens,
    }),
    ...(usage.listCost != null && {
      list_cost: fromMonetaryAmount(usage.listCost),
    }),
    ...(usage.outputTokens !== undefined && {
      output_tokens: usage.outputTokens,
    }),
    ...(usage.serverToolUse != null && {
      server_tool_use: {
        ...(usage.serverToolUse.webFetchRequests !== undefined && {
          web_fetch_requests: usage.serverToolUse.webFetchRequests,
        }),
        ...(usage.serverToolUse.webSearchRequests !== undefined && {
          web_search_requests: usage.serverToolUse.webSearchRequests,
        }),
      },
    }),
  };
}

function fromSessionStopReason(reason: SessionStopReason): object {
  return reason.type === "requires_action"
    ? { type: reason.type, event_ids: reason.eventIds }
    : { type: reason.type };
}

function fromSessionExecutionError(error: SessionExecutionError): object {
  const base = {
    type: error.type,
    message: error.message,
    retry_status: { type: error.retryStatus },
  };
  switch (error.type) {
    case "mcp_connection_failed_error":
    case "mcp_authentication_failed_error":
      return { ...base, mcp_server_name: error.mcpServerName };
    case "credential_host_unreachable_error":
      return {
        ...base,
        credential_id: error.credentialId,
        vault_id: error.vaultId,
      };
    default:
      return base;
  }
}

function fromSpanModelUsage(usage: SpanModelUsageView): object {
  return {
    cache_creation_input_tokens: usage.cacheCreationInputTokens,
    cache_read_input_tokens: usage.cacheReadInputTokens,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    ...(usage.speed !== undefined && { speed: usage.speed }),
  };
}

export function toSessionEventResponse(event: SessionEventView): object {
  switch (event.type) {
    case "user.message":
    case "user.interrupt":
    case "user.tool_confirmation":
    case "user.custom_tool_result":
    case "user.define_outcome":
    case "user.tool_result":
    case "system.message":
      return toSentSessionEventResponse(event);
    case "session.usage":
      return {
        id: event.id,
        processed_at: event.processedAt,
        type: event.type,
        usage: fromSessionUsage(event.usage),
        ...(event.budget !== undefined && {
          budget:
            event.budget === null
              ? null
              : {
                  max_list_cost: fromMonetaryAmount(event.budget),
                  type: "limit",
                },
        }),
      };
    case "agent.custom_tool_use":
      return {
        id: event.id,
        type: event.type,
        input: event.input,
        name: event.name,
        processed_at: event.processedAt,
        ...(event.sessionThreadId !== undefined && {
          session_thread_id: event.sessionThreadId,
        }),
      };
    case "agent.mcp_tool_result":
      return {
        ...(event.sessionThreadId !== undefined && { session_thread_id: event.sessionThreadId }),
        id: event.id,
        type: event.type,
        mcp_tool_use_id: event.mcpToolUseId,
        processed_at: event.processedAt,
        ...(event.content !== undefined && {
          content: event.content.map(fromToolResultContent),
        }),
        ...(event.isError !== undefined && { is_error: event.isError }),
      };
    case "agent.mcp_tool_use":
      return {
        id: event.id,
        type: event.type,
        input: event.input,
        mcp_server_name: event.mcpServerName,
        name: event.name,
        processed_at: event.processedAt,
        ...(event.evaluatedPermission !== undefined && {
          evaluated_permission: event.evaluatedPermission,
        }),
        ...(event.sessionThreadId !== undefined && {
          session_thread_id: event.sessionThreadId,
        }),
      };
    case "agent.message":
      return {
        ...(event.sessionThreadId !== undefined && { session_thread_id: event.sessionThreadId }),
        id: event.id,
        type: event.type,
        content: event.content.map(fromUserMessageContent),
        processed_at: event.processedAt,
      };
    case "agent.thinking":
    case "span.model_request_start":
      return {
        id: event.id,
        type: event.type,
        processed_at: event.processedAt,
        ...(event.sessionThreadId !== undefined && { session_thread_id: event.sessionThreadId }),
      };
    case "agent.thread_context_compacted":
    case "session.status_rescheduled":
    case "session.status_running":
    case "session.status_terminated":
    case "session.deleted":
      return {
        id: event.id,
        type: event.type,
        processed_at: event.processedAt,
      };
    case "agent.thread_message_received":
      return {
        ...(event.fromMessageId !== undefined && { from_message_id: event.fromMessageId }),
        ...(event.sessionThreadId !== undefined && { session_thread_id: event.sessionThreadId }),
        id: event.id,
        type: event.type,
        content: event.content.map(fromUserMessageContent),
        from_session_thread_id: event.fromSessionThreadId,
        processed_at: event.processedAt,
        ...(event.fromAgentName !== undefined && {
          from_agent_name: event.fromAgentName,
        }),
      };
    case "agent.thread_message_sent":
      return {
        ...(event.sessionThreadId !== undefined && { session_thread_id: event.sessionThreadId }),
        id: event.id,
        type: event.type,
        content: event.content.map(fromUserMessageContent),
        processed_at: event.processedAt,
        to_session_thread_id: event.toSessionThreadId,
        ...(event.toAgentName !== undefined && {
          to_agent_name: event.toAgentName,
        }),
      };
    case "agent.tool_result":
      return {
        ...(event.sessionThreadId !== undefined && { session_thread_id: event.sessionThreadId }),
        id: event.id,
        type: event.type,
        processed_at: event.processedAt,
        tool_use_id: event.toolUseId,
        ...(event.content !== undefined && {
          content: event.content.map(fromToolResultContent),
        }),
        ...(event.isError !== undefined && { is_error: event.isError }),
      };
    case "agent.tool_use":
      return {
        id: event.id,
        type: event.type,
        input: event.input,
        name: event.name,
        processed_at: event.processedAt,
        ...(event.evaluatedPermission !== undefined && {
          evaluated_permission: event.evaluatedPermission,
        }),
        ...(event.sessionThreadId !== undefined && {
          session_thread_id: event.sessionThreadId,
        }),
      };
    case "session.error":
      return {
        ...(event.sessionThreadId !== undefined && { session_thread_id: event.sessionThreadId }),
        id: event.id,
        type: event.type,
        error: fromSessionExecutionError(event.error),
        processed_at: event.processedAt,
      };
    case "session.status_idle":
      return {
        id: event.id,
        type: event.type,
        processed_at: event.processedAt,
        stop_reason: fromSessionStopReason(event.stopReason),
      };
    case "session.thread_created":
      return {
        ...(event.content !== undefined && { content: event.content }),
        ...(event.parentThreadId !== undefined && { parent_thread_id: event.parentThreadId }),
        ...(event.parentToolUseId !== undefined && { parent_tool_use_id: event.parentToolUseId }),
        id: event.id,
        type: event.type,
        agent_name: event.agentName,
        processed_at: event.processedAt,
        session_thread_id: event.sessionThreadId,
      };
    case "session.thread_status_idle":
      return {
        ...(event.interrupted !== undefined && { interrupted: event.interrupted }),
        id: event.id,
        type: event.type,
        agent_name: event.agentName,
        processed_at: event.processedAt,
        session_thread_id: event.sessionThreadId,
        stop_reason: fromSessionStopReason(event.stopReason),
      };
    case "session.thread_status_rescheduled":
    case "session.thread_status_running":
    case "session.thread_status_terminated":
      return {
        id: event.id,
        type: event.type,
        agent_name: event.agentName,
        processed_at: event.processedAt,
        session_thread_id: event.sessionThreadId,
      };
    case "span.model_request_end":
      return {
        ...(event.sessionThreadId !== undefined && { session_thread_id: event.sessionThreadId }),
        id: event.id,
        type: event.type,
        is_error: event.isError,
        model_request_start_id: event.modelRequestStartId,
        model_usage: fromSpanModelUsage(event.modelUsage),
        processed_at: event.processedAt,
      };
    case "span.outcome_evaluation_start":
    case "span.outcome_evaluation_ongoing":
      return {
        id: event.id,
        type: event.type,
        iteration: event.iteration,
        outcome_id: event.outcomeId,
        processed_at: event.processedAt,
      };
    case "span.outcome_evaluation_end":
      return {
        id: event.id,
        type: event.type,
        explanation: event.explanation,
        iteration: event.iteration,
        outcome_evaluation_start_id: event.outcomeEvaluationStartId,
        outcome_id: event.outcomeId,
        processed_at: event.processedAt,
        result: event.result,
        usage: fromSpanModelUsage(event.usage),
      };
    case "session.updated":
      return {
        id: event.id,
        type: event.type,
        processed_at: event.processedAt,
        ...(event.agent !== undefined && {
          agent:
            event.agent === null ? null : toSessionAgentResponse(event.agent),
        }),
        ...(event.budget !== undefined && {
          budget:
            event.budget === null
              ? null
              : {
                  type: "limit",
                  max_list_cost: fromMonetaryAmount(event.budget),
                },
        }),
        ...(event.metadata !== undefined && { metadata: event.metadata }),
        ...(event.title !== undefined && { title: event.title }),
      };
  }
}

export function toStreamSessionEventResponse(event: StreamSessionEvent): object {
  switch (event.type) {
    case "event_start":
      return {
        type: event.type,
        event: { id: event.event.id, type: event.event.type },
      };
    case "event_delta":
      return {
        type: event.type,
        event_id: event.eventId,
        delta: {
          type: event.delta.type,
          content: {
            type: event.delta.content.type,
            text: event.delta.content.text,
          },
          ...(event.delta.index !== undefined && { index: event.delta.index }),
        },
      };
    default:
      return toSessionEventResponse(event);
  }
}
