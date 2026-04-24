// In-memory implementations of every port for unit tests. Mirrors the partial
// UNIQUE semantics + atomic clear-then-set behavior of the D1 adapter so tests
// catch the same constraint violations.

import {
  ModelCardDefaultConflictError,
  ModelCardDuplicateModelIdError,
  ModelCardNotFoundError,
} from "./errors";
import type {
  Clock,
  Crypto,
  IdGenerator,
  Logger,
  ModelCardRepo,
  ModelCardUpdateFields,
  NewModelCardInput,
} from "./ports";
import { ModelCardService } from "./service";
import type { ModelCardRow } from "./types";

interface InMemModelCard {
  id: string;
  tenant_id: string;
  model_id: string;
  provider: string;
  display_name: string;
  base_url: string | null;
  custom_headers: Record<string, string> | null;
  api_key_cipher: string;
  api_key_preview: string;
  is_default: boolean;
  created_at: number;
  updated_at: number | null;
  archived_at: number | null;
}

export class InMemoryModelCardRepo implements ModelCardRepo {
  private readonly byId = new Map<string, InMemModelCard>();

  async insert(input: NewModelCardInput): Promise<ModelCardRow> {
    // Match the D1 UNIQUE(tenant_id, model_id).
    for (const c of this.byId.values()) {
      if (c.tenant_id === input.tenantId && c.model_id === input.modelId) {
        throw new ModelCardDuplicateModelIdError(input.modelId);
      }
    }
    if (input.isDefault) {
      // Atomic clear-then-insert: matches the D1 batch in the adapter.
      // Without the clear, the partial UNIQUE(tenant_id) WHERE is_default=1
      // would reject the insert when another default already exists.
      this.clearTenantDefaults(input.tenantId, input.createdAt);
    }
    // else: nothing to enforce — partial UNIQUE only constrains rows
    // where is_default = 1, so a non-default insert can't violate it.
    const row: InMemModelCard = {
      id: input.id,
      tenant_id: input.tenantId,
      model_id: input.modelId,
      provider: input.provider,
      display_name: input.displayName,
      base_url: input.baseUrl,
      custom_headers: input.customHeaders,
      api_key_cipher: input.apiKeyCipher,
      api_key_preview: input.apiKeyPreview,
      is_default: input.isDefault,
      created_at: input.createdAt,
      updated_at: null,
      archived_at: null,
    };
    this.byId.set(input.id, row);
    return toRow(row);
  }

  async get(tenantId: string, cardId: string): Promise<ModelCardRow | null> {
    const row = this.byId.get(cardId);
    if (!row || row.tenant_id !== tenantId) return null;
    return toRow(row);
  }

  async list(tenantId: string): Promise<ModelCardRow[]> {
    return Array.from(this.byId.values())
      .filter((c) => c.tenant_id === tenantId)
      .sort((a, b) => a.created_at - b.created_at)
      .map(toRow);
  }

  async findByModelId(
    tenantId: string,
    modelId: string,
  ): Promise<ModelCardRow | null> {
    for (const c of this.byId.values()) {
      if (
        c.tenant_id === tenantId &&
        c.model_id === modelId &&
        c.archived_at === null
      ) {
        return toRow(c);
      }
    }
    return null;
  }

  async getDefault(tenantId: string): Promise<ModelCardRow | null> {
    for (const c of this.byId.values()) {
      if (c.tenant_id === tenantId && c.is_default && c.archived_at === null) {
        return toRow(c);
      }
    }
    return null;
  }

  async update(
    tenantId: string,
    cardId: string,
    update: ModelCardUpdateFields,
  ): Promise<ModelCardRow> {
    const row = this.byId.get(cardId);
    if (!row || row.tenant_id !== tenantId) throw new ModelCardNotFoundError();

    // UNIQUE(tenant_id, model_id) check on rename
    if (update.modelId !== undefined && update.modelId !== row.model_id) {
      for (const c of this.byId.values()) {
        if (
          c.id !== row.id &&
          c.tenant_id === tenantId &&
          c.model_id === update.modelId
        ) {
          throw new ModelCardDuplicateModelIdError(update.modelId);
        }
      }
    }

    if (update.isDefault === true && !row.is_default) {
      // Atomic clear-then-flip to mirror the D1 batch.
      this.clearTenantDefaults(tenantId, update.updatedAt);
    } else if (update.isDefault === true && row.is_default) {
      // Already default; no-op atomic.
    } else if (update.isDefault === undefined) {
      // is_default not in the patch — nothing to enforce.
    }

    if (update.displayName !== undefined) row.display_name = update.displayName;
    if (update.provider !== undefined) row.provider = update.provider;
    if (update.modelId !== undefined) row.model_id = update.modelId;
    if (update.baseUrl !== undefined) row.base_url = update.baseUrl;
    if (update.customHeaders !== undefined) row.custom_headers = update.customHeaders;
    if (update.apiKeyCipher !== undefined) row.api_key_cipher = update.apiKeyCipher;
    if (update.apiKeyPreview !== undefined) row.api_key_preview = update.apiKeyPreview;
    if (update.isDefault !== undefined) row.is_default = update.isDefault;
    row.updated_at = update.updatedAt;

    // Final partial-UNIQUE assertion — should never fire on the service path.
    if (row.is_default) this.assertNoOtherDefault(tenantId, row.id);

    return toRow(row);
  }

  async delete(tenantId: string, cardId: string): Promise<void> {
    const row = this.byId.get(cardId);
    if (!row || row.tenant_id !== tenantId) return;
    this.byId.delete(cardId);
  }

  async setDefault(
    tenantId: string,
    cardId: string,
    updatedAt: number,
  ): Promise<ModelCardRow> {
    const row = this.byId.get(cardId);
    if (!row || row.tenant_id !== tenantId) throw new ModelCardNotFoundError();
    this.clearTenantDefaults(tenantId, updatedAt);
    row.is_default = true;
    row.updated_at = updatedAt;
    return toRow(row);
  }

  async getApiKeyCipher(
    tenantId: string,
    cardId: string,
  ): Promise<string | null> {
    const row = this.byId.get(cardId);
    if (!row || row.tenant_id !== tenantId) return null;
    return row.api_key_cipher;
  }

  // ── helpers used by both insert + update + setDefault ──

  /** Atomically clear is_default = 1 on every other card in the tenant. */
  private clearTenantDefaults(tenantId: string, updatedAt: number): void {
    for (const c of this.byId.values()) {
      if (c.tenant_id === tenantId && c.is_default) {
        c.is_default = false;
        c.updated_at = updatedAt;
      }
    }
  }

  /** Throws ModelCardDefaultConflictError if any other row in the tenant has
   *  is_default = true (excluding `exceptId` if provided). */
  private assertNoOtherDefault(
    tenantId: string,
    exceptId: string | null,
  ): void {
    for (const c of this.byId.values()) {
      if (
        c.tenant_id === tenantId &&
        c.is_default &&
        (exceptId === null || c.id !== exceptId)
      ) {
        throw new ModelCardDefaultConflictError();
      }
    }
  }
}

export class SequentialIdGenerator implements IdGenerator {
  private n = 0;
  modelCardId(): string {
    return `mdl-${++this.n}`;
  }
}

export class ManualClock implements Clock {
  constructor(private ms: number = 0) {}
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
  set(ms: number): void {
    this.ms = ms;
  }
}

export class SilentLogger implements Logger {
  warn(): void {}
}

/**
 * Trivial reversible "encryption" — base64 wrap. Lets tests round-trip the
 * service's encrypt/decrypt boundary without a real AES key, while still
 * exercising the cipher path (so a bug that returns the cipher in the row
 * would be caught).
 */
export class FakeCrypto implements Crypto {
  async encrypt(plaintext: string): Promise<string> {
    return `enc(${plaintext})`;
  }
  async decrypt(ciphertext: string): Promise<string> {
    if (!ciphertext.startsWith("enc(") || !ciphertext.endsWith(")")) {
      throw new Error(`FakeCrypto.decrypt: not a fake-cipher: ${ciphertext}`);
    }
    return ciphertext.slice(4, -1);
  }
}

/**
 * Convenience factory — full in-memory wiring with sane defaults. Tests can
 * pass overrides for any port.
 */
export function createInMemoryModelCardService(opts?: {
  clock?: Clock;
  ids?: IdGenerator;
  logger?: Logger;
  crypto?: Crypto;
}): {
  service: ModelCardService;
  repo: InMemoryModelCardRepo;
} {
  const repo = new InMemoryModelCardRepo();
  const service = new ModelCardService({
    repo,
    crypto: opts?.crypto ?? new FakeCrypto(),
    clock: opts?.clock,
    ids: opts?.ids ?? new SequentialIdGenerator(),
    logger: opts?.logger ?? new SilentLogger(),
  });
  return { service, repo };
}

// ── helpers ──

function toRow(c: InMemModelCard): ModelCardRow {
  return {
    id: c.id,
    tenant_id: c.tenant_id,
    model_id: c.model_id,
    provider: c.provider,
    display_name: c.display_name,
    base_url: c.base_url,
    custom_headers: c.custom_headers,
    api_key_preview: c.api_key_preview,
    is_default: c.is_default,
    created_at: msToIso(c.created_at),
    updated_at: c.updated_at !== null ? msToIso(c.updated_at) : null,
    archived_at: c.archived_at !== null ? msToIso(c.archived_at) : null,
  };
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}
