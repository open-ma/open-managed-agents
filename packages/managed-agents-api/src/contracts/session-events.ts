import type {
  BetaManagedAgentsSessionEvent,
  BetaManagedAgentsSessionEventsPageCursor,
  BetaManagedAgentsSendSessionEvents,
  BetaManagedAgentsStreamSessionEvents,
  EventListParams,
  EventSendParams,
  EventStreamParams,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";
import { z } from "zod";
import {
  budgetSchema,
  monetaryAmountSchema,
  sessionAgentResponseSchema,
} from "./sessions";
import {
  redactedBlockSchema,
  rubricSchema,
  sendableEventSchema,
  textBlockSchema,
  toolResultContentSchema,
  userMessageContentSchema,
} from "./session-event-inputs";
export {
  rubricSchema,
  textBlockSchema,
  userMessageContentSchema,
} from "./session-event-inputs";

export type SessionEventSendBody = Omit<EventSendParams, "betas">;
export type SessionEventListQuery = Omit<EventListParams, "betas">;
export type SessionEventStreamQuery = Omit<EventStreamParams, "betas">;
export type SessionEventListResponse = Pick<
  BetaManagedAgentsSessionEventsPageCursor,
  "data" | "next_page"
>;
type SentWireEvent = NonNullable<BetaManagedAgentsSendSessionEvents["data"]>[number];
type ListedWireEvent = BetaManagedAgentsSessionEvent;

export const sessionEventListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).optional(),
    page: z.string().min(1).optional(),
    "created_at[gt]": z.string().min(1).optional(),
    "created_at[gte]": z.string().min(1).optional(),
    "created_at[lt]": z.string().min(1).optional(),
    "created_at[lte]": z.string().min(1).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    types: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const sessionEventStreamQuerySchema: z.ZodType<SessionEventStreamQuery> = z
  .object({
    event_deltas: z.array(z.enum(["agent.message", "agent.thinking"])).optional(),
  })
  .strict();

export const sessionEventSendBodySchema: z.ZodType<SessionEventSendBody> = z
  .object({ events: z.array(sendableEventSchema).min(1) })
  .strict()
  .superRefine(({ events }, context) => {
    for (const [index, event] of events.entries()) {
      if (
        event.type === "user.tool_confirmation" &&
        event.result === "allow" &&
        event.deny_message !== undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "deny_message is only allowed when result is deny",
          path: ["events", index, "deny_message"],
        });
      }
    }

    const systemMessageIndexes = events.flatMap((event, index) =>
      event.type === "system.message" ? [index] : [],
    );
    if (systemMessageIndexes.length > 1) {
      context.addIssue({
        code: "custom",
        message: "At most one system.message event is allowed per request",
        path: ["events", systemMessageIndexes[1]],
      });
    }
    const systemMessageIndex = systemMessageIndexes[0];
    if (systemMessageIndex === undefined) return;
    if (systemMessageIndex !== events.length - 1) {
      context.addIssue({
        code: "custom",
        message: "system.message must be the final event in the request",
        path: ["events", systemMessageIndex],
      });
    }
    const precedingType = events[systemMessageIndex - 1]?.type;
    if (
      precedingType !== "user.message" &&
      precedingType !== "user.tool_result" &&
      precedingType !== "user.custom_tool_result"
    ) {
      context.addIssue({
        code: "custom",
        message:
          "system.message must immediately follow user.message, user.tool_result, or user.custom_tool_result",
        path: ["events", systemMessageIndex],
      });
    }
  });

const sentEventBase = {
  id: z.string().min(1),
  processed_at: z.string().nullable().optional(),
};

export const sentEventSchema: z.ZodType<SentWireEvent> = z.discriminatedUnion("type", [
  z
    .object({
      ...sentEventBase,
      type: z.literal("user.message"),
      content: z.array(userMessageContentSchema),
    })
    .strict(),
  z
    .object({
      ...sentEventBase,
      type: z.literal("user.interrupt"),
      session_thread_id: z.string().nullable().optional(),
    })
    .strict(),
  z
    .object({
      ...sentEventBase,
      type: z.literal("user.tool_confirmation"),
      result: z.enum(["allow", "deny"]),
      tool_use_id: z.string().min(1),
      deny_message: z.string().nullable().optional(),
      session_thread_id: z.string().nullable().optional(),
    })
    .strict(),
  z
    .object({
      ...sentEventBase,
      type: z.literal("user.custom_tool_result"),
      custom_tool_use_id: z.string().min(1),
      content: z.array(toolResultContentSchema).optional(),
      is_error: z.boolean().nullable().optional(),
      session_thread_id: z.string().nullable().optional(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      type: z.literal("user.define_outcome"),
      description: z.string(),
      rubric: rubricSchema,
      max_iterations: z.number().int().nullable(),
      outcome_id: z.string().min(1),
      processed_at: z.string(),
    })
    .strict(),
  z
    .object({
      ...sentEventBase,
      type: z.literal("user.tool_result"),
      tool_use_id: z.string().min(1),
      content: z.array(toolResultContentSchema).optional(),
      is_error: z.boolean().nullable().optional(),
      session_thread_id: z.string().nullable().optional(),
    })
    .strict(),
  z
    .object({
      ...sentEventBase,
      type: z.literal("system.message"),
      content: z.array(textBlockSchema),
    })
    .strict(),
]);

export const sessionEventSendResponseSchema: z.ZodType<BetaManagedAgentsSendSessionEvents> =
  z
    .object({
      data: z.array(sentEventSchema).optional(),
    })
    .strict();

const sessionUsageSnapshotSchema = z
  .object({
    active_seconds: z.number().optional(),
    cache_creation: z
      .object({
        ephemeral_1h_input_tokens: z.number().int().optional(),
        ephemeral_5m_input_tokens: z.number().int().optional(),
      })
      .strict()
      .optional(),
    cache_read_input_tokens: z.number().int().optional(),
    input_tokens: z.number().int().optional(),
    list_cost: monetaryAmountSchema.optional(),
    output_tokens: z.number().int().optional(),
    server_tool_use: z
      .object({
        web_fetch_requests: z.number().int().optional(),
        web_search_requests: z.number().int().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const sessionUsageEventSchema = z
  .object({
    id: z.string().min(1),
    processed_at: z.string(),
    type: z.literal("session.usage"),
    usage: sessionUsageSnapshotSchema,
    budget: budgetSchema.nullable().optional(),
  })
  .strict();

const eventInputSchema = z.record(z.string(), z.unknown());

const retryStatusSchema = z
  .object({ type: z.enum(["retrying", "exhausted", "terminal"]) })
  .strict();

const sessionExecutionErrorSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("unknown_error"),
      message: z.string(),
      retry_status: retryStatusSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("model_overloaded_error"),
      message: z.string(),
      retry_status: retryStatusSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("model_rate_limited_error"),
      message: z.string(),
      retry_status: retryStatusSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("model_request_failed_error"),
      message: z.string(),
      retry_status: retryStatusSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("mcp_connection_failed_error"),
      mcp_server_name: z.string(),
      message: z.string(),
      retry_status: retryStatusSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("mcp_authentication_failed_error"),
      mcp_server_name: z.string(),
      message: z.string(),
      retry_status: retryStatusSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("billing_error"),
      message: z.string(),
      retry_status: retryStatusSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("credential_host_unreachable_error"),
      credential_id: z.string(),
      message: z.string(),
      retry_status: retryStatusSchema,
      vault_id: z.string(),
    })
    .strict(),
]);

const stopReasonSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("end_turn") }).strict(),
  z
    .object({
      type: z.literal("requires_action"),
      event_ids: z.array(z.string()),
    })
    .strict(),
  z.object({ type: z.literal("retries_exhausted") }).strict(),
  z.object({ type: z.literal("budget_reached") }).strict(),
]);

const spanModelUsageSchema = z
  .object({
    cache_creation_input_tokens: z.number().int(),
    cache_read_input_tokens: z.number().int(),
    input_tokens: z.number().int(),
    output_tokens: z.number().int(),
    speed: z.enum(["standard", "fast"]).nullable().optional(),
  })
  .strict();

const historySessionEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      id: z.string().min(1),
      type: z.literal("agent.custom_tool_use"),
      input: eventInputSchema,
      name: z.string(),
      processed_at: z.string(),
      session_thread_id: z.string().nullable().optional(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      type: z.literal("agent.mcp_tool_result"),
      session_thread_id: z.string().nullable().optional(),
      mcp_tool_use_id: z.string(),
      processed_at: z.string(),
      content: z.array(toolResultContentSchema).optional(),
      is_error: z.boolean().nullable().optional(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      type: z.literal("agent.mcp_tool_use"),
      input: eventInputSchema,
      mcp_server_name: z.string(),
      name: z.string(),
      processed_at: z.string(),
      evaluated_permission: z.enum(["allow", "ask", "deny"]).optional(),
      session_thread_id: z.string().nullable().optional(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      type: z.literal("agent.message"),
      session_thread_id: z.string().nullable().optional(),
      content: z.array(z.union([textBlockSchema, redactedBlockSchema])),
      processed_at: z.string(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      type: z.literal("agent.thinking"),
      session_thread_id: z.string().nullable().optional(),
      processed_at: z.string(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      type: z.literal("agent.thread_context_compacted"),
      processed_at: z.string(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      type: z.literal("agent.thread_message_received"),
      from_message_id: z.string().optional(),
      session_thread_id: z.string().nullable().optional(),
      content: z.array(userMessageContentSchema),
      from_session_thread_id: z.string(),
      processed_at: z.string(),
      from_agent_name: z.string().nullable().optional(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      type: z.literal("agent.thread_message_sent"),
      session_thread_id: z.string().nullable().optional(),
      content: z.array(userMessageContentSchema),
      processed_at: z.string(),
      to_session_thread_id: z.string(),
      to_agent_name: z.string().nullable().optional(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      type: z.literal("agent.tool_result"),
      session_thread_id: z.string().nullable().optional(),
      processed_at: z.string(),
      tool_use_id: z.string(),
      content: z.array(toolResultContentSchema).optional(),
      is_error: z.boolean().nullable().optional(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      type: z.literal("agent.tool_use"),
      input: eventInputSchema,
      name: z.string(),
      processed_at: z.string(),
      evaluated_permission: z.enum(["allow", "ask", "deny"]).optional(),
      session_thread_id: z.string().nullable().optional(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      type: z.literal("session.error"),
      session_thread_id: z.string().nullable().optional(),
      error: sessionExecutionErrorSchema,
      processed_at: z.string(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      type: z.literal("session.status_idle"),
      processed_at: z.string(),
      stop_reason: stopReasonSchema,
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      type: z.literal("session.status_rescheduled"),
      processed_at: z.string(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      type: z.literal("session.status_running"),
      processed_at: z.string(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      type: z.literal("session.status_terminated"),
      processed_at: z.string(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      type: z.literal("session.thread_created"),
      content: z.array(textBlockSchema).optional(),
      parent_thread_id: z.string().optional(),
      parent_tool_use_id: z.string().optional(),
      agent_name: z.string(),
      processed_at: z.string(),
      session_thread_id: z.string(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      type: z.literal("session.thread_status_idle"),
      interrupted: z.boolean().optional(),
      agent_name: z.string(),
      processed_at: z.string(),
      session_thread_id: z.string(),
      stop_reason: stopReasonSchema,
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      type: z.literal("session.thread_status_rescheduled"),
      agent_name: z.string(),
      processed_at: z.string(),
      session_thread_id: z.string(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      type: z.literal("session.thread_status_running"),
      agent_name: z.string(),
      processed_at: z.string(),
      session_thread_id: z.string(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      type: z.literal("session.thread_status_terminated"),
      agent_name: z.string(),
      processed_at: z.string(),
      session_thread_id: z.string(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      type: z.literal("span.model_request_start"),
      session_thread_id: z.string().nullable().optional(),
      processed_at: z.string(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      type: z.literal("span.model_request_end"),
      session_thread_id: z.string().nullable().optional(),
      is_error: z.boolean().nullable(),
      model_request_start_id: z.string(),
      model_usage: spanModelUsageSchema,
      processed_at: z.string(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      type: z.literal("span.outcome_evaluation_start"),
      iteration: z.number().int(),
      outcome_id: z.string(),
      processed_at: z.string(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      type: z.literal("span.outcome_evaluation_ongoing"),
      iteration: z.number().int(),
      outcome_id: z.string(),
      processed_at: z.string(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      type: z.literal("span.outcome_evaluation_end"),
      explanation: z.string(),
      iteration: z.number().int(),
      outcome_evaluation_start_id: z.string(),
      outcome_id: z.string(),
      processed_at: z.string(),
      result: z.string(),
      usage: spanModelUsageSchema,
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      type: z.literal("session.deleted"),
      processed_at: z.string(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      type: z.literal("session.updated"),
      processed_at: z.string(),
      agent: sessionAgentResponseSchema.nullable().optional(),
      budget: budgetSchema.nullable().optional(),
      metadata: z.record(z.string(), z.string()).optional(),
      title: z.string().nullable().optional(),
    })
    .strict(),
]);

const listedSessionEventSchema = z.union([
  sentEventSchema,
  sessionUsageEventSchema,
  historySessionEventSchema,
]);

export const sessionEventPageResponseSchema = z
  .object({
    data: z.array(listedSessionEventSchema),
    next_page: z.string().nullable(),
  })
  .strict();

const sessionEventStartSchema = z
  .object({
    type: z.literal("event_start"),
    event: z.discriminatedUnion("type", [
      z
        .object({ id: z.string().min(1), type: z.literal("agent.message") })
        .strict(),
      z
        .object({ id: z.string().min(1), type: z.literal("agent.thinking") })
        .strict(),
    ]),
  })
  .strict();

const sessionEventDeltaSchema = z
  .object({
    type: z.literal("event_delta"),
    event_id: z.string().min(1),
    delta: z
      .object({
        type: z.literal("content_delta"),
        content: textBlockSchema,
        index: z.number().int().optional(),
      })
      .strict(),
  })
  .strict();

export const sessionStreamEventResponseSchema: z.ZodType<BetaManagedAgentsStreamSessionEvents> =
  z.union([
    sentEventSchema,
    sessionUsageEventSchema,
    historySessionEventSchema,
    sessionEventStartSchema,
    sessionEventDeltaSchema,
  ]);
