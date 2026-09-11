import type {
  ListProviderCatalogModelsResult,
  ProviderModelCatalogSourcePort,
} from "@open-managed-agents/oma-models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

export interface HttpFetchPort {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

export class HttpProviderModelCatalog implements ProviderModelCatalogSourcePort {
  constructor(private readonly dependencies: HttpFetchPort) {}

  async list(input: {
    provider: string;
    apiKey?: string;
  }): Promise<ListProviderCatalogModelsResult> {
    const providerId = normalizeProviderId(input.provider);

    // The SDK-first path reads Pi's built-in catalog and never receives a
    // tenant credential. The old ant/oai + api_key path remains below as a
    // compatibility-only live discovery lane.
    if (!input.apiKey) {
      const provider = builtinProviders().find((candidate) => candidate.id === providerId);
      if (!provider) return { type: "unsupported_provider" };
      return {
        type: "success",
        models: provider.getModels().map((model) => ({
          id: model.id,
          name: model.name,
          provider: model.provider,
          api: model.api,
          reasoning: model.reasoning,
          input: model.input,
          context_window: model.contextWindow,
          max_tokens: model.maxTokens,
        })),
      };
    }

    if (providerId !== "anthropic" && providerId !== "openai") {
      return { type: "unsupported_provider" };
    }
    try {
      if (providerId === "anthropic") {
        const response = await this.dependencies.fetch(
          "https://api.anthropic.com/v1/models?limit=100",
          {
            headers: {
              "x-api-key": input.apiKey,
              "anthropic-version": "2023-06-01",
            },
          },
        );
        if (!response.ok) {
          return {
            type: "upstream_error",
            message: `Anthropic API ${response.status}`,
          };
        }
        const body = await response.json() as {
          data?: Array<{ id?: unknown; display_name?: unknown }>;
        };
        const models = (body.data ?? []).flatMap((model) =>
          typeof model.id === "string"
            ? [{
                id: model.id,
                name: typeof model.display_name === "string"
                  ? model.display_name
                  : model.id,
              }]
            : []
        );
        return { type: "success", models };
      }

      const response = await this.dependencies.fetch(
        "https://api.openai.com/v1/models",
        { headers: { Authorization: `Bearer ${input.apiKey}` } },
      );
      if (!response.ok) {
        return {
          type: "upstream_error",
          message: `OpenAI API ${response.status}`,
        };
      }
      const body = await response.json() as {
        data?: Array<{ id?: unknown }>;
      };
      const chatPrefixes = ["gpt-", "o1", "o3", "o4", "chatgpt-"];
      const models = (body.data ?? [])
        .flatMap((model) => typeof model.id === "string" ? [model.id] : [])
        .filter((id) => chatPrefixes.some((prefix) => id.startsWith(prefix)))
        .sort((left, right) => left.localeCompare(right))
        .map((id) => ({ id, name: id }));
      return { type: "success", models };
    } catch (error) {
      return {
        type: "upstream_error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function normalizeProviderId(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "ant") return "anthropic";
  if (normalized === "oai") return "openai";
  return normalized;
}
