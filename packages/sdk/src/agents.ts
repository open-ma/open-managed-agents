import type {
  BetaManagedAgentsModel,
  BetaManagedAgentsModelConfig,
  BetaManagedAgentsModelConfigParams,
} from "@anthropic-ai/sdk/resources/beta/agents/agents";

export type OpenMaAgentModelParams =
  | BetaManagedAgentsModel
  | BetaManagedAgentsModelConfigParams;

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
