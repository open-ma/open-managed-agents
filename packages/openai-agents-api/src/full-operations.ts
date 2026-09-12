export interface OpenAIAgentsOperationDefinition {
  operation: string;
  method: "GET" | "POST" | "DELETE";
  path: string;
  bodySchema?: string;
  querySchema?: string;
  omit?: string[];
  responseSchema?: string;
  mode?: "page" | "tokenPage" | "stream" | "binary" | "void";
}

// Public HTTP operations in openai@7.15.0. sessions.stream is an SDK helper that
// composes retrieve + events.stream + events.create, not an additional endpoint.
export const openAIAgentsOperations = [
  { operation: "agents.create", method: "POST", path: "/v1/agents", bodySchema: "agents.AgentCreateParams", responseSchema: "agents.Agent" },
  { operation: "agents.list", method: "GET", path: "/v1/agents", querySchema: "agents.AgentListParams", responseSchema: "agents.Agent", mode: "page" },
  { operation: "environments.templates.create", method: "POST", path: "/v1/agents/environments/templates", bodySchema: "environments.templates.TemplateCreateParams", responseSchema: "environments.templates.EnvironmentTemplate" },
  { operation: "environments.templates.list", method: "GET", path: "/v1/agents/environments/templates", querySchema: "environments.templates.TemplateListParams", responseSchema: "environments.templates.EnvironmentTemplate", mode: "page" },
  { operation: "environments.templates.retrieve", method: "GET", path: "/v1/agents/environments/templates/:environment_template_id", responseSchema: "environments.templates.EnvironmentTemplate" },
  { operation: "environments.templates.update", method: "POST", path: "/v1/agents/environments/templates/:environment_template_id", bodySchema: "environments.templates.TemplateUpdateParams", responseSchema: "environments.templates.EnvironmentTemplate" },
  { operation: "environments.templates.delete", method: "DELETE", path: "/v1/agents/environments/templates/:environment_template_id", responseSchema: "environments.templates.EnvironmentTemplateDeleted" },
  { operation: "environments.retrieve", method: "GET", path: "/v1/agents/environments/:environment_id", responseSchema: "environments.EnvironmentInfo" },
  { operation: "environments.files.create", method: "POST", path: "/v1/agents/environments/:environment_id/files", bodySchema: "environments.files.FileCreateParams", responseSchema: "environments.files.EnvironmentFile" },
  { operation: "environments.files.list", method: "GET", path: "/v1/agents/environments/:environment_id/files", querySchema: "environments.files.FileListParams", responseSchema: "environments.files.EnvironmentFile", mode: "tokenPage" },
  { operation: "sessions.create", method: "POST", path: "/v1/agents/sessions", bodySchema: "sessions.SessionCreateParamsBase", responseSchema: "agents.AgentSession" },
  { operation: "sessions.list", method: "GET", path: "/v1/agents/sessions", querySchema: "sessions.SessionListParams", responseSchema: "agents.AgentSession", mode: "page" },
  { operation: "sessions.retrieve", method: "GET", path: "/v1/agents/sessions/:session_id", responseSchema: "agents.AgentSession" },
  { operation: "sessions.update", method: "POST", path: "/v1/agents/sessions/:session_id", bodySchema: "sessions.SessionUpdateParams", responseSchema: "agents.AgentSession" },
  { operation: "sessions.delete", method: "DELETE", path: "/v1/agents/sessions/:session_id", responseSchema: "agents.AgentSessionDeleted" },
  { operation: "sessions.subagents.list", method: "GET", path: "/v1/agents/sessions/:session_id/subagents", querySchema: "sessions.subagents.SubagentListParams", responseSchema: "agents.Subagent", mode: "page" },
  { operation: "sessions.subagents.retrieve", method: "GET", path: "/v1/agents/sessions/:session_id/subagents/:subagent_id", responseSchema: "agents.Subagent" },
  { operation: "sessions.subagents.items.list", method: "GET", path: "/v1/agents/sessions/:session_id/subagents/:subagent_id/items", querySchema: "sessions.subagents.items.ItemListParams", omit: ["session_id"], responseSchema: "agents.AgentSessionItem", mode: "page" },
  { operation: "sessions.subagents.turns.list", method: "GET", path: "/v1/agents/sessions/:session_id/subagents/:subagent_id/turns", querySchema: "sessions.subagents.turns.TurnListParams", omit: ["session_id"], responseSchema: "sessions.turns.Turn", mode: "page" },
  { operation: "sessions.subagents.turns.retrieve", method: "GET", path: "/v1/agents/sessions/:session_id/subagents/:subagent_id/turns/:turn_id", responseSchema: "sessions.turns.Turn" },
  { operation: "sessions.subagents.turns.items.list", method: "GET", path: "/v1/agents/sessions/:session_id/subagents/:subagent_id/turns/:turn_id/items", querySchema: "sessions.subagents.turns.items.ItemListParams", omit: ["session_id", "subagent_id"], responseSchema: "agents.AgentSessionItem", mode: "page" },
  { operation: "sessions.items.list", method: "GET", path: "/v1/agents/sessions/:session_id/items", querySchema: "sessions.items.ItemListParams", responseSchema: "agents.AgentSessionItem", mode: "page" },
  { operation: "sessions.turns.list", method: "GET", path: "/v1/agents/sessions/:session_id/turns", querySchema: "sessions.turns.TurnListParams", responseSchema: "sessions.turns.Turn", mode: "page" },
  { operation: "sessions.turns.retrieve", method: "GET", path: "/v1/agents/sessions/:session_id/turns/:turn_id", responseSchema: "sessions.turns.Turn" },
  { operation: "sessions.events.create", method: "POST", path: "/v1/agents/sessions/:session_id/events", bodySchema: "sessions.events.EventCreateParams", omit: ["Idempotency-Key"], mode: "void" },
  { operation: "sessions.events.stream", method: "GET", path: "/v1/agents/sessions/:session_id/events", responseSchema: "agents.AgentSessionEvent", mode: "stream" },
  { operation: "sessions.artifacts.list", method: "GET", path: "/v1/agents/sessions/:session_id/artifacts", querySchema: "sessions.artifacts.ArtifactListParams", responseSchema: "sessions.artifacts.SessionArtifact", mode: "page" },
  { operation: "sessions.artifacts.retrieve", method: "GET", path: "/v1/agents/sessions/:session_id/artifacts/:artifact_id", responseSchema: "sessions.artifacts.SessionArtifact" },
  { operation: "sessions.artifacts.delete", method: "DELETE", path: "/v1/agents/sessions/:session_id/artifacts/:artifact_id", responseSchema: "sessions.artifacts.SessionArtifactDeleted" },
  { operation: "sessions.artifacts.content", method: "GET", path: "/v1/agents/sessions/:session_id/artifacts/:artifact_id/content", mode: "binary" },
  { operation: "agents.retrieve", method: "GET", path: "/v1/agents/:agent_id", responseSchema: "agents.Agent" },
  { operation: "agents.update", method: "POST", path: "/v1/agents/:agent_id", bodySchema: "agents.AgentUpdateParams", responseSchema: "agents.Agent" },
  { operation: "agents.delete", method: "DELETE", path: "/v1/agents/:agent_id", responseSchema: "agents.AgentDeleted" },
  { operation: "vaults.create", method: "POST", path: "/v1/vaults", bodySchema: "vaults.VaultCreateParams", responseSchema: "vaults.Vault" },
  { operation: "vaults.list", method: "GET", path: "/v1/vaults", querySchema: "vaults.VaultListParams", responseSchema: "vaults.Vault", mode: "page" },
  { operation: "vaults.retrieve", method: "GET", path: "/v1/vaults/:vault_id", responseSchema: "vaults.Vault" },
  { operation: "vaults.delete", method: "DELETE", path: "/v1/vaults/:vault_id", responseSchema: "vaults.VaultDeleted" },
  { operation: "vaults.credentials.create", method: "POST", path: "/v1/vaults/:vault_id/credentials", bodySchema: "vaults.credentials.CredentialCreateParams", responseSchema: "vaults.credentials.Credential" },
  { operation: "vaults.credentials.list", method: "GET", path: "/v1/vaults/:vault_id/credentials", querySchema: "vaults.credentials.CredentialListParams", responseSchema: "vaults.credentials.Credential", mode: "page" },
  { operation: "vaults.credentials.retrieve", method: "GET", path: "/v1/vaults/:vault_id/credentials/:credential_id", responseSchema: "vaults.credentials.Credential" },
  { operation: "vaults.credentials.update", method: "POST", path: "/v1/vaults/:vault_id/credentials/:credential_id", bodySchema: "vaults.credentials.CredentialUpdateParams", omit: ["vault_id"], responseSchema: "vaults.credentials.Credential" },
  { operation: "vaults.credentials.delete", method: "DELETE", path: "/v1/vaults/:vault_id/credentials/:credential_id", responseSchema: "vaults.credentials.CredentialDeleted" },
] as const satisfies readonly OpenAIAgentsOperationDefinition[];

export type OpenAIAgentsOperation = typeof openAIAgentsOperations[number]["operation"];
