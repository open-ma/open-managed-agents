-- Tracks comments the bot authored via the OMA Linear MCP `linear_post_comment`
-- tool. When Linear sends a Comment webhook with parentId set, we look up
-- parentId here — if present, the reply is a human responding to a question
-- the bot asked, and we route it back to the bot's OMA session as a user
-- message. Without this row, we have no way to map a reply comment back to
-- which bot session it belongs to.

CREATE TABLE IF NOT EXISTS "linear_authored_comments" (
  "comment_id"     TEXT PRIMARY KEY,
  "oma_session_id" TEXT NOT NULL,
  "publication_id" TEXT NOT NULL,
  "installation_id" TEXT NOT NULL,
  "issue_id"       TEXT NOT NULL,
  "agent_session_id" TEXT,         -- Linear AgentSession id at time of post (if any)
  "created_at"     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_linear_authored_comments_session"
  ON "linear_authored_comments" ("oma_session_id");
