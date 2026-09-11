import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Durable Session execution authority shared by the main D1 worker and the
 * SessionDO host.  This table is deliberately part of the control-plane
 * schema: it stores only admitted event batches and lease/fencing metadata,
 * never provider-specific runtime state.
 */
export const managed_session_executions = sqliteTable(
  "managed_session_executions",
  {
    workspace_id: text("workspace_id").notNull(),
    session_id: text("session_id").notNull(),
    lane_id: text("lane_id").notNull(),
    id: text("id").notNull(),
    admitted_at_ms: integer("admitted_at_ms").notNull(),
    events_json: text("events_json").notNull(),
    events_fingerprint: text("events_fingerprint").notNull(),
    state: text("state").notNull(),
    attempt_id: text("attempt_id"),
    owner_id: text("owner_id"),
    generation: integer("generation").notNull().default(0),
    attempt_count: integer("attempt_count").notNull().default(0),
    max_attempts: integer("max_attempts").notNull().default(10),
    deadline_at_ms: integer("deadline_at_ms").notNull(),
    claimed_at_ms: integer("claimed_at_ms"),
    lease_expires_at_ms: integer("lease_expires_at_ms"),
    interrupt_requested_at_ms: integer("interrupt_requested_at_ms"),
    settled_at_ms: integer("settled_at_ms"),
    failure: text("failure"),
    revision: integer("revision").notNull().default(1),
  },
  (table) => [
    primaryKey({ columns: [table.workspace_id, table.id] }),
    index("managed_session_executions_claim_idx").on(
      table.state,
      table.lease_expires_at_ms,
      table.admitted_at_ms,
      table.id,
    ),
    index("managed_session_executions_session_idx").on(
      table.workspace_id,
      table.session_id,
      table.lane_id,
      table.admitted_at_ms,
      table.id,
    ),
  ],
);
