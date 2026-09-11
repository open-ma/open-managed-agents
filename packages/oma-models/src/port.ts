import type { OmaProviderModel } from "./model";

export type OmaProviderModelView = OmaProviderModel;

export interface ListOmaProviderModelsCommand {
  provider: string;
  /** @deprecated Compatibility-only live discovery credential. */
  apiKey?: string;
}

export type ListOmaProviderModelsResult =
  | { type: "success"; models: OmaProviderModelView[] }
  | { type: "upstream_error"; message: string };

export interface OmaModelsApplicationPort {
  listProviderModels(
    command: ListOmaProviderModelsCommand,
  ): Promise<ListOmaProviderModelsResult>;
}
