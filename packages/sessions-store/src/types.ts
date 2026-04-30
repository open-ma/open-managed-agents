// Public types for the sessions store service. Mirrors the D1 schema in
// apps/main/migrations/0010_sessions_tables.sql.
//
// Design choices:
//   - SessionRow holds the full session record incl. agent_snapshot /
//     environment_snapshot (frozen at create time so trajectory + replay still
//     work after the agent or env definition mutates).
//   - SessionResourceRow keeps the discriminated SessionResource shape from
//     @open-managed-agents/shared as the resource payload — adapters JSON.parse
//     the `config` column. The full SessionResource is round-tripped through
//     `config` for symmetry across resource types; a denormalized `type` column
//     supports the per-type quota count without touching JSON.
//   - The actual secret values for `github_repository.authorization_token` and
//     `env.value` (legacy: `env_secret.value`) are NOT stored here — they
//     continue to live in CONFIG_KV under
//     `t:{tenant}:secret:{session}:{resource}` keys, owned by the route layer
//     (sessions.ts:361/374, internal.ts:315). This store is intentionally
//     write-once for resource metadata only.

import type {
  AgentConfig,
  EnvironmentConfig,
  SessionResource,
  SessionStatus,
} from "@open-managed-agents/shared";

export interface SessionRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  environment_id: string;
  title: string;
  status: SessionStatus;
  /** Vault IDs attached to the session — used by SessionDO for outbound credential lookup. */
  vault_ids: string[] | null;
  /** Frozen agent definition at session-create time. Null only for tests / legacy paths. */
  agent_snapshot: AgentConfig | null;
  /** Frozen environment definition at session-create time. */
  environment_snapshot: EnvironmentConfig | null;
  /** Caller-supplied free-form metadata (Linear webhook context, eval-run id, etc.). */
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string | null;
  archived_at: string | null;
}

export interface SessionResourceRow {
  id: string;
  session_id: string;
  type: SessionResource["type"];
  /** Full SessionResource payload — adapters JSON.parse the `config` column. */
  resource: SessionResource;
  created_at: string;
}

/** Hard cap, mirrored from sessions.ts:869. Per-session resource ceiling. */
export const MAX_RESOURCES_PER_SESSION = 100;

/** Hard cap, mirrored from sessions.ts:188 + sessions.ts:893. Anthropic-aligned. */
export const MAX_MEMORY_STORE_RESOURCES_PER_SESSION = 8;
