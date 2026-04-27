// Public types for the environments store service. Mirrors the D1 schema in
// apps/main/migrations/0003_environments_table.sql.
//
// Design choices:
//   - EnvironmentRow holds the full environment record (id, tenant_id, name,
//     description, status, build_error, sandbox_worker_name, config, metadata,
//     timestamps). Adapters JSON.parse the `config` and `metadata` columns.
//   - The shared `EnvironmentConfig` type (packages/shared/src/types.ts) has
//     every field except `tenant_id`. Routes returning this row to API
//     clients should strip `tenant_id` first (see sessions.ts toApiSession
//     for the pattern). Sessions store snapshots reuse the EnvironmentConfig
//     shape — see toEnvironmentConfig() helper in service.ts.
//   - status is intentionally TEXT in SQL (no CHECK constraint per project
//     convention). Service layer is the source of truth for the enum.
//   - sandbox_worker_name is denormalized to its own column even though it
//     could live inside `config` — getSandboxBinding (sessions.ts:47,
//     internal.ts:131, eval-runner.ts:27, session-do.ts:24) reads it on
//     every session-attached request, so the column read avoids a JSON.parse.

import type { EnvironmentConfig } from "@open-managed-agents/shared";

/**
 * Status of the environment build. Mirrors EnvironmentConfig.status with
 * "ready" as the canonical default for environments that don't go through
 * GitHub Actions (e.g. local dev where sandbox-default is used directly).
 */
export type EnvironmentStatus = "building" | "ready" | "error";

export interface EnvironmentRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  status: EnvironmentStatus;
  /** Worker name picked at session-create to find the SANDBOX_<name> binding. */
  sandbox_worker_name: string | null;
  /** Last build error message; null when status is "building" | "ready". */
  build_error: string | null;
  /** Free-form environment definition (packages, networking, etc.). */
  config: EnvironmentConfig["config"];
  /** Caller-supplied free-form metadata (publication context, eval-run id, etc.). */
  metadata: Record<string, unknown> | null;
  /** Image-build strategy. `base_snapshot` (default for new envs) installs
   *  packages once into a CF Sandbox snapshot under /home/env-cache/<id>/
   *  and restores on session boot. `dockerfile` is opt-in for users who
   *  need apt packages or full image control — it goes through the
   *  existing per-env CI build pipeline. Null = legacy (treated as
   *  `dockerfile` for back-compat with envs created before this field
   *  existed). */
  image_strategy: "base_snapshot" | "dockerfile" | null;
  /** Strategy-specific opaque blob (the `ImageHandle` returned by
   *  EnvironmentImageStrategy.prepare). For `base_snapshot` it carries
   *  the CF DirectoryBackup + cached env vars; for `dockerfile` it
   *  carries the per-env worker name + dockerfile hash. JSON-encoded
   *  in D1; deserialized to `unknown` here so the platform doesn't
   *  need to know the per-strategy shape. */
  image_handle: Record<string, unknown> | null;
  created_at: string;
  updated_at: string | null;
  archived_at: string | null;
}
