import type { OmaProviderModel } from "./model";

export interface ListProviderCatalogModelsQuery {
  provider: string;
  /** @deprecated Compatibility-only live discovery credential. */
  apiKey?: string;
}

export type ListProviderCatalogModelsResult =
  | { type: "success"; models: OmaProviderModel[] }
  | { type: "unsupported_provider" }
  | { type: "upstream_error"; message: string };

export interface ProviderModelCatalogSourcePort {
  list(
    query: ListProviderCatalogModelsQuery,
  ): Promise<ListProviderCatalogModelsResult>;
}
