import { generateVaultId } from "@open-managed-agents/shared";
import { paginateVia } from "@open-managed-agents/shared";
import { VaultNotFoundError } from "./errors";
import type {
  Clock,
  IdGenerator,
  Logger,
  VaultRepo,
  VaultUpdateFields,
} from "./ports";
import type { VaultRow } from "./types";

export interface VaultServiceDeps {
  repo: VaultRepo;
  clock?: Clock;
  ids?: IdGenerator;
  logger?: Logger;
}

/**
 * VaultService — pure business logic over abstract ports.
 *
 * Vaults are intentionally minimal: the heavy lifting (credentials, mcp
 * server bindings, OAuth state) lives in adjacent stores. This service
 * just owns the vault entity itself.
 *
 * Cross-store cascade (vault archive → archive its credentials) is NOT
 * handled here — it's the route handler's job because the credentials
 * service is in a different package and we don't want a service-to-service
 * dependency in this package's port surface.
 */
export class VaultService {
  private readonly repo: VaultRepo;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly logger: Logger;

  constructor(deps: VaultServiceDeps) {
    this.repo = deps.repo;
    this.clock = deps.clock ?? defaultClock;
    this.ids = deps.ids ?? defaultIds;
    this.logger = deps.logger ?? consoleLogger;
  }

  async create(opts: { tenantId: string; name: string }): Promise<VaultRow> {
    return await this.repo.insert({
      id: this.ids.vaultId(),
      tenantId: opts.tenantId,
      name: opts.name,
      createdAt: this.clock.nowMs(),
    });
  }

  async get(opts: { tenantId: string; vaultId: string }): Promise<VaultRow | null> {
    return this.repo.get(opts.tenantId, opts.vaultId);
  }

  async exists(opts: { tenantId: string; vaultId: string }): Promise<boolean> {
    return this.repo.exists(opts.tenantId, opts.vaultId);
  }

  async list(opts: {
    tenantId: string;
    includeArchived?: boolean;
  }): Promise<VaultRow[]> {
    return this.repo.list(opts.tenantId, {
      includeArchived: opts.includeArchived ?? false,
    });
  }

  /** Cursor-paginated list. Order: created_at DESC, id DESC tie-break. */
  async listPage(opts: {
    tenantId: string;
    includeArchived?: boolean;
    limit?: number;
    cursor?: string;
  }): Promise<{ items: VaultRow[]; nextCursor?: string }> {
    return paginateVia({
      cursor: opts.cursor,
      limit: opts.limit,
      fetch: (after, limit) =>
        this.repo.listPage(opts.tenantId, {
          includeArchived: opts.includeArchived ?? false,
          limit,
          after,
        }),
      extractCursor: (r) => ({
        createdAt: new Date(r.created_at).getTime(),
        id: r.id,
      }),
    });
  }

  async update(opts: {
    tenantId: string;
    vaultId: string;
    name?: string;
  }): Promise<VaultRow> {
    await this.requireVault(opts);
    const fields: VaultUpdateFields = { updatedAt: this.clock.nowMs() };
    if (opts.name !== undefined) fields.name = opts.name;
    return this.repo.update(opts.tenantId, opts.vaultId, fields);
  }

  async archive(opts: { tenantId: string; vaultId: string }): Promise<VaultRow> {
    await this.requireVault(opts);
    return this.repo.archive(opts.tenantId, opts.vaultId, this.clock.nowMs());
  }

  async delete(opts: { tenantId: string; vaultId: string }): Promise<void> {
    await this.requireVault(opts);
    await this.repo.delete(opts.tenantId, opts.vaultId);
  }

  // ============================================================
  // Internals
  // ============================================================

  private async requireVault(opts: {
    tenantId: string;
    vaultId: string;
  }): Promise<VaultRow> {
    const row = await this.repo.get(opts.tenantId, opts.vaultId);
    if (!row) throw new VaultNotFoundError();
    return row;
  }
}

// ============================================================
// Default infra (used when callers don't override)
// ============================================================

const defaultClock: Clock = { nowMs: () => Date.now() };

const defaultIds: IdGenerator = { vaultId: generateVaultId };

const consoleLogger: Logger = { warn: (msg, ctx) => console.warn(msg, ctx) };
