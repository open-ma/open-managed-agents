// In-memory implementations of every port for unit tests. Mirrors the partial
// UNIQUE semantics + cascade behavior of the D1 adapter so tests catch the same
// constraint violations.
//
// Crypto symmetry: this fake mirrors SqlCredentialRepo's encrypt-on-write /
// decrypt-on-read boundary. By default it uses an identity (passthrough)
// crypto so existing tests keep working unchanged. Pass a custom Crypto (e.g.
// FakeCrypto below) to exercise the encryption path in a unit test.

import type { CredentialAuth } from "@open-managed-agents/shared";
import { CredentialDuplicateMcpUrlError, CredentialNotFoundError } from "./errors";
import type {
  Clock,
  CredentialRepo,
  CredentialUpdateFields,
  Crypto,
  IdGenerator,
  Logger,
  NewCredentialInput,
} from "./ports";
import { CredentialService } from "./service";
import type { CredentialRow } from "./types";

/**
 * In-memory row mirrors the SQL schema: hot-path fields denormalized
 * alongside an encrypted `auth_cipher` blob. Crypto is optional — defaults to
 * identity so the row's `auth_cipher` is just `JSON.stringify(auth)`.
 */
interface InMemCredential {
  id: string;
  tenant_id: string;
  vault_id: string;
  display_name: string;
  auth_type: string;
  mcp_server_url: string | null;
  provider: string | null;
  auth_cipher: string;
  created_at: number;
  updated_at: number | null;
  archived_at: number | null;
}

export class InMemoryCredentialRepo implements CredentialRepo {
  private readonly byId = new Map<string, InMemCredential>();
  private readonly crypto: Crypto;

  constructor(opts?: { crypto?: Crypto }) {
    this.crypto = opts?.crypto ?? identityCrypto;
  }

  async insert(input: NewCredentialInput): Promise<CredentialRow> {
    // Match the D1 partial UNIQUE: (tenant_id, vault_id, mcp_server_url)
    // WHERE mcp_server_url IS NOT NULL AND archived_at IS NULL.
    if (input.auth.mcp_server_url) {
      for (const c of this.byId.values()) {
        if (
          c.tenant_id === input.tenantId &&
          c.vault_id === input.vaultId &&
          c.archived_at === null &&
          c.mcp_server_url === input.auth.mcp_server_url
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
      auth_type: input.auth.type,
      mcp_server_url: input.auth.mcp_server_url ?? null,
      provider: input.auth.provider ?? null,
      auth_cipher: await this.crypto.encrypt(JSON.stringify(input.auth)),
      created_at: input.createdAt,
      updated_at: null,
      archived_at: null,
    };
    this.byId.set(input.id, row);
    return await this.toRow(row);
  }

  async get(tenantId: string, vaultId: string, credentialId: string): Promise<CredentialRow | null> {
    const row = this.byId.get(credentialId);
    if (!row) return null;
    if (row.tenant_id !== tenantId || row.vault_id !== vaultId) return null;
    return await this.toRow(row);
  }

  async list(
    tenantId: string,
    vaultId: string,
    opts: { includeArchived: boolean },
  ): Promise<CredentialRow[]> {
    const matches = Array.from(this.byId.values())
      .filter((c) => c.tenant_id === tenantId && c.vault_id === vaultId)
      .filter((c) => opts.includeArchived || c.archived_at === null)
      .sort((a, b) => a.created_at - b.created_at);
    return Promise.all(matches.map((m) => this.toRow(m)));
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
        c.mcp_server_url === mcpServerUrl
      ) {
        return await this.toRow(c);
      }
    }
    return null;
  }

  async listByVaults(tenantId: string, vaultIds: string[]): Promise<CredentialRow[]> {
    if (!vaultIds.length) return [];
    const set = new Set(vaultIds);
    const matches = Array.from(this.byId.values())
      .filter((c) => c.tenant_id === tenantId && set.has(c.vault_id))
      .sort((a, b) => a.created_at - b.created_at);
    return Promise.all(matches.map((m) => this.toRow(m)));
  }

  async listProviderTagged(tenantId: string, vaultIds: string[]): Promise<CredentialRow[]> {
    if (!vaultIds.length) return [];
    const set = new Set(vaultIds);
    const matches = Array.from(this.byId.values()).filter(
      (c) =>
        c.tenant_id === tenantId &&
        set.has(c.vault_id) &&
        c.archived_at === null &&
        c.provider !== null,
    );
    return Promise.all(matches.map((m) => this.toRow(m)));
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
    if (update.auth !== undefined) {
      row.auth_type = update.auth.type;
      row.mcp_server_url = update.auth.mcp_server_url ?? null;
      row.provider = update.auth.provider ?? null;
      row.auth_cipher = await this.crypto.encrypt(JSON.stringify(update.auth));
    }
    row.updated_at = update.updatedAt;
    return await this.toRow(row);
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
    return await this.toRow(row);
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

  /**
   * Test introspection: returns the raw encrypted blob for a row, bypassing
   * crypto. Use to assert that the on-disk format is encrypted and not the
   * plaintext JSON.
   */
  __getRawAuthCipher(credentialId: string): string | undefined {
    return this.byId.get(credentialId)?.auth_cipher;
  }

  private async toRow(c: InMemCredential): Promise<CredentialRow> {
    const authJson = await this.crypto.decrypt(c.auth_cipher);
    return {
      id: c.id,
      tenant_id: c.tenant_id,
      vault_id: c.vault_id,
      display_name: c.display_name,
      auth: JSON.parse(authJson) as CredentialAuth,
      created_at: msToIso(c.created_at),
      updated_at: c.updated_at !== null ? msToIso(c.updated_at) : null,
      archived_at: c.archived_at !== null ? msToIso(c.archived_at) : null,
    };
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
 * Reversible test crypto with a recognizable wrapper so tests can:
 *   1. assert the on-disk blob is the cipher (not the plaintext)
 *   2. confirm decrypt is wired (would fail to parse otherwise)
 *
 * Mirrors packages/model-cards-store/src/test-fakes.ts:FakeCrypto for
 * cross-store consistency.
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
 * pass overrides for any port (e.g. a ManualClock for deterministic timestamps,
 * FakeCrypto to exercise the encryption boundary).
 */
export function createInMemoryCredentialService(opts?: {
  clock?: Clock;
  ids?: IdGenerator;
  logger?: Logger;
  crypto?: Crypto;
}): {
  service: CredentialService;
  repo: InMemoryCredentialRepo;
} {
  const repo = new InMemoryCredentialRepo({ crypto: opts?.crypto });
  const service = new CredentialService({
    repo,
    clock: opts?.clock,
    ids: opts?.ids ?? new SequentialIdGenerator(),
    logger: opts?.logger ?? new SilentLogger(),
  });
  return { service, repo };
}

// ── helpers ──

const identityCrypto: Crypto = {
  async encrypt(plaintext) {
    return plaintext;
  },
  async decrypt(ciphertext) {
    return ciphertext;
  },
};

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}
