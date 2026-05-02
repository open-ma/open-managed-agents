// Abstract ports the AgentService depends on. Same DIP pattern as
// packages/credentials-store/src/ports.ts — concrete adapters in src/adapters/
// implement these against Cloudflare bindings; src/test-fakes.ts provides
// in-memory implementations.
//
// Keep these tiny and runtime-agnostic: no Cloudflare types, no D1 query
// language. Pass plain data + return plain data. The schema is no-FK by
// project convention; cascade-by-agent (history rows) lives in this port
// (`deleteWithVersions`) so adapters and the in-memory fake share one
// canonical implementation.
//
// Tenant routing: every method takes `tenantId` as the first argument (or
// a top-level field on the input). This is intentional — see
// packages/credentials-store/src/ports.ts for the rationale.

import type { AgentConfig } from "@open-managed-agents/shared";
import type { PageCursor } from "@open-managed-agents/shared";
import type { AgentRow, AgentVersionRow } from "./types";

export interface NewAgentInput {
  id: string;
  tenantId: string;
  /** Full agent config, including version=1 + created_at + updated_at. */
  config: AgentConfig;
  createdAt: number;
}

export interface AgentUpdateFields {
  /** Full replacement config — service merges fields, repo just writes. */
  config: AgentConfig;
  version: number;
  updatedAt: number;
}

export interface AgentRepo {
  /** Insert a new agent at version 1. */
  insert(input: NewAgentInput): Promise<AgentRow>;

  get(tenantId: string, agentId: string): Promise<AgentRow | null>;

  /**
   * Cross-tenant lookup by id — replaces SessionDO's CONFIG_KV fallback at
   * session-do.ts:185 (which can hit a wrong-tenant key when sandbox-default's
   * KV namespace differs from main's). Used at agent runtime when the snapshot
   * isn't on the DO state.
   */
  getById(agentId: string): Promise<AgentRow | null>;

  /** List agents in a tenant. `includeArchived: false` excludes archived rows. */
  list(
    tenantId: string,
    opts: { includeArchived: boolean },
  ): Promise<AgentRow[]>;

  /**
   * Cursor-paginated list. Order: created_at DESC, id DESC (newest first,
   * id breaks ties on identical timestamps). Returns up to `limit` items
   * plus `hasMore` so the service layer can decide whether to emit a
   * `nextCursor`. Caller doesn't need to interpret the cursor — `after`
   * is the typed pair `{createdAt, id}` decoded by the service.
   */
  listPage(
    tenantId: string,
    opts: {
      includeArchived: boolean;
      limit: number;
      /** Decoded cursor: skip rows up to and including (created_at, id). */
      after?: PageCursor;
    },
  ): Promise<{ items: AgentRow[]; hasMore: boolean }>;

  /**
   * Atomic update: write the prior snapshot to agent_versions AND replace the
   * agents row in one batch. Replaces the legacy non-atomic KV pattern (KV.put
   * history then KV.put current at agents.ts:251 + 276).
   */
  updateWithVersionSnapshot(
    tenantId: string,
    agentId: string,
    update: AgentUpdateFields,
    priorSnapshot: AgentVersionSnapshotInput,
  ): Promise<AgentRow>;

  archive(
    tenantId: string,
    agentId: string,
    archivedAt: number,
  ): Promise<AgentRow>;

  /**
   * Hard-delete the agent AND cascade-delete every history row in the same
   * batch. Replaces the legacy "kvListAll versions then loop delete" pattern.
   */
  deleteWithVersions(tenantId: string, agentId: string): Promise<void>;

  // ── agent_versions operations ──

  /** All historical snapshots for an agent (excludes the current version). */
  listVersions(tenantId: string, agentId: string): Promise<AgentVersionRow[]>;

  /** A specific historical snapshot. Returns null when the version is the
   *  current one (matching legacy KV semantics — current lives in `agents`). */
  getVersion(
    tenantId: string,
    agentId: string,
    version: number,
  ): Promise<AgentVersionRow | null>;
}

/** Append-only snapshot row — the service writes one per update via `updateWithVersionSnapshot`. */
export interface AgentVersionSnapshotInput {
  agentId: string;
  tenantId: string;
  version: number;
  /** Full AgentConfig as it was at this version. */
  snapshot: AgentConfig;
  createdAt: number;
}

export interface Clock {
  nowMs(): number;
}

export interface IdGenerator {
  agentId(): string;
}

export interface Logger {
  warn(msg: string, ctx?: unknown): void;
}
