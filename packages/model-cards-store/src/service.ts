import { generateModelCardId } from "@open-managed-agents/shared";
import { paginateVia } from "@open-managed-agents/shared";
import { ModelCardNotFoundError } from "./errors";
import type {
  Clock,
  Crypto,
  IdGenerator,
  Logger,
  ModelCardRepo,
  ModelCardUpdateFields,
} from "./ports";
import { apiKeyPreview, ModelCardRow } from "./types";

export interface ModelCardServiceDeps {
  repo: ModelCardRepo;
  /** Encrypts the api_key on the way in / decrypts on getApiKey reads.
   *  Defaults to identity (cleartext) when not provided. */
  crypto?: Crypto;
  clock?: Clock;
  ids?: IdGenerator;
  logger?: Logger;
}

/**
 * ModelCardService — pure business logic over abstract ports.
 *
 * Owns:
 *   - Atomic "set as default" — was the kvListAll + per-card UPDATE loop in
 *     model-cards.ts:49-51 + 118-120 + the standalone clearDefaults() helper.
 *   - api_key plaintext boundary — encrypts on write, decrypts on getApiKey,
 *     never returns the cipher in the row shape.
 *   - api_key_preview derivation (last 4 chars).
 *
 * Does NOT own:
 *   - Validation that the model_id is a known provider model — that's the
 *     route layer's job (or a future ModelCatalog port).
 *   - Tenant authorization — caller must have already established `tenantId`
 *     via the auth middleware before calling.
 *   - Cascade on delete — there is no cascade today; agents reference cards
 *     by id and the agent route validates the reference at write time
 *     (agents.ts:46-85). When that validation moves into the model-cards
 *     service, add a guard here.
 *
 * Default + UNIQUE invariants:
 *   - The DB enforces UNIQUE(tenant_id, model_id) and PARTIAL UNIQUE
 *     (tenant_id) WHERE is_default = 1. The service uses repo methods that
 *     implement clear-then-set atomically, so partial-UNIQUE violations
 *     should never surface under normal use. They DO surface if a caller
 *     bypasses the service.
 */
export class ModelCardService {
  private readonly repo: ModelCardRepo;
  private readonly crypto: Crypto;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly logger: Logger;

  constructor(deps: ModelCardServiceDeps) {
    this.repo = deps.repo;
    this.crypto = deps.crypto ?? identityCrypto;
    this.clock = deps.clock ?? defaultClock;
    this.ids = deps.ids ?? defaultIds;
    this.logger = deps.logger ?? consoleLogger;
  }

  // ============================================================
  // Write paths
  // ============================================================

  async create(opts: {
    tenantId: string;
    /** Tenant-unique handle. UNIQUE(tenant_id, model_id) enforced in DB. */
    modelId: string;
    provider: string;
    /** Wire-level LLM model string sent to provider. Defaults to modelId
     *  when omitted (so a new card with `model_id: "claude-sonnet-4-6"`
     *  needs no extra config to do the obvious thing). */
    model?: string;
    apiKey: string;
    baseUrl?: string | null;
    customHeaders?: Record<string, string> | null;
    /** When true, atomically clears any existing default before inserting. */
    makeDefault?: boolean;
  }): Promise<ModelCardRow> {
    const apiKeyCipher = await this.crypto.encrypt(opts.apiKey);
    return await this.repo.insert({
      id: this.ids.modelCardId(),
      tenantId: opts.tenantId,
      modelId: opts.modelId,
      provider: opts.provider,
      model: opts.model ?? opts.modelId,
      baseUrl: opts.baseUrl ?? null,
      customHeaders: opts.customHeaders ?? null,
      apiKeyCipher,
      apiKeyPreview: apiKeyPreview(opts.apiKey),
      isDefault: !!opts.makeDefault,
      createdAt: this.clock.nowMs(),
    });
  }

  async update(opts: {
    tenantId: string;
    cardId: string;
    provider?: string;
    /** Rename the handle. UNIQUE(tenant_id, model_id) still enforced. */
    modelId?: string;
    /** Change the wire-level LLM string sent to the provider. */
    model?: string;
    /** Pass `null` to clear the override and fall back to the provider default. */
    baseUrl?: string | null;
    /** Pass `null` to clear. Pass an object to replace. */
    customHeaders?: Record<string, string> | null;
    /** New plaintext api_key. Service derives + stores cipher + preview. */
    apiKey?: string;
    /** Atomically clears other defaults if true (per partial UNIQUE). */
    isDefault?: boolean;
  }): Promise<ModelCardRow> {
    await this.requireCard(opts);
    const update: ModelCardUpdateFields = { updatedAt: this.clock.nowMs() };
    if (opts.provider !== undefined) update.provider = opts.provider;
    if (opts.modelId !== undefined) update.modelId = opts.modelId;
    if (opts.model !== undefined) update.model = opts.model;
    if (opts.baseUrl !== undefined) update.baseUrl = opts.baseUrl;
    if (opts.customHeaders !== undefined) update.customHeaders = opts.customHeaders;
    if (opts.isDefault !== undefined) update.isDefault = opts.isDefault;
    if (opts.apiKey !== undefined) {
      update.apiKeyCipher = await this.crypto.encrypt(opts.apiKey);
      update.apiKeyPreview = apiKeyPreview(opts.apiKey);
    }
    // Explicit `await` so an immediately-rejecting update is caught here and
    // becomes this function's rejection — without it, V8 transiently marks
    // the inner Promise as unhandled before the outer await catches it.
    return await this.repo.update(opts.tenantId, opts.cardId, update);
  }

  /**
   * Atomically mark this card as the tenant default, clearing any other
   * is_default=1 row in the same batch. Replaces the kvListAll +
   * per-card UPDATE loop in the legacy clearDefaults() + makeDefault flow.
   */
  async setDefault(opts: {
    tenantId: string;
    cardId: string;
  }): Promise<ModelCardRow> {
    await this.requireCard(opts);
    return await this.repo.setDefault(opts.tenantId, opts.cardId, this.clock.nowMs());
  }

  async delete(opts: { tenantId: string; cardId: string }): Promise<void> {
    await this.requireCard(opts);
    await this.repo.delete(opts.tenantId, opts.cardId);
  }

  // ============================================================
  // Read paths
  // ============================================================

  async get(opts: {
    tenantId: string;
    cardId: string;
  }): Promise<ModelCardRow | null> {
    return this.repo.get(opts.tenantId, opts.cardId);
  }

  async list(opts: { tenantId: string }): Promise<ModelCardRow[]> {
    return this.repo.list(opts.tenantId);
  }

  /** Cursor-paginated list. Order: created_at DESC, id DESC tie-break. */
  async listPage(opts: {
    tenantId: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ items: ModelCardRow[]; nextCursor?: string }> {
    return paginateVia({
      cursor: opts.cursor,
      limit: opts.limit,
      fetch: (after, limit) =>
        this.repo.listPage(opts.tenantId, { limit, after }),
      extractCursor: (r) => ({
        createdAt: new Date(r.created_at).getTime(),
        id: r.id,
      }),
    });
  }

  /**
   * Used by the agent worker when no explicit model_card_id is pinned on the
   * agent. Returns the first card whose `model_id` exactly matches. Replaces
   * the per-tenant CONFIG_KV.list + JSON.parse loop in
   * session-do.ts:1141-1163.
   */
  async findByModelId(opts: {
    tenantId: string;
    modelId: string;
  }): Promise<ModelCardRow | null> {
    return this.repo.findByModelId(opts.tenantId, opts.modelId);
  }

  async getDefault(opts: { tenantId: string }): Promise<ModelCardRow | null> {
    return this.repo.getDefault(opts.tenantId);
  }

  /**
   * Returns the cleartext api_key for a card. Used by:
   *   - The /v1/model_cards/:id/key route (consumed by the agent worker
   *     when it can't read AUTH_DB directly — staging today, prod TBD).
   *   - The agent worker's resolveModelCardCredentials path.
   * Returns null when the card doesn't exist OR the cipher decrypt fails
   * (logged as a warning); callers should treat null as "fall back to env
   * vars" exactly like the legacy KV path did.
   */
  async getApiKey(opts: {
    tenantId: string;
    cardId: string;
  }): Promise<string | null> {
    const cipher = await this.repo.getApiKeyCipher(opts.tenantId, opts.cardId);
    if (cipher === null) return null;
    try {
      return await this.crypto.decrypt(cipher);
    } catch (err) {
      this.logger.warn("model-cards-store: api_key decrypt failed", {
        tenantId: opts.tenantId,
        cardId: opts.cardId,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // ============================================================
  // Internals
  // ============================================================

  private async requireCard(opts: {
    tenantId: string;
    cardId: string;
  }): Promise<ModelCardRow> {
    const row = await this.repo.get(opts.tenantId, opts.cardId);
    if (!row) throw new ModelCardNotFoundError();
    return row;
  }
}

// ============================================================
// Default infra (used when callers don't override)
// ============================================================

const defaultClock: Clock = { nowMs: () => Date.now() };

const defaultIds: IdGenerator = { modelCardId: generateModelCardId };

const consoleLogger: Logger = { warn: (msg, ctx) => console.warn(msg, ctx) };

/**
 * No-op encryption — matches the legacy KV layout where api_keys were stored
 * cleartext under `t:{tenant}:modelcard:{id}:key`. Use this when no
 * encryption secret is available; flip to a real AES-GCM impl in prod.
 */
const identityCrypto: Crypto = {
  async encrypt(plaintext) {
    return plaintext;
  },
  async decrypt(ciphertext) {
    return ciphertext;
  },
};
