-- Tracks comments the bot authored via the OMA Linear MCP `linear_post_comment`
-- tool. Lets us route a Linear `Comment` webhook with a `parentId` back to
-- the bot's OMA session: parentId resolves here → omaSessionId → dispatch
-- the new comment as user.message into that session.
--
-- Slim schema: anything derivable from oma_session_id (publication,
-- installation, vault) is fetched on demand at webhook time, not denormalized
-- here. issue_id is kept because thread context lookups want it without a
-- session-record round-trip.

CREATE TABLE IF NOT EXISTS "linear_authored_comments" (
  "comment_id"     TEXT PRIMARY KEY,
  "oma_session_id" TEXT NOT NULL,
  "issue_id"       TEXT NOT NULL,
  "created_at"     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_linear_authored_comments_session"
  ON "linear_authored_comments" ("oma_session_id");
