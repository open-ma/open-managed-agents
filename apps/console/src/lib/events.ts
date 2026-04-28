/**
 * Generic shape of any wire event coming over the session events stream.
 * Covers all current and future event types via the catch-all index
 * signature — render code must defensively check `type` before
 * accessing kind-specific fields.
 *
 * Lives in lib/ rather than the timeline folder because both the
 * Conversation view and the Timeline view consume events.
 */
export interface Event {
  type: string;
  content?: Array<{ type: string; text: string }> | string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  mcp_tool_use_id?: string;
  mcp_server_name?: string;
  error?: string;
  source?: string;
  message?: string;
  stop_reason?: { type: string };
  /** Canonical id for streamed assistant messages — set on
   *  agent.message_stream_start / _chunk / _stream_end and on the
   *  matching final agent.message. Lets the renderer correlate
   *  in-flight chunks with the eventually-committed message. */
  message_id?: string;
  delta?: string;
  /** ISO timestamp. Server sets it for stored events; the client tags
   *  streamed events on arrival with Date.now() as a best-effort fallback. */
  ts?: string;
  /** Server-side monotonic seq. Only set for events fetched from /events. */
  seq?: number;
  [key: string]: unknown;
}
