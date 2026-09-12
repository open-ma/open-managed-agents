import type {
  AgentCreateParams,
  BetaManagedAgentsSkillParams,
  BetaManagedAgentsURLMCPServerParams,
} from "@anthropic-ai/sdk/resources/beta/agents/agents";
import { z } from "zod";

type AgentToolInput = NonNullable<AgentCreateParams["tools"]>[number];
type AgentMultiagentInput = Exclude<
  AgentCreateParams["multiagent"],
  null | undefined
>;

const permissionPolicyInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("always_allow") }).strict(),
  z.object({ type: z.literal("always_ask") }).strict(),
]);

const simpleToolConfigInputSchema = <
  const Name extends "bash" | "edit" | "read" | "write" | "glob" | "grep",
>(
  name: Name,
) =>
  z
    .object({
      name: z.literal(name),
      enabled: z.boolean().nullable().optional(),
      permission_policy: permissionPolicyInputSchema.nullable().optional(),
      type: z.literal(name).optional(),
    })
    .strict();

const userLocationInputSchema = z
  .object({
    type: z.literal("approximate"),
    city: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    region: z.string().nullable().optional(),
    timezone: z.string().nullable().optional(),
  })
  .strict();

const agentToolConfigInputSchema = z.discriminatedUnion("name", [
  simpleToolConfigInputSchema("bash"),
  simpleToolConfigInputSchema("edit"),
  simpleToolConfigInputSchema("read"),
  simpleToolConfigInputSchema("write"),
  simpleToolConfigInputSchema("glob"),
  simpleToolConfigInputSchema("grep"),
  z
    .object({
      name: z.literal("web_fetch"),
      allowed_domains: z.array(z.string()).optional(),
      blocked_domains: z.array(z.string()).optional(),
      enabled: z.boolean().nullable().optional(),
      max_content_tokens: z.number().int().nullable().optional(),
      permission_policy: permissionPolicyInputSchema.nullable().optional(),
      type: z.literal("web_fetch").optional(),
    })
    .strict(),
  z
    .object({
      name: z.literal("web_search"),
      allowed_domains: z.array(z.string()).optional(),
      blocked_domains: z.array(z.string()).optional(),
      enabled: z.boolean().nullable().optional(),
      permission_policy: permissionPolicyInputSchema.nullable().optional(),
      type: z.literal("web_search").optional(),
      user_location: userLocationInputSchema.nullable().optional(),
    })
    .strict(),
]);

const defaultToolConfigInputSchema = z
  .object({
    enabled: z.boolean().nullable().optional(),
    permission_policy: permissionPolicyInputSchema.nullable().optional(),
  })
  .strict();

const agentToolsetInputSchema = z
  .object({
    type: z.literal("agent_toolset_20260401"),
    configs: z.array(agentToolConfigInputSchema).optional(),
    default_config: defaultToolConfigInputSchema.nullable().optional(),
  })
  .strict();

const mcpToolsetInputSchema = z
  .object({
    mcp_server_name: z.string().min(1),
    type: z.literal("mcp_toolset"),
    configs: z
      .array(
        z
          .object({
            name: z.string().min(1),
            enabled: z.boolean().nullable().optional(),
            permission_policy: permissionPolicyInputSchema.nullable().optional(),
          })
          .strict(),
      )
      .optional(),
    default_config: defaultToolConfigInputSchema.nullable().optional(),
  })
  .strict();

const customToolInputSchema = z
  .object({
    type: z.literal("object"),
    properties: z.record(z.string(), z.unknown()).nullable().optional(),
    required: z.array(z.string()).nullable().optional(),
  })
  .catchall(z.unknown());

const customToolSchema = z
  .object({
    description: z.string(),
    input_schema: customToolInputSchema,
    name: z.string().min(1),
    type: z.literal("custom"),
  })
  .strict();

export const agentToolInputSchema = z.discriminatedUnion("type", [
  agentToolsetInputSchema,
  mcpToolsetInputSchema,
  customToolSchema,
]) satisfies z.ZodType<AgentToolInput>;

export const agentMcpServerInputSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        name: z.string().min(1),
        type: z.literal("url"),
        url: z.string().min(1),
      })
      .strict(),
    z
      .object({
        name: z.string().min(1),
        type: z.literal("stdio"),
        command: z.string().startsWith("/"),
        args: z.array(z.string()).optional(),
        env: z.record(z.string(), z.string()).optional(),
      })
      .strict(),
  ]);

export const agentSkillInputSchema = z.discriminatedUnion("type", [
  z
    .object({
      skill_id: z.string().min(1),
      type: z.literal("anthropic"),
      version: z.string().nullable().optional(),
    })
    .strict(),
  z
    .object({
      skill_id: z.string().min(1),
      type: z.literal("custom"),
      version: z.string().nullable().optional(),
    })
    .strict(),
]) satisfies z.ZodType<BetaManagedAgentsSkillParams>;

export const agentMultiagentInputSchema = z
  .object({
    type: z.literal("coordinator"),
    agents: z.array(
      z.union([
        z.string().min(1),
        z
          .object({
            id: z.string().min(1),
            type: z.literal("agent"),
            version: z.number().int().min(1).optional(),
          })
          .strict(),
        z.object({ type: z.literal("self") }).strict(),
        z
          .object({ model: z.string().min(1), type: z.literal("advisor") })
          .strict(),
      ]),
    ),
  })
  .strict() satisfies z.ZodType<AgentMultiagentInput>;
