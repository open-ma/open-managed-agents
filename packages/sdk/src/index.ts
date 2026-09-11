import Anthropic, {
  type ClientOptions as AnthropicClientOptions,
} from "@anthropic-ai/sdk";
import { OmaResources } from "./oma.js";

export {
  OmaModelsResource,
  OmaModelCardsResource,
  OmaResources,
  type OmaModelCard,
  type OmaModelCardCreateParams,
  type OmaModelCardDeleted,
  type OmaModelCardListParams,
  type OmaModelCardListResponse,
  type OmaModelCardUpdateParams,
  type OmaModelListParams,
  type OmaModelListResponse,
  type OmaModelProvider,
  type OmaPiModelConfig,
  type OmaProviderModel,
  type OmaHTTPMethod,
  type OmaPath,
  type OmaRequestParams,
} from "./oma.js";
export { Anthropic };

export type { AnthropicClientOptions };
export interface OpenMAOptions extends AnthropicClientOptions {
  /** @deprecated Use the official SDK spelling, `baseURL`. */
  baseUrl?: string;
  /** @deprecated Use the official SDK spelling, `authToken`. */
  bearer?: string;
  /** Active OpenMA workspace. Sent as `x-active-tenant`. */
  activeTenantId?: string;
  /** Optional legacy User-Agent override. */
  userAgent?: string;
}

/** @deprecated Use `OpenMAOptions`. */
export type ClientOptions = OpenMAOptions;

type HeaderValue = string | readonly string[] | null | undefined;

function mergeDefaultHeaders(
  defaultHeaders: AnthropicClientOptions["defaultHeaders"],
  additions: Record<string, string>,
): Record<string, HeaderValue> {
  const merged: Record<string, HeaderValue> = {};
  const set = (name: string, value: HeaderValue) => {
    merged[name.toLowerCase()] = value;
  };

  for (const [name, value] of Object.entries(additions)) set(name, value);

  if (defaultHeaders instanceof Headers) {
    defaultHeaders.forEach((value, name) => set(name, value));
    return merged;
  }

  if (Array.isArray(defaultHeaders)) {
    for (const entry of defaultHeaders) {
      if (entry.length >= 2) set(String(entry[0]), entry[1] as HeaderValue);
    }
    return merged;
  }

  if (defaultHeaders && typeof defaultHeaders === "object") {
    const nullable = defaultHeaders as {
      values?: unknown;
      nulls?: unknown;
    };
    if (nullable.values instanceof Headers && nullable.nulls instanceof Set) {
      nullable.values.forEach((value, name) => set(name, value));
      for (const name of nullable.nulls) set(String(name), null);
      return merged;
    }
    for (const [name, value] of Object.entries(defaultHeaders)) {
      set(name, value as HeaderValue);
    }
  }

  return merged;
}

export class OpenMA {
  readonly anthropic: Anthropic;
  readonly beta: Anthropic["beta"];
  readonly oma: OmaResources;

  constructor(options: OpenMAOptions = {}) {
    const {
      activeTenantId,
      baseUrl,
      bearer,
      defaultHeaders,
      userAgent,
      ...anthropicOptions
    } = options;

    this.anthropic = new Anthropic({
      ...anthropicOptions,
      baseURL: options.baseURL ?? baseUrl ?? "https://openma.dev",
      authToken: options.authToken ?? bearer,
      defaultHeaders: mergeDefaultHeaders(defaultHeaders, {
        ...(activeTenantId ? { "x-active-tenant": activeTenantId } : {}),
        ...(userAgent ? { "user-agent": userAgent } : {}),
      }),
    });
    this.beta = this.anthropic.beta;
    this.oma = new OmaResources(this.anthropic);
  }
}
