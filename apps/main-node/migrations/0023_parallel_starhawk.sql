ALTER TABLE "api_keys" ADD COLUMN "credential_type" text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "environment_id" text;
