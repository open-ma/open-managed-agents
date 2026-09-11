import { and, asc, desc, eq, gte, isNull, like, lt, ne, or, sql } from "drizzle-orm";
import {
  asBuilder,
  atomicWrite,
  getAll,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import { model_cards } from "@open-managed-agents/db-schema/cf-auth";
import {
  escapeLikePattern,
  fetchN,
  trimPage,
  type PageCursor,
} from "@open-managed-agents/shared";
import {
  ModelCardDefaultConflictError,
  ModelCardDuplicateModelIdError,
  ModelCardNotFoundError,
} from "../errors";
import type {
  ModelCardRepo,
  ModelCardUpdateFields,
  NewModelCardInput,
} from "../ports";
import type { ModelCardRow } from "../types";


/**
 * Drizzle implementation of {@link ModelCardRepo}. Owns the queries against
 * the `model_cards` table defined in apps/main/migrations/0013_model_cards_table.sql.
 *
 * Atomicity:
 *   - insert(isDefault=true) clears-then-inserts atomically so the partial
 *     UNIQUE(tenant_id) WHERE is_default = 1 invariant holds without a
 *     read-then-write race. D1 uses batch; PG uses transaction.
 *   - update with isDefault=true uses the same atomic clear-then-update.
 *   - setDefault uses the same atomic clear-then-flip.
 *
 * The api_key_cipher is treated as an opaque blob — the service handles
 * encryption via the Crypto port before passing it in.
 */
export class SqlModelCardRepo implements ModelCardRepo {
  private readonly db: OmaDbBuilder;
  constructor(db: OmaDb) {
    this.db = asBuilder(db);
  }

  async insert(input: NewModelCardInput): Promise<ModelCardRow> {
    const insertQ = this.db.insert(model_cards).values({
      id: input.id,
      tenant_id: input.tenantId,
      model_id: input.modelId,
      provider: input.provider,
      model: input.model,
      base_url: input.baseUrl,
      custom_headers:
        input.customHeaders !== null ? JSON.stringify(input.customHeaders) : null,
      pi_config: input.piConfig !== null ? JSON.stringify(input.piConfig) : null,
      api_key_cipher: input.apiKeyCipher,
      api_key_preview: input.apiKeyPreview,
      is_default: input.isDefault ? 1 : 0,
      created_at: input.createdAt,
    });

    try {
      if (input.isDefault) {
        // Atomic clear-then-insert. Order matters — clear the previous default
        // first so the partial UNIQUE doesn't reject the insert.
        const clearQ = this.clearDefaultsQuery(input.tenantId, input.createdAt);
        await atomicWrite(this.db, [clearQ, insertQ]);
      } else {
        await runOnce(insertQ);
      }
    } catch (err) {
      throw mapInsertError(err, input.modelId);
    }
    const row = await this.get(input.tenantId, input.id);
    if (!row) throw new Error("model_card vanished after insert");
    return row;
  }

  async get(tenantId: string, cardId: string): Promise<ModelCardRow | null> {
    const row = await getOne<typeof model_cards.$inferSelect>(
      this.db
        .select()
        .from(model_cards)
        .where(
          and(eq(model_cards.id, cardId), eq(model_cards.tenant_id, tenantId)),
        ),
    );
    return row ? toRow(row) : null;
  }

  async list(tenantId: string): Promise<ModelCardRow[]> {
    const rows = await getAll<typeof model_cards.$inferSelect>(
      this.db
        .select()
        .from(model_cards)
        .where(eq(model_cards.tenant_id, tenantId))
        .orderBy(asc(model_cards.created_at)),
    );
    return rows.map(toRow);
  }

  async listPage(
    tenantId: string,
    opts: {
      limit: number;
      after?: PageCursor;
      q?: string;
      provider?: string;
      createdAfter?: number;
      createdBefore?: number;
    },
  ): Promise<{ items: ModelCardRow[]; hasMore: boolean }> {
    const conds = [eq(model_cards.tenant_id, tenantId)];
    if (opts.q) {
      // Match either the user-facing handle (model_id) OR the wire-level
      // model string — users sometimes search for the underlying provider
      // name (e.g. "claude-sonnet") rather than their own handle.
      const pattern = `%${escapeLikePattern(opts.q)}%`;
      conds.push(
        or(
          like(model_cards.model_id, pattern),
          like(model_cards.model, pattern),
        )!,
      );
    }
    if (opts.provider !== undefined) {
      conds.push(eq(model_cards.provider, opts.provider));
    }
    if (opts.createdAfter !== undefined)
      conds.push(gte(model_cards.created_at, opts.createdAfter));
    if (opts.createdBefore !== undefined)
      conds.push(lt(model_cards.created_at, opts.createdBefore));
    if (opts.after) {
      conds.push(
        or(
          lt(model_cards.created_at, opts.after.createdAt),
          and(
            eq(model_cards.created_at, opts.after.createdAt),
            lt(model_cards.id, opts.after.id),
          ),
        )!,
      );
    }
    const rows = await getAll<typeof model_cards.$inferSelect>(
      this.db
        .select()
        .from(model_cards)
        .where(and(...conds))
        .orderBy(desc(model_cards.created_at), desc(model_cards.id))
        .limit(fetchN(opts.limit)),
    );
    return trimPage(rows.map(toRow), opts.limit);
  }

  async findByModelId(
    tenantId: string,
    modelId: string,
  ): Promise<ModelCardRow | null> {
    const row = await getOne<typeof model_cards.$inferSelect>(
      this.db
        .select()
        .from(model_cards)
        .where(
          and(
            eq(model_cards.tenant_id, tenantId),
            eq(model_cards.model_id, modelId),
            isNull(model_cards.archived_at),
          ),
        )
        .limit(1),
    );
    return row ? toRow(row) : null;
  }

  async getDefault(tenantId: string): Promise<ModelCardRow | null> {
    const row = await getOne<typeof model_cards.$inferSelect>(
      this.db
        .select()
        .from(model_cards)
        .where(
          and(
            eq(model_cards.tenant_id, tenantId),
            eq(model_cards.is_default, 1),
            isNull(model_cards.archived_at),
          ),
        )
        .limit(1),
    );
    return row ? toRow(row) : null;
  }

  async update(
    tenantId: string,
    cardId: string,
    update: ModelCardUpdateFields,
  ): Promise<ModelCardRow> {
    // Pre-check existence — Drizzle's run() result shape is dialect-specific,
    // so we read first to throw a domain error if the row is missing.
    const existing = await this.get(tenantId, cardId);
    if (!existing) throw new ModelCardNotFoundError();

    const set: Record<string, unknown> = { updated_at: update.updatedAt };
    if (update.provider !== undefined) set.provider = update.provider;
    if (update.modelId !== undefined) set.model_id = update.modelId;
    if (update.model !== undefined) set.model = update.model;
    if (update.baseUrl !== undefined) set.base_url = update.baseUrl;
    if (update.customHeaders !== undefined) {
      set.custom_headers =
        update.customHeaders !== null ? JSON.stringify(update.customHeaders) : null;
    }
    if (update.piConfig !== undefined) {
      set.pi_config = update.piConfig !== null ? JSON.stringify(update.piConfig) : null;
    }
    if (update.apiKeyCipher !== undefined) set.api_key_cipher = update.apiKeyCipher;
    if (update.apiKeyPreview !== undefined) set.api_key_preview = update.apiKeyPreview;
    if (update.isDefault !== undefined) set.is_default = update.isDefault ? 1 : 0;

    const updateQ = this.db
      .update(model_cards)
      .set(set)
      .where(
        and(eq(model_cards.id, cardId), eq(model_cards.tenant_id, tenantId)),
      );

    try {
      if (update.isDefault === true) {
        // Atomic: clear other defaults THEN apply the patch (which sets
        // is_default = 1 for this row). The partial UNIQUE never sees two
        // defaults at once.
        const clearQ = this.clearDefaultsExceptQuery(tenantId, cardId, update.updatedAt);
        await atomicWrite(this.db, [clearQ, updateQ]);
      } else {
        await runOnce(updateQ);
      }
    } catch (err) {
      throw mapInsertError(err, update.modelId ?? "");
    }
    const row = await this.get(tenantId, cardId);
    if (!row) throw new ModelCardNotFoundError();
    return row;
  }

  async delete(tenantId: string, cardId: string): Promise<void> {
    await runOnce(
      this.db
        .delete(model_cards)
        .where(
          and(eq(model_cards.id, cardId), eq(model_cards.tenant_id, tenantId)),
        ),
    );
  }

  async setDefault(
    tenantId: string,
    cardId: string,
    updatedAt: number,
  ): Promise<ModelCardRow> {
    // Verify the target exists before the batch — otherwise we'd silently
    // clear all defaults and "set" a non-existent row.
    const existing = await this.get(tenantId, cardId);
    if (!existing) throw new ModelCardNotFoundError();

    const clearQ = this.clearDefaultsExceptQuery(tenantId, cardId, updatedAt);
    const flipQ = this.db
      .update(model_cards)
      .set({ is_default: 1, updated_at: updatedAt })
      .where(
        and(eq(model_cards.id, cardId), eq(model_cards.tenant_id, tenantId)),
      );

    await atomicWrite(this.db, [clearQ, flipQ]);
    const row = await this.get(tenantId, cardId);
    if (!row) throw new ModelCardNotFoundError();
    return row;
  }

  async getApiKeyCipher(
    tenantId: string,
    cardId: string,
  ): Promise<string | null> {
    const row = await getOne<{ api_key_cipher: string }>(
      this.db
        .select({ api_key_cipher: model_cards.api_key_cipher })
        .from(model_cards)
        .where(
          and(eq(model_cards.id, cardId), eq(model_cards.tenant_id, tenantId)),
        ),
    );
    return row?.api_key_cipher ?? null;
  }

  // ── batch helper queries ──

  /** UPDATE that flips every is_default row in the tenant to 0. */
  private clearDefaultsQuery(tenantId: string, updatedAt: number) {
    return this.db
      .update(model_cards)
      .set({ is_default: 0, updated_at: updatedAt })
      .where(
        and(
          eq(model_cards.tenant_id, tenantId),
          eq(model_cards.is_default, 1),
        ),
      );
  }

  /** Same as clearDefaultsQuery but skips the row that's about to be flipped on. */
  private clearDefaultsExceptQuery(
    tenantId: string,
    exceptCardId: string,
    updatedAt: number,
  ) {
    return this.db
      .update(model_cards)
      .set({ is_default: 0, updated_at: updatedAt })
      .where(
        and(
          eq(model_cards.tenant_id, tenantId),
          eq(model_cards.is_default, 1),
          ne(model_cards.id, exceptCardId),
        ),
      );
  }
}

function toRow(r: typeof model_cards.$inferSelect): ModelCardRow {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    model_id: r.model_id,
    model: r.model,
    provider: r.provider,
    base_url: r.base_url,
    custom_headers:
      r.custom_headers !== null
        ? (JSON.parse(r.custom_headers) as Record<string, string>)
        : null,
    pi_config:
      r.pi_config !== null
        ? (JSON.parse(r.pi_config) as Record<string, unknown>)
        : null,
    api_key_preview: r.api_key_preview,
    // postgres.js returns BIGINT columns as strings by default, even though
    // the cross-dialect Drizzle schema models these flags/timestamps as
    // numbers. Normalize at the adapter boundary so SQLite and PG expose the
    // same domain shape.
    is_default: Number(r.is_default) === 1,
    created_at: msToIso(r.created_at),
    updated_at: r.updated_at !== null ? msToIso(r.updated_at) : null,
    archived_at: r.archived_at !== null ? msToIso(r.archived_at) : null,
  };
}

function msToIso(ms: number | string | bigint): string {
  return new Date(Number(ms)).toISOString();
}

/**
 * Map a SQLite UNIQUE-constraint error into our domain errors. SQLite emits
 * messages like:
 *   "UNIQUE constraint failed: model_cards.tenant_id, model_cards.model_id"
 *   "UNIQUE constraint failed: idx_model_cards_default"  (named index)
 * We pattern-match the column / index name; otherwise rethrow.
 */
function mapInsertError(err: unknown, modelId: string): unknown {
  if (!(err instanceof Error)) return err;
  const msg = err.message;
  if (!/unique constraint failed/i.test(msg)) return err;
  if (/idx_model_cards_default/i.test(msg)) {
    return new ModelCardDefaultConflictError();
  }
  if (/model_id/i.test(msg) || /idx_model_cards_model_id/i.test(msg)) {
    return new ModelCardDuplicateModelIdError(modelId);
  }
  return err;
}
