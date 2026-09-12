import type {
  BetaManagedAgentsAgent,
  BetaManagedAgentsModelConfig,
} from "@anthropic-ai/sdk/resources/beta/agents/agents";

interface OpenMaAgentExtension {
  aux_model?: BetaManagedAgentsModelConfig;
  appendable_prompts?: string[];
  harness?: string;
  acp?: {
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
  };
  runtime_binding?: {
    runtime_id: string;
    acp_agent_id: string;
    local_skill_blocklist?: string[];
  };
  enable_general_subagent?: boolean;
}

/** The Console intentionally renders the official Managed Agent resource. */
export type AgentRecord = BetaManagedAgentsAgent & {
  _oma?: OpenMaAgentExtension;
};
