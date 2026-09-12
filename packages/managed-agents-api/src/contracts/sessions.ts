import type {
  BetaManagedAgentsSession,
  BetaManagedAgentsDeletedSession,
  SessionCreateParams,
  SessionListParams,
  SessionUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/sessions/sessions";
import { z } from "zod";
import { agentModelInputSchema, type OpenMaMcpServerBody } from "./agents";
import {
  agentMcpServerInputSchema,
  agentSkillInputSchema,
  agentToolInputSchema,
} from "./agent-input-components";
import { sessionAgentResponseSchema } from "./agent-response-components";
import {
  userDefineOutcomeEventInputSchema,
  userMessageEventInputSchema,
} from "./session-event-inputs";
import { sessionResourceResponseSchema } from "./session-resources";

type OfficialSessionCreateBody = Omit<SessionCreateParams, "betas">;
type OfficialSessionAgent = Exclude<OfficialSessionCreateBody["agent"], string>;
type OfficialSessionAgentOverride = Extract<
  OfficialSessionAgent,
  { type: "agent_with_overrides" }
>;
export type SessionCreateBody = Omit<OfficialSessionCreateBody, "agent"> & {
  agent:
    | string
    | Exclude<OfficialSessionAgent, { type: "agent_with_overrides" }>
    | (Omit<OfficialSessionAgentOverride, "mcp_servers"> & {
        mcp_servers?: OpenMaMcpServerBody[];
      });
};
export type SessionListQuery = Omit<SessionListParams, "betas">;
type OfficialSessionUpdateBody = Omit<SessionUpdateParams, "betas">;
export type SessionUpdateBody = Omit<OfficialSessionUpdateBody, "agent"> & {
  agent?: Omit<NonNullable<OfficialSessionUpdateBody["agent"]>, "mcp_servers"> & {
    mcp_servers?: OpenMaMcpServerBody[];
  };
};
type SessionAgentOverrides = Extract<
  Exclude<SessionCreateBody["agent"], string>,
  { type: "agent_with_overrides" }
>;

const agentReferenceSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("agent"),
    version: z.number().int().min(1).optional(),
  })
  .strict();

const agentOverridesSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("agent_with_overrides"),
    mcp_servers: z.array(agentMcpServerInputSchema).optional(),
    model: agentModelInputSchema.optional(),
    skills: z.array(agentSkillInputSchema).optional(),
    system: z.string().nullable().optional(),
    tools: z.array(agentToolInputSchema).optional(),
    version: z.number().int().min(1).optional(),
  })
  .strict();

const sessionCheckoutInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("branch"), name: z.string().min(1) }).strict(),
  z.object({ type: z.literal("commit"), sha: z.string().min(1) }).strict(),
]);

const sessionResourceInputSchema: z.ZodType<
  NonNullable<SessionCreateBody["resources"]>[number]
> = z.discriminatedUnion("type", [
  z
    .object({
      file_id: z.string().min(1),
      type: z.literal("file"),
      mount_path: z.string().nullable().optional(),
    })
    .strict(),
  z
    .object({
      authorization_token: z.string().min(1),
      type: z.literal("github_repository"),
      url: z.string().min(1),
      checkout: sessionCheckoutInputSchema.nullable().optional(),
      mount_path: z.string().nullable().optional(),
    })
    .strict(),
  z
    .object({
      memory_store_id: z.string().min(1),
      type: z.literal("memory_store"),
      access: z.enum(["read_write", "read_only"]).nullable().optional(),
      instructions: z.string().nullable().optional(),
    })
    .strict(),
]);

export const monetaryAmountSchema = z
  .object({
    amount: z.string().regex(/^(0|[1-9]\d*)$/),
    currency: z.literal("USD"),
  })
  .strict();

export const budgetSchema = z
  .object({
    max_list_cost: monetaryAmountSchema,
    type: z.literal("limit"),
  })
  .strict();

export const sessionCreateBodySchema: z.ZodType<SessionCreateBody> = z
  .object({
    agent: z.union([
      z.string().min(1),
      agentReferenceSchema,
      agentOverridesSchema,
    ]),
    environment_id: z.string().min(1),
    budget: budgetSchema.optional(),
    initial_events: z
      .array(
        z.union([
          userMessageEventInputSchema,
          userDefineOutcomeEventInputSchema,
        ]),
      )
      .optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    resources: z.array(sessionResourceInputSchema).optional(),
    title: z.string().nullable().optional(),
    vault_ids: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const sessionUpdateBodySchema: z.ZodType<SessionUpdateBody> = z
  .object({
    agent: z
      .object({
        mcp_servers: z.array(agentMcpServerInputSchema).optional(),
        tools: z.array(agentToolInputSchema).optional(),
      })
      .strict()
      .optional(),
    budget: budgetSchema.nullable().optional(),
    metadata: z
      .record(z.string(), z.string().nullable())
      .nullable()
      .optional(),
    title: z.string().nullable().optional(),
    vault_ids: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const sessionListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).optional(),
    page: z.string().min(1).optional(),
    agent_id: z.string().min(1).optional(),
    agent_version: z.coerce.number().int().min(1).optional(),
    "created_at[gt]": z.string().min(1).optional(),
    "created_at[gte]": z.string().min(1).optional(),
    "created_at[lt]": z.string().min(1).optional(),
    "created_at[lte]": z.string().min(1).optional(),
    deployment_id: z.string().min(1).optional(),
    include_archived: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
    memory_store_id: z.string().min(1).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    statuses: z
      .array(z.enum(["rescheduling", "running", "idle", "terminated"]))
      .optional(),
  })
  .strict();

export { sessionAgentResponseSchema } from "./agent-response-components";

const sessionStatsResponseSchema = z
  .object({
    active_seconds: z.number().optional(),
    duration_seconds: z.number().optional(),
  })
  .strict();

export const sessionUsageResponseSchema = z
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
    list_cost: monetaryAmountSchema.nullable().optional(),
    output_tokens: z.number().int().optional(),
    server_tool_use: z
      .object({
        web_fetch_requests: z.number().int().optional(),
        web_search_requests: z.number().int().optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

export const sessionResponseSchema = z
  .object({
    id: z.string().min(1),
    agent: sessionAgentResponseSchema,
    archived_at: z.string().nullable(),
    budget: budgetSchema.nullable(),
    created_at: z.string(),
    environment_id: z.string().min(1),
    metadata: z.record(z.string(), z.string()),
    outcome_evaluations: z.array(
      z.object({
        completed_at: z.string().nullable(),
        description: z.string(),
        explanation: z.string().nullable(),
        iteration: z.number().int(),
        outcome_id: z.string().min(1),
        result: z.string(),
        type: z.literal("outcome_evaluation"),
      }).strict(),
    ),
    resources: z.array(sessionResourceResponseSchema),
    stats: sessionStatsResponseSchema,
    status: z.enum(["rescheduling", "running", "idle", "terminated"]),
    title: z.string().nullable(),
    type: z.literal("session"),
    updated_at: z.string(),
    usage: sessionUsageResponseSchema,
    vault_ids: z.array(z.string()),
    deployment_id: z.string().nullable().optional(),
  })
  .strict();

export const sessionPageResponseSchema = z
  .object({
    data: z.array(sessionResponseSchema),
    next_page: z.string().nullable(),
    prev_page: z.string().nullable(),
  })
  .strict();

export const deletedSessionResponseSchema: z.ZodType<BetaManagedAgentsDeletedSession> =
  z
    .object({
      id: z.string().min(1),
      type: z.literal("session_deleted"),
    })
    .strict();
