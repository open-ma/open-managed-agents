import { z } from "zod";

const id = z.string().min(1);
const timestamp = z.number().int().nonnegative();
const count = z.number().int().nonnegative();
const strings = z.array(z.string());
const metadata = z.record(z.string().max(64), z.string().max(512)).refine((value) => Object.keys(value).length <= 16, "Metadata allows at most 16 keys");
const serviceTier = z.enum(["auto", "default", "flex", "priority", "fast"]);
const verbosity = z.enum(["low", "medium", "high"]);
const reasoning = z.strictObject({ effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).nullable(), summary: z.enum(["concise", "detailed", "auto"]).nullable() });
const textFormat = z.strictObject({ type: z.literal("text") });
const functionTool = z.strictObject({ type: z.literal("function"), name: id, description: z.string(), parameters: z.record(z.string(), z.unknown()), defer_loading: z.boolean() });
const inputContent = z.discriminatedUnion("type", [z.strictObject({ type: z.literal("input_text"), text: z.string() }), z.strictObject({ type: z.literal("input_image"), image_url: id })]);
const inputMessage = z.strictObject({ type: z.literal("message").optional(), role: z.literal("user"), content: z.array(inputContent).min(1) });
const environment = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("none") }),
  z.strictObject({ type: z.literal("self_hosted"), workspace_directory: z.string().startsWith("/"), capability_directories: strings.nullish() }),
  z.strictObject({ type: z.literal("openai_hosted"), environment_template_id: id.optional(), env: z.record(z.string(), z.string()).nullish(), capability_directories: strings.nullish(), packages: z.strictObject({ npm: strings.nullish(), python: strings.nullish(), system: strings.nullish() }).nullish(), network: z.strictObject({ access: z.enum(["enabled", "disabled", "restricted"]), allowed_domains: strings.nullish() }).nullish() }),
]);

export const sessionCreateBodySchema = z.strictObject({
  environment,
  agent_id: id.optional(),
  agent: z.strictObject({ model: id.optional(), instructions: z.string().nullish(), reasoning: reasoning.partial().nullish(), service_tier: serviceTier.nullish(), multi_agent: z.strictObject({ enabled: z.boolean(), max_concurrent_subagents: z.number().int().positive().optional() }).nullish(), text: z.strictObject({ format: textFormat.nullish(), verbosity: verbosity.nullish() }).nullish(), tools: z.array(functionTool.extend({ defer_loading: z.boolean().optional() })).nullish() }).optional(),
  input: z.union([z.string(), z.array(inputMessage)]).nullish(),
  metadata: metadata.nullish(),
  vault_ids: z.array(id).nullish(),
  stream: z.boolean().optional(),
}).refine((body) => Boolean(body.agent_id || body.agent?.model), { message: "agent.model is required when agent_id is omitted", path: ["agent", "model"] })
  .refine((body) => body.environment.type !== "none" || (typeof body.input === "string" ? body.input.length > 0 : Boolean(body.input?.length)), { message: "An environment of type none requires initial input", path: ["input"] });

export const sessionUpdateBodySchema = z.strictObject({ metadata: metadata.nullish() });
export const listQuerySchema = z.strictObject({ after: id.optional(), limit: z.coerce.number().int().positive().optional(), order: z.enum(["asc", "desc"]).optional() });
export const sessionListQuerySchema = listQuerySchema.extend({ agent_id: id.optional() });
export const eventCreateBodySchema = z.strictObject({ events: z.array(z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("agent.session.input.message"), input: z.array(inputMessage).min(1) }),
  z.strictObject({ type: z.literal("agent.session.input.cancel") }),
  z.strictObject({ type: z.literal("agent.session.input.tool_result"), call_id: id, turn_id: id, success: z.boolean(), error: z.string().nullish(), output: z.union([z.string(), z.array(inputContent)]).nullish() }),
])).min(1) });

export const tokenUsageSchema = z.strictObject({ input_tokens: count, output_tokens: count, total_tokens: count, input_tokens_details: z.strictObject({ cached_tokens: count }), output_tokens_details: z.strictObject({ reasoning_tokens: count }) });
export const sessionResponseSchema = z.strictObject({
  id, object: z.literal("agent.session"), created_at: timestamp, last_active_at: timestamp,
  agent: z.strictObject({ id, name: z.string().nullable(), model: id, instructions: z.string().nullable(), reasoning, service_tier: serviceTier, multi_agent: z.strictObject({ enabled: z.boolean(), max_concurrent_subagents: z.number().int().positive().nullable() }), text: z.strictObject({ format: textFormat, verbosity }), tools: z.array(functionTool) }),
  environment: z.discriminatedUnion("type", [z.strictObject({ type: z.literal("none") }), z.strictObject({ type: z.literal("self_hosted"), id, workspace_directory: z.string().startsWith("/"), capability_directories: strings, remote_url: id })]),
  error: z.string().nullable(), metadata,
  required_actions: z.array(z.discriminatedUnion("type", [z.strictObject({ type: z.literal("function_call"), call_id: id, turn_id: id, name: id, arguments: z.unknown() }), z.strictObject({ type: z.literal("environment_connection"), environment_id: id })])),
  status: z.enum(["idle", "in_progress", "requires_action", "failed"]), usage: tokenUsageSchema.nullable(), vault_ids: z.array(id),
});
export const deletedSessionSchema = z.strictObject({ id, object: z.literal("agent.session.deleted"), deleted: z.literal(true) });
export const turnResponseSchema = z.strictObject({
  id, object: z.literal("agent.session.turn"), agent_id: id, session_id: id, subagent_id: id.nullable(),
  created_at: timestamp, started_at: timestamp.nullable(), completed_at: timestamp.nullable(),
  status: z.enum(["queued", "in_progress", "waiting", "completed", "failed", "cancelled"]),
  error: z.strictObject({ code: z.enum(["context_length_exceeded", "session_budget_exceeded", "usage_limit_exceeded", "rate_limit_exceeded", "server_overloaded", "cyber_policy", "connection_failed", "server_error", "authentication_error", "invalid_request", "resource_not_found", "sandbox_error", "executor_version_incompatible", "active_turn_not_steerable", "request_timeout", "internal_error"]), message: z.string() }).nullable(), usage: tokenUsageSchema.nullable(),
});
export const messageItemSchema = z.strictObject({
  id: id.nullable(), type: z.literal("message"), turn_id: id, role: z.enum(["user", "assistant"]),
  content: z.array(z.union([inputContent, z.strictObject({ type: z.literal("output_text"), text: z.string() })])),
  phase: z.enum(["commentary", "final_answer"]).nullable(), status: z.enum(["in_progress", "completed", "incomplete"]),
});
export const pageSchema = <T extends z.ZodType>(item: T) => z.strictObject({ data: z.array(item), has_more: z.boolean() }).refine((page) => !page.has_more || (page.data.length > 0 && Boolean((page.data.at(-1) as { id?: string | null })?.id)), "A continued page requires a final resource ID");
const eventBase = { event_id: id };
export const sessionErrorEventSchema = z.strictObject({ ...eventBase, type: z.literal("error"), session_id: id, error: z.strictObject({ code: z.string().nullable(), message: z.string(), param: z.string().nullable(), type: z.string() }) });
const turnEventBase = { ...eventBase, session_id: id, turn_id: id, turn: turnResponseSchema };
const textEventBase = { ...eventBase, session_id: id, turn_id: id.nullable(), item_id: id, content_index: count, output_index: count };
export const sessionEventSchema = z.union([
  z.strictObject({ ...eventBase, type: z.enum(["agent.session.created", "agent.session.idle", "agent.session.in_progress", "agent.session.requires_action", "agent.session.failed"]), session: sessionResponseSchema }),
  z.strictObject({ ...turnEventBase, type: z.enum(["agent.session.turn.created", "agent.session.turn.in_progress"]) }),
  z.strictObject({ ...turnEventBase, type: z.enum(["agent.session.turn.completed", "agent.session.turn.failed", "agent.session.turn.cancelled"]), usage: tokenUsageSchema.nullable() }),
  z.strictObject({ ...textEventBase, type: z.literal("agent.session.turn.output_text.delta"), delta: z.string() }),
  z.strictObject({ ...textEventBase, type: z.literal("agent.session.turn.output_text.done"), text: z.string() }),
]);

export type SessionCreateBody = z.infer<typeof sessionCreateBodySchema>;
export type EventCreateBody = z.infer<typeof eventCreateBodySchema>;
