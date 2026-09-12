-- Cloudflare deployments created before the SQL API-key adapter keep API
-- keys in CONFIG_KV and therefore have no `api_keys` table.  The same
-- migration directory is also used by Node SQL deployments, where the table
-- already exists.  Materialize the legacy base shape first so this migration
-- is valid from both starting points; CF continues to use KV until its
-- ApiKeyStorage adapter is explicitly changed.
CREATE TABLE IF NOT EXISTS `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `api_keys_hash_unique` ON `api_keys` (`hash`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_api_keys_tenant` ON `api_keys` (`tenant_id`,`revoked_at`);--> statement-breakpoint
ALTER TABLE `api_keys` ADD `credential_type` text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE `api_keys` ADD `environment_id` text;
