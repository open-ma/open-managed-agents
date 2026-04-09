/**
 * TypeScript client SDK for the Managed Agents API.
 *
 * Usage:
 *   import { ManagedAgentsClient } from "open-managed-agents/sdk";
 *   const client = new ManagedAgentsClient({ apiKey: "...", baseUrl: "https://..." });
 */

import type {
  AgentConfig,
  EnvironmentConfig,
  SessionMeta,
  SessionEvent,
  VaultConfig,
  CredentialConfig,
  CredentialAuth,
  MemoryStoreConfig,
  MemoryItem,
  MemoryVersion,
  FileRecord,
  SessionResource,
  ToolConfig,
  StoredEvent,
  ContentBlock,
  UserMessageEvent,
  UserInterruptEvent,
  UserToolConfirmationEvent,
  UserCustomToolResultEvent,
  UserDefineOutcomeEvent,
} from "../types";

// Re-export types for SDK consumers
export type {
  AgentConfig,
  EnvironmentConfig,
  SessionMeta,
  SessionEvent,
  VaultConfig,
  CredentialConfig,
  CredentialAuth,
  MemoryStoreConfig,
  MemoryItem,
  MemoryVersion,
  FileRecord,
  SessionResource,
  ToolConfig,
  StoredEvent,
  ContentBlock,
};

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** Standard paginated list response. */
export interface ListResponse<T> {
  data: T[];
}

/** Error thrown when the API returns a non-2xx status. */
export class ManagedAgentsError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ManagedAgentsError";
  }
}

/** Input event types the SDK can send. */
export type InputEvent =
  | UserMessageEvent
  | UserInterruptEvent
  | UserToolConfirmationEvent
  | UserCustomToolResultEvent
  | UserDefineOutcomeEvent;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface ClientOptions {
  apiKey: string;
  baseUrl: string;
}

export class ManagedAgentsClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  readonly agents: AgentsAPI;
  readonly environments: EnvironmentsAPI;
  readonly sessions: SessionsAPI;
  readonly vaults: VaultsAPI;
  readonly memoryStores: MemoryStoresAPI;
  readonly files: FilesAPI;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;

    this.agents = new AgentsAPI(this);
    this.environments = new EnvironmentsAPI(this);
    this.sessions = new SessionsAPI(this);
    this.vaults = new VaultsAPI(this);
    this.memoryStores = new MemoryStoresAPI(this);
    this.files = new FilesAPI(this);
  }

  /** Low-level fetch that adds auth and content-type headers. */
  async fetch(path: string, opts: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      "x-api-key": this.apiKey,
      ...(opts.headers as Record<string, string> | undefined),
    };
    // Only set Content-Type for requests with a body
    if (opts.body !== undefined && opts.body !== null && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    return fetch(`${this.baseUrl}${path}`, { ...opts, headers });
  }

  /** Fetch + parse JSON response with error handling. */
  async fetchJSON<T>(path: string, opts: RequestInit = {}): Promise<T> {
    const res = await this.fetch(path, opts);
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new ManagedAgentsError(
        res.status,
        (body as Record<string, string>).error || `HTTP ${res.status}`,
      );
    }
    // 202 Accepted — no body (e.g. event send)
    if (res.status === 202 || res.status === 204) return null as T;
    return res.json() as Promise<T>;
  }
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export interface AgentCreateParams {
  name: string;
  model: string | { id: string; speed?: "standard" | "fast" };
  system?: string;
  tools?: ToolConfig[];
  harness?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentUpdateParams {
  name?: string;
  model?: string | { id: string; speed?: "standard" | "fast" };
  system?: string;
  tools?: ToolConfig[];
  description?: string;
}

export interface AgentListParams {
  limit?: number;
  order?: "asc" | "desc";
}

class AgentVersionsAPI {
  constructor(private client: ManagedAgentsClient) {}

  async list(agentId: string): Promise<ListResponse<AgentConfig>> {
    return this.client.fetchJSON(`/v1/agents/${agentId}/versions`);
  }

  async get(agentId: string, version: number): Promise<AgentConfig> {
    return this.client.fetchJSON(`/v1/agents/${agentId}/versions/${version}`);
  }
}

export class AgentsAPI {
  readonly versions: AgentVersionsAPI;

  constructor(private client: ManagedAgentsClient) {
    this.versions = new AgentVersionsAPI(client);
  }

  async create(params: AgentCreateParams): Promise<AgentConfig> {
    return this.client.fetchJSON("/v1/agents", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async list(params?: AgentListParams): Promise<ListResponse<AgentConfig>> {
    const qs = params ? toQueryString(params) : "";
    return this.client.fetchJSON(`/v1/agents${qs ? "?" + qs : ""}`);
  }

  async get(id: string): Promise<AgentConfig> {
    return this.client.fetchJSON(`/v1/agents/${id}`);
  }

  async update(id: string, params: AgentUpdateParams): Promise<AgentConfig> {
    return this.client.fetchJSON(`/v1/agents/${id}`, {
      method: "PUT",
      body: JSON.stringify(params),
    });
  }

  async archive(id: string): Promise<AgentConfig> {
    return this.client.fetchJSON(`/v1/agents/${id}/archive`, { method: "POST" });
  }

  async delete(id: string): Promise<{ type: string; id: string }> {
    return this.client.fetchJSON(`/v1/agents/${id}`, { method: "DELETE" });
  }
}

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

export interface EnvironmentCreateParams {
  name: string;
  config?: EnvironmentConfig["config"];
}

export interface EnvironmentUpdateParams {
  name?: string;
  config?: EnvironmentConfig["config"];
}

export class EnvironmentsAPI {
  constructor(private client: ManagedAgentsClient) {}

  async create(params: EnvironmentCreateParams): Promise<EnvironmentConfig> {
    return this.client.fetchJSON("/v1/environments", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async list(): Promise<ListResponse<EnvironmentConfig>> {
    return this.client.fetchJSON("/v1/environments");
  }

  async get(id: string): Promise<EnvironmentConfig> {
    return this.client.fetchJSON(`/v1/environments/${id}`);
  }

  async update(id: string, params: EnvironmentUpdateParams): Promise<EnvironmentConfig> {
    return this.client.fetchJSON(`/v1/environments/${id}`, {
      method: "PUT",
      body: JSON.stringify(params),
    });
  }

  async archive(id: string): Promise<EnvironmentConfig> {
    return this.client.fetchJSON(`/v1/environments/${id}/archive`, { method: "POST" });
  }

  async delete(id: string): Promise<{ type: string; id: string }> {
    return this.client.fetchJSON(`/v1/environments/${id}`, { method: "DELETE" });
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface SessionCreateParams {
  agent: string;
  environment_id: string;
  title?: string;
  vault_ids?: string[];
  resources?: Array<{
    type: "file" | "memory_store";
    file_id?: string;
    memory_store_id?: string;
    mount_path?: string;
    access?: "read_write" | "read_only";
  }>;
}

export interface SessionListParams {
  agent_id?: string;
  limit?: number;
  order?: "asc" | "desc";
  include_archived?: boolean;
}

export interface SessionUpdateParams {
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface EventSendParams {
  events: InputEvent[];
}

export interface EventListParams {
  limit?: number;
  order?: "asc" | "desc";
  after?: string;
}

export interface ResourceCreateParams {
  type: "file" | "memory_store";
  file_id?: string;
  memory_store_id?: string;
  mount_path?: string;
}

class SessionEventsAPI {
  constructor(private client: ManagedAgentsClient) {}

  /** Send user events to a session (POST). Returns void (202). */
  async send(sessionId: string, params: EventSendParams): Promise<void> {
    await this.client.fetchJSON(`/v1/sessions/${sessionId}/events`, {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  /** List stored events as JSON (GET without SSE accept header). */
  async list(sessionId: string, params?: EventListParams): Promise<ListResponse<StoredEvent>> {
    const qs = params ? toQueryString(params) : "";
    return this.client.fetchJSON(`/v1/sessions/${sessionId}/events${qs ? "?" + qs : ""}`);
  }

  /**
   * Open an SSE stream and yield parsed SessionEvents.
   *
   * Usage:
   *   for await (const event of client.sessions.events.stream(sessionId)) {
   *     if (event.type === "agent.message") console.log(event.content);
   *     if (event.type === "session.status_idle") break;
   *   }
   */
  async *stream(sessionId: string): AsyncGenerator<SessionEvent> {
    const res = await this.client.fetch(`/v1/sessions/${sessionId}/events`, {
      headers: {
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new ManagedAgentsError(
        res.status,
        (body as Record<string, string>).error || `HTTP ${res.status}`,
      );
    }

    if (!res.body) {
      throw new ManagedAgentsError(0, "Response body is null — SSE streaming not available");
    }

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop()!;

        for (const part of parts) {
          const dataLine = part
            .split("\n")
            .find((line) => line.startsWith("data: "));
          if (!dataLine) continue;
          const json = dataLine.slice(6);
          if (!json) continue;
          yield JSON.parse(json) as SessionEvent;
        }
      }

      // Process any remaining buffered data
      if (buffer.trim()) {
        const dataLine = buffer
          .split("\n")
          .find((line) => line.startsWith("data: "));
        if (dataLine) {
          const json = dataLine.slice(6);
          if (json) {
            yield JSON.parse(json) as SessionEvent;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

class SessionResourcesAPI {
  constructor(private client: ManagedAgentsClient) {}

  async create(sessionId: string, params: ResourceCreateParams): Promise<SessionResource> {
    return this.client.fetchJSON(`/v1/sessions/${sessionId}/resources`, {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async list(sessionId: string): Promise<ListResponse<SessionResource>> {
    return this.client.fetchJSON(`/v1/sessions/${sessionId}/resources`);
  }

  async delete(sessionId: string, resourceId: string): Promise<{ type: string; id: string }> {
    return this.client.fetchJSON(`/v1/sessions/${sessionId}/resources/${resourceId}`, {
      method: "DELETE",
    });
  }
}

export class SessionsAPI {
  readonly events: SessionEventsAPI;
  readonly resources: SessionResourcesAPI;

  constructor(private client: ManagedAgentsClient) {
    this.events = new SessionEventsAPI(client);
    this.resources = new SessionResourcesAPI(client);
  }

  async create(params: SessionCreateParams): Promise<SessionMeta> {
    return this.client.fetchJSON("/v1/sessions", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async list(params?: SessionListParams): Promise<ListResponse<SessionMeta>> {
    const qs = params ? toQueryString(params) : "";
    return this.client.fetchJSON(`/v1/sessions${qs ? "?" + qs : ""}`);
  }

  async get(id: string): Promise<SessionMeta> {
    return this.client.fetchJSON(`/v1/sessions/${id}`);
  }

  async update(id: string, params: SessionUpdateParams): Promise<SessionMeta> {
    return this.client.fetchJSON(`/v1/sessions/${id}`, {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async archive(id: string): Promise<SessionMeta> {
    return this.client.fetchJSON(`/v1/sessions/${id}/archive`, { method: "POST" });
  }

  async delete(id: string): Promise<{ type: string; id: string }> {
    return this.client.fetchJSON(`/v1/sessions/${id}`, { method: "DELETE" });
  }
}

// ---------------------------------------------------------------------------
// Vaults
// ---------------------------------------------------------------------------

export interface VaultCreateParams {
  name: string;
}

export interface VaultListParams {
  include_archived?: boolean;
}

export interface CredentialCreateParams {
  display_name: string;
  auth: CredentialAuth;
}

export interface CredentialUpdateParams {
  display_name?: string;
  auth?: Partial<CredentialAuth>;
}

class VaultCredentialsAPI {
  constructor(private client: ManagedAgentsClient) {}

  async create(vaultId: string, params: CredentialCreateParams): Promise<CredentialConfig> {
    return this.client.fetchJSON(`/v1/vaults/${vaultId}/credentials`, {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async list(vaultId: string): Promise<ListResponse<CredentialConfig>> {
    return this.client.fetchJSON(`/v1/vaults/${vaultId}/credentials`);
  }

  async update(
    vaultId: string,
    credentialId: string,
    params: CredentialUpdateParams,
  ): Promise<CredentialConfig> {
    return this.client.fetchJSON(`/v1/vaults/${vaultId}/credentials/${credentialId}`, {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async archive(vaultId: string, credentialId: string): Promise<CredentialConfig> {
    return this.client.fetchJSON(`/v1/vaults/${vaultId}/credentials/${credentialId}/archive`, {
      method: "POST",
    });
  }

  async delete(vaultId: string, credentialId: string): Promise<{ type: string; id: string }> {
    return this.client.fetchJSON(`/v1/vaults/${vaultId}/credentials/${credentialId}`, {
      method: "DELETE",
    });
  }
}

export class VaultsAPI {
  readonly credentials: VaultCredentialsAPI;

  constructor(private client: ManagedAgentsClient) {
    this.credentials = new VaultCredentialsAPI(client);
  }

  async create(params: VaultCreateParams): Promise<VaultConfig> {
    return this.client.fetchJSON("/v1/vaults", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async list(params?: VaultListParams): Promise<ListResponse<VaultConfig>> {
    const qs = params ? toQueryString(params) : "";
    return this.client.fetchJSON(`/v1/vaults${qs ? "?" + qs : ""}`);
  }

  async get(id: string): Promise<VaultConfig> {
    return this.client.fetchJSON(`/v1/vaults/${id}`);
  }

  async archive(id: string): Promise<VaultConfig> {
    return this.client.fetchJSON(`/v1/vaults/${id}/archive`, { method: "POST" });
  }

  async delete(id: string): Promise<{ type: string; id: string }> {
    return this.client.fetchJSON(`/v1/vaults/${id}`, { method: "DELETE" });
  }
}

// ---------------------------------------------------------------------------
// Memory Stores
// ---------------------------------------------------------------------------

export interface MemoryStoreCreateParams {
  name: string;
  description?: string;
}

export interface MemoryStoreListParams {
  include_archived?: boolean;
}

export interface MemoryWriteParams {
  path: string;
  content: string;
  precondition?: { type: "not_exists" };
}

export interface MemoryUpdateParams {
  path?: string;
  content?: string;
  precondition?: { type: "content_sha256"; content_sha256: string };
}

export interface MemoryListParams {
  prefix?: string;
}

export interface MemoryVersionListParams {
  memory_id?: string;
}

class MemoriesAPI {
  constructor(private client: ManagedAgentsClient) {}

  async write(storeId: string, params: MemoryWriteParams): Promise<MemoryItem> {
    return this.client.fetchJSON(`/v1/memory_stores/${storeId}/memories`, {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async list(storeId: string, params?: MemoryListParams): Promise<ListResponse<Omit<MemoryItem, "content">>> {
    const qs = params ? toQueryString(params) : "";
    return this.client.fetchJSON(`/v1/memory_stores/${storeId}/memories${qs ? "?" + qs : ""}`);
  }

  async get(storeId: string, memoryId: string): Promise<MemoryItem> {
    return this.client.fetchJSON(`/v1/memory_stores/${storeId}/memories/${memoryId}`);
  }

  async update(storeId: string, memoryId: string, params: MemoryUpdateParams): Promise<MemoryItem> {
    return this.client.fetchJSON(`/v1/memory_stores/${storeId}/memories/${memoryId}`, {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async delete(storeId: string, memoryId: string): Promise<{ type: string; id: string }> {
    return this.client.fetchJSON(`/v1/memory_stores/${storeId}/memories/${memoryId}`, {
      method: "DELETE",
    });
  }
}

class MemoryVersionsAPI {
  constructor(private client: ManagedAgentsClient) {}

  async list(
    storeId: string,
    params?: MemoryVersionListParams,
  ): Promise<ListResponse<Omit<MemoryVersion, "content">>> {
    const qs = params ? toQueryString(params) : "";
    return this.client.fetchJSON(`/v1/memory_stores/${storeId}/memory_versions${qs ? "?" + qs : ""}`);
  }

  async get(storeId: string, versionId: string): Promise<MemoryVersion> {
    return this.client.fetchJSON(`/v1/memory_stores/${storeId}/memory_versions/${versionId}`);
  }

  async redact(storeId: string, versionId: string): Promise<MemoryVersion> {
    return this.client.fetchJSON(
      `/v1/memory_stores/${storeId}/memory_versions/${versionId}/redact`,
      { method: "POST" },
    );
  }
}

export class MemoryStoresAPI {
  readonly memories: MemoriesAPI;
  readonly versions: MemoryVersionsAPI;

  constructor(private client: ManagedAgentsClient) {
    this.memories = new MemoriesAPI(client);
    this.versions = new MemoryVersionsAPI(client);
  }

  async create(params: MemoryStoreCreateParams): Promise<MemoryStoreConfig> {
    return this.client.fetchJSON("/v1/memory_stores", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async list(params?: MemoryStoreListParams): Promise<ListResponse<MemoryStoreConfig>> {
    const qs = params ? toQueryString(params) : "";
    return this.client.fetchJSON(`/v1/memory_stores${qs ? "?" + qs : ""}`);
  }

  async get(id: string): Promise<MemoryStoreConfig> {
    return this.client.fetchJSON(`/v1/memory_stores/${id}`);
  }

  async archive(id: string): Promise<MemoryStoreConfig> {
    return this.client.fetchJSON(`/v1/memory_stores/${id}/archive`, { method: "POST" });
  }

  async delete(id: string): Promise<{ type: string; id: string }> {
    return this.client.fetchJSON(`/v1/memory_stores/${id}`, { method: "DELETE" });
  }
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export interface FileUploadParams {
  filename: string;
  content: string;
  media_type?: string;
  scope_id?: string;
}

export interface FileListParams {
  scope_id?: string;
  limit?: number;
  order?: "asc" | "desc";
}

export class FilesAPI {
  constructor(private client: ManagedAgentsClient) {}

  async upload(params: FileUploadParams): Promise<FileRecord> {
    return this.client.fetchJSON("/v1/files", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async list(params?: FileListParams): Promise<ListResponse<FileRecord>> {
    const qs = params ? toQueryString(params) : "";
    return this.client.fetchJSON(`/v1/files${qs ? "?" + qs : ""}`);
  }

  async get(id: string): Promise<FileRecord> {
    return this.client.fetchJSON(`/v1/files/${id}`);
  }

  async download(id: string): Promise<string> {
    const res = await this.client.fetch(`/v1/files/${id}/content`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new ManagedAgentsError(
        res.status,
        (body as Record<string, string>).error || `HTTP ${res.status}`,
      );
    }
    return res.text();
  }

  async delete(id: string): Promise<{ type: string; id: string }> {
    return this.client.fetchJSON(`/v1/files/${id}`, { method: "DELETE" });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toQueryString(params: any): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) {
      qs.set(k, String(v));
    }
  }
  return qs.toString();
}
