// Public types for the agents store service. Mirrors the D1 schema in
// apps/main/migrations/0002_agents_tables.sql.
//
// Design choices:
//   - AgentRow IS the canonical AgentConfig — adapters JSON.parse the `config`
//     column and round-trip the whole thing. Hot fields (tenant_id, version,
//     created_at, archived_at) live as their own columns for query-side
//     filtering / ordering; the JSON blob carries the rest.
//   - Two-table design: `agents` holds the current row (one per id);
//     `agent_versions` holds append-only snapshots written BEFORE each
//     update bump. listVersions / getVersion return only HISTORICAL rows
//     (matching the legacy KV semantics: versions n..current-1 are in history,
//     `current` is in `agents`).

import type { AgentConfig } from "@open-managed-agents/shared";

/**
 * Current-state agent row. Equivalent to the AgentConfig shape with the
 * tenant_id surfaced (the legacy KV value never carried tenant_id since the
 * KV key encoded it). All sub-fields are the parsed AgentConfig fields.
 */
export type AgentRow = AgentConfig & {
  tenant_id: string;
};

/**
 * Append-only history row. `snapshot` is the full AgentConfig at that version,
 * frozen the moment update() bumped past it. `created_at` records WHEN the row
 * was archived to history (i.e. when the next update happened), not the
 * agent's original create_at.
 */
export interface AgentVersionRow {
  agent_id: string;
  tenant_id: string;
  version: number;
  /** Full AgentConfig at that version. */
  snapshot: AgentConfig;
  /** When this snapshot was archived to history (i.e. the previous-update timestamp). */
  created_at: string;
}
