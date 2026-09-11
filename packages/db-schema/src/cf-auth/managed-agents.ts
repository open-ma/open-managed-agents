// Official Anthropic Managed Agents persistence (CF SQLite / D1).
//
// These tables are intentionally separate from legacy OMA `agents` and
// `agent_versions`. The two JSON documents have different contracts and must
// remain independently deployable while `/v1/oma/*` extensions are isolated.

import { blob, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const managed_agents = sqliteTable(
  "managed_agents",
  {
    id: text("id").primaryKey().notNull(),
    workspace_id: text("workspace_id").notNull(),
    document: text("document").notNull(),
    version: integer("version").notNull(),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
    archived_at: integer("archived_at"),
  },
  (table) => [
    index("idx_managed_agents_workspace_created_id").on(
      table.workspace_id,
      table.created_at,
      table.id,
    ),
  ],
);

export const managed_agent_versions = sqliteTable(
  "managed_agent_versions",
  {
    agent_id: text("agent_id").notNull(),
    workspace_id: text("workspace_id").notNull(),
    version: integer("version").notNull(),
    document: text("document").notNull(),
    created_at: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.agent_id, table.version] }),
    index("idx_managed_agent_versions_workspace_agent").on(
      table.workspace_id,
      table.agent_id,
      table.version,
    ),
  ],
);

export const managed_files = sqliteTable(
  "managed_files",
  {
    workspace_id: text("workspace_id").notNull(),
    id: text("id").notNull(),
    document: text("document").notNull(),
    created_at: integer("created_at").notNull(),
    scope_id: text("scope_id"),
  },
  (table) => [
    primaryKey({ columns: [table.workspace_id, table.id] }),
    index("idx_managed_files_workspace_created_id").on(
      table.workspace_id,
      table.created_at,
      table.id,
    ),
    index("idx_managed_files_workspace_scope_created_id").on(
      table.workspace_id,
      table.scope_id,
      table.created_at,
      table.id,
    ),
  ],
);

export const managed_environments = sqliteTable(
  "managed_environments",
  {
    workspace_id: text("workspace_id").notNull(),
    id: text("id").notNull(),
    document: text("document").notNull(),
    revision: integer("revision").notNull(),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
    archived_at: integer("archived_at"),
  },
  (table) => [
    primaryKey({ columns: [table.workspace_id, table.id] }),
    index("idx_managed_environments_workspace_created_id").on(
      table.workspace_id,
      table.created_at,
      table.id,
    ),
  ],
);

export const managed_memory_stores = sqliteTable(
  "managed_memory_stores",
  {
    workspace_id: text("workspace_id").notNull(),
    id: text("id").notNull(),
    document: text("document").notNull(),
    revision: integer("revision").notNull(),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
    archived_at: integer("archived_at"),
  },
  (table) => [
    primaryKey({ columns: [table.workspace_id, table.id] }),
    index("idx_managed_memory_stores_workspace_created_id").on(
      table.workspace_id,
      table.created_at,
      table.id,
    ),
  ],
);

export const managed_memories = sqliteTable(
  "managed_memories",
  {
    workspace_id: text("workspace_id").notNull(),
    memory_store_id: text("memory_store_id").notNull(),
    id: text("id").notNull(),
    document: text("document").notNull(),
    revision: integer("revision").notNull(),
    path: text("path").notNull(),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspace_id, table.id] }),
    index("idx_managed_memories_workspace_store_updated_id").on(
      table.workspace_id,
      table.memory_store_id,
      table.updated_at,
      table.id,
    ),
    uniqueIndex("idx_managed_memories_workspace_store_path").on(
      table.workspace_id,
      table.memory_store_id,
      table.path,
    ),
  ],
);

export const managed_memory_versions = sqliteTable(
  "managed_memory_versions",
  {
    workspace_id: text("workspace_id").notNull(),
    memory_store_id: text("memory_store_id").notNull(),
    id: text("id").notNull(),
    memory_id: text("memory_id").notNull(),
    document: text("document").notNull(),
    revision: integer("revision").notNull(),
    operation: text("operation").notNull(),
    actor_kind: text("actor_kind").notNull(),
    actor_id: text("actor_id").notNull(),
    created_at: integer("created_at").notNull(),
    redacted_at: integer("redacted_at"),
  },
  (table) => [
    primaryKey({ columns: [table.workspace_id, table.id] }),
    index("idx_managed_memory_versions_workspace_store_created_id").on(
      table.workspace_id,
      table.memory_store_id,
      table.created_at,
      table.id,
    ),
    index("idx_managed_memory_versions_workspace_memory_created_id").on(
      table.workspace_id,
      table.memory_id,
      table.created_at,
      table.id,
    ),
  ],
);

export const managed_skills = sqliteTable(
  "managed_skills",
  {
    workspace_id: text("workspace_id").notNull(),
    id: text("id").notNull(),
    document: text("document").notNull(),
    revision: integer("revision").notNull(),
    source: text("source").notNull(),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspace_id, table.id] }),
    index("idx_managed_skills_workspace_created_id").on(
      table.workspace_id,
      table.created_at,
      table.id,
    ),
  ],
);

export const managed_skill_versions = sqliteTable(
  "managed_skill_versions",
  {
    workspace_id: text("workspace_id").notNull(),
    skill_id: text("skill_id").notNull(),
    id: text("id").notNull(),
    version: text("version").notNull(),
    document: text("document").notNull(),
    archive: blob("archive", { mode: "buffer" }).notNull(),
    archive_filename: text("archive_filename").notNull(),
    archive_media_type: text("archive_media_type").notNull(),
    created_at: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspace_id, table.skill_id, table.version],
    }),
    uniqueIndex("idx_managed_skill_versions_workspace_id").on(
      table.workspace_id,
      table.id,
    ),
    index("idx_managed_skill_versions_workspace_skill_created_id").on(
      table.workspace_id,
      table.skill_id,
      table.created_at,
      table.id,
    ),
  ],
);

export const managed_deployments = sqliteTable(
  "managed_deployments",
  {
    workspace_id: text("workspace_id").notNull(),
    id: text("id").notNull(),
    document: text("document").notNull(),
    sealed_resource_secrets: text("sealed_resource_secrets").notNull(),
    revision: integer("revision").notNull(),
    agent_id: text("agent_id").notNull(),
    status: text("status").notNull(),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
    archived_at: integer("archived_at"),
  },
  (table) => [
    primaryKey({ columns: [table.workspace_id, table.id] }),
    index("idx_managed_deployments_workspace_created_id").on(
      table.workspace_id,
      table.created_at,
      table.id,
    ),
    index("idx_managed_deployments_workspace_agent_created_id").on(
      table.workspace_id,
      table.agent_id,
      table.created_at,
      table.id,
    ),
  ],
);

export const managed_deployment_runs = sqliteTable(
  "managed_deployment_runs",
  {
    workspace_id: text("workspace_id").notNull(),
    id: text("id").notNull(),
    deployment_id: text("deployment_id").notNull(),
    document: text("document").notNull(),
    revision: integer("revision").notNull(),
    has_error: integer("has_error").notNull(),
    trigger_type: text("trigger_type").notNull(),
    created_at: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspace_id, table.id] }),
    index("idx_managed_deployment_runs_workspace_created_id").on(
      table.workspace_id,
      table.created_at,
      table.id,
    ),
    index("idx_managed_deployment_runs_workspace_deployment_created_id").on(
      table.workspace_id,
      table.deployment_id,
      table.created_at,
      table.id,
    ),
  ],
);

export const managed_environment_work = sqliteTable(
  "managed_environment_work",
  {
    workspace_id: text("workspace_id").notNull(),
    environment_id: text("environment_id").notNull(),
    id: text("id").notNull(),
    session_id: text("session_id"),
    document: text("document").notNull(),
    sealed_secret: text("sealed_secret").notNull(),
    claim_at: integer("claim_at"),
    claim_worker_id: text("claim_worker_id"),
    claim_generation: integer("claim_generation").notNull().default(0),
    heartbeat_ttl_seconds: integer("heartbeat_ttl_seconds").notNull(),
    revision: integer("revision").notNull(),
    state: text("state").notNull(),
    created_at: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspace_id, table.id] }),
    index("idx_managed_environment_work_queue").on(
      table.workspace_id,
      table.environment_id,
      table.state,
      table.claim_at,
      table.created_at,
      table.id,
    ),
    index("idx_managed_environment_work_created_id").on(
      table.workspace_id,
      table.environment_id,
      table.created_at,
      table.id,
    ),
    index("idx_managed_environment_work_session").on(
      table.workspace_id,
      table.session_id,
      table.state,
      table.created_at,
      table.id,
    ),
  ],
);

export const managed_environment_work_workers = sqliteTable(
  "managed_environment_work_workers",
  {
    workspace_id: text("workspace_id").notNull(),
    environment_id: text("environment_id").notNull(),
    worker_id: text("worker_id").notNull(),
    last_polled_at: integer("last_polled_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspace_id, table.environment_id, table.worker_id],
    }),
    index("idx_managed_environment_work_workers_activity").on(
      table.workspace_id,
      table.environment_id,
      table.last_polled_at,
    ),
  ],
);

export const managed_dreams = sqliteTable(
  "managed_dreams",
  {
    workspace_id: text("workspace_id").notNull(),
    id: text("id").notNull(),
    document: text("document").notNull(),
    revision: integer("revision").notNull(),
    status: text("status").notNull(),
    created_at: integer("created_at").notNull(),
    archived_at: integer("archived_at"),
  },
  (table) => [
    primaryKey({ columns: [table.workspace_id, table.id] }),
    index("idx_managed_dreams_workspace_created_id").on(
      table.workspace_id,
      table.created_at,
      table.id,
    ),
    index("idx_managed_dreams_workspace_status_created_id").on(
      table.workspace_id,
      table.status,
      table.created_at,
      table.id,
    ),
  ],
);

export const managed_tunnels = sqliteTable(
  "managed_tunnels",
  {
    workspace_id: text("workspace_id").notNull(),
    id: text("id").notNull(),
    document: text("document").notNull(),
    revision: integer("revision").notNull(),
    created_at: integer("created_at").notNull(),
    archived_at: integer("archived_at"),
  },
  (table) => [
    primaryKey({ columns: [table.workspace_id, table.id] }),
    index("idx_managed_tunnels_workspace_created_id").on(
      table.workspace_id,
      table.created_at,
      table.id,
    ),
  ],
);

export const managed_vaults = sqliteTable(
  "managed_vaults",
  {
    workspace_id: text("workspace_id").notNull(),
    id: text("id").notNull(),
    document: text("document").notNull(),
    revision: integer("revision").notNull(),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
    archived_at: integer("archived_at"),
  },
  (table) => [
    primaryKey({ columns: [table.workspace_id, table.id] }),
    index("idx_managed_vaults_workspace_created_id").on(
      table.workspace_id,
      table.created_at,
      table.id,
    ),
  ],
);

export const managed_credentials = sqliteTable(
  "managed_credentials",
  {
    workspace_id: text("workspace_id").notNull(),
    vault_id: text("vault_id").notNull(),
    id: text("id").notNull(),
    sealed_document: text("sealed_document").notNull(),
    revision: integer("revision").notNull(),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
    archived_at: integer("archived_at"),
  },
  (table) => [
    primaryKey({ columns: [table.workspace_id, table.id] }),
    index("idx_managed_credentials_workspace_vault_created_id").on(
      table.workspace_id,
      table.vault_id,
      table.created_at,
      table.id,
    ),
  ],
);

export const managed_user_profiles = sqliteTable(
  "managed_user_profiles",
  {
    workspace_id: text("workspace_id").notNull(),
    id: text("id").notNull(),
    document: text("document").notNull(),
    revision: integer("revision").notNull(),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspace_id, table.id] }),
    index("idx_managed_user_profiles_workspace_created_id").on(
      table.workspace_id,
      table.created_at,
      table.id,
    ),
  ],
);

export const managed_sessions = sqliteTable(
  "managed_sessions",
  {
    id: text("id").primaryKey().notNull(),
    workspace_id: text("workspace_id").notNull(),
    document: text("document").notNull(),
    revision: integer("revision").notNull(),
    agent_id: text("agent_id").notNull(),
    agent_version: integer("agent_version").notNull(),
    environment_id: text("environment_id").notNull(),
    deployment_id: text("deployment_id"),
    status: text("status").notNull(),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
    archived_at: integer("archived_at"),
  },
  (table) => [
    index("idx_managed_sessions_workspace_created_id").on(
      table.workspace_id,
      table.created_at,
      table.id,
    ),
    index("idx_managed_sessions_workspace_agent").on(
      table.workspace_id,
      table.agent_id,
      table.agent_version,
    ),
  ],
);

export const managed_session_memory_stores = sqliteTable(
  "managed_session_memory_stores",
  {
    session_id: text("session_id").notNull(),
    workspace_id: text("workspace_id").notNull(),
    memory_store_id: text("memory_store_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.memory_store_id] }),
    index("idx_managed_session_memory_stores_workspace_store").on(
      table.workspace_id,
      table.memory_store_id,
      table.session_id,
    ),
  ],
);

export const managed_session_initial_events = sqliteTable(
  "managed_session_initial_events",
  {
    session_id: text("session_id").notNull(),
    workspace_id: text("workspace_id").notNull(),
    sequence: integer("sequence").notNull(),
    document: text("document").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.sequence] }),
  ],
);

export const managed_session_events = sqliteTable(
  "managed_session_events",
  {
    workspace_id: text("workspace_id").notNull(),
    session_id: text("session_id").notNull(),
    thread_id: text("thread_id"),
    id: text("id").notNull(),
    type: text("type").notNull(),
    document: text("document").notNull(),
    processed_at: integer("processed_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspace_id, table.session_id, table.id] }),
    index("idx_managed_session_events_workspace_session_time_id").on(
      table.workspace_id,
      table.session_id,
      table.processed_at,
      table.id,
    ),
    index("idx_managed_session_events_workspace_session_type_time_id").on(
      table.workspace_id,
      table.session_id,
      table.type,
      table.processed_at,
      table.id,
    ),
    index("idx_managed_session_events_workspace_thread_time_id").on(
      table.workspace_id,
      table.session_id,
      table.thread_id,
      table.processed_at,
      table.id,
    ),
  ],
);

export const managed_session_threads = sqliteTable(
  "managed_session_threads",
  {
    workspace_id: text("workspace_id").notNull(),
    session_id: text("session_id").notNull(),
    id: text("id").notNull(),
    document: text("document").notNull(),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
    archived_at: integer("archived_at"),
  },
  (table) => [
    primaryKey({ columns: [table.workspace_id, table.session_id, table.id] }),
    index("idx_managed_session_threads_workspace_session_created_id").on(
      table.workspace_id,
      table.session_id,
      table.created_at,
      table.id,
    ),
  ],
);

export const managed_session_resource_secrets = sqliteTable(
  "managed_session_resource_secrets",
  {
    workspace_id: text("workspace_id").notNull(),
    session_id: text("session_id").notNull(),
    resource_id: text("resource_id").notNull(),
    secret_type: text("secret_type").notNull(),
    sealed_value: text("sealed_value").notNull(),
    updated_at: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspace_id, table.session_id, table.resource_id],
    }),
    index("idx_managed_session_resource_secrets_workspace_session").on(
      table.workspace_id,
      table.session_id,
    ),
  ],
);
