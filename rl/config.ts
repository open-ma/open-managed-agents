import type { RolloutConfig } from "./types.js";

export function loadConfig(overrides?: Partial<RolloutConfig>): RolloutConfig {
  return {
    api_url: overrides?.api_url || process.env.OMA_API_URL || "http://localhost:8787",
    api_key: overrides?.api_key || process.env.OMA_API_KEY || "test-key",
    model: overrides?.model || process.env.RL_MODEL || "claude-sonnet-4-6",
    model_base_url: overrides?.model_base_url || process.env.RL_MODEL_BASE_URL,
    model_compat: overrides?.model_compat || (process.env.RL_MODEL_COMPAT as RolloutConfig["model_compat"]) || undefined,
    concurrency: overrides?.concurrency || parseInt(process.env.RL_CONCURRENCY || "8", 10),
    timeout_ms: overrides?.timeout_ms || parseInt(process.env.RL_TIMEOUT_MS || "300000", 10),
    max_turns: overrides?.max_turns || parseInt(process.env.RL_MAX_TURNS || "5", 10),
  };
}
