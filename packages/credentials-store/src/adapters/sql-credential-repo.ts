import type { SqlClient } from "@open-managed-agents/sql-client";
import type { CredentialAuth } from "@open-managed-agents/shared";
import { CredentialDuplicateMcpUrlError, CredentialNotFoundError } from "../errors";
import type {
  CredentialRepo,
  CredentialUpdateFields,
  Crypto,
  NewCredentialInput,
} from "../ports";
import type { CredentialRow } from "../types";

/**
 * SQL implementation of {@link CredentialRepo}. Owns the SQL against
 * the `credentials` table defined in apps/main/migrations/0009_credentials_table.sql.
 *
 * Hot fields (auth_type, mcp_server_url, provider) are denormalized into their
 * own columns for indexing; the full CredentialAuth lives in the `auth` JSON
 * column. Writers must keep them in sync — see `bindAuthColumns`.
 *
 * The `auth` column is encrypted via the {@link Crypto} port. The denormalized
 * hot-path columns stay plaintext (they're SQL index keys, not secrets).
 * See ports.ts for the rationale on placing crypto at the repo layer.
 */
export class SqlCredentialRepo implements CredentialRepo {
  private readonly db: SqlClient;
  private readonly crypto: Crypto;

  constructor(db: SqlClient, opts?: { crypto?: Crypto }) {
    this.db = db;
    this.crypto = opts?.crypto ?? identityCrypto;
  }

  async insert(input: NewCredentialInput): Promise<CredentialRow> {
    const authCipher = await this.crypto.encrypt(JSON.stringify(input.auth));
    try {
      await this.db
        .prepare(
          `INSERT INTO credentials
             (id, tenant_id, vault_id, display_name, auth_type, mcp_server_url, provider, auth, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.id,
          input.tenantId,
          input.vaultId,
          input.displayName,
          input.auth.type,
          input.auth.mcp_server_url ?? null,
          input.auth.provider ?? null,
          authCipher,
          input.createdAt,
        )
        .run();
    } catch (err) {
      if (isMcpUrlUniqueViolation(err)) throw new CredentialDuplicateMcpUrlError();
      throw err;
    }
    const row = await this.get(input.tenantId, input.vaultId, input.id);
    if (!row) throw new Error("credential vanished after insert");
    return row;
  }

  async get(
    tenantId: string,
    vaultId: string,
    credentialId: string,
  ): Promise<CredentialRow | null> {
    const row = await this.db
      .prepare(
        `SELECT id, tenant_id, vault_id, display_name, auth, created_at, updated_at, archived_at
         FROM credentials
         WHERE id = ? AND tenant_id = ? AND vault_id = ?`,
      )
      .bind(credentialId, tenantId, vaultId)
      .first<DbCredential>();
    return row ? await this.toRow(row) : null;
  }

  async list(
    tenantId: string,
    vaultId: string,
    opts: { includeArchived: boolean },
  ): Promise<CredentialRow[]> {
    const sql = opts.includeArchived
      ? `SELECT id, tenant_id, vault_id, display_name, auth, created_at, updated_at, archived_at
         FROM credentials WHERE tenant_id = ? AND vault_id = ? ORDER BY created_at ASC`
      : `SELECT id, tenant_id, vault_id, display_name, auth, created_at, updated_at, archived_at
         FROM credentials WHERE tenant_id = ? AND vault_id = ? AND archived_at IS NULL
         ORDER BY created_at ASC`;
    const result = await this.db.prepare(sql).bind(tenantId, vaultId).all<DbCredential>();
    return this.toRows(result.results ?? []);
  }

  async countAll(tenantId: string, vaultId: string): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS c FROM credentials WHERE tenant_id = ? AND vault_id = ?`)
      .bind(tenantId, vaultId)
      .first<{ c: number }>();
    return row?.c ?? 0;
  }

  async findActiveByMcpUrl(
    tenantId: string,
    vaultId: string,
    mcpServerUrl: string,
  ): Promise<CredentialRow | null> {
    const row = await this.db
      .prepare(
        `SELECT id, tenant_id, vault_id, display_name, auth, created_at, updated_at, archived_at
         FROM credentials
         WHERE tenant_id = ? AND vault_id = ? AND mcp_server_url = ? AND archived_at IS NULL
         LIMIT 1`,
      )
      .bind(tenantId, vaultId, mcpServerUrl)
      .first<DbCredential>();
    return row ? await this.toRow(row) : null;
  }

  async listByVaults(tenantId: string, vaultIds: string[]): Promise<CredentialRow[]> {
    if (!vaultIds.length) return [];
    const placeholders = vaultIds.map(() => "?").join(", ");
    const result = await this.db
      .prepare(
        `SELECT id, tenant_id, vault_id, display_name, auth, created_at, updated_at, archived_at
         FROM credentials
         WHERE tenant_id = ? AND vault_id IN (${placeholders})
         ORDER BY vault_id, created_at ASC`,
      )
      .bind(tenantId, ...vaultIds)
      .all<DbCredential>();
    return this.toRows(result.results ?? []);
  }

  async listProviderTagged(tenantId: string, vaultIds: string[]): Promise<CredentialRow[]> {
    if (!vaultIds.length) return [];
    const placeholders = vaultIds.map(() => "?").join(", ");
    const result = await this.db
      .prepare(
        `SELECT id, tenant_id, vault_id, display_name, auth, created_at, updated_at, archived_at
         FROM credentials
         WHERE tenant_id = ? AND vault_id IN (${placeholders})
           AND archived_at IS NULL AND provider IS NOT NULL`,
      )
      .bind(tenantId, ...vaultIds)
      .all<DbCredential>();
    return this.toRows(result.results ?? []);
  }

  async update(
    tenantId: string,
    vaultId: string,
    credentialId: string,
    update: CredentialUpdateFields,
  ): Promise<CredentialRow> {
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (update.displayName !== undefined) {
      sets.push("display_name = ?");
      binds.push(update.displayName);
    }
    if (update.auth !== undefined) {
      // Keep denormalized columns in sync with the JSON blob. mcp_server_url
      // is immutable per service-layer check, but we still rewrite it for
      // correctness if a caller ever bypasses the service. The JSON blob is
      // encrypted; the denormalized columns stay plaintext for indexing.
      const authCipher = await this.crypto.encrypt(JSON.stringify(update.auth));
      sets.push("auth_type = ?", "mcp_server_url = ?", "provider = ?", "auth = ?");
      binds.push(
        update.auth.type,
        update.auth.mcp_server_url ?? null,
        update.auth.provider ?? null,
        authCipher,
      );
    }
    sets.push("updated_at = ?");
    binds.push(update.updatedAt);
    binds.push(credentialId, tenantId, vaultId);

    const result = await this.db
      .prepare(
        `UPDATE credentials SET ${sets.join(", ")}
         WHERE id = ? AND tenant_id = ? AND vault_id = ?`,
      )
      .bind(...binds)
      .run();
    if (!result.meta?.changes) throw new CredentialNotFoundError();
    const row = await this.get(tenantId, vaultId, credentialId);
    if (!row) throw new CredentialNotFoundError();
    return row;
  }

  async archive(
    tenantId: string,
    vaultId: string,
    credentialId: string,
    archivedAt: number,
  ): Promise<CredentialRow> {
    const result = await this.db
      .prepare(
        `UPDATE credentials SET archived_at = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND vault_id = ?`,
      )
      .bind(archivedAt, archivedAt, credentialId, tenantId, vaultId)
      .run();
    if (!result.meta?.changes) throw new CredentialNotFoundError();
    const row = await this.get(tenantId, vaultId, credentialId);
    if (!row) throw new CredentialNotFoundError();
    return row;
  }

  async archiveByVault(
    tenantId: string,
    vaultId: string,
    archivedAt: number,
  ): Promise<void> {
    // Single UPDATE replaces the KV list+loop in the old vaults.ts:91-104.
    // Atomic by D1 default, no FK needed — soft FK on vault_id is enough.
    await this.db
      .prepare(
        `UPDATE credentials SET archived_at = ?, updated_at = ?
         WHERE tenant_id = ? AND vault_id = ? AND archived_at IS NULL`,
      )
      .bind(archivedAt, archivedAt, tenantId, vaultId)
      .run();
  }

  async delete(tenantId: string, vaultId: string, credentialId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM credentials WHERE id = ? AND tenant_id = ? AND vault_id = ?`)
      .bind(credentialId, tenantId, vaultId)
      .run();
  }

  private async toRow(r: DbCredential): Promise<CredentialRow> {
    const authJson = await this.crypto.decrypt(r.auth);
    return {
      id: r.id,
      tenant_id: r.tenant_id,
      vault_id: r.vault_id,
      display_name: r.display_name,
      auth: JSON.parse(authJson) as CredentialAuth,
      created_at: msToIso(r.created_at),
      updated_at: r.updated_at !== null ? msToIso(r.updated_at) : null,
      archived_at: r.archived_at !== null ? msToIso(r.archived_at) : null,
    };
  }

  private async toRows(rs: DbCredential[]): Promise<CredentialRow[]> {
    return Promise.all(rs.map((r) => this.toRow(r)));
  }
}

interface DbCredential {
  id: string;
  tenant_id: string;
  vault_id: string;
  display_name: string;
  auth: string; // ciphertext (was: plaintext JSON pre-encryption rollout)
  created_at: number;
  updated_at: number | null;
  archived_at: number | null;
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}

function isMcpUrlUniqueViolation(err: unknown): boolean {
  // D1/SQLite throws "UNIQUE constraint failed: ..." with the index columns.
  // We check both the explicit index name and the column to stay robust to
  // SQLite's error format variations.
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    /unique constraint failed/i.test(msg) &&
    (/mcp_server_url/i.test(msg) || /idx_credentials_mcp_url_active/i.test(msg))
  );
}

/**
 * Identity (passthrough) crypto — used as the default when callers don't wire
 * a real one. Matches the legacy plaintext-on-disk behavior so existing tests
 * keep working without ceremony. Production wiring MUST override this.
 */
const identityCrypto: Crypto = {
  async encrypt(plaintext) {
    return plaintext;
  },
  async decrypt(ciphertext) {
    return ciphertext;
  },
};
