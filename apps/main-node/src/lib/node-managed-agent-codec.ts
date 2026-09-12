import type {
  AgentCustomToolInputSchema,
  AgentTool,
  AgentToolConfig,
  Environment,
  AgentToolDefaultConfig,
  Session,
} from "@open-managed-agents/managed-agents-application";

export async function resolveNodeManagedAuxiliaryToolModel<Model>(
  session: Session,
  buildModel: (model: Session["agent"]["model"]) => Promise<Model>,
): Promise<{
  model: Model;
  modelInfo: { model_id: string };
  providerOptions?: Record<string, unknown>;
} | undefined> {
  const auxiliaryModel = session.agent.openma?.auxiliaryModel;
  if (auxiliaryModel === undefined) return undefined;
  return {
    model: await buildModel(auxiliaryModel),
    modelInfo: { model_id: auxiliaryModel.id },
    ...(auxiliaryModel.providerOptions !== undefined && {
      providerOptions: structuredClone(auxiliaryModel.providerOptions),
    }),
  };
}
import type { AgentConfig } from "@open-managed-agents/shared";

interface LegacyPermissionPolicy {
  type: "always_allow" | "always_ask";
}

interface LegacyToolDefaultConfig {
  enabled: boolean;
  permission_policy: LegacyPermissionPolicy;
}

interface LegacyToolUserLocation {
  type: "approximate";
  city?: string | null;
  country?: string | null;
  region?: string | null;
  timezone?: string | null;
}

interface LegacyAgentToolConfig {
  enabled: boolean;
  name: AgentToolConfig["name"];
  permission_policy: LegacyPermissionPolicy;
  type: AgentToolConfig["type"];
  allowed_domains?: string[];
  blocked_domains?: string[];
  max_content_tokens?: number | null;
  user_location?: LegacyToolUserLocation | null;
}

type LegacyAgentTool =
  | {
      type: "agent_toolset_20260401";
      configs: LegacyAgentToolConfig[];
      default_config: LegacyToolDefaultConfig;
    }
  | {
      type: "mcp_toolset";
      mcp_server_name: string;
      configs: Array<{
        name: string;
        enabled: boolean;
        permission_policy: LegacyPermissionPolicy;
      }>;
      default_config: LegacyToolDefaultConfig;
    }
  | {
      type: "custom";
      name: string;
      description: string;
      input_schema: AgentCustomToolInputSchema;
    };

interface LegacyMultiagent {
  type: "coordinator";
  agents: Array<
    | { type: "agent"; id: string; version: number }
    | { type: "advisor"; model: string }
  >;
}

export interface LegacyManagedHarnessAgentConfig
  extends Omit<AgentConfig, "tools" | "skills" | "callable_agents"> {
  tools: LegacyAgentTool[];
  skills: Array<{ type: "anthropic" | "custom"; skill_id: string; version: string }>;
  callable_agents?: Array<{ type: "agent"; id: string; version: number }>;
  multiagent?: LegacyMultiagent;
}

export interface LegacyHarnessEnvironmentConfig {
  networking?:
    | { type: "unrestricted" }
    | {
        type: "limited";
        allow_mcp_servers: boolean;
        allow_package_managers: boolean;
        allowed_hosts: string[];
      };
}

export function toLegacyHarnessEnvironmentConfig(
  environment: Environment,
): LegacyHarnessEnvironmentConfig {
  if (environment.config.type === "self_hosted") return {};
  const networking = environment.config.networking;
  return {
    networking: networking.type === "unrestricted"
      ? { type: "unrestricted" }
      : {
          type: "limited",
          allow_mcp_servers: networking.allowMcpServers,
          allow_package_managers: networking.allowPackageManagers,
          allowed_hosts: [...networking.allowedHosts],
        },
  };
}

function legacyPermissionPolicy(
  policy: AgentToolDefaultConfig["permissionPolicy"],
): LegacyPermissionPolicy {
  return { type: policy.type };
}

function legacyDefaultConfig(
  config: AgentToolDefaultConfig,
): LegacyToolDefaultConfig {
  return {
    enabled: config.enabled,
    permission_policy: legacyPermissionPolicy(config.permissionPolicy),
  };
}

function legacyToolConfig(config: AgentToolConfig): LegacyAgentToolConfig {
  const common: LegacyAgentToolConfig = {
    type: config.type,
    name: config.name,
    enabled: config.enabled,
    permission_policy: legacyPermissionPolicy(config.permissionPolicy),
  };
  switch (config.type) {
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

function legacyTool(tool: AgentTool): LegacyAgentTool {
  switch (tool.type) {
    case "agent_toolset_20260401":
      return {
        type: tool.type,
        configs: tool.configs.map(legacyToolConfig),
        default_config: legacyDefaultConfig(tool.defaultConfig),
      };
    case "mcp_toolset":
      return {
        type: tool.type,
        mcp_server_name: tool.mcpServerName,
        configs: tool.configs.map((config) => ({
          name: config.name,
          enabled: config.enabled,
          permission_policy: legacyPermissionPolicy(config.permissionPolicy),
        })),
        default_config: legacyDefaultConfig(tool.defaultConfig),
      };
    case "custom":
      return {
        type: tool.type,
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      };
  }
}

export function toLegacyHarnessAgentConfig(
  session: Session,
): LegacyManagedHarnessAgentConfig {
  const { agent } = session;
  const roster = agent.multiagent?.agents ?? [];
  const callableAgents = roster.flatMap((member) =>
    member.type === "agent"
      ? [{ type: member.type, id: member.id, version: member.version }]
      : [],
  );
  return {
    id: agent.id,
    name: agent.name,
    model: {
      id: agent.model.id,
      ...(agent.model.effort !== undefined && { effort: agent.model.effort }),
      ...(agent.model.inferenceGeo !== undefined && {
        inference_geo: agent.model.inferenceGeo,
      }),
      ...(agent.model.providerOptions !== undefined && {
        provider_options: structuredClone(agent.model.providerOptions),
      }),
      ...(agent.model.speed !== undefined && { speed: agent.model.speed }),
    },
    system: agent.system ?? "",
    tools: agent.tools.map(legacyTool),
    mcp_servers: agent.mcpServers.map((server) => ({ ...server })),
    skills: agent.skills.map((skill) => ({
      type: skill.type,
      skill_id: skill.skillId,
      version: skill.version,
    })),
    ...(callableAgents.length > 0 && { callable_agents: callableAgents }),
    ...(agent.multiagent !== null && {
      multiagent: {
        type: agent.multiagent.type,
        agents: roster.map((member) =>
          member.type === "advisor"
            ? { type: member.type, model: member.model }
            : { type: member.type, id: member.id, version: member.version },
        ),
      },
    }),
    ...(agent.description !== null && { description: agent.description }),
    ...(agent.openma?.auxiliaryModel !== undefined && {
      aux_model: {
        id: agent.openma.auxiliaryModel.id,
        ...(agent.openma.auxiliaryModel.effort !== undefined && {
          effort: agent.openma.auxiliaryModel.effort,
        }),
        ...(agent.openma.auxiliaryModel.inferenceGeo !== undefined && {
          inference_geo: agent.openma.auxiliaryModel.inferenceGeo,
        }),
        ...(agent.openma.auxiliaryModel.providerOptions !== undefined && {
          provider_options: structuredClone(
            agent.openma.auxiliaryModel.providerOptions,
          ),
        }),
        ...(agent.openma.auxiliaryModel.speed !== undefined && {
          speed: agent.openma.auxiliaryModel.speed,
        }),
      },
    }),
    ...(agent.openma?.appendablePrompts !== undefined && {
      appendable_prompts: agent.openma.appendablePrompts,
    }),
    ...(agent.openma?.harness !== undefined && {
      harness: agent.openma.harness,
    }),
    ...(agent.openma?.acp !== undefined && {
      acp: {
        agent: agent.openma.acp.agent,
        ...(agent.openma.acp.restart !== undefined && {
          restart: {
            mode: agent.openma.acp.restart.mode,
            ...(agent.openma.acp.restart.maxRestarts !== undefined && {
              max_restarts: agent.openma.acp.restart.maxRestarts,
            }),
            ...(agent.openma.acp.restart.windowMs !== undefined && {
              window_ms: agent.openma.acp.restart.windowMs,
            }),
          },
        }),
        ...(agent.openma.acp.idleTimeoutMs !== undefined && {
          idle_timeout_ms: agent.openma.acp.idleTimeoutMs,
        }),
        ...(agent.openma.acp.perTurnTimeoutMs !== undefined && {
          per_turn_timeout_ms: agent.openma.acp.perTurnTimeoutMs,
        }),
      },
    }),
    ...(agent.openma?.runtimeBinding !== undefined && {
      runtime_binding: {
        runtime_id: agent.openma.runtimeBinding.runtimeId,
        acp_agent_id: agent.openma.runtimeBinding.acpAgentId,
        ...(agent.openma.runtimeBinding.localSkillBlocklist !== undefined && {
          local_skill_blocklist:
            agent.openma.runtimeBinding.localSkillBlocklist,
        }),
      },
    }),
    ...(agent.openma?.enableGeneralSubagent !== undefined && {
      enable_general_subagent: agent.openma.enableGeneralSubagent,
    }),
    version: agent.version,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
  };
}

export function allowAllLegacyHarnessTools(
  agent: LegacyManagedHarnessAgentConfig,
): LegacyManagedHarnessAgentConfig {
  return {
    ...agent,
    tools: agent.tools.map((tool) => {
      switch (tool.type) {
        case "custom":
          return { ...tool };
        case "agent_toolset_20260401":
          return {
            ...tool,
            default_config: {
              ...tool.default_config,
              permission_policy: { type: "always_allow" as const },
            },
            configs: tool.configs.map((config) => ({
              ...config,
              permission_policy: { type: "always_allow" as const },
            })),
          };
        case "mcp_toolset":
          return {
            ...tool,
            default_config: {
              ...tool.default_config,
              permission_policy: { type: "always_allow" as const },
            },
            configs: tool.configs.map((config) => ({
              ...config,
              permission_policy: { type: "always_allow" as const },
            })),
          };
      }
    }),
  };
}
