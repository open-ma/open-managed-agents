import type {
  AgentMcpServer,
  AgentMultiagent,
  AgentSkill,
  AgentTool,
} from "./definition";

export type AgentEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export type AgentSpeed = "standard" | "fast";

export interface AgentModel {
  id: string;
  effort?: AgentEffortLevel;
  inferenceGeo?: string;
  speed?: AgentSpeed;
}

export interface AgentAcpProcess {
  id?: string;
  command: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
}

export interface AgentAcpRestartPolicy {
  mode: "never" | "on-crash" | "always";
  maxRestarts?: number;
  windowMs?: number;
}

export interface AgentAcpConfig {
  agent: AgentAcpProcess;
  restart?: AgentAcpRestartPolicy;
  idleTimeoutMs?: number;
  perTurnTimeoutMs?: number;
}

export interface AgentRuntimeBinding {
  runtimeId: string;
  acpAgentId: string;
  localSkillBlocklist?: string[];
}

/**
 * OpenMA additions to the Anthropic Managed Agents resource. These values are
 * versioned with the Agent so a Session can pin one atomic configuration.
 */
export interface AgentOpenMaExtensions {
  auxiliaryModel?: AgentModel;
  appendablePrompts?: string[];
  harness?: string;
  acp?: AgentAcpConfig;
  runtimeBinding?: AgentRuntimeBinding;
  enableGeneralSubagent?: boolean;
}

export interface Agent {
  id: string;
  archivedAt: string | null;
  createdAt: string;
  description: string | null;
  mcpServers: AgentMcpServer[];
  metadata: Record<string, string>;
  model: AgentModel;
  multiagent: AgentMultiagent | null;
  name: string;
  openma?: AgentOpenMaExtensions;
  skills: AgentSkill[];
  system: string | null;
  tools: AgentTool[];
  updatedAt: string;
  version: number;
}
