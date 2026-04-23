-- Per-OMA-session pointer to "the Linear AgentSession panel this bot is
-- currently working in". Written by the linear_enter_panel / linear_exit_panel
-- MCP tools, read by event-tap to know where to mirror agent.thinking /
-- tool_use / message events. Single field, single writer (the tools), single
-- reader (event-tap) — strong consistency via D1 instead of the previous
-- KV-based scattered state.
--
-- Replaces the metadata.linear.currentAgentSessionId field that used to live
-- in the OMA session record (KV) and got overwritten on every webhook resume.
-- Now the bot itself decides when it's "on stage" in a panel.

CREATE TABLE IF NOT EXISTS "linear_oma_panel_binding" (
  "oma_session_id"          TEXT PRIMARY KEY,
  "panel_agent_session_id"  TEXT NOT NULL,
  "updated_at"              INTEGER NOT NULL
);
