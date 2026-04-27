import type { Client } from "../client.js";
import type { EnvironmentSummary, PaginatedResponse } from "../types.js";

export interface CreateEnvironmentInput {
  name: string;
  config: { type: string; [k: string]: unknown };
}

export class EnvironmentsResource {
  constructor(private readonly client: Client) {}

  async list(): Promise<PaginatedResponse<EnvironmentSummary>> {
    return this.client.request<PaginatedResponse<EnvironmentSummary>>("GET", "/v1/environments");
  }

  async get(environmentId: string): Promise<EnvironmentSummary> {
    return this.client.request<EnvironmentSummary>("GET", `/v1/environments/${environmentId}`);
  }

  async create(input: CreateEnvironmentInput): Promise<EnvironmentSummary> {
    return this.client.request<EnvironmentSummary>("POST", "/v1/environments", { body: input });
  }

  async delete(environmentId: string): Promise<void> {
    await this.client.request("DELETE", `/v1/environments/${environmentId}`);
  }
}
