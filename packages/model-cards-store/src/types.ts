// Public types for the model cards store service. Mirrors the D1 schema in
// apps/main/migrations/0013_model_cards_table.sql.
//
// Design notes:
//   - The plaintext `api_key` is NEVER part of ModelCardRow. The service
//     exposes a separate `getApiKey()` method for callers that legitimately
//     need the cleartext (the agent worker's model resolver and the
//     `/v1/model_cards/:id/key` route). List/get responses carry only
//     `api_key_preview` (last 4 chars), matching the legacy KV row shape.
//   - `is_default` is denormalized (boolean) for fast `getDefault` reads.
//     The DB enforces "at most one default per tenant" via a partial UNIQUE
//     index — see the migration for the index definition + rationale.
//   - `archived_at` is included for forward compatibility with a soft-delete
//     pattern; the legacy KV path used hard delete and we keep that as the
//     default `delete()` semantic. Adapters DO NOT filter by archived_at on
//     read paths today; flip the column to enforce soft delete in a future
//     iteration without a schema change.
//   - The encrypted blob lives in the schema under `api_key_cipher`. Whether
//     the value at rest is genuinely encrypted is decided by the `Crypto`
//     port wired into the service. The default in-memory + factory wiring
//     uses an identity Crypto so the migration ships without depending on
//     a new wrangler secret — see INTEGRATION_GUIDE.md "Open questions" for
//     the production rotation plan.

export interface ModelCardRow {
  id: string;
  tenant_id: string;
  /** Tenant-unique user-facing handle (e.g. "claude-prod", "bedrock-sonnet").
   *  Agents reference cards via `agent.model = card.model_id`. UNIQUE per
   *  tenant — same string can't pin two different credentials. */
  model_id: string;
  /** Actual LLM model string sent to the provider's API on each turn
   *  (e.g. "claude-sonnet-4-6", "gpt-4o"). No uniqueness constraint —
   *  multiple cards may serve the same underlying LLM with different keys
   *  / base_urls / providers. */
  model: string;
  /** Provider tag — controls how the agent worker shapes outbound requests. */
  provider: string;
  /** Optional override for the upstream API base URL. NULL = use provider default. */
  base_url: string | null;
  /** Optional extra HTTP headers (used by *-compatible providers). NULL when unset. */
  custom_headers: Record<string, string> | null;
  /** Last-4 of the api key, safe to surface in API responses. */
  api_key_preview: string;
  is_default: boolean;
  created_at: string;
  updated_at: string | null;
  archived_at: string | null;
}

/** Deterministic preview helper — kept exported so route layer + adapter agree. */
export function apiKeyPreview(apiKey: string): string {
  return apiKey.slice(-4);
}
