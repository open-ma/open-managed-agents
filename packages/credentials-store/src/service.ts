import { generateCredentialId } from "@open-managed-agents/shared";
import type { CredentialAuth } from "@open-managed-agents/shared";
import {
  CredentialImmutableFieldError,
  CredentialMaxExceededError,
  CredentialNotFoundError,
} from "./errors";
import type {
  Clock,
  CredentialRepo,
  CredentialUpdateFields,
  IdGenerator,
  Logger,
} from "./ports";
import {
  CredentialRow,
  MAX_CREDENTIALS_PER_VAULT,
  SECRET_AUTH_FIELDS,
} from "./types";

export interface CredentialServiceDeps {
  repo: CredentialRepo;
  clock?: Clock;
  ids?: IdGenerator;
  logger?: Logger;
}

/**
 * CredentialService — pure business logic over abstract ports.
 *
 * Owns:
 *   - max-credentials-per-vault enforcement (was vaults.ts:140 KV list+count)
 *   - mcp_server_url immutability on update (was vaults.ts:208)
 *   - merge semantics for partial auth updates (was vaults.ts:213)
 *   - cascade-by-vault on vault archive (was vaults.ts:91-104 KV list+loop)
 *
 * Does NOT own:
 *   - Vault existence checks — caller (vaults.ts) verifies the vault exists
 *     before calling. Vaults are still KV-only as of OPE-7 scope; introducing
 *     a VaultRepo port here would be premature.
 *   - HTTP secret stripping — exported as `stripSecrets` for handlers to call
 *     on the way out. Service returns the full row.
 *
 * mcp_server_url uniqueness is enforced by the partial UNIQUE index in the
 * D1 schema (and replicated in the in-memory fake). Adapters surface
 * violations as {@link CredentialDuplicateMcpUrlError}.
 */
export class CredentialService {
  private readonly repo: CredentialRepo;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly logger: Logger;

  constructor(deps: CredentialServiceDeps) {
    this.repo = deps.repo;
    this.clock = deps.clock ?? defaultClock;
    this.ids = deps.ids ?? defaultIds;
    this.logger = deps.logger ?? consoleLogger;
  }

  // ============================================================
  // Write paths
  // ============================================================

  async create(opts: {
    tenantId: string;
    vaultId: string;
    displayName: string;
    auth: CredentialAuth;
  }): Promise<CredentialRow> {
    const count = await this.repo.countAll(opts.tenantId, opts.vaultId);
    if (count >= MAX_CREDENTIALS_PER_VAULT) {
      throw new CredentialMaxExceededError(MAX_CREDENTIALS_PER_VAULT);
    }
    // Explicit `await` so an immediately-rejecting insert is caught here and
    // becomes this function's rejection — without it, V8 transiently marks the
    // inner Promise as unhandled before the outer await catches it.
    return await this.repo.insert({
      id: this.ids.credentialId(),
      tenantId: opts.tenantId,
      vaultId: opts.vaultId,
      displayName: opts.displayName,
      auth: opts.auth,
      createdAt: this.clock.nowMs(),
    });
  }

  async update(opts: {
    tenantId: string;
    vaultId: string;
    credentialId: string;
    displayName?: string;
    /** Partial auth update — merged into existing auth. */
    auth?: Partial<CredentialAuth>;
  }): Promise<CredentialRow> {
    const existing = await this.requireCredential(opts);

    // mcp_server_url is immutable (changing it would break the partial UNIQUE
    // semantics + invalidate any cached outbound snapshots).
    if (
      opts.auth?.mcp_server_url !== undefined &&
      opts.auth.mcp_server_url !== existing.auth.mcp_server_url
    ) {
      throw new CredentialImmutableFieldError("mcp_server_url");
    }

    const update: CredentialUpdateFields = { updatedAt: this.clock.nowMs() };
    if (opts.displayName !== undefined) update.displayName = opts.displayName;
    if (opts.auth !== undefined) update.auth = { ...existing.auth, ...opts.auth };

    return this.repo.update(opts.tenantId, opts.vaultId, opts.credentialId, update);
  }

  async archive(opts: {
    tenantId: string;
    vaultId: string;
    credentialId: string;
  }): Promise<CredentialRow> {
    await this.requireCredential(opts);
    return this.repo.archive(
      opts.tenantId,
      opts.vaultId,
      opts.credentialId,
      this.clock.nowMs(),
    );
  }

  async delete(opts: {
    tenantId: string;
    vaultId: string;
    credentialId: string;
  }): Promise<void> {
    await this.requireCredential(opts);
    await this.repo.delete(opts.tenantId, opts.vaultId, opts.credentialId);
  }

  /**
   * Cascade archive — called by vaults.ts when a vault is archived. Replaces
   * the KV list+loop pattern with a single repo call.
   */
  async archiveByVault(opts: {
    tenantId: string;
    vaultId: string;
  }): Promise<void> {
    await this.repo.archiveByVault(opts.tenantId, opts.vaultId, this.clock.nowMs());
  }

  /**
   * Token refresh write-back — called by the outbound proxy (apps/agent/src/outbound.ts)
   * after a successful OAuth refresh. Best-effort: a single failed write still
   * lets the in-session snapshot serve fresh tokens, but next session would
   * see stale until a future refresh succeeds.
   */
  async refreshAuth(opts: {
    tenantId: string;
    vaultId: string;
    credentialId: string;
    auth: Partial<CredentialAuth>;
  }): Promise<CredentialRow | null> {
    const existing = await this.repo.get(opts.tenantId, opts.vaultId, opts.credentialId);
    if (!existing) return null;
    const merged: CredentialAuth = { ...existing.auth, ...opts.auth };
    return this.repo.update(opts.tenantId, opts.vaultId, opts.credentialId, {
      auth: merged,
      updatedAt: this.clock.nowMs(),
    });
  }

  // ============================================================
  // Read paths
  // ============================================================

  async get(opts: {
    tenantId: string;
    vaultId: string;
    credentialId: string;
  }): Promise<CredentialRow | null> {
    return this.repo.get(opts.tenantId, opts.vaultId, opts.credentialId);
  }

  /** List credentials in a vault. Includes archived to match historical KV behavior. */
  async list(opts: {
    tenantId: string;
    vaultId: string;
    includeArchived?: boolean;
  }): Promise<CredentialRow[]> {
    return this.repo.list(opts.tenantId, opts.vaultId, {
      includeArchived: opts.includeArchived ?? true,
    });
  }

  /**
   * Pre-fetch credentials across multiple vaults — used by sessions.ts
   * fetchVaultCredentials at session init. Returns an array per-vault so the
   * caller can shape the SessionDO snapshot in one pass.
   */
  async listByVaults(opts: {
    tenantId: string;
    vaultIds: string[];
  }): Promise<Array<{ vault_id: string; credentials: CredentialRow[] }>> {
    if (!opts.vaultIds.length) return [];
    const rows = await this.repo.listByVaults(opts.tenantId, opts.vaultIds);
    const grouped = new Map<string, CredentialRow[]>();
    for (const id of opts.vaultIds) grouped.set(id, []);
    for (const r of rows) {
      const bucket = grouped.get(r.vault_id);
      if (bucket) bucket.push(r);
    }
    return opts.vaultIds.map((vault_id) => ({
      vault_id,
      credentials: grouped.get(vault_id) ?? [],
    }));
  }

  /**
   * List provider-tagged active credentials across vaults — used by
   * refreshProviderCredentialsForSession to figure out which (provider, vault)
   * pairs need a token refresh before the session starts.
   */
  async listProviderTagged(opts: {
    tenantId: string;
    vaultIds: string[];
  }): Promise<CredentialRow[]> {
    if (!opts.vaultIds.length) return [];
    return this.repo.listProviderTagged(opts.tenantId, opts.vaultIds);
  }

  // ============================================================
  // Internals
  // ============================================================

  private async requireCredential(opts: {
    tenantId: string;
    vaultId: string;
    credentialId: string;
  }): Promise<CredentialRow> {
    const row = await this.repo.get(opts.tenantId, opts.vaultId, opts.credentialId);
    if (!row) throw new CredentialNotFoundError();
    return row;
  }
}

// ============================================================
// stripSecrets — exported helper used by HTTP handlers
// ============================================================

/**
 * Remove secret fields from a credential before returning to the API. Mirrors
 * the previous helper in apps/main/src/routes/vaults.ts. Returns a shallow
 * copy — does not mutate the input row.
 */
export function stripSecrets(cred: CredentialRow): CredentialRow {
  const auth = { ...cred.auth };
  for (const field of SECRET_AUTH_FIELDS) {
    if (field in auth) delete auth[field];
  }
  return { ...cred, auth };
}

// ============================================================
// Default infra (used when callers don't override)
// ============================================================

const defaultClock: Clock = { nowMs: () => Date.now() };

const defaultIds: IdGenerator = { credentialId: generateCredentialId };

const consoleLogger: Logger = { warn: (msg, ctx) => console.warn(msg, ctx) };
