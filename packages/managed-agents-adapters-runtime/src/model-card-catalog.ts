import type {
  FindCatalogModel,
  ListCatalogModels,
  ListCatalogModelsResult,
  Model,
  ModelCatalogSourcePort,
} from "@open-managed-agents/managed-agents-application";
import {
  getSupportedThinkingLevels,
  type Api,
  type Model as PiModel,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

export interface ModelCardCatalogRecord {
  model_id: string;
  model: string;
  provider: string;
  base_url: string | null;
  pi_config: Record<string, unknown> | null;
  created_at: string;
  archived_at: string | null;
}

export interface ModelCardCatalogReader {
  list(input: { tenantId: string }): Promise<ModelCardCatalogRecord[]>;
  findByModelId(input: {
    tenantId: string;
    modelId: string;
  }): Promise<ModelCardCatalogRecord | null>;
}

/**
 * Adapts the tenant's executable model-card registry to the public Managed
 * Agents Models Port. Provider credentials deliberately stay behind the
 * model-card service boundary and never enter the SDK response shape.
 */
export class ModelCardCatalogSource implements ModelCatalogSourcePort {
  constructor(private readonly cards: ModelCardCatalogReader) {}

  async find(input: FindCatalogModel): Promise<Model | null> {
    const card = await this.cards.findByModelId({
      tenantId: input.workspaceId,
      modelId: input.modelId,
    });
    return card === null || card.archived_at !== null ? null : toModel(card);
  }

  async list(input: ListCatalogModels): Promise<ListCatalogModelsResult> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Model card page limit must be a positive integer");
    }
    const models = (await this.cards.list({ tenantId: input.workspaceId }))
      .filter((card) => card.archived_at === null)
      .map(toModel)
      .sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        right.id.localeCompare(left.id)
      );
    const positionId = input.afterId ?? input.beforeId;
    const position = positionId === undefined
      ? undefined
      : models.findIndex((model) => model.id === positionId);
    if (position === -1) return { type: "invalid_position" };

    if (input.beforeId !== undefined && position !== undefined) {
      const start = Math.max(0, position - input.limit);
      return {
        type: "page",
        models: models.slice(start, position),
        hasMore: start > 0,
      };
    }

    const start = position === undefined ? 0 : position + 1;
    const end = start + input.limit;
    return {
      type: "page",
      models: models.slice(start, end),
      hasMore: end < models.length,
    };
  }
}

function toModel(card: ModelCardCatalogRecord): Model {
  const piModel = resolvePiModel(card);
  return {
    id: card.model_id,
    allowedFallbackModels: null,
    capabilities: piModel ? toCapabilities(piModel) : null,
    createdAt: card.created_at,
    displayName: piModel?.name ?? card.model_id,
    maxInputTokens: piModel?.contextWindow ?? null,
    maxTokens: piModel?.maxTokens ?? null,
  };
}

function resolvePiModel(card: ModelCardCatalogRecord): PiModel<Api> | null {
  try {
    const providerId = normalizeProviderId(card.provider);
    const provider = builtinProviders().find((candidate) => candidate.id === providerId);
    const catalogModel = provider?.getModels().find((model) => model.id === card.model);
    if (catalogModel) return catalogModel;

    const config = card.pi_config as Partial<PiModel<Api>> | null;
    if (!config?.api) return null;
    return {
      id: card.model,
      name: typeof config.name === "string" ? config.name : card.model,
      provider: providerId,
      api: config.api,
      baseUrl: card.base_url ?? provider?.baseUrl ?? "",
      reasoning: typeof config.reasoning === "boolean" ? config.reasoning : false,
      input: Array.isArray(config.input) ? config.input : ["text"],
      cost: config.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: typeof config.contextWindow === "number" ? config.contextWindow : 128_000,
      maxTokens: typeof config.maxTokens === "number" ? config.maxTokens : 32_768,
      ...(config.thinkingLevelMap ? { thinkingLevelMap: config.thinkingLevelMap } : {}),
      ...(config.samplingParams ? { samplingParams: config.samplingParams } : {}),
      ...(config.headers ? { headers: config.headers } : {}),
      ...(config.compat ? { compat: config.compat } : {}),
    } as PiModel<Api>;
  } catch {
    // A malformed custom card remains retrievable/executable by handle, but
    // one bad metadata object must not make the entire official catalog 500.
    return null;
  }
}

function toCapabilities(model: PiModel<Api>): NonNullable<Model["capabilities"]> {
  const levels = new Set(getSupportedThinkingLevels(model));
  const support = (supported: boolean) => ({ supported });
  const reasoning = model.reasoning === true;
  const compat = model.compat as Record<string, unknown> | undefined;
  return {
    batch: support(false),
    citations: support(false),
    codeExecution: support(false),
    contextManagement: {
      clearThinking20251015: null,
      clearToolUses20250919: null,
      compact20260112: null,
      supported: false,
    },
    effort: {
      supported: reasoning && levels.size > 0,
      low: support(levels.has("low")),
      medium: support(levels.has("medium")),
      high: support(levels.has("high")),
      xhigh: support(levels.has("xhigh")),
      max: support(levels.has("max")),
    },
    imageInput: support(model.input.includes("image")),
    pdfInput: support(false),
    structuredOutputs: support(
      compat?.supportsStrictMode === true || compat?.supportsStrictTools === true,
    ),
    thinking: {
      supported: reasoning,
      types: {
        adaptive: support(compat?.forceAdaptiveThinking === true),
        enabled: support(reasoning),
      },
    },
  };
}

function normalizeProviderId(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "ant") return "anthropic";
  if (normalized === "oai") return "openai";
  if (normalized === "ant-compatible") return "anthropic";
  if (normalized === "oai-compatible") return "openai";
  return normalized;
}
