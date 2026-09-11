import type { OmaModelsApplicationPort } from "./port";
import type { ProviderModelCatalogSourcePort } from "./catalog-source";

export interface OmaModelsApplicationServiceDependencies {
  catalog: ProviderModelCatalogSourcePort;
}

export class OmaModelsApplicationService implements OmaModelsApplicationPort {
  constructor(
    private readonly dependencies: OmaModelsApplicationServiceDependencies,
  ) {}

  async listProviderModels(command: {
    provider: string;
    apiKey?: string;
  }) {
    const result = await this.dependencies.catalog.list(command);
    if (result.type === "unsupported_provider") {
      return { type: "success" as const, models: [] };
    }
    if (result.type === "upstream_error") {
      return {
        type: "upstream_error" as const,
        message: `Failed to fetch models: ${result.message}`,
      };
    }
    return result;
  }
}
