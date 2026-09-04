CREATE TABLE "managed_session_executions" (
	"workspace_id" text NOT NULL,
	"session_id" text NOT NULL,
	"lane_id" text NOT NULL,
	"id" text NOT NULL,
	"admitted_at_ms" bigint NOT NULL,
	"events_json" text NOT NULL,
	"events_fingerprint" text NOT NULL,
	"state" text NOT NULL,
	"attempt_id" text,
	"owner_id" text,
	"generation" bigint DEFAULT 0 NOT NULL,
	"attempt_count" bigint DEFAULT 0 NOT NULL,
	"max_attempts" bigint DEFAULT 10 NOT NULL,
	"deadline_at_ms" bigint NOT NULL,
	"claimed_at_ms" bigint,
	"lease_expires_at_ms" bigint,
	"interrupt_requested_at_ms" bigint,
	"settled_at_ms" bigint,
	"failure" text,
	"revision" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "managed_session_executions_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE INDEX "managed_session_executions_claim_idx" ON "managed_session_executions" USING btree ("state","lease_expires_at_ms","admitted_at_ms","id");--> statement-breakpoint
CREATE INDEX "managed_session_executions_session_idx" ON "managed_session_executions" USING btree ("workspace_id","session_id","lane_id","admitted_at_ms","id");
