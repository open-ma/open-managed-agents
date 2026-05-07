// Abstract ports the VaultService depends on. Same DIP pattern as
// packages/credentials-store/src/ports.ts.
//
// Keep these tiny and runtime-agnostic: no Cloudflare types, no D1 query
// language. Pass plain data + return plain data.

import type { VaultRow } from "./types";
import type { PageCursor } from "@open-managed-agents/shared";

export interface NewVaultInput {
  id: string;
  tenantId: string;
  name: string;
  createdAt: number;
}

export interface VaultUpdateFields {
  name?: string;
  updatedAt: number;
}

export interface VaultRepo {
  insert(input: NewVaultInput): Promise<VaultRow>;

  get(tenantId: string, vaultId: string): Promise<VaultRow | null>;

  /**
   * Cheap existence check used by credentials routes that need to verify
   * vault membership before doing the actual credential op. Avoids loading
   * the whole row when the only thing the caller cares about is yes/no.
   */
  exists(tenantId: string, vaultId: string): Promise<boolean>;

  list(
    tenantId: string,
    opts: { includeArchived: boolean },
  ): Promise<VaultRow[]>;

  /** Cursor-paginated list. Order: created_at DESC, id DESC. */
  listPage(
    tenantId: string,
    opts: {
      includeArchived: boolean;
      limit: number;
      after?: PageCursor;
    },
  ): Promise<{ items: VaultRow[]; hasMore: boolean }>;

  update(
    tenantId: string,
    vaultId: string,
    update: VaultUpdateFields,
  ): Promise<VaultRow>;

  archive(
    tenantId: string,
    vaultId: string,
    archivedAt: number,
  ): Promise<VaultRow>;

  delete(tenantId: string, vaultId: string): Promise<void>;
}

export interface Clock {
  nowMs(): number;
}

export interface IdGenerator {
  vaultId(): string;
}

export interface Logger {
  warn(msg: string, ctx?: unknown): void;
}
