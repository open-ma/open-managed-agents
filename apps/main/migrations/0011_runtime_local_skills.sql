-- C1: daemon hello manifest now reports local skills detected on the user's
-- machine (Claude Code globals + plugin skills). Persisted on the runtime row
-- so the Console can show them and per-agent settings can blocklist by id.
--
-- Shape (JSON object): { "<acp-agent-id>": [ { id, name?, description?,
--   source: "global"|"plugin"|"project", source_label? } ] }
--
-- Default '{}' so old rows stay valid until the daemon redelivers a hello
-- with the new shape (happens on every WS reconnect).

ALTER TABLE "runtimes" ADD COLUMN "local_skills_json" TEXT NOT NULL DEFAULT '{}';
