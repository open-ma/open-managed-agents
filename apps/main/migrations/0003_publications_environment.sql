-- Each publication binds an OMA agent to a Linear workspace AND to a specific
-- OMA environment. The environment determines the sandbox the agent runs in
-- when triggered by Linear events.
--
-- Nullable for backward compatibility with rows created during early dev;
-- the gateway refuses to dispatch a session if it's null.

ALTER TABLE "linear_publications" ADD COLUMN "environment_id" TEXT;
