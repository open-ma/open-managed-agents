// Public types for the session-secrets store. Intentionally tiny: this store
// just shuttles opaque per-session secret payloads (env values, GH access
// tokens) between the create-resource HTTP path and SessionDO at session
// warmup. No structured row, no metadata, no parsing.

/**
 * The raw secret payload bytes — `env.value` (a raw env var value, was
 * `env_secret.value` before the rename) or `github_repository.token` (a GH
 * access token). Adapters store and return it as-is; the storage layer never
 * inspects or transforms the value.
 */
export type SecretValue = string;
