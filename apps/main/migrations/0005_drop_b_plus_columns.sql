-- B+ removal: the shared-bot install path is gone. The two columns it
-- needed on linear_publications (slash_command for routing, is_default_agent
-- for default-route fallback) and the partial index that enforced one
-- default per installation are no longer referenced.

DROP INDEX IF EXISTS "idx_linear_publications_default";

ALTER TABLE "linear_publications" DROP COLUMN "slash_command";
ALTER TABLE "linear_publications" DROP COLUMN "is_default_agent";
