// Abstract ports the ModelCardService depends on. Same DIP pattern as
// packages/credentials-store/src/ports.ts — concrete adapters in src/adapters/
// implement these against Cloudflare bindings; src/test-fakes.ts provides
// in-memory implementations.
//
// Keep these tiny and runtime-agnostic: no Cloudflare types, no D1 query
// language. Pass plain data + return plain data. The schema is no-FK by
// project convention.
//
// Notes on the api_key handling:
//   - The repo only ever sees `api_key_cipher` (an opaque ciphertext blob).
//     Encryption + decryption happen at the service boundary via the `Crypto`
//     port so the adapter stays SQL-pure.
//   - Reads of the cleartext key go through `getApiKeyCipher` so the service
//     can decrypt on demand without polluting the standard read shape.

import type { ModelCardRow } from "./types";
import type { PageCursor } from "@open-managed-agents/shared";

export interface NewModelCardInput {
  id: string;
  tenantId: string;
  modelId: string;
  provider: string;
  displayName: string;
  baseUrl: string | null;
  customHeaders: Record<string, string> | null;
  apiKeyCipher: string;
  apiKeyPreview: string;
  /**
   * When true, the repo MUST clear any existing is_default=1 row in this
   * tenant atomically (single batch) before inserting this row. Without that
   * the partial UNIQUE index would reject the insert.
   */
  isDefault: boolean;
  createdAt: number;
}

export interface ModelCardUpdateFields {
  displayName?: string;
  provider?: string;
  modelId?: string;
  baseUrl?: string | null;
  customHeaders?: Record<string, string> | null;
  /** New ciphertext when the api_key is rotated. Pair with `apiKeyPreview`. */
  apiKeyCipher?: string;
  apiKeyPreview?: string;
  /**
   * When true, the repo MUST atomically clear any existing is_default=1 row
   * in the tenant (other than this one) before flipping this row's is_default
   * to 1. When false, the repo just sets is_default=0.
   */
  isDefault?: boolean;
  updatedAt: number;
}

export interface ModelCardRepo {
  /**
   * Insert a new model card. Throws {@link ModelCardDuplicateModelIdError} on
   * (tenant_id, model_id) UNIQUE violation. When `input.isDefault` is true,
   * atomically clears the previous default in the same batch — see the
   * partial UNIQUE index in 0013_model_cards_table.sql.
   */
  insert(input: NewModelCardInput): Promise<ModelCardRow>;

  get(tenantId: string, cardId: string): Promise<ModelCardRow | null>;

  /** List all cards for a tenant. Default order: created_at ASC (legacy KV order). */
  list(tenantId: string): Promise<ModelCardRow[]>;

  /** Cursor-paginated list. Order: created_at DESC, id DESC. */
  listPage(
    tenantId: string,
    opts: {
      limit: number;
      after?: PageCursor;
    },
  ): Promise<{ items: ModelCardRow[]; hasMore: boolean }>;

  /**
   * Find an active card by (tenant_id, model_id). Used by the agent worker's
   * model resolver to derive credentials when no explicit `model_card_id` is
   * pinned on the agent. Returns the card whose `model_id` exactly matches.
   */
  findByModelId(tenantId: string, modelId: string): Promise<ModelCardRow | null>;

  /** Single-row read of the tenant default. NULL when no default is set. */
  getDefault(tenantId: string): Promise<ModelCardRow | null>;

  /**
   * Patch the model card. UNIQUE + partial-UNIQUE rules apply same as insert
   * — see error types above. When `update.isDefault` is true, the repo MUST
   * atomically clear other defaults in this tenant before setting this row's
   * is_default = 1.
   */
  update(
    tenantId: string,
    cardId: string,
    update: ModelCardUpdateFields,
  ): Promise<ModelCardRow>;

  /** Hard-delete. Caller is responsible for any cascade (none today). */
  delete(tenantId: string, cardId: string): Promise<void>;

  /**
   * Atomic clear-then-set: clears every is_default = 1 row in the tenant and
   * marks this card as default. Replaces the legacy clearDefaults+setDefault
   * loop in model-cards.ts:49-51 / 118-120.
   */
  setDefault(tenantId: string, cardId: string, updatedAt: number): Promise<ModelCardRow>;

  /**
   * Fetch the encrypted api_key blob. Returns NULL when the card is missing
   * or doesn't belong to the tenant. Service decrypts via the `Crypto` port.
   */
  getApiKeyCipher(tenantId: string, cardId: string): Promise<string | null>;
}

/** Symmetric encryption boundary for the api_key at rest. */
export interface Crypto {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

export interface Clock {
  nowMs(): number;
}

export interface IdGenerator {
  modelCardId(): string;
}

export interface Logger {
  warn(msg: string, ctx?: unknown): void;
}
