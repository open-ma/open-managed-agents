-- Per-OMA-session pointer to "the Linear AgentSession panel this bot is
-- currently working in". Written by the linear_enter_panel / linear_exit_panel
-- MCP tools, read by event-tap to know where to mirror agent.thinking /
-- tool_use / message events. Single field, single writer (the tools), single
-- reader (event-tap) — strong consistency via D1 instead of the previous
-- KV-based scattered state.
--
-- last_elicitation_at: stamped by linear_request_input after the elicitation
-- activity is posted. event-tap drops every event for ~30s afterward, so
-- Linear sees only the elicitation and keeps the panel in `awaitingInput`
-- state — without this, a model that emits "Question sent, waiting" after
-- the tool call would be mirrored as a `response` activity, flipping the
-- panel to `complete` and removing the inline reply box.

CREATE TABLE IF NOT EXISTS "linear_oma_panel_binding" (
  "oma_session_id"          TEXT PRIMARY KEY,
  "panel_agent_session_id"  TEXT NOT NULL,
  "updated_at"              INTEGER NOT NULL,
  "last_elicitation_at"     INTEGER
);
