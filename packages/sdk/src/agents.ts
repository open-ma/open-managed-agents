import type {
  AgentCreateParams,
  AgentUpdateParams,
  BetaManagedAgentsAgent,
  BetaManagedAgentsMCPServerURLDefinition,
  BetaManagedAgentsURLMCPServerParams,
  BetaManagedAgentsModel,
  BetaManagedAgentsModelConfig,
  BetaManagedAgentsModelConfigParams,
} from "@anthropic-ai/sdk/resources/beta/agents/agents";
import type Anthropic from "@anthropic-ai/sdk";
import type { APIPromise } from "@anthropic-ai/sdk/api-promise";

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

export type OpenMaAgentModelParams =
  | BetaManagedAgentsModel
  | BetaManagedAgentsModelConfigParams;

/** OpenMA extension for a standard MCP process launched inside the sandbox. */
export interface OpenMaStdioMcpServerParams {
  name: string;
  type: "stdio";
  /** Absolute executable path inside the sandbox. */
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type OpenMaMcpServerParams =
  | BetaManagedAgentsURLMCPServerParams
  | OpenMaStdioMcpServerParams;

export interface OpenMaStdioMcpServer {
  name: string;
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type OpenMaMcpServer =
  | BetaManagedAgentsMCPServerURLDefinition
  | OpenMaStdioMcpServer;

export type OpenMaAgentCreateParams = Omit<AgentCreateParams, "mcp_servers"> & {
  mcp_servers?: OpenMaMcpServerParams[];
};

export type OpenMaAgentUpdateParams = Omit<AgentUpdateParams, "mcp_servers"> & {
  mcp_servers?: OpenMaMcpServerParams[] | null;
};

export type OpenMaAgent = Omit<BetaManagedAgentsAgent, "mcp_servers"> & {
  mcp_servers: OpenMaMcpServer[];
};

export interface OpenMaAgentAcpParams {
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

export interface OpenMaAgentRuntimeBindingParams {
  runtime_id: string;
  acp_agent_id: string;
  local_skill_blocklist?: string[];
}

/** OpenMA's namespaced additions to an Agent create or update payload. */
export interface OpenMaAgentExtensionParams {
  aux_model?: OpenMaAgentModelParams | null;
  appendable_prompts?: string[] | null;
  harness?: string | null;
  acp?: OpenMaAgentAcpParams | null;
  runtime_binding?: OpenMaAgentRuntimeBindingParams | null;
  enable_general_subagent?: boolean | null;
}

export interface OpenMaAgentAcp {
  agent: {
    id?: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
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

/** OpenMA extension returned with an Agent when at least one value is set. */
export interface OpenMaAgentExtension {
  aux_model?: BetaManagedAgentsModelConfig;
  appendable_prompts?: string[];
  harness?: string;
  acp?: OpenMaAgentAcp;
  runtime_binding?: OpenMaAgentRuntimeBindingParams;
  enable_general_subagent?: boolean;
}

declare module "@anthropic-ai/sdk/resources/beta/agents/agents" {
  interface Agents {
    create(
      params: OpenMaAgentCreateParams,
      options?: Anthropic.RequestOptions,
    ): APIPromise<OpenMaAgent>;
    update(
      agentID: string,
      params: OpenMaAgentUpdateParams,
      options?: Anthropic.RequestOptions,
    ): APIPromise<OpenMaAgent>;
  }

  interface BetaManagedAgentsModelConfigParams {
    /** OpenMA extension for provider-namespaced inference options. */
    provider_options?: OpenMaProviderOptions | null;
  }

  interface BetaManagedAgentsModelConfig {
    /** Resolved OpenMA provider-namespaced inference options. */
    provider_options?: OpenMaProviderOptions;
  }

  interface AgentCreateParams {
    /** OpenMA-only settings accepted by OpenMA endpoints. */
    _oma?: OpenMaAgentExtensionParams;
  }

  interface AgentUpdateParams {
    /** Patch OpenMA-only settings. Omit fields to preserve and use null to clear. */
    _oma?: OpenMaAgentExtensionParams;
  }

  interface BetaManagedAgentsAgent {
    /** OpenMA-only settings pinned to this Agent version. */
    _oma?: OpenMaAgentExtension;
  }

  interface BetaManagedAgentsSessionThreadAgent {
    /** OpenMA-only settings pinned to this thread's Agent version. */
    _oma?: OpenMaAgentExtension;
  }
}

declare module "@anthropic-ai/sdk/resources/beta/sessions/sessions" {
  interface BetaManagedAgentsSessionAgent {
    /** OpenMA-only settings pinned when the Session was created. */
    _oma?: OpenMaAgentExtension;
  }
}
