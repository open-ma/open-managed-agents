// Abstract ports the EnvironmentService depends on. Same DIP pattern as
// packages/credentials-store/src/ports.ts and packages/sessions-store/src/ports.ts.
//
// Keep these tiny and runtime-agnostic: no Cloudflare types, no D1 query
// language. Pass plain data + return plain data.
//
// Tenant routing: every method takes `tenantId` as the first argument. This
// is intentional — it makes tenantId a routing key, so a future per-tenant-D1
// adapter can pick a database per call without any port changes.

import type { EnvironmentConfig } from "@open-managed-agents/shared";
import type { PageCursor } from "@open-managed-agents/shared";
import type { EnvironmentRow, EnvironmentStatus } from "./types";

export interface NewEnvironmentInput {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  status: EnvironmentStatus;
  sandboxWorkerName: string | null;
  buildError: string | null;
  config: EnvironmentConfig["config"];
  metadata: Record<string, unknown> | null;
  /** Image-build strategy. Null = legacy (treated as `dockerfile`). */
  imageStrategy?: "base_snapshot" | "dockerfile" | null;
  /** Strategy-specific opaque blob — see EnvironmentRow.image_handle. */
  imageHandle?: Record<string, unknown> | null;
  createdAt: number;
}

/**
 * Update fields for an existing environment row. All optional except
 * `updatedAt`. Tri-state semantics for nullable fields:
 *   - undefined : leave column untouched
 *   - null      : clear the column (set to NULL)
 *   - value     : set the column
 *
 * Pulled apart from create input so the route layer can express "clear the
 * build_error after a successful retry" without conflating it with leave-as-is.
 */
export interface EnvironmentUpdateFields {
  name?: string;
  description?: string | null;
  status?: EnvironmentStatus;
  sandboxWorkerName?: string | null;
  buildError?: string | null;
  config?: EnvironmentConfig["config"];
  metadata?: Record<string, unknown> | null;
  imageStrategy?: "base_snapshot" | "dockerfile" | null;
  imageHandle?: Record<string, unknown> | null;
  updatedAt: number;
}

export interface EnvironmentRepo {
  insert(input: NewEnvironmentInput): Promise<EnvironmentRow>;

  get(tenantId: string, environmentId: string): Promise<EnvironmentRow | null>;

  list(
    tenantId: string,
    opts: { includeArchived: boolean },
  ): Promise<EnvironmentRow[]>;

  /** Cursor-paginated list. Order: created_at DESC, id DESC. */
  listPage(
    tenantId: string,
    opts: {
      includeArchived: boolean;
      limit: number;
      after?: PageCursor;
    },
  ): Promise<{ items: EnvironmentRow[]; hasMore: boolean }>;

  update(
    tenantId: string,
    environmentId: string,
    update: EnvironmentUpdateFields,
  ): Promise<EnvironmentRow>;

  archive(
    tenantId: string,
    environmentId: string,
    archivedAt: number,
  ): Promise<EnvironmentRow>;

  delete(tenantId: string, environmentId: string): Promise<void>;
}

export interface Clock {
  nowMs(): number;
}

export interface IdGenerator {
  environmentId(): string;
}

export interface Logger {
  warn(msg: string, ctx?: unknown): void;
}
