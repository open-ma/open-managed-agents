import type Anthropic from "@anthropic-ai/sdk";
import type { Api, Model as PiModel } from "@earendil-works/pi-ai";

/** Pi provider id. Built-ins and user-defined ids share this open shape. */
export type OmaModelProvider = string;

/**
 * Serializable Pi Model fields accepted by a Model Card. Identity, endpoint,
 * and credentials remain first-class Model Card fields and cannot be
 * overridden here.
 */
export type OmaPiModelConfig = Partial<
  Pick<
    PiModel<Api>,
    | "name"
    | "api"
    | "reasoning"
    | "thinkingLevelMap"
    | "input"
    | "cost"
    | "contextWindow"
    | "maxTokens"
    | "samplingParams"
    | "headers"
    | "compat"
  >
>;

export interface OmaProviderModel {
  id: string;
  name: string;
  provider?: string;
  api?: string;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  context_window?: number;
  max_tokens?: number;
}

export interface OmaModelListParams {
  provider: OmaModelProvider;
  /** @deprecated The SDK-first Pi catalog does not require provider credentials. */
  apiKey?: string;
}

export interface OmaModelListResponse {
  data: OmaProviderModel[];
}

export type OmaPath = `/v1/oma/${string}`;
export type OmaHTTPMethod = "get" | "post" | "put" | "patch" | "delete";

export interface OmaRequestParams
  extends Omit<Anthropic.RequestOptions, "method" | "path"> {
  method: OmaHTTPMethod;
  path: OmaPath;
}

export class OmaModelsResource {
  constructor(private readonly client: Anthropic) {}

  list(
    params: OmaModelListParams,
    options?: Anthropic.RequestOptions,
  ) {
    return this.client.post<OmaModelListResponse>("/v1/oma/models/list", {
      body: {
        provider: params.provider,
        ...(params.apiKey ? { api_key: params.apiKey } : {}),
      },
      ...options,
    });
  }
}

export interface OmaModelCard {
  id: string;
  /** Tenant-unique handle referenced by an Agent's `model.id`. */
  model_id: string;
  /** Wire-level model id sent through Pi. */
  model: string;
  provider: OmaModelProvider;
  api_key_preview?: string;
  base_url?: string;
  custom_headers?: Record<string, string>;
  pi_config?: OmaPiModelConfig;
  is_default: boolean;
  created_at: string;
  updated_at?: string;
  archived_at: string | null;
  probe?:
    | { ok: boolean; message?: string }
    | { ok: null; reason: "unsupported_provider" };
}

export interface OmaModelCardCreateParams {
  model_id: string;
  provider: OmaModelProvider;
  api_key: string;
  model?: string;
  base_url?: string;
  custom_headers?: Record<string, string>;
  pi_config?: OmaPiModelConfig;
  is_default?: boolean;
}

export interface OmaModelCardUpdateParams {
  model_id?: string;
  provider?: OmaModelProvider;
  api_key?: string;
  model?: string;
  base_url?: string | null;
  custom_headers?: Record<string, string> | null;
  pi_config?: OmaPiModelConfig | null;
  is_default?: boolean;
}

export interface OmaModelCardListParams {
  limit?: number;
  cursor?: string;
  q?: string;
  provider?: OmaModelProvider;
  created_after?: string;
  created_before?: string;
}

export interface OmaModelCardListResponse {
  data: OmaModelCard[];
  next_page?: string;
  next_cursor?: string;
}

export interface OmaModelCardDeleted {
  type: "model_card_deleted";
  id: string;
}

export class OmaModelCardsResource {
  constructor(private readonly client: Anthropic) {}

  create(
    params: OmaModelCardCreateParams,
    options?: Anthropic.RequestOptions,
  ) {
    return this.client.post<OmaModelCard>("/v1/oma/model_cards", {
      body: params,
      ...options,
    });
  }

  list(
    params: OmaModelCardListParams = {},
    options?: Anthropic.RequestOptions,
  ) {
    return this.client.get<OmaModelCardListResponse>("/v1/oma/model_cards", {
      query: params,
      ...options,
    });
  }

  retrieve(id: string, options?: Anthropic.RequestOptions) {
    return this.client.get<OmaModelCard>(
      `/v1/oma/model_cards/${encodeURIComponent(id)}`,
      options,
    );
  }

  update(
    id: string,
    params: OmaModelCardUpdateParams,
    options?: Anthropic.RequestOptions,
  ) {
    return this.client.post<OmaModelCard>(
      `/v1/oma/model_cards/${encodeURIComponent(id)}`,
      { body: params, ...options },
    );
  }

  delete(id: string, options?: Anthropic.RequestOptions) {
    return this.client.delete<OmaModelCardDeleted>(
      `/v1/oma/model_cards/${encodeURIComponent(id)}`,
      options,
    );
  }
}

export class OmaResources {
  readonly models: OmaModelsResource;
  readonly modelCards: OmaModelCardsResource;

  constructor(private readonly client: Anthropic) {
    this.models = new OmaModelsResource(client);
    this.modelCards = new OmaModelCardsResource(client);
  }

  request<Response>(params: OmaRequestParams) {
    const { method, path, ...options } = params;
    if (!path.startsWith("/v1/oma/")) {
      throw new TypeError("OpenMA extension requests must use /v1/oma/* paths");
    }
    return this.client.request<Response>({ method, path, ...options });
  }
}
