import {
  cursorBinds,
  cursorWhereSql,
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
 * Cloudflare D1 implementation of {@link ModelCardRepo}. Owns the SQL against
 * the `model_cards` table defined in apps/main/migrations/0013_model_cards_table.sql.
 *
 * Atomicity:
 *   - insert(isDefault=true) uses D1.batch to clear-then-insert so the partial
 *     UNIQUE(tenant_id) WHERE is_default = 1 invariant holds without a
 *     read-then-write race.
 *   - update with isDefault=true uses D1.batch the same way.
 *   - setDefault uses D1.batch (clear all + flip target).
 *
 * The api_key_cipher is treated as an opaque blob — the service handles
 * encryption via the Crypto port before passing it in.
 */
export class D1ModelCardRepo implements ModelCardRepo {
  constructor(private readonly db: D1Database) {}

  async insert(input: NewModelCardInput): Promise<ModelCardRow> {
    const insertStmt = this.db
      .prepare(
        `INSERT INTO model_cards
           (id, tenant_id, model_id, provider, display_name, base_url,
            custom_headers, api_key_cipher, api_key_preview, is_default,
            created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.tenantId,
        input.modelId,
        input.provider,
        input.displayName,
        input.baseUrl,
        input.customHeaders !== null ? JSON.stringify(input.customHeaders) : null,
        input.apiKeyCipher,
        input.apiKeyPreview,
        input.isDefault ? 1 : 0,
        input.createdAt,
      );

    try {
      if (input.isDefault) {
        // Atomic clear-then-insert. Order matters — clear the previous default
        // first so the partial UNIQUE doesn't reject the insert.
        await this.db.batch([this.clearDefaultsStmt(input.tenantId, input.createdAt), insertStmt]);
      } else {
        await insertStmt.run();
      }
    } catch (err) {
      throw mapInsertError(err, input.modelId);
    }
    const row = await this.get(input.tenantId, input.id);
    if (!row) throw new Error("model_card vanished after insert");
    return row;
  }

  async get(tenantId: string, cardId: string): Promise<ModelCardRow | null> {
    const row = await this.db
      .prepare(
        `SELECT id, tenant_id, model_id, provider, display_name, base_url,
                custom_headers, api_key_preview, is_default,
                created_at, updated_at, archived_at
         FROM model_cards
         WHERE id = ? AND tenant_id = ?`,
      )
      .bind(cardId, tenantId)
      .first<DbModelCard>();
    return row ? toRow(row) : null;
  }

  async list(tenantId: string): Promise<ModelCardRow[]> {
    const result = await this.db
      .prepare(
        `SELECT id, tenant_id, model_id, provider, display_name, base_url,
                custom_headers, api_key_preview, is_default,
                created_at, updated_at, archived_at
         FROM model_cards
         WHERE tenant_id = ?
         ORDER BY created_at ASC`,
      )
      .bind(tenantId)
      .all<DbModelCard>();
    return (result.results ?? []).map(toRow);
  }

  async listPage(
    tenantId: string,
    opts: {
      limit: number;
      after?: PageCursor;
    },
  ): Promise<{ items: ModelCardRow[]; hasMore: boolean }> {
    const sql =
      `SELECT id, tenant_id, model_id, provider, display_name, base_url, ` +
      `custom_headers, api_key_preview, is_default, ` +
      `created_at, updated_at, archived_at FROM model_cards ` +
      `WHERE tenant_id = ? ${cursorWhereSql(opts.after)} ` +
      `ORDER BY created_at DESC, id DESC LIMIT ?`;
    const result = await this.db
      .prepare(sql)
      .bind(tenantId, ...cursorBinds(opts.after), fetchN(opts.limit))
      .all<DbModelCard>();
    return trimPage((result.results ?? []).map(toRow), opts.limit);
  }

  async findByModelId(
    tenantId: string,
    modelId: string,
  ): Promise<ModelCardRow | null> {
    const row = await this.db
      .prepare(
        `SELECT id, tenant_id, model_id, provider, display_name, base_url,
                custom_headers, api_key_preview, is_default,
                created_at, updated_at, archived_at
         FROM model_cards
         WHERE tenant_id = ? AND model_id = ? AND archived_at IS NULL
         LIMIT 1`,
      )
      .bind(tenantId, modelId)
      .first<DbModelCard>();
    return row ? toRow(row) : null;
  }

  async getDefault(tenantId: string): Promise<ModelCardRow | null> {
    const row = await this.db
      .prepare(
        `SELECT id, tenant_id, model_id, provider, display_name, base_url,
                custom_headers, api_key_preview, is_default,
                created_at, updated_at, archived_at
         FROM model_cards
         WHERE tenant_id = ? AND is_default = 1 AND archived_at IS NULL
         LIMIT 1`,
      )
      .bind(tenantId)
      .first<DbModelCard>();
    return row ? toRow(row) : null;
  }

  async update(
    tenantId: string,
    cardId: string,
    update: ModelCardUpdateFields,
  ): Promise<ModelCardRow> {
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (update.displayName !== undefined) {
      sets.push("display_name = ?");
      binds.push(update.displayName);
    }
    if (update.provider !== undefined) {
      sets.push("provider = ?");
      binds.push(update.provider);
    }
    if (update.modelId !== undefined) {
      sets.push("model_id = ?");
      binds.push(update.modelId);
    }
    if (update.baseUrl !== undefined) {
      sets.push("base_url = ?");
      binds.push(update.baseUrl);
    }
    if (update.customHeaders !== undefined) {
      sets.push("custom_headers = ?");
      binds.push(update.customHeaders !== null ? JSON.stringify(update.customHeaders) : null);
    }
    if (update.apiKeyCipher !== undefined) {
      sets.push("api_key_cipher = ?");
      binds.push(update.apiKeyCipher);
    }
    if (update.apiKeyPreview !== undefined) {
      sets.push("api_key_preview = ?");
      binds.push(update.apiKeyPreview);
    }
    if (update.isDefault !== undefined) {
      sets.push("is_default = ?");
      binds.push(update.isDefault ? 1 : 0);
    }
    sets.push("updated_at = ?");
    binds.push(update.updatedAt);
    binds.push(cardId, tenantId);

    const updateStmt = this.db
      .prepare(
        `UPDATE model_cards SET ${sets.join(", ")}
         WHERE id = ? AND tenant_id = ?`,
      )
      .bind(...binds);

    try {
      if (update.isDefault === true) {
        // Atomic: clear other defaults THEN apply the patch (which sets
        // is_default = 1 for this row). The partial UNIQUE never sees two
        // defaults at once.
        await this.db.batch([
          this.clearDefaultsExceptStmt(tenantId, cardId, update.updatedAt),
          updateStmt,
        ]);
      } else {
        const result = await updateStmt.run();
        if (!result.meta?.changes) throw new ModelCardNotFoundError();
      }
    } catch (err) {
      throw mapInsertError(err, update.modelId ?? "");
    }
    const row = await this.get(tenantId, cardId);
    if (!row) throw new ModelCardNotFoundError();
    return row;
  }

  async delete(tenantId: string, cardId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM model_cards WHERE id = ? AND tenant_id = ?`)
      .bind(cardId, tenantId)
      .run();
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

    await this.db.batch([
      this.clearDefaultsExceptStmt(tenantId, cardId, updatedAt),
      this.db
        .prepare(
          `UPDATE model_cards SET is_default = 1, updated_at = ?
           WHERE id = ? AND tenant_id = ?`,
        )
        .bind(updatedAt, cardId, tenantId),
    ]);
    const row = await this.get(tenantId, cardId);
    if (!row) throw new ModelCardNotFoundError();
    return row;
  }

  async getApiKeyCipher(
    tenantId: string,
    cardId: string,
  ): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT api_key_cipher FROM model_cards WHERE id = ? AND tenant_id = ?`,
      )
      .bind(cardId, tenantId)
      .first<{ api_key_cipher: string }>();
    return row?.api_key_cipher ?? null;
  }

  // ── batch helper statements ──

  /** UPDATE that flips every is_default row in the tenant to 0. */
  private clearDefaultsStmt(
    tenantId: string,
    updatedAt: number,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE model_cards SET is_default = 0, updated_at = ?
         WHERE tenant_id = ? AND is_default = 1`,
      )
      .bind(updatedAt, tenantId);
  }

  /** Same as clearDefaultsStmt but skips the row that's about to be flipped on. */
  private clearDefaultsExceptStmt(
    tenantId: string,
    exceptCardId: string,
    updatedAt: number,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE model_cards SET is_default = 0, updated_at = ?
         WHERE tenant_id = ? AND is_default = 1 AND id != ?`,
      )
      .bind(updatedAt, tenantId, exceptCardId);
  }
}

interface DbModelCard {
  id: string;
  tenant_id: string;
  model_id: string;
  provider: string;
  display_name: string;
  base_url: string | null;
  custom_headers: string | null; // JSON
  api_key_preview: string;
  is_default: number; // SQLite stores BOOLEAN as INTEGER
  created_at: number;
  updated_at: number | null;
  archived_at: number | null;
}

function toRow(r: DbModelCard): ModelCardRow {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    model_id: r.model_id,
    provider: r.provider,
    display_name: r.display_name,
    base_url: r.base_url,
    custom_headers:
      r.custom_headers !== null
        ? (JSON.parse(r.custom_headers) as Record<string, string>)
        : null,
    api_key_preview: r.api_key_preview,
    is_default: r.is_default === 1,
    created_at: msToIso(r.created_at),
    updated_at: r.updated_at !== null ? msToIso(r.updated_at) : null,
    archived_at: r.archived_at !== null ? msToIso(r.archived_at) : null,
  };
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
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
