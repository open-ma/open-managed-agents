ALTER TABLE `api_keys` ADD `credential_type` text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE `api_keys` ADD `environment_id` text;
