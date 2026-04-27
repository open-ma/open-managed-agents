import type { Client } from "../client.js";
import type { AgentDetail, AgentSummary, PaginatedResponse } from "../types.js";

export interface CreateAgentInput {
  name: string;
  model: string;
  system: string;
  tools?: unknown[];
  skills?: string[];
  mcp_servers?: unknown[];
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateAgentInput {
  name?: string;
  model?: string;
  system?: string;
  tools?: unknown[];
  skills?: string[];
  mcp_servers?: unknown[];
  description?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ListAgentsOptions {
  archived?: boolean;
  limit?: number;
  cursor?: string;
}

export class AgentsResource {
  constructor(private readonly client: Client) {}

  async list(opts: ListAgentsOptions = {}): Promise<PaginatedResponse<AgentSummary>> {
    return this.client.request<PaginatedResponse<AgentSummary>>(
      "GET",
      "/v1/agents",
      { query: opts as Record<string, string | number | boolean | undefined> },
    );
  }

  async get(agentId: string): Promise<AgentDetail> {
    return this.client.request<AgentDetail>("GET", `/v1/agents/${agentId}`);
  }

  async create(input: CreateAgentInput): Promise<AgentDetail> {
    return this.client.request<AgentDetail>("POST", "/v1/agents", { body: input });
  }

  async update(agentId: string, input: UpdateAgentInput): Promise<AgentDetail> {
    return this.client.request<AgentDetail>("PUT", `/v1/agents/${agentId}`, { body: input });
  }

  async delete(agentId: string): Promise<void> {
    await this.client.request("DELETE", `/v1/agents/${agentId}`);
  }
}
