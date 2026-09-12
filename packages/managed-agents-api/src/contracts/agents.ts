import type {
  AgentCreateParams,
  AgentListParams,
  AgentRetrieveParams,
  AgentUpdateParams,
  BetaManagedAgentsAgent,
} from "@anthropic-ai/sdk/resources/beta/agents/agents";
import type { VersionListParams } from "@anthropic-ai/sdk/resources/beta/agents/versions";
import { z } from "zod";
import {
  agentMcpServerInputSchema,
  agentMultiagentInputSchema,
  agentSkillInputSchema,
  agentToolInputSchema,
} from "./agent-input-components";
import {
  agentMcpServerResponseSchema,
  agentModelResponseSchema,
  agentMultiagentResponseSchema,
  openMaAgentExtensionResponseSchema,
  agentSkillResponseSchema,
  agentToolResponseSchema,
} from "./agent-response-components";

type OfficialAgentCreateBody = Omit<AgentCreateParams, "betas">;
export type AgentListQuery = Omit<AgentListParams, "betas">;
export type AgentRetrieveQuery = Omit<AgentRetrieveParams, "betas">;
type OfficialAgentUpdateBody = Omit<AgentUpdateParams, "betas">;
export type AgentVersionListQuery = Omit<VersionListParams, "betas">;

type AgentModelConfig = Exclude<OfficialAgentCreateBody["model"], string>;
type AgentModelName = Exclude<OfficialAgentCreateBody["model"], AgentModelConfig>;

export type OpenMaJsonValue =
  | string
  | number
  | boolean
  | null
  | OpenMaProviderOptions
  | OpenMaJsonValue[];

export interface OpenMaProviderOptions {
  [key: string]: OpenMaJsonValue;
}

export type OpenMaAgentModelConfigBody = AgentModelConfig & {
  /** OpenMA extension: provider-namespaced, JSON-compatible inference options. */
  provider_options?: OpenMaProviderOptions | null;
};

export type OpenMaAgentModelBody = AgentModelName | OpenMaAgentModelConfigBody;

export interface OpenMaAgentAcpBody {
  agent: {
    id?: string;
    command: string;
    args?: string[];
    env?: Record<string, string | null>;
    cwd?: string;
  };
  restart?: {
    mode: "never" | "on-crash" | "always";
    max_restarts?: number;
    window_ms?: number;
  };
  idle_timeout_ms?: number;
  per_turn_timeout_ms?: number;
}

export interface OpenMaAgentRuntimeBindingBody {
  runtime_id: string;
  acp_agent_id: string;
  local_skill_blocklist?: string[];
}

export interface OpenMaAgentExtensionBody {
  aux_model?: OpenMaAgentModelBody | null;
  appendable_prompts?: string[] | null;
  harness?: string | null;
  acp?: OpenMaAgentAcpBody | null;
  runtime_binding?: OpenMaAgentRuntimeBindingBody | null;
  enable_general_subagent?: boolean | null;
}

export type AgentCreateBody = Omit<OfficialAgentCreateBody, "model"> & {
  model: OpenMaAgentModelBody;
  _oma?: OpenMaAgentExtensionBody;
};
export type AgentUpdateBody = Omit<OfficialAgentUpdateBody, "model"> & {
  model?: OpenMaAgentModelBody;
  _oma?: OpenMaAgentExtensionBody;
};

const effortLevelSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
const providerOptionsSchema: z.ZodType<OpenMaProviderOptions> = z.record(
  z.string(),
  z.json(),
);
const metadataKeySchema = z.string().min(1).max(64);
const metadataValueSchema = z.string().max(512);
const agentMetadataSchema = z
  .record(metadataKeySchema, metadataValueSchema)
  .refine((metadata) => Object.keys(metadata).length <= 16, {
    message: "Agent metadata may contain at most 16 keys",
  });
const agentMetadataPatchSchema = z.record(
  metadataKeySchema,
  metadataValueSchema.nullable(),
);

const modelConfigSchema: z.ZodType<OpenMaAgentModelConfigBody> = z
  .object({
    id: z.string().min(1),
    effort: z
      .union([
        effortLevelSchema,
        z.object({ type: effortLevelSchema }).strict(),
      ])
      .nullable()
      .optional(),
    inference_geo: z.string().nullable().optional(),
    provider_options: providerOptionsSchema.nullable().optional(),
    speed: z.enum(["standard", "fast"]).nullable().optional(),
  })
  .strict();

export const agentModelInputSchema: z.ZodType<AgentCreateBody["model"]> = z.union([
  z.string().min(1),
  modelConfigSchema,
]);

const agentAcpSchema: z.ZodType<OpenMaAgentAcpBody> = z
  .object({
    agent: z
      .object({
        id: z.string().min(1).optional(),
        command: z.string().min(1),
        args: z.array(z.string()).optional(),
        env: z.record(z.string(), z.string().nullable()).optional(),
        cwd: z.string().min(1).optional(),
      })
      .strict(),
    restart: z
      .object({
        mode: z.enum(["never", "on-crash", "always"]),
        max_restarts: z.number().int().min(0).optional(),
        window_ms: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    idle_timeout_ms: z.number().int().positive().optional(),
    per_turn_timeout_ms: z.number().int().positive().optional(),
  })
  .strict();

const runtimeBindingSchema: z.ZodType<OpenMaAgentRuntimeBindingBody> = z
  .object({
    runtime_id: z.string().min(1),
    acp_agent_id: z.string().min(1),
    local_skill_blocklist: z.array(z.string().min(1)).optional(),
  })
  .strict();

const openMaAgentExtensionSchema: z.ZodType<OpenMaAgentExtensionBody> = z
  .object({
    aux_model: agentModelInputSchema.nullable().optional(),
    appendable_prompts: z.array(z.string().min(1)).nullable().optional(),
    harness: z.string().min(1).nullable().optional(),
    acp: agentAcpSchema.nullable().optional(),
    runtime_binding: runtimeBindingSchema.nullable().optional(),
    enable_general_subagent: z.boolean().nullable().optional(),
  })
  .strict();

export const agentCreateBodySchema: z.ZodType<AgentCreateBody> = z
  .object({
    name: z.string().min(1),
    model: agentModelInputSchema,
    description: z.string().nullable().optional(),
    mcp_servers: z.array(agentMcpServerInputSchema).optional(),
    metadata: agentMetadataSchema.optional(),
    multiagent: agentMultiagentInputSchema.nullable().optional(),
    skills: z.array(agentSkillInputSchema).optional(),
    system: z.string().nullable().optional(),
    tools: z.array(agentToolInputSchema).optional(),
    _oma: openMaAgentExtensionSchema.optional(),
  })
  .strict();

export const agentRetrieveQuerySchema = z
  .object({
    version: z.coerce.number().int().min(1).optional(),
  })
  .strict();

export const agentListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).optional(),
    page: z.string().min(1).optional(),
    "created_at[gte]": z.string().min(1).optional(),
    "created_at[lte]": z.string().min(1).optional(),
    include_archived: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
  })
  .strict();

export const agentVersionListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).optional(),
    page: z.string().min(1).optional(),
  })
  .strict();

export const agentUpdateBodySchema: z.ZodType<AgentUpdateBody> = z
  .object({
    description: z.string().nullable().optional(),
    mcp_servers: z.array(agentMcpServerInputSchema).nullable().optional(),
    metadata: agentMetadataPatchSchema.nullable().optional(),
    model: agentModelInputSchema.optional(),
    multiagent: agentMultiagentInputSchema.nullable().optional(),
    name: z.string().min(1).optional(),
    skills: z.array(agentSkillInputSchema).nullable().optional(),
    system: z.string().nullable().optional(),
    tools: z.array(agentToolInputSchema).nullable().optional(),
    version: z.number().int().min(1).optional(),
    _oma: openMaAgentExtensionSchema.optional(),
  })
  .strict();

export const agentResponseSchema: z.ZodType<BetaManagedAgentsAgent> = z
  .object({
    id: z.string().min(1),
    archived_at: z.string().nullable(),
    created_at: z.string(),
    description: z.string().nullable(),
    mcp_servers: z.array(agentMcpServerResponseSchema),
    metadata: z.record(z.string(), z.string()),
    model: agentModelResponseSchema,
    multiagent: agentMultiagentResponseSchema.nullable(),
    name: z.string().min(1),
    skills: z.array(agentSkillResponseSchema),
    system: z.string().nullable(),
    tools: z.array(agentToolResponseSchema),
    type: z.literal("agent"),
    updated_at: z.string(),
    version: z.number().int().min(1),
    _oma: openMaAgentExtensionResponseSchema.optional(),
  })
  .strict();

export const agentPageResponseSchema = z
  .object({
    data: z.array(agentResponseSchema),
    next_page: z.string().nullable(),
  })
  .strict();
