import type {
  AgentCustomToolInputSchema,
  AgentMcpServerInput,
  AgentMultiagentInput,
  AgentPermissionPolicy,
  AgentSkillInput,
  AgentToolConfigInput,
  AgentToolDefaultConfigInput,
  AgentToolInput,
  AgentModel,
  SessionThreadAgent,
  JsonObject,
  JsonValue,
} from "@open-managed-agents/managed-agents-application";
import type { AgentCreateBody } from "../contracts/agents";
import { fromOpenMaAgentExtension } from "./openma-agent-extension";

type WireMcpServer = NonNullable<AgentCreateBody["mcp_servers"]>[number];
type WireMultiagent = Exclude<
  AgentCreateBody["multiagent"],
  null | undefined
>;
type WireSkill = NonNullable<AgentCreateBody["skills"]>[number];
type WireTool = NonNullable<AgentCreateBody["tools"]>[number];
type WireToolConfig = NonNullable<
  Extract<WireTool, { type: "agent_toolset_20260401" }>["configs"]
>[number];

function toJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value !== "object") {
    throw new Error("Custom tool input schema must contain JSON values");
  }
  const result: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = toJsonValue(child);
  }
  return result;
}

function toJsonObject(value: object): JsonObject {
  const result = toJsonValue(value);
  if (result === null || Array.isArray(result) || typeof result !== "object") {
    throw new Error("Expected a JSON object");
  }
  return result;
}

function toPermissionPolicy(
  policy: { type: "always_allow" | "always_ask" },
): AgentPermissionPolicy {
  return { type: policy.type };
}

function toDefaultConfig(
  config: {
    enabled?: boolean | null;
    permission_policy?: { type: "always_allow" | "always_ask" } | null;
  },
): AgentToolDefaultConfigInput {
  return {
    ...(config.enabled !== undefined && { enabled: config.enabled }),
    ...(config.permission_policy !== undefined && {
      permissionPolicy:
        config.permission_policy === null
          ? null
          : toPermissionPolicy(config.permission_policy),
    }),
  };
}

function toToolConfig(config: WireToolConfig): AgentToolConfigInput {
  const common = {
    ...(config.enabled !== undefined && { enabled: config.enabled }),
    ...(config.permission_policy !== undefined && {
      permissionPolicy:
        config.permission_policy === null
          ? null
          : toPermissionPolicy(config.permission_policy),
    }),
  };
  switch (config.name) {
    case "web_fetch":
      return {
        ...common,
        name: config.name,
        ...(config.type !== undefined && { type: config.type }),
        ...(config.allowed_domains !== undefined && {
          allowedDomains: config.allowed_domains,
        }),
        ...(config.blocked_domains !== undefined && {
          blockedDomains: config.blocked_domains,
        }),
        ...(config.max_content_tokens !== undefined && {
          maxContentTokens: config.max_content_tokens,
        }),
      };
    case "web_search":
      return {
        ...common,
        name: config.name,
        ...(config.type !== undefined && { type: config.type }),
        ...(config.allowed_domains !== undefined && {
          allowedDomains: config.allowed_domains,
        }),
        ...(config.blocked_domains !== undefined && {
          blockedDomains: config.blocked_domains,
        }),
        ...(config.user_location !== undefined && {
          userLocation:
            config.user_location === null
              ? null
              : {
                  type: config.user_location.type,
                  ...(config.user_location.city !== undefined && {
                    city: config.user_location.city,
                  }),
                  ...(config.user_location.country !== undefined && {
                    country: config.user_location.country,
                  }),
                  ...(config.user_location.region !== undefined && {
                    region: config.user_location.region,
                  }),
                  ...(config.user_location.timezone !== undefined && {
                    timezone: config.user_location.timezone,
                  }),
                },
        }),
      };
    case "bash":
      return {
        ...common,
        name: config.name,
        ...(config.type !== undefined && { type: config.type }),
      };
    case "edit":
      return {
        ...common,
        name: config.name,
        ...(config.type !== undefined && { type: config.type }),
      };
    case "read":
      return {
        ...common,
        name: config.name,
        ...(config.type !== undefined && { type: config.type }),
      };
    case "write":
      return {
        ...common,
        name: config.name,
        ...(config.type !== undefined && { type: config.type }),
      };
    case "glob":
      return {
        ...common,
        name: config.name,
        ...(config.type !== undefined && { type: config.type }),
      };
    case "grep":
      return {
        ...common,
        name: config.name,
        ...(config.type !== undefined && { type: config.type }),
      };
  }
}

function toCustomToolInputSchema(value: object): AgentCustomToolInputSchema {
  const schema = toJsonObject(value);
  if (schema.type !== "object") {
    throw new Error("Custom tool input schema type must be object");
  }
  return { ...schema, type: "object" };
}

export function toAgentMcpServerInput(
  server: WireMcpServer,
): AgentMcpServerInput {
  return { name: server.name, type: server.type, url: server.url };
}

export function toAgentSkillInput(skill: WireSkill): AgentSkillInput {
  return {
    skillId: skill.skill_id,
    type: skill.type,
    ...(skill.version !== undefined && { version: skill.version }),
  };
}

export function toAgentMultiagentInput(
  multiagent: WireMultiagent,
): AgentMultiagentInput {
  return {
    type: multiagent.type,
    agents: multiagent.agents.map((entry) => {
      if (typeof entry === "string") return entry;
      switch (entry.type) {
        case "agent":
          return {
            type: entry.type,
            agentId: entry.id,
            ...(entry.version !== undefined && { version: entry.version }),
          };
        case "self":
          return { type: entry.type };
        case "advisor":
          return { type: entry.type, model: entry.model };
      }
    }),
  };
}

export function toAgentToolInput(tool: WireTool): AgentToolInput {
  switch (tool.type) {
    case "agent_toolset_20260401":
      return {
        type: tool.type,
        ...(tool.configs !== undefined && {
          configs: tool.configs.map(toToolConfig),
        }),
        ...(tool.default_config !== undefined && {
          defaultConfig:
            tool.default_config === null
              ? null
              : toDefaultConfig(tool.default_config),
        }),
      };
    case "mcp_toolset":
      return {
        type: tool.type,
        mcpServerName: tool.mcp_server_name,
        ...(tool.configs !== undefined && {
          configs: tool.configs.map((config) => ({
            name: config.name,
            ...(config.enabled !== undefined && { enabled: config.enabled }),
            ...(config.permission_policy !== undefined && {
              permissionPolicy:
                config.permission_policy === null
                  ? null
                  : toPermissionPolicy(config.permission_policy),
            }),
          })),
        }),
        ...(tool.default_config !== undefined && {
          defaultConfig:
            tool.default_config === null
              ? null
              : toDefaultConfig(tool.default_config),
        }),
      };
    case "custom":
      return {
        description: tool.description,
        inputSchema: toCustomToolInputSchema(tool.input_schema),
        name: tool.name,
        type: tool.type,
      };
  }
}

function requireResolved<Value>(
  value: Value | null | undefined,
  field: string,
): Value {
  if (value === null || value === undefined) {
    throw new Error(`Application returned unresolved agent field ${field}`);
  }
  return value;
}

function fromPermissionPolicy(policy: AgentPermissionPolicy): object {
  return { type: policy.type };
}

function fromResolvedDefaultConfig(
  config: AgentToolDefaultConfigInput | null | undefined,
): object {
  const resolved = requireResolved(config, "defaultConfig");
  return {
    enabled: requireResolved(resolved.enabled, "defaultConfig.enabled"),
    permission_policy: fromPermissionPolicy(
      requireResolved(
        resolved.permissionPolicy,
        "defaultConfig.permissionPolicy",
      ),
    ),
  };
}

function fromResolvedToolConfig(config: AgentToolConfigInput): object {
  const common = {
    enabled: requireResolved(config.enabled, `${config.name}.enabled`),
    name: config.name,
    permission_policy: fromPermissionPolicy(
      requireResolved(
        config.permissionPolicy,
        `${config.name}.permissionPolicy`,
      ),
    ),
    type: requireResolved(config.type, `${config.name}.type`),
  };
  switch (config.name) {
    case "web_fetch":
      return {
        ...common,
        ...(config.allowedDomains !== undefined && {
          allowed_domains: config.allowedDomains,
        }),
        ...(config.blockedDomains !== undefined && {
          blocked_domains: config.blockedDomains,
        }),
        ...(config.maxContentTokens !== undefined && {
          max_content_tokens: config.maxContentTokens,
        }),
      };
    case "web_search":
      return {
        ...common,
        ...(config.allowedDomains !== undefined && {
          allowed_domains: config.allowedDomains,
        }),
        ...(config.blockedDomains !== undefined && {
          blocked_domains: config.blockedDomains,
        }),
        ...(config.userLocation !== undefined && {
          user_location:
            config.userLocation === null
              ? null
              : {
                  type: config.userLocation.type,
                  ...(config.userLocation.city !== undefined && {
                    city: config.userLocation.city,
                  }),
                  ...(config.userLocation.country !== undefined && {
                    country: config.userLocation.country,
                  }),
                  ...(config.userLocation.region !== undefined && {
                    region: config.userLocation.region,
                  }),
                  ...(config.userLocation.timezone !== undefined && {
                    timezone: config.userLocation.timezone,
                  }),
                },
        }),
      };
    default:
      return common;
  }
}

export function fromAgentMcpServerInput(server: AgentMcpServerInput): object {
  return { name: server.name, type: server.type, url: server.url };
}

export function fromAgentSkillInput(skill: AgentSkillInput): object {
  return {
    skill_id: skill.skillId,
    type: skill.type,
    version: requireResolved(skill.version, `${skill.type} skill version`),
  };
}

export function fromAgentMultiagentInput(
  multiagent: AgentMultiagentInput,
): object {
  return {
    type: multiagent.type,
    agents: multiagent.agents.map((entry) => {
      if (typeof entry === "string" || entry.type === "self") {
        throw new Error("Application returned an unresolved multiagent roster entry");
      }
      if (entry.type === "advisor") {
        return { type: entry.type, model: entry.model };
      }
      return {
        type: entry.type,
        id: entry.agentId,
        version: requireResolved(entry.version, "multiagent agent version"),
      };
    }),
  };
}

export function fromAgentToolInput(tool: AgentToolInput): object {
  switch (tool.type) {
    case "agent_toolset_20260401":
      return {
        type: tool.type,
        configs: requireResolved(tool.configs, "agent toolset configs").map(
          fromResolvedToolConfig,
        ),
        default_config: fromResolvedDefaultConfig(tool.defaultConfig),
      };
    case "mcp_toolset":
      return {
        type: tool.type,
        mcp_server_name: tool.mcpServerName,
        configs: requireResolved(tool.configs, "MCP toolset configs").map(
          (config) => ({
            name: config.name,
            enabled: requireResolved(
              config.enabled,
              `${config.name}.enabled`,
            ),
            permission_policy: fromPermissionPolicy(
              requireResolved(
                config.permissionPolicy,
                `${config.name}.permissionPolicy`,
              ),
            ),
          }),
        ),
        default_config: fromResolvedDefaultConfig(tool.defaultConfig),
      };
    case "custom":
      return {
        description: tool.description,
        input_schema: tool.inputSchema,
        name: tool.name,
        type: tool.type,
      };
  }
}

export function fromAgentModel(model: AgentModel): object {
  return {
    id: model.id,
    ...(model.effort !== undefined && {
      effort: { type: model.effort },
    }),
    ...(model.inferenceGeo !== undefined && {
      inference_geo: model.inferenceGeo,
    }),
    ...(model.speed !== undefined && { speed: model.speed }),
  };
}

export function fromSessionThreadAgent(agent: SessionThreadAgent): object {
  if (agent.type === "advisor") {
    return { type: agent.type, model: agent.model };
  }
  return {
    id: agent.id,
    description: agent.description,
    mcp_servers: agent.mcpServers.map(fromAgentMcpServerInput),
    model: fromAgentModel(agent.model),
    name: agent.name,
    ...(agent.openma !== undefined &&
      Object.keys(agent.openma).length > 0 && {
        _oma: fromOpenMaAgentExtension(agent.openma),
      }),
    skills: agent.skills.map(fromAgentSkillInput),
    system: agent.system,
    tools: agent.tools.map(fromAgentToolInput),
    type: agent.type,
    version: agent.version,
  };
}
