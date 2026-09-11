import type { PiModelConfig } from "./pi-provider";

export interface ResolvedModelCardCredentials {
  model: string;
  apiKey: string;
  baseURL?: string;
  provider?: string;
  customHeaders?: Record<string, string>;
  piConfig?: PiModelConfig;
}

export interface StoredModelCardProviderConfig {
  model: string;
  provider: string;
  base_url: string | null;
  custom_headers: Record<string, string> | null;
  pi_config: Record<string, unknown> | null;
}

/**
 * Replace the complete environment fallback once a stored card is selected.
 * A missing card endpoint means "use Pi's provider catalog", not "inherit
 * ANTHROPIC_BASE_URL". Keeping this projection pure makes that isolation a
 * testable boundary for every platform composition.
 */
export function bindStoredModelCardCredentials(
  fallback: ResolvedModelCardCredentials,
  card: StoredModelCardProviderConfig,
  apiKey: string,
): ResolvedModelCardCredentials {
  return {
    model: card.model,
    apiKey,
    baseURL: card.base_url ?? undefined,
    provider: card.provider,
    customHeaders: card.custom_headers ?? undefined,
    piConfig: (card.pi_config as PiModelConfig | null) ?? undefined,
  };
}
