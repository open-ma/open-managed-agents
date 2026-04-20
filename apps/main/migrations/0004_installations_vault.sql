-- Per-installation vault id holding the bearer credential for the external
-- API. Sessions triggered by this install bind to it so the sandbox's
-- outbound Worker can inject the token without exposing it to agent code.

ALTER TABLE "linear_installations" ADD COLUMN "vault_id" TEXT;
