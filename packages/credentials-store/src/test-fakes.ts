// In-memory implementations of every port for unit tests. Mirrors the partial
// UNIQUE semantics + cascade behavior of the D1 adapter so tests catch the same
// constraint violations.

import type { CredentialAuth } from "@open-managed-agents/shared";
import { CredentialDuplicateMcpUrlError, CredentialNotFoundError } from "./errors";
import type {
  Clock,
  CredentialRepo,
  CredentialUpdateFields,
  IdGenerator,
  Logger,
  NewCredentialInput,
} from "./ports";
import { CredentialService } from "./service";
import type { CredentialRow } from "./types";

interface InMemCredential {
  id: string;
  tenant_id: string;
  vault_id: string;
  display_name: string;
  auth: CredentialAuth;
  created_at: number;
  updated_at: number | null;
  archived_at: number | null;
}

export class InMemoryCredentialRepo implements CredentialRepo {
  private readonly byId = new Map<string, InMemCredential>();

  async insert(input: NewCredentialInput): Promise<CredentialRow> {
    // Match the D1 partial UNIQUE: (tenant_id, vault_id, mcp_server_url)
    // WHERE mcp_server_url IS NOT NULL AND archived_at IS NULL.
    if (input.auth.mcp_server_url) {
      for (const c of this.byId.values()) {
        if (
          c.tenant_id === input.tenantId &&
          c.vault_id === input.vaultId &&
          c.archived_at === null &&
          c.auth.mcp_server_url === input.auth.mcp_server_url
        ) {
          throw new CredentialDuplicateMcpUrlError();
        }
      }
    }
    const row: InMemCredential = {
      id: input.id,
      tenant_id: input.tenantId,
      vault_id: input.vaultId,
      display_name: input.displayName,
      auth: input.auth,
      created_at: input.createdAt,
      updated_at: null,
      archived_at: null,
    };
    this.byId.set(input.id, row);
    return toRow(row);
  }

  async get(tenantId: string, vaultId: string, credentialId: string): Promise<CredentialRow | null> {
    const row = this.byId.get(credentialId);
    if (!row) return null;
    if (row.tenant_id !== tenantId || row.vault_id !== vaultId) return null;
    return toRow(row);
  }

  async list(
    tenantId: string,
    vaultId: string,
    opts: { includeArchived: boolean },
  ): Promise<CredentialRow[]> {
    return Array.from(this.byId.values())
      .filter((c) => c.tenant_id === tenantId && c.vault_id === vaultId)
      .filter((c) => opts.includeArchived || c.archived_at === null)
      .sort((a, b) => a.created_at - b.created_at)
      .map(toRow);
  }

  async countAll(tenantId: string, vaultId: string): Promise<number> {
    let n = 0;
    for (const c of this.byId.values()) {
      if (c.tenant_id === tenantId && c.vault_id === vaultId) n++;
    }
    return n;
  }

  async findActiveByMcpUrl(
    tenantId: string,
    vaultId: string,
    mcpServerUrl: string,
  ): Promise<CredentialRow | null> {
    for (const c of this.byId.values()) {
      if (
        c.tenant_id === tenantId &&
        c.vault_id === vaultId &&
        c.archived_at === null &&
        c.auth.mcp_server_url === mcpServerUrl
      ) {
        return toRow(c);
      }
    }
    return null;
  }

  async listByVaults(tenantId: string, vaultIds: string[]): Promise<CredentialRow[]> {
    if (!vaultIds.length) return [];
    const set = new Set(vaultIds);
    return Array.from(this.byId.values())
      .filter((c) => c.tenant_id === tenantId && set.has(c.vault_id))
      .sort((a, b) => a.created_at - b.created_at)
      .map(toRow);
  }

  async listProviderTagged(tenantId: string, vaultIds: string[]): Promise<CredentialRow[]> {
    if (!vaultIds.length) return [];
    const set = new Set(vaultIds);
    return Array.from(this.byId.values())
      .filter(
        (c) =>
          c.tenant_id === tenantId &&
          set.has(c.vault_id) &&
          c.archived_at === null &&
          !!c.auth.provider,
      )
      .map(toRow);
  }

  async update(
    tenantId: string,
    vaultId: string,
    credentialId: string,
    update: CredentialUpdateFields,
  ): Promise<CredentialRow> {
    const row = this.byId.get(credentialId);
    if (!row || row.tenant_id !== tenantId || row.vault_id !== vaultId) {
      throw new CredentialNotFoundError();
    }
    if (update.displayName !== undefined) row.display_name = update.displayName;
    if (update.auth !== undefined) row.auth = update.auth;
    row.updated_at = update.updatedAt;
    return toRow(row);
  }

  async archive(
    tenantId: string,
    vaultId: string,
    credentialId: string,
    archivedAt: number,
  ): Promise<CredentialRow> {
    const row = this.byId.get(credentialId);
    if (!row || row.tenant_id !== tenantId || row.vault_id !== vaultId) {
      throw new CredentialNotFoundError();
    }
    row.archived_at = archivedAt;
    row.updated_at = archivedAt;
    return toRow(row);
  }

  async archiveByVault(
    tenantId: string,
    vaultId: string,
    archivedAt: number,
  ): Promise<void> {
    for (const c of this.byId.values()) {
      if (c.tenant_id === tenantId && c.vault_id === vaultId && c.archived_at === null) {
        c.archived_at = archivedAt;
        c.updated_at = archivedAt;
      }
    }
  }

  async delete(tenantId: string, vaultId: string, credentialId: string): Promise<void> {
    const row = this.byId.get(credentialId);
    if (!row || row.tenant_id !== tenantId || row.vault_id !== vaultId) return;
    this.byId.delete(credentialId);
  }
}

export class SequentialIdGenerator implements IdGenerator {
  private n = 0;
  credentialId(): string {
    return `cred-${++this.n}`;
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
 * Convenience factory — full in-memory wiring with sane defaults. Tests can
 * pass overrides for any port (e.g. a ManualClock for deterministic timestamps).
 */
export function createInMemoryCredentialService(opts?: {
  clock?: Clock;
  ids?: IdGenerator;
  logger?: Logger;
}): {
  service: CredentialService;
  repo: InMemoryCredentialRepo;
} {
  const repo = new InMemoryCredentialRepo();
  const service = new CredentialService({
    repo,
    clock: opts?.clock,
    ids: opts?.ids ?? new SequentialIdGenerator(),
    logger: opts?.logger ?? new SilentLogger(),
  });
  return { service, repo };
}

// ── helpers ──

function toRow(c: InMemCredential): CredentialRow {
  return {
    id: c.id,
    tenant_id: c.tenant_id,
    vault_id: c.vault_id,
    display_name: c.display_name,
    auth: c.auth,
    created_at: msToIso(c.created_at),
    updated_at: c.updated_at !== null ? msToIso(c.updated_at) : null,
    archived_at: c.archived_at !== null ? msToIso(c.archived_at) : null,
  };
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}
