/** Typed errors so HTTP handlers can map to status codes without leaking internals. */

export class ModelCardNotFoundError extends Error {
  readonly code = "model_card_not_found";
  constructor(message = "Model card not found") {
    super(message);
  }
}

/**
 * Adapter-level UNIQUE(tenant_id, model_id) violation surfaced as a domain error.
 * Replaces the per-tenant kvListAll + JSON.parse loop in the legacy
 * model-cards.ts:33-43.
 */
export class ModelCardDuplicateModelIdError extends Error {
  readonly code = "model_card_duplicate_model_id";
  constructor(public readonly modelId: string, message?: string) {
    super(message ?? `model_id "${modelId}" is already used by another model card`);
  }
}

/**
 * Partial UNIQUE(tenant_id) WHERE is_default = 1 violation. Surfaced when a
 * caller tries to insert/update a row to is_default=1 without atomically
 * clearing the previous default first. Indicates a service-layer bug — the
 * service's create-with-default and setDefault operations are wrapped in
 * an atomic clear-then-set so this should never fire under normal use.
 */
export class ModelCardDefaultConflictError extends Error {
  readonly code = "model_card_default_conflict";
  constructor(message = "Another model card is already the default for this tenant") {
    super(message);
  }
}
