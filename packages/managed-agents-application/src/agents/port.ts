import type {
  Agent,
  AgentAcpConfig,
  AgentEffortLevel,
  AgentModel,
  AgentRuntimeBinding,
  AgentSpeed,
} from "../domain/agent";
import type { JsonObject } from "../domain/json";
import type {
  AgentMcpServerInput,
  AgentMultiagentInput,
  AgentSkillInput,
  AgentToolInput,
} from "../domain/agent-definition";

export type {
  AgentMcpServerInput,
  AgentMultiagentInput,
  AgentSkillInput,
  AgentToolInput,
} from "../domain/agent-definition";

export type { AgentEffortLevel, AgentSpeed } from "../domain/agent";

export interface AgentModelInput {
  id: string;
  effort?: AgentEffortLevel | null;
  inferenceGeo?: string | null;
  providerOptions?: JsonObject | null;
  speed?: AgentSpeed | null;
}

export interface AgentOpenMaInput {
  auxiliaryModel?: string | AgentModelInput | null;
  appendablePrompts?: string[] | null;
  harness?: string | null;
  acp?: AgentAcpConfig | null;
  runtimeBinding?: AgentRuntimeBinding | null;
  enableGeneralSubagent?: boolean | null;
  /** Internal protocol-adapter state, never accepted from the public API. */
  compatibility?: JsonObject | null;
}

export type AgentModelView = AgentModel;

export interface CreateAgentCommand {
  name: string;
  model: string | AgentModelInput;
  description?: string | null;
  mcpServers?: AgentMcpServerInput[];
  metadata?: Record<string, string>;
  multiagent?: AgentMultiagentInput | null;
  openma?: AgentOpenMaInput;
  skills?: AgentSkillInput[];
  system?: string | null;
  tools?: AgentToolInput[];
}

export interface RetrieveAgentQuery {
  agentId: string;
  version?: number;
}

export interface UpdateAgentCommand {
  agentId: string;
  description?: string | null;
  mcpServers?: AgentMcpServerInput[] | null;
  metadata?: Record<string, string | null> | null;
  model?: string | AgentModelInput;
  multiagent?: AgentMultiagentInput | null;
  name?: string;
  openma?: AgentOpenMaInput;
  skills?: AgentSkillInput[] | null;
  system?: string | null;
  tools?: AgentToolInput[] | null;
  expectedVersion?: number;
}

export interface ArchiveAgentCommand {
  agentId: string;
}

export interface ListAgentsQuery {
  pageSize?: number;
  cursor?: string;
  createdAtOrAfter?: string;
  createdAtOrBefore?: string;
  includeArchived?: boolean;
}

export interface ListAgentVersionsQuery {
  agentId: string;
  pageSize?: number;
  cursor?: string;
}

export type AgentView = Agent;

export type CreateAgentResult =
  | { type: "created"; agent: AgentView }
  | { type: "invalid_request"; message: string };

export type RetrieveAgentResult =
  | { type: "found"; agent: AgentView }
  | { type: "not_found" };

export type UpdateAgentResult =
  | { type: "updated"; agent: AgentView }
  | { type: "invalid_request"; message: string }
  | { type: "not_found" }
  | { type: "version_conflict"; message: string };

export type ArchiveAgentResult =
  | { type: "archived"; agent: AgentView }
  | { type: "not_found" };

export interface ListAgentsPage {
  agents: AgentView[];
  nextCursor: string | null;
}

export type ListAgentsResult =
  | { type: "page"; page: ListAgentsPage }
  | { type: "invalid_request"; message: string };

export type ListAgentVersionsResult =
  | { type: "page"; page: ListAgentsPage }
  | { type: "invalid_request"; message: string }
  | { type: "not_found" };

export interface AgentsApplicationPort {
  createAgent(command: CreateAgentCommand): Promise<CreateAgentResult>;
  retrieveAgent(query: RetrieveAgentQuery): Promise<RetrieveAgentResult>;
  updateAgent(command: UpdateAgentCommand): Promise<UpdateAgentResult>;
  archiveAgent(command: ArchiveAgentCommand): Promise<ArchiveAgentResult>;
  listAgents(query: ListAgentsQuery): Promise<ListAgentsResult>;
  listAgentVersions(query: ListAgentVersionsQuery): Promise<ListAgentVersionsResult>;
}
