import { bigint, index, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

/** Node-only durable execution outbox and lease state. */
export const managed_session_executions = pgTable(
  "managed_session_executions",
  {
    workspace_id: text("workspace_id").notNull(),
    session_id: text("session_id").notNull(),
    lane_id: text("lane_id").notNull(),
    id: text("id").notNull(),
    admitted_at_ms: bigint("admitted_at_ms", { mode: "number" }).notNull(),
    events_json: text("events_json").notNull(),
    events_fingerprint: text("events_fingerprint").notNull(),
    state: text("state").notNull(),
    attempt_id: text("attempt_id"),
    owner_id: text("owner_id"),
    generation: bigint("generation", { mode: "number" }).notNull().default(0),
    attempt_count: bigint("attempt_count", { mode: "number" }).notNull().default(0),
    max_attempts: bigint("max_attempts", { mode: "number" }).notNull().default(10),
    deadline_at_ms: bigint("deadline_at_ms", { mode: "number" }).notNull(),
    claimed_at_ms: bigint("claimed_at_ms", { mode: "number" }),
    lease_expires_at_ms: bigint("lease_expires_at_ms", { mode: "number" }),
    interrupt_requested_at_ms: bigint("interrupt_requested_at_ms", { mode: "number" }),
    settled_at_ms: bigint("settled_at_ms", { mode: "number" }),
    failure: text("failure"),
    revision: bigint("revision", { mode: "number" }).notNull().default(1),
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
