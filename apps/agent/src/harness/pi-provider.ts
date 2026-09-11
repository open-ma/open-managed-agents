import {
  createModels,
  createProvider,
  type Api,
  type Model,
  type Models,
  type Provider,
  type ProviderHeaders,
  type ProviderStreams,
  type ModelThinkingLevel,
  type SimpleStreamOptions,
  clampThinkingLevel,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
export { toAiSdkLanguageModel } from "./pi-ai-sdk";

export interface PiModelRuntime {
  models: Models;
  model: Model<Api>;
  /** Pi-native per-agent default. `off` is Pi's own default. */
  thinkingLevel: ModelThinkingLevel;
  /** Managed Agents request priority. Model cards do not own this setting. */
  speed: "standard" | "fast";
}

/**
 * Serializable Pi model fields that a custom model card may provide.
 * Identity, provider, endpoint and credentials stay owned by the card;
 * every capability/protocol field below keeps Pi's public meaning.
 */
export type PiModelConfig = Partial<
  Pick<
    Model<Api>,
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

export interface PiModelCardBinding {
  /** Wire-level provider model id, not the OpenMA model-card handle. */
  model: string;
  apiKey: string;
  /** Model-card provider. Legacy ant/oai values are accepted for migration. */
  provider?: string;
  baseURL?: string;
  customHeaders?: Record<string, string>;
  /** Optional Pi-native model metadata for a custom or overridden model. */
  piConfig?: PiModelConfig;
  /** Pi-native agent setting. Managed Agents `model.effort` maps here. */
  thinkingLevel?: ModelThinkingLevel;
  /** Managed Agents `model.speed`; inherited by sessions pinned to this agent version. */
  speed?: "standard" | "fast";
}

interface ProviderPlan {
  id: string;
  name: string;
  api?: Api;
  streams?: ProviderStreams;
  catalog?: Provider;
}

/**
 * Compose a tenant-scoped Pi Models collection from an OpenMA model card.
 *
 * OpenMA deliberately does not implement provider request semantics here.
 * Pi owns auth application, model metadata, payloads, streaming and provider
 * compatibility. The only translation retained locally is the four legacy
 * model-card provider tags, so existing installations can migrate without
 * rewriting their stored cards.
 */
export function createPiModelRuntime(input: PiModelCardBinding): PiModelRuntime {
  const plan = resolveProviderPlan(input.provider, input.piConfig);
  const catalogModels = plan.catalog?.getModels() ?? [];
  const catalogModel = catalogModels.find((model) => model.id === input.model);
  const baseUrl = input.baseURL ?? catalogModel?.baseUrl ?? plan.catalog?.baseUrl;
  const api = input.piConfig?.api
    ?? plan.api
    ?? catalogModel?.api
    ?? inferProviderApi(plan.id, catalogModels);

  if (!baseUrl) {
    throw new Error(`Pi provider ${plan.id} does not define a base URL`);
  }

  const baseModel: Model<Api> = catalogModel
    ? {
        ...catalogModel,
        id: input.model,
        provider: plan.id,
        api,
        baseUrl,
      }
    : {
        id: input.model,
        name: input.model,
        provider: plan.id,
        api,
        baseUrl,
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        // Pi requires capacity hints for custom models. These are deliberately
        // conservative fallbacks, not request/protocol behavior; a future
        // model-card metadata field can replace them without changing the Port.
        contextWindow: 128_000,
        maxTokens: 32_768,
      };
  const model: Model<Api> = {
    ...baseModel,
    ...input.piConfig,
    // Model-card identity and routing are not overrideable through Pi
    // metadata. This also makes stored configuration safe to spread.
    id: input.model,
    provider: plan.id,
    api,
    baseUrl,
  };
  const providerStreams = resolveProviderStreams(plan, model, catalogModel);

  const provider = createProvider({
    id: plan.id,
    name: plan.name,
    baseUrl,
    headers: mergeHeaders(plan.catalog?.headers, input.customHeaders),
    auth: {
      apiKey: {
        name: "OpenMA model card",
        check: async () => ({ type: "api_key", source: "OpenMA model card" }),
        resolve: async () => ({
          auth: { apiKey: input.apiKey },
          source: "OpenMA model card",
        }),
      },
    },
    models: [model],
    api: providerStreams,
  });

  const models = createModels();
  models.setProvider(provider);
  return {
    models,
    model,
    thinkingLevel: clampThinkingLevel(model, input.thinkingLevel ?? "off"),
    speed: input.speed ?? "standard",
  };
}

/**
 * Project Managed Agents request controls onto Pi's provider request Port.
 * Pi still owns provider auth, protocol encoding, streaming, and validation.
 */
export function withPiRuntimeRequestOptions(
  runtime: PiModelRuntime,
  options: SimpleStreamOptions = {},
): SimpleStreamOptions {
  const baseFetch = options.fetch ?? observablePiFetch;
  if (runtime.speed !== "fast") return { ...options, fetch: baseFetch };

  const originalPayload = options.onPayload;
  const api = runtime.model.api;
  const onPayload: NonNullable<SimpleStreamOptions["onPayload"]> = async (
    payload,
    model,
  ) => {
    const projected = originalPayload
      ? (await originalPayload(payload, model)) ?? payload
      : payload;
    if (typeof projected !== "object" || projected === null || Array.isArray(projected)) {
      throw new TypeError("Pi provider payload must be an object to apply Managed Agents speed");
    }
    if (api === "anthropic-messages") return { ...projected, speed: "fast" };
    if (api === "openai-completions") {
      return { ...projected, service_tier: "priority" };
    }
    return projected;
  };

  if (api === "anthropic-messages") {
    return {
      ...options,
      fetch: (input, init) => fastAnthropicFetch(baseFetch, input, init),
      onPayload,
    };
  }
  if (api === "openai-responses" || api === "openai-codex-responses") {
    return {
      ...options,
      fetch: baseFetch,
      onPayload,
      serviceTier: "priority",
    } as SimpleStreamOptions;
  }
  if (api === "openai-completions") {
    return { ...options, fetch: baseFetch, onPayload };
  }
  throw new Error(
    `Managed Agents speed "fast" is not supported by Pi API "${api}"`,
  );
}

async function fastAnthropicFetch(
  fetcher: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  const beta = headers.get("anthropic-beta")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean) ?? [];
  if (!beta.includes("fast-mode-2026-02-01")) beta.push("fast-mode-2026-02-01");
  headers.set("anthropic-beta", beta.join(","));
  return fetcher(input, { ...init, headers });
}

/** Observable transport that never logs query strings, headers, or secrets. */
async function observablePiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await globalThis.fetch(input, init);
  if (!response.ok) {
    const rawUrl = input instanceof Request ? input.url : String(input);
    let safeUrl = rawUrl;
    try {
      const url = new URL(rawUrl);
      safeUrl = `${url.origin}${url.pathname}`;
    } catch {
      safeUrl = "<invalid-provider-url>";
    }
    console.warn(`[pi-provider] upstream=${safeUrl} status=${response.status}`);
  }
  return response;
}

function resolveProviderPlan(
  provider: string | undefined,
  piConfig: PiModelConfig | undefined,
): ProviderPlan {
  const requested = (provider ?? "ant").toLowerCase();
  const providers = builtinProviders();
  const getBuiltin = (id: string): Provider | undefined =>
    providers.find((candidate) => candidate.id === id);

  switch (requested) {
    case "ant-compatible":
    case "anthropic-compatible":
      return {
        id: "anthropic-compatible",
        name: "Anthropic-compatible",
        api: "anthropic-messages",
        streams: anthropicMessagesApi(),
        catalog: requireBuiltin(getBuiltin("anthropic"), "anthropic"),
      };
    case "oai-compatible":
    case "openai-compatible":
      return {
        id: "openai-compatible",
        name: "OpenAI-compatible",
        api: "openai-completions",
        streams: openAICompletionsApi(),
        catalog: requireBuiltin(getBuiltin("openai"), "openai"),
      };
  }

  const id = requested === "ant" ? "anthropic" : requested === "oai" ? "openai" : requested;
  const catalog = getBuiltin(id);
  if (catalog) return { id, name: catalog.name, catalog };

  if (!piConfig?.api) {
    throw new Error(
      `Custom Pi provider "${id}" requires pi_config.api so Pi can select its protocol implementation`,
    );
  }
  const streams = getApiProvider(piConfig.api);
  if (!streams) {
    throw new Error(`Pi has no API implementation registered for "${piConfig.api}"`);
  }
  return {
    id,
    name: id,
    api: piConfig.api,
    streams,
  };
}

function requireBuiltin(provider: Provider | undefined, id: string): Provider {
  if (!provider) throw new Error(`Pi built-in provider "${id}" is unavailable`);
  return provider;
}

function resolveProviderStreams(
  plan: ProviderPlan,
  model: Model<Api>,
  catalogModel: Model<Api> | undefined,
): ProviderStreams {
  if (plan.streams) return plan.streams;

  // A custom model may live under an official provider id while selecting a
  // different Pi API implementation. Let Pi's registry own that dispatch.
  if (model.api !== catalogModel?.api) {
    const registered = getApiProvider(model.api);
    if (registered) return registered;
  }
  if (plan.catalog) return delegateProviderStreams(plan.catalog);
  throw new Error(`Pi has no API implementation registered for "${model.api}"`);
}

function inferProviderApi(providerId: string, models: readonly Model<Api>[]): Api {
  const apis = new Set(models.map((model) => model.api));
  if (apis.size === 1) return apis.values().next().value as Api;
  throw new Error(
    `Model is not in Pi's ${providerId} catalog and its API cannot be inferred; `
      + "use a catalog model or a legacy compatible provider tag for a custom endpoint",
  );
}

function delegateProviderStreams(provider: Provider): ProviderStreams {
  return {
    stream: (model, context, options) => provider.stream(model, context, options),
    streamSimple: (model, context, options) => provider.streamSimple(model, context, options),
    ...(provider.fetchDeferred
      ? {
          fetchDeferred: (model, handle, options) =>
            provider.fetchDeferred!(model, handle, options),
        }
      : {}),
    ...(provider.cancelDeferred
      ? {
          cancelDeferred: (model, handle, options) =>
            provider.cancelDeferred!(model, handle, options),
        }
      : {}),
  };
}

function mergeHeaders(
  base: ProviderHeaders | undefined,
  override: Record<string, string> | undefined,
): ProviderHeaders | undefined {
  if (!base && !override) return undefined;
  const merged = { ...base };
  for (const [name, value] of Object.entries(override ?? {})) {
    for (const existing of Object.keys(merged)) {
      if (existing.toLowerCase() === name.toLowerCase()) delete merged[existing];
    }
    merged[name] = value;
  }
  return merged;
}
