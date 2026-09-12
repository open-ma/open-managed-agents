import type {
  BetaManagedAgentsAdvisor,
  BetaManagedAgentsAgent,
  BetaManagedAgentsAgentToolset20260401,
  BetaManagedAgentsAnthropicSkill,
  BetaManagedAgentsCustomSkill,
  BetaManagedAgentsCustomTool,
  BetaManagedAgentsMCPToolset,
  BetaManagedAgentsModelConfig,
} from "@anthropic-ai/sdk/resources/beta/agents/agents";
import { z } from "zod";

const permissionPolicySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("always_allow") }).strict(),
  z.object({ type: z.literal("always_ask") }).strict(),
]);

const resolvedSimpleToolSchema = <
  const Name extends "bash" | "edit" | "read" | "write" | "glob" | "grep",
>(
  name: Name,
) =>
  z
    .object({
      enabled: z.boolean(),
      name: z.literal(name),
      permission_policy: permissionPolicySchema,
      type: z.literal(name),
    })
    .strict();

const userLocationSchema = z
  .object({
    type: z.literal("approximate"),
    city: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    region: z.string().nullable().optional(),
    timezone: z.string().nullable().optional(),
  })
  .strict();

const resolvedAgentToolConfigSchema = z.discriminatedUnion("type", [
  resolvedSimpleToolSchema("bash"),
  resolvedSimpleToolSchema("edit"),
  resolvedSimpleToolSchema("read"),
  resolvedSimpleToolSchema("write"),
  resolvedSimpleToolSchema("glob"),
  resolvedSimpleToolSchema("grep"),
  z
    .object({
      enabled: z.boolean(),
      name: z.literal("web_fetch"),
      permission_policy: permissionPolicySchema,
      type: z.literal("web_fetch"),
      allowed_domains: z.array(z.string()).optional(),
      blocked_domains: z.array(z.string()).optional(),
      max_content_tokens: z.number().int().nullable().optional(),
    })
    .strict(),
  z
    .object({
      enabled: z.boolean(),
      name: z.literal("web_search"),
      permission_policy: permissionPolicySchema,
      type: z.literal("web_search"),
      allowed_domains: z.array(z.string()).optional(),
      blocked_domains: z.array(z.string()).optional(),
      user_location: userLocationSchema.nullable().optional(),
    })
    .strict(),
]);

const resolvedDefaultToolConfigSchema = z
  .object({
    enabled: z.boolean(),
    permission_policy: permissionPolicySchema,
  })
  .strict();

const resolvedAgentToolsetSchema = z
  .object({
    configs: z.array(resolvedAgentToolConfigSchema),
    default_config: resolvedDefaultToolConfigSchema,
    type: z.literal("agent_toolset_20260401"),
  })
  .strict() satisfies z.ZodType<BetaManagedAgentsAgentToolset20260401>;

const resolvedMcpToolsetSchema = z
  .object({
    configs: z.array(
      z
        .object({
          enabled: z.boolean(),
          name: z.string(),
          permission_policy: permissionPolicySchema,
        })
        .strict(),
    ),
    default_config: resolvedDefaultToolConfigSchema,
    mcp_server_name: z.string(),
    type: z.literal("mcp_toolset"),
  })
  .strict() satisfies z.ZodType<BetaManagedAgentsMCPToolset>;

const customToolInputSchema = z
  .object({
    type: z.literal("object"),
    properties: z.record(z.string(), z.unknown()).nullable().optional(),
    required: z.array(z.string()).nullable().optional(),
  })
  .catchall(z.unknown());

const resolvedCustomToolSchema = z
  .object({
    description: z.string(),
    input_schema: customToolInputSchema,
    name: z.string(),
    type: z.literal("custom"),
  })
  .strict() satisfies z.ZodType<BetaManagedAgentsCustomTool>;

export const agentToolResponseSchema = z.union([
  resolvedAgentToolsetSchema,
  resolvedMcpToolsetSchema,
  resolvedCustomToolSchema,
]);

export const agentMcpServerResponseSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        name: z.string(),
        type: z.literal("url"),
        url: z.string(),
      })
      .strict(),
    z
      .object({
        name: z.string(),
        type: z.literal("stdio"),
        command: z.string().startsWith("/"),
        args: z.array(z.string()).optional(),
        env: z.record(z.string(), z.string()).optional(),
      })
      .strict(),
  ]);

export const agentModelResponseSchema = z
  .object({
    id: z.string().min(1),
    effort: z
      .object({ type: z.enum(["low", "medium", "high", "xhigh", "max"]) })
      .strict()
      .optional(),
    inference_geo: z.string().optional(),
    provider_options: z.record(z.string(), z.json()).optional(),
    speed: z.enum(["standard", "fast"]).optional(),
  })
  .strict() satisfies z.ZodType<BetaManagedAgentsModelConfig>;

const openMaAgentAcpResponseSchema = z
  .object({
    agent: z
      .object({
        id: z.string().min(1).optional(),
        command: z.string().min(1),
        args: z.array(z.string()).optional(),
        env: z.record(z.string(), z.string()).optional(),
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

export const openMaAgentExtensionResponseSchema = z
  .object({
    aux_model: agentModelResponseSchema.optional(),
    appendable_prompts: z.array(z.string().min(1)).optional(),
    harness: z.string().min(1).optional(),
    acp: openMaAgentAcpResponseSchema.optional(),
    runtime_binding: z
      .object({
        runtime_id: z.string().min(1),
        acp_agent_id: z.string().min(1),
        local_skill_blocklist: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    enable_general_subagent: z.boolean().optional(),
  })
  .strict();

const anthropicSkillResponseSchema = z
  .object({
    skill_id: z.string(),
    type: z.literal("anthropic"),
    version: z.string(),
  })
  .strict() satisfies z.ZodType<BetaManagedAgentsAnthropicSkill>;

const customSkillResponseSchema = z
  .object({
    skill_id: z.string(),
    type: z.literal("custom"),
    version: z.string(),
  })
  .strict() satisfies z.ZodType<BetaManagedAgentsCustomSkill>;

export const agentSkillResponseSchema = z.union([
  anthropicSkillResponseSchema,
  customSkillResponseSchema,
]);

export const advisorResponseSchema = z
  .object({ model: z.string(), type: z.literal("advisor") })
  .strict() satisfies z.ZodType<BetaManagedAgentsAdvisor>;

const resolvedAgentReferenceSchema = z
  .object({
    id: z.string(),
    type: z.literal("agent"),
    version: z.number().int(),
  })
  .strict();

export const agentMultiagentResponseSchema = z
  .object({
    agents: z.array(z.union([resolvedAgentReferenceSchema, advisorResponseSchema])),
    type: z.literal("coordinator"),
  })
  .strict() satisfies z.ZodType<NonNullable<BetaManagedAgentsAgent["multiagent"]>>;

export const sessionThreadAgentResponseSchema = z
  .object({
    id: z.string(),
    description: z.string().nullable(),
    mcp_servers: z.array(agentMcpServerResponseSchema),
    model: agentModelResponseSchema,
    name: z.string(),
    _oma: openMaAgentExtensionResponseSchema.optional(),
    skills: z.array(agentSkillResponseSchema),
    system: z.string().nullable(),
    tools: z.array(agentToolResponseSchema),
    type: z.literal("agent"),
    version: z.number().int(),
  })
  .strict();

export const sessionAgentMultiagentResponseSchema = z
  .object({
    agents: z.array(
      z.union([sessionThreadAgentResponseSchema, advisorResponseSchema]),
    ),
    type: z.literal("coordinator"),
  })
  .strict();

export const sessionAgentResponseSchema = z
    .object({
      id: z.string().min(1),
      description: z.string().nullable(),
      mcp_servers: z.array(agentMcpServerResponseSchema),
      model: agentModelResponseSchema,
      multiagent: sessionAgentMultiagentResponseSchema.nullable(),
      name: z.string().min(1),
      _oma: openMaAgentExtensionResponseSchema.optional(),
      skills: z.array(agentSkillResponseSchema),
      system: z.string().nullable(),
      tools: z.array(agentToolResponseSchema),
      type: z.literal("agent"),
      version: z.number().int().min(1),
    })
    .strict();
