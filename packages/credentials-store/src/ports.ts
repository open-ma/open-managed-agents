// Abstract ports the CredentialService depends on. Same DIP pattern as
// packages/memory-store/src/ports.ts — concrete adapters in src/adapters/
// implement these against Cloudflare bindings; src/test-fakes.ts provides
// in-memory implementations.
//
// Keep these tiny and runtime-agnostic: no Cloudflare types, no D1 query
// language. Pass plain data + return plain data. The schema is no-FK by
// project convention; cascade-by-vault lives in this port (`archiveByVault`)
// so adapters and the in-memory fake share one canonical implementation.
//
// Tenant routing: every method takes `tenantId` as the first argument (or
// a top-level field on the input). This is intentional — it makes tenantId
// a routing key, so a future per-tenant-D1 / per-tenant-SQLite adapter can
// pick a database per call without any port changes. See
// packages/services/README.md "Per-tenant routing is an adapter-internal concern".

import type { CredentialAuth } from "@open-managed-agents/shared";
import type { CredentialRow } from "./types";

export interface NewCredentialInput {
  id: string;
  tenantId: string;
  vaultId: string;
  displayName: string;
  auth: CredentialAuth;
  createdAt: number;
}

export interface CredentialUpdateFields {
  /** Optional display_name change. */
  displayName?: string;
  /** Full replacement of auth blob — service handles merge semantics + immutable-field checks. */
  auth?: CredentialAuth;
  updatedAt: number;
}

export interface CredentialRepo {
  /**
   * Insert a new credential. Throws {@link CredentialDuplicateMcpUrlError}
   * if the (tenant_id, vault_id, mcp_server_url) partial UNIQUE is violated.
   */
  insert(input: NewCredentialInput): Promise<CredentialRow>;

  get(tenantId: string, vaultId: string, credentialId: string): Promise<CredentialRow | null>;

  /** List credentials in a vault. `includeArchived: false` excludes archived rows. */
  list(
    tenantId: string,
    vaultId: string,
    opts: { includeArchived: boolean },
  ): Promise<CredentialRow[]>;

  /**
   * Count credentials in a vault for the MAX_CREDENTIALS_PER_VAULT enforcement.
   * Counts active + archived to match historical KV behavior in vaults.ts:140.
   */
  countAll(tenantId: string, vaultId: string): Promise<number>;

  /** Look up an active credential by mcp_server_url within a vault. */
  findActiveByMcpUrl(
    tenantId: string,
    vaultId: string,
    mcpServerUrl: string,
  ): Promise<CredentialRow | null>;

  /**
   * Pre-fetch all credentials across multiple vaults — single round-trip,
   * used by sessions.ts at session init to build the outbound snapshot.
   */
  listByVaults(
    tenantId: string,
    vaultIds: string[],
  ): Promise<CredentialRow[]>;

  /**
   * List provider-tagged credentials across vaults. Used by
   * refreshProviderCredentialsForSession to fan out token refresh per
   * (provider, vault). Active rows only.
   */
  listProviderTagged(
    tenantId: string,
    vaultIds: string[],
  ): Promise<CredentialRow[]>;

  update(
    tenantId: string,
    vaultId: string,
    credentialId: string,
    update: CredentialUpdateFields,
  ): Promise<CredentialRow>;

  archive(
    tenantId: string,
    vaultId: string,
    credentialId: string,
    archivedAt: number,
  ): Promise<CredentialRow>;

  /**
   * App-layer cascade for vault archive — mark every still-active credential
   * in a vault as archived in one round-trip. Replaces the list+loop in
   * vaults.ts:91-104 (which was non-atomic in the KV era).
   */
  archiveByVault(
    tenantId: string,
    vaultId: string,
    archivedAt: number,
  ): Promise<void>;

  delete(tenantId: string, vaultId: string, credentialId: string): Promise<void>;
}

export interface Clock {
  nowMs(): number;
}

export interface IdGenerator {
  credentialId(): string;
}

export interface Logger {
  warn(msg: string, ctx?: unknown): void;
}
