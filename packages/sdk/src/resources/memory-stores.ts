import type { Client } from "../client.js";

// =================================================================
// Types — mirror Anthropic Managed Agents Memory shapes
// (https://platform.claude.com/docs/en/managed-agents/memory)
// =================================================================

export interface MemoryStore {
  id: string;
  name: string;
  description?: string;
  created_at: string;
  updated_at?: string;
  archived_at?: string;
}

export interface Memory {
  id: string;
  store_id: string;
  path: string;
  content: string;
  content_sha256: string;
  etag: string;
  size_bytes: number;
  created_at: string;
  updated_at: string;
}

export type MemoryListItem = Omit<Memory, "content">;

export interface MemoryVersion {
  id: string;
  memory_id: string;
  store_id: string;
  operation: "created" | "modified" | "deleted";
  path?: string;
  content?: string;
  content_sha256?: string;
  size_bytes?: number;
  actor: { type: "user" | "api_key" | "agent_session" | "system"; id: string };
  created_at: string;
  redacted?: boolean;
}

export type MemoryVersionListItem = Omit<MemoryVersion, "content">;

export type WritePrecondition =
  | { type: "not_exists" }
  | { type: "content_sha256"; content_sha256: string };

export interface CreateMemoryStoreInput {
  name: string;
  description?: string;
}

export interface ListMemoryStoresOptions {
  include_archived?: boolean;
}

export interface CreateMemoryInput {
  path: string;
  content: string;
  precondition?: WritePrecondition;
}

export interface ListMemoriesOptions {
  path_prefix?: string;
  /** Anthropic-aligned: limit how deep below path_prefix to surface entries. */
  depth?: number;
}

export interface UpdateMemoryInput {
  path?: string;
  content?: string;
  precondition?: WritePrecondition;
}

export interface ListMemoryVersionsOptions {
  memory_id?: string;
}

// =================================================================
// Resource: oma.memoryStores
// =================================================================

export class MemoryStoresResource {
  // Nested namespaces. Initialized in the constructor since `this.client`
  // isn't set yet at field-initializer time.
  readonly memories: MemoryStoresMemoriesResource;
  readonly memoryVersions: MemoryStoresMemoryVersionsResource;

  constructor(private readonly client: Client) {
    this.memories = new MemoryStoresMemoriesResource(client);
    this.memoryVersions = new MemoryStoresMemoryVersionsResource(client);
  }

  async create(input: CreateMemoryStoreInput): Promise<MemoryStore> {
    return this.client.request<MemoryStore>("POST", "/v1/memory_stores", { body: input });
  }

  async list(opts: ListMemoryStoresOptions = {}): Promise<{ data: MemoryStore[] }> {
    return this.client.request<{ data: MemoryStore[] }>("GET", "/v1/memory_stores", {
      query: opts as Record<string, string | number | boolean | undefined>,
    });
  }

  async retrieve(storeId: string): Promise<MemoryStore> {
    return this.client.request<MemoryStore>("GET", `/v1/memory_stores/${storeId}`);
  }

  async archive(storeId: string): Promise<MemoryStore> {
    return this.client.request<MemoryStore>("POST", `/v1/memory_stores/${storeId}/archive`);
  }

  async delete(storeId: string): Promise<void> {
    await this.client.request("DELETE", `/v1/memory_stores/${storeId}`);
  }
}

// =================================================================
// Sub-resource: oma.memoryStores.memories
// =================================================================

export class MemoryStoresMemoriesResource {
  constructor(private readonly client: Client) {}

  async create(storeId: string, input: CreateMemoryInput): Promise<Memory> {
    return this.client.request<Memory>(
      "POST",
      `/v1/memory_stores/${storeId}/memories`,
      { body: input },
    );
  }

  async list(
    storeId: string,
    opts: ListMemoriesOptions = {},
  ): Promise<{ data: MemoryListItem[] }> {
    return this.client.request<{ data: MemoryListItem[] }>(
      "GET",
      `/v1/memory_stores/${storeId}/memories`,
      { query: opts as Record<string, string | number | boolean | undefined> },
    );
  }

  async retrieve(storeId: string, memoryId: string): Promise<Memory> {
    return this.client.request<Memory>(
      "GET",
      `/v1/memory_stores/${storeId}/memories/${memoryId}`,
    );
  }

  async update(
    storeId: string,
    memoryId: string,
    input: UpdateMemoryInput,
  ): Promise<Memory> {
    return this.client.request<Memory>(
      "POST",
      `/v1/memory_stores/${storeId}/memories/${memoryId}`,
      { body: input },
    );
  }

  async delete(
    storeId: string,
    memoryId: string,
    opts: { expected_content_sha256?: string } = {},
  ): Promise<void> {
    await this.client.request(
      "DELETE",
      `/v1/memory_stores/${storeId}/memories/${memoryId}`,
      { query: opts as Record<string, string | number | boolean | undefined> },
    );
  }
}

// =================================================================
// Sub-resource: oma.memoryStores.memoryVersions
// =================================================================

export class MemoryStoresMemoryVersionsResource {
  constructor(private readonly client: Client) {}

  async list(
    storeId: string,
    opts: ListMemoryVersionsOptions = {},
  ): Promise<{ data: MemoryVersionListItem[] }> {
    return this.client.request<{ data: MemoryVersionListItem[] }>(
      "GET",
      `/v1/memory_stores/${storeId}/memory_versions`,
      { query: opts as Record<string, string | number | boolean | undefined> },
    );
  }

  async retrieve(storeId: string, versionId: string): Promise<MemoryVersion> {
    return this.client.request<MemoryVersion>(
      "GET",
      `/v1/memory_stores/${storeId}/memory_versions/${versionId}`,
    );
  }

  /**
   * Wipes content/path/sha/size on a prior version. Refuses the live head
   * (write a new version first or delete the memory). Audit row is preserved.
   */
  async redact(storeId: string, versionId: string): Promise<MemoryVersion> {
    return this.client.request<MemoryVersion>(
      "POST",
      `/v1/memory_stores/${storeId}/memory_versions/${versionId}/redact`,
    );
  }
}
