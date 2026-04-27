import { useEffect, useMemo, useState, useRef } from "react";
import { useParams, Link } from "react-router";
import { useApi } from "../lib/api";
import { Markdown } from "../components/Markdown";

interface Event {
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
  /** ISO timestamp. Server sets it for stored events; the client tags streamed
   *  events on arrival with Date.now() as a best-effort fallback. */
  ts?: string;
  /** Server-side monotonic seq. Only set for events fetched from /events. */
  seq?: number;
  [key: string]: unknown;
}

type View = "chat" | "timeline";

export function SessionDetail() {
  const { id } = useParams();
  const { api, streamEvents } = useApi();
  const [events, setEvents] = useState<Event[]>([]);
  /** In-flight assistant streams keyed by message_id. Each entry holds
   *  the deltas accumulated so far. Wiped on the matching agent.message
   *  (same message_id), which becomes the canonical render. */
  const [streams, setStreams] = useState<Map<string, string>>(new Map());
  /** In-flight reasoning streams keyed by thinking_id. Same lifecycle
   *  as messages — drained on matching agent.thinking. */
  const [thinkingStreams, setThinkingStreams] = useState<Map<string, string>>(new Map());
  /** In-flight tool-input streams keyed by tool_use_id. Wiped when the
   *  canonical agent.tool_use / mcp_tool_use / custom_tool_use lands
   *  with the same id (toolCallId on the AI SDK side). The accumulated
   *  string is partial JSON — render as a code block, not Markdown. */
  const [toolInputStreams, setToolInputStreams] = useState<Map<string, { name?: string; partial: string }>>(new Map());
  const [view, setView] = useState<View>("chat");
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [title, setTitle] = useState("");
  const [agentId, setAgentId] = useState("");
  const [linear, setLinear] = useState<{
    issueId?: string;
    issueIdentifier?: string;
    workspaceId?: string;
  } | null>(null);
  const [slack, setSlack] = useState<{
    channelId?: string;
    threadTs?: string;
    workspaceId?: string;
    eventKind?: string;
  } | null>(null);
  const [status, setStatus] = useState("idle");
  const scrollRef = useRef<HTMLDivElement>(null);
  const seenKeys = useRef(new Set<string>());
  const abortRef = useRef<AbortController | null>(null);

  const eventKey = (e: Event) => `${e.type}:${JSON.stringify(e.content || e.id || e.tool_use_id || e.error || "").slice(0, 120)}`;

  const addEvent = (e: Record<string, unknown>) => {
    const ev = e as Event;

    // Streaming chunk lifecycle. None of these go into the events list
    // (would pollute history once the canonical agent.message lands);
    // they drive the `streams` map that the renderer overlays after
    // committed events. The matching agent.message arrives with the
    // same message_id and replaces the in-flight render.
    if (ev.type === "agent.message_stream_start" && ev.message_id) {
      const mid = ev.message_id;
      setStreams((prev) => {
        if (prev.has(mid)) return prev;
        const next = new Map(prev);
        next.set(mid, "");
        return next;
      });
      return;
    }
    if (ev.type === "agent.message_chunk" && ev.message_id && typeof ev.delta === "string") {
      const mid = ev.message_id;
      const delta = ev.delta;
      setStreams((prev) => {
        const next = new Map(prev);
        next.set(mid, (next.get(mid) ?? "") + delta);
        return next;
      });
      return;
    }
    if (ev.type === "agent.message_stream_end") {
      // Hold the in-flight render until the canonical agent.message
      // arrives — keeps UI stable through the brief gap between the
      // SSE stream_end and the events-log commit. If the run was
      // aborted/interrupted, the canonical event will land via the
      // recovery path and clean up the same way.
      return;
    }

    // Thinking stream lifecycle. Same pattern as message stream:
    // start opens an entry, chunk appends, end is held, canonical
    // agent.thinking with same thinking_id closes it.
    if (ev.type === "agent.thinking_stream_start" && ev.thinking_id) {
      const tid = ev.thinking_id;
      setThinkingStreams((prev) => {
        if (prev.has(tid)) return prev;
        const next = new Map(prev);
        next.set(tid, "");
        return next;
      });
      return;
    }
    if (ev.type === "agent.thinking_chunk" && ev.thinking_id && typeof ev.delta === "string") {
      const tid = ev.thinking_id;
      const delta = ev.delta;
      setThinkingStreams((prev) => {
        const next = new Map(prev);
        next.set(tid, (next.get(tid) ?? "") + delta);
        return next;
      });
      return;
    }
    if (ev.type === "agent.thinking_stream_end") return;

    // Tool-input stream lifecycle. The accumulated string is partial
    // JSON; once tool_use lands with the same id, drop the in-flight
    // render and let the EventBubble's collapsed tool widget take over.
    if (ev.type === "agent.tool_use_input_stream_start" && ev.tool_use_id) {
      const tid = ev.tool_use_id;
      const name = (ev as { tool_name?: string }).tool_name;
      setToolInputStreams((prev) => {
        if (prev.has(tid)) return prev;
        const next = new Map(prev);
        next.set(tid, { name, partial: "" });
        return next;
      });
      return;
    }
    if (ev.type === "agent.tool_use_input_chunk" && ev.tool_use_id && typeof ev.delta === "string") {
      const tid = ev.tool_use_id;
      const delta = ev.delta;
      setToolInputStreams((prev) => {
        const cur = prev.get(tid);
        if (!cur) return prev;
        const next = new Map(prev);
        next.set(tid, { ...cur, partial: cur.partial + delta });
        return next;
      });
      return;
    }
    if (ev.type === "agent.tool_use_input_stream_end") return;

    // Canonical agent.message lands → drop the in-flight render so
    // we don't double-show the same content.
    if (ev.type === "agent.message" && ev.message_id) {
      const mid = ev.message_id;
      setStreams((prev) => {
        if (!prev.has(mid)) return prev;
        const next = new Map(prev);
        next.delete(mid);
        return next;
      });
    }

    // Canonical agent.thinking → drop the in-flight reasoning entry.
    // If the canonical event has thinking_id we use it; otherwise we
    // bail-clear all live thinking streams (multi-stream-per-step is
    // rare and safer to err on closing them all).
    if (ev.type === "agent.thinking") {
      const tid = ev.thinking_id;
      setThinkingStreams((prev) => {
        if (prev.size === 0) return prev;
        if (tid && !prev.has(tid)) return prev;
        const next = new Map(prev);
        if (tid) next.delete(tid);
        else next.clear();
        return next;
      });
    }

    // Canonical tool_use of any kind (built-in, MCP, custom) → drop
    // in-flight tool input. The canonical id field equals the AI SDK
    // toolCallId we used as tool_use_id.
    if ((ev.type === "agent.tool_use"
      || ev.type === "agent.mcp_tool_use"
      || ev.type === "agent.custom_tool_use") && ev.id) {
      const tid = ev.id;
      setToolInputStreams((prev) => {
        if (!prev.has(tid)) return prev;
        const next = new Map(prev);
        next.delete(tid);
        return next;
      });
    }

    const key = eventKey(ev);
    if (seenKeys.current.has(key)) return;
    seenKeys.current.add(key);

    if (ev.type === "session.status_running") { setStatus("running"); return; }
    if (ev.type === "session.status_idle") { setStatus("idle"); return; }
    if (ev.type?.startsWith("span.") || ev.type === "agent.thinking") return;

    // Tag streamed events with arrival time so the timeline has a usable ts
    // even before the server-side stored copy round-trips.
    if (!ev.ts) ev.ts = new Date().toISOString();

    setEvents((prev) => [...prev, ev]);
  };

  useEffect(() => {
    if (!id) return;
    seenKeys.current.clear();
    setStreams(new Map());
    setThinkingStreams(new Map());
    setToolInputStreams(new Map());

    // Load session info
    api<{
      title?: string;
      agent_id?: string;
      metadata?: Record<string, unknown>;
    }>(`/v1/sessions/${id}`)
      .then((s) => {
        setTitle(s.title || id);
        setAgentId(s.agent_id || "");
        const linearMeta = s.metadata?.linear as
          | { issueId?: string; issueIdentifier?: string; workspaceId?: string }
          | undefined;
        if (linearMeta && (linearMeta.issueId || linearMeta.issueIdentifier)) {
          setLinear(linearMeta);
        }
        const slackMeta = s.metadata?.slack as
          | { channelId?: string; threadTs?: string; workspaceId?: string; eventKind?: string }
          | undefined;
        if (slackMeta && (slackMeta.channelId || slackMeta.threadTs)) {
          setSlack(slackMeta);
        }
      })
      .catch(() => {});

    // Load history. The /events endpoint wraps each event as { seq, type, ts,
    // data }; promote seq + ts onto the inner event so timeline has them.
    api<{ data: Array<{ seq?: number; type: string; ts?: string; data: Event }> }>(`/v1/sessions/${id}/events?limit=1000&order=asc`)
      .then((res) => {
        for (const e of res.data) {
          const inner = e.data || (e as unknown as Event);
          if (e.ts && !inner.ts) inner.ts = e.ts;
          if (e.seq !== undefined && inner.seq === undefined) inner.seq = e.seq;
          addEvent(inner);
        }
      })
      .catch(() => {});

    // Connect SSE
    const abort = new AbortController();
    abortRef.current = abort;
    streamEvents(id, addEvent, abort.signal);

    return () => { abort.abort(); };
  }, [id]);

  useEffect(() => {
    if (view !== "chat") return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [events, streams, thinkingStreams, toolInputStreams, view]);

  const send = async () => {
    if (!input.trim() || !id) return;
    const text = input;
    setInput("");
    setSending(true);
    try {
      await api(`/v1/sessions/${id}/events`, {
        method: "POST",
        body: JSON.stringify({
          events: [{ type: "user.message", content: [{ type: "text", text }] }],
        }),
      });
    } catch {}
    setSending(false);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-8 py-4 border-b border-border flex items-center gap-3 shrink-0">
        <Link to="/sessions" className="text-fg-subtle hover:text-fg-muted text-sm">&larr; Sessions</Link>
        <h2 className="font-display text-lg font-semibold flex-1">{title}</h2>
        <div className="flex items-center gap-2">
          {status === "running" && (
            <span className="flex items-center gap-1.5 text-xs text-info">
              <span className="w-2 h-2 rounded-full bg-info animate-pulse" />
              Running
            </span>
          )}
          <span className="text-xs text-fg-subtle font-mono">{agentId}</span>
        </div>
      </div>

      {/* View tabs */}
      <div className="px-8 border-b border-border flex items-center gap-1 shrink-0">
        <ViewTab label="Conversation" active={view === "chat"} onClick={() => setView("chat")} />
        <ViewTab label="Timeline" active={view === "timeline"} onClick={() => setView("timeline")} />
        {view === "timeline" && (
          <span className="ml-auto text-xs text-fg-subtle font-mono">{events.length} events</span>
        )}
      </div>

      {/* Linear context (when triggered by a Linear webhook) */}
      {linear && (
        <div className="px-8 py-2 border-b border-border bg-blue-50/50 text-xs flex items-center gap-2 text-blue-900">
          <span>🔗</span>
          <span className="font-medium">Linear</span>
          <span className="text-blue-700">·</span>
          <span>
            issue{" "}
            <span className="font-mono">{linear.issueIdentifier ?? linear.issueId}</span>
          </span>
          {linear.workspaceId && (
            <a
              href={`https://linear.app`}
              target="_blank"
              rel="noreferrer"
              className="ml-auto hover:underline"
            >
              Open in Linear ↗
            </a>
          )}
        </div>
      )}

      {/* Slack context (when triggered by a Slack event) */}
      {slack && (
        <div className="px-8 py-2 border-b border-border bg-purple-50/50 text-xs flex items-center gap-2 text-purple-900">
          <span>💬</span>
          <span className="font-medium">Slack</span>
          <span className="text-purple-700">·</span>
          <span>
            {slack.channelId ? (
              <>
                channel <span className="font-mono">{slack.channelId}</span>
              </>
            ) : (
              "—"
            )}
            {slack.threadTs && (
              <>
                {" "}thread{" "}
                <span className="font-mono">{slack.threadTs}</span>
              </>
            )}
          </span>
          {slack.eventKind && (
            <span className="text-purple-700/60 font-mono uppercase tracking-wider text-[10px]">
              {slack.eventKind}
            </span>
          )}
        </div>
      )}

      {view === "chat" ? (
        <>
          {/* Events */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-8 py-6 space-y-4">
            {events.map((e, i) => (
              <EventBubble key={i} event={e} />
            ))}
            {/* In-flight thinking streams. Render before message/tool
                streams so the visual order roughly matches what the
                LLM produced (Anthropic emits reasoning before text/tool). */}
            {Array.from(thinkingStreams.entries()).map(([tid, text]) => (
              <ThinkingStreamingBubble key={`think-${tid}`} text={text} />
            ))}
            {/* In-flight tool inputs — partial JSON shown in a code box. */}
            {Array.from(toolInputStreams.entries()).map(([tid, { name, partial }]) => (
              <ToolInputStreamingBubble key={`tin-${tid}`} name={name} partial={partial} />
            ))}
            {/* In-flight assistant message text streams. */}
            {Array.from(streams.entries()).map(([mid, text]) => (
              <StreamingBubble key={`stream-${mid}`} text={text} />
            ))}
            {/* Typing dots only when the agent is running and nothing
                else is streaming — avoids duplicate activity indicators. */}
            {status === "running"
              && streams.size === 0
              && thinkingStreams.size === 0
              && toolInputStreams.size === 0 && (
              <div className="flex gap-1 py-2">
                <span className="w-1.5 h-1.5 bg-fg-subtle rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                <span className="w-1.5 h-1.5 bg-fg-subtle rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                <span className="w-1.5 h-1.5 bg-fg-subtle rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
            )}
          </div>

          {/* Input */}
          <div className="px-8 py-4 border-t border-border flex gap-2 shrink-0">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
              placeholder="Send a message..."
              className="flex-1 border border-border rounded-lg px-4 py-2.5 text-sm outline-none focus:border-border-strong transition-colors bg-bg text-fg"
              disabled={sending}
            />
            <button
              onClick={send}
              disabled={sending || !input.trim()}
              className="px-5 py-2.5 bg-brand text-brand-fg rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-40 transition-colors"
            >
              Send
            </button>
          </div>
        </>
      ) : (
        <TimelineView events={events} />
      )}
    </div>
  );
}

function ViewTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-2.5 text-sm border-b-2 transition-colors ${
        active
          ? "border-brand text-fg font-medium"
          : "border-transparent text-fg-subtle hover:text-fg-muted"
      }`}
    >
      {label}
    </button>
  );
}

/** In-progress assistant message rendered from accumulated chunk
 *  deltas. Looks like a normal agent bubble but ends in a soft
 *  pulsing block cursor so it reads as live. Replaced by a real
 *  EventBubble once the canonical agent.message lands. */
function StreamingBubble({ text }: { text: string }) {
  return (
    <div className="max-w-2xl">
      <div className="text-xs text-fg-subtle mb-1">Agent</div>
      <div className="bg-bg-surface rounded-2xl rounded-bl-sm px-4 py-3 text-sm leading-relaxed">
        <Markdown>{text}</Markdown>
        <span className="inline-block w-1.5 h-3.5 bg-fg-subtle/50 align-middle ml-0.5 animate-pulse" />
      </div>
    </div>
  );
}

/** In-progress reasoning block. Rendered as a faded, italicized
 *  bubble so it's visually distinct from canonical assistant
 *  messages. Replaced when the matching agent.thinking lands (or
 *  swept on first agent.thinking arrival when correlation is lost). */
function ThinkingStreamingBubble({ text }: { text: string }) {
  return (
    <div className="max-w-2xl">
      <div className="text-xs text-fg-subtle mb-1 flex items-center gap-1.5">
        <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v1m0 14v1m8-8h-1M5 12H4m13.66-5.66l-.7.7M6.34 17.66l-.7.7M17.66 17.66l-.7-.7M6.34 6.34l-.7-.7" />
        </svg>
        <span>Thinking…</span>
      </div>
      <div className="bg-bg-surface/60 rounded-2xl rounded-bl-sm px-4 py-3 text-xs leading-relaxed text-fg-subtle italic whitespace-pre-wrap">
        {text}
        <span className="inline-block w-1 h-3 bg-fg-subtle/50 align-middle ml-0.5 animate-pulse" />
      </div>
    </div>
  );
}

/** In-progress tool-input bubble. The accumulated string is partial
 *  JSON streamed by the model — render as a code block (NOT Markdown).
 *  Disappears when the canonical agent.tool_use lands and the regular
 *  collapsible tool widget takes over. */
function ToolInputStreamingBubble({ name, partial }: { name?: string; partial: string }) {
  return (
    <div className="max-w-2xl">
      <div className="border border-border rounded-lg overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 bg-bg-surface">
          <svg className="w-3.5 h-3.5 text-info shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
          </svg>
          <span className="text-sm font-medium">{name ?? "tool"}</span>
          <span className="text-xs text-fg-subtle ml-auto">preparing…</span>
          <span className="inline-block w-1 h-3 bg-fg-subtle/50 align-middle animate-pulse" />
        </div>
        {partial && (
          <pre className="text-xs px-3 py-2 font-mono text-fg-subtle overflow-x-auto whitespace-pre-wrap break-all">
            {partial}
          </pre>
        )}
      </div>
    </div>
  );
}

function EventBubble({ event }: { event: Event }) {
  const [toolOpen, setToolOpen] = useState(false);

  switch (event.type) {
    case "user.message":
      return (
        <div className="flex justify-end">
          <div className="max-w-lg">
            <div className="text-xs text-fg-subtle text-right mb-1">You</div>
            <div className="bg-brand text-brand-fg rounded-2xl rounded-br-sm px-4 py-3 text-sm leading-relaxed">
              {Array.isArray(event.content) ? event.content[0]?.text : ""}
            </div>
          </div>
        </div>
      );

    case "agent.message":
      return (
        <div className="max-w-2xl">
          <div className="text-xs text-fg-subtle mb-1">Agent</div>
          <div className="bg-bg-surface rounded-2xl rounded-bl-sm px-4 py-3 text-sm leading-relaxed">
            <Markdown>{(Array.isArray(event.content) ? event.content : []).map((b) => b.text).join("")}</Markdown>
          </div>
        </div>
      );

    case "agent.tool_use":
      return (
        <div className="max-w-2xl">
          <button
            onClick={() => setToolOpen(!toolOpen)}
            className="flex items-center gap-2 px-3 py-2 border border-border rounded-lg text-sm hover:bg-bg-surface transition-colors w-full text-left"
          >
            <svg className="w-3.5 h-3.5 text-info shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
            </svg>
            <span className="font-medium">{event.name}</span>
            <svg className={`w-3 h-3 ml-auto text-fg-subtle transition-transform ${toolOpen ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {toolOpen && (
            <pre className="mt-1 bg-bg-surface border border-border rounded-lg p-3 text-xs font-mono overflow-x-auto max-h-48 overflow-y-auto text-fg-muted">
              {JSON.stringify(event.input, null, 2)}
            </pre>
          )}
        </div>
      );

    case "agent.tool_result":
      return (
        <div className="max-w-2xl">
          <div className="border-l-3 border-success bg-bg-surface rounded-r-lg px-3 py-2 text-xs font-mono max-h-40 overflow-y-auto text-fg-muted whitespace-pre-wrap">
            {typeof event.content === "string" ? event.content : JSON.stringify(event.content)}
          </div>
        </div>
      );

    case "session.error":
      return (
        <div className="max-w-2xl bg-danger-subtle border border-danger/30 rounded-lg px-4 py-2.5 text-sm text-danger">
          Error: {event.error}
        </div>
      );

    case "session.warning":
      return (
        <div className="max-w-2xl bg-warning-subtle border border-warning/30 rounded-lg px-4 py-2.5 text-sm text-warning">
          <div className="font-medium mb-0.5">Warning ({String(event.source ?? "")})</div>
          <div>{String(event.message ?? "")}</div>
        </div>
      );

    default:
      return null;
  }
}

// ─── Timeline (waterfall) ────────────────────────────────────────────────
//
// Pure-frontend projection of the event stream into a Gantt-style timeline.
// Tool/MCP/custom-tool calls become bars (use→result paired by id); model
// turns are derived as the gap between the last completed event and the next
// agent.message; messages and session.* events render as instants. We
// deliberately drop agent.thinking (already filtered upstream) and tool
// result events (consumed in pairing) to keep one row per logical span.

type SpanFamily = "model" | "tool" | "mcp" | "custom_tool" | "user" | "agent" | "system" | "warn" | "error";

interface Span {
  key: string;
  family: SpanFamily;
  label: string;
  detail?: string;
  /** ms since the first event */
  startMs: number;
  /** 0 for instants */
  durationMs: number;
}

const FAMILY_DOT: Record<SpanFamily, string> = {
  model: "bg-info",
  tool: "bg-emerald-500",
  mcp: "bg-purple-500",
  custom_tool: "bg-amber-500",
  user: "bg-brand",
  agent: "bg-fg-muted",
  system: "bg-fg-subtle",
  warn: "bg-warning",
  error: "bg-danger",
};

const FAMILY_BAR: Record<SpanFamily, string> = {
  model: "bg-info/70",
  tool: "bg-emerald-500/70",
  mcp: "bg-purple-500/70",
  custom_tool: "bg-amber-500/70",
  user: "bg-brand/70",
  agent: "bg-fg-muted/70",
  system: "bg-fg-subtle/70",
  warn: "bg-warning/70",
  error: "bg-danger/70",
};

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

function deriveSpans(events: Event[]): { spans: Span[]; totalMs: number } {
  const timed = events.filter((e) => e.ts);
  if (timed.length === 0) return { spans: [], totalMs: 0 };

  const t0 = new Date(timed[0].ts!).getTime();
  const tEnd = new Date(timed[timed.length - 1].ts!).getTime();
  const totalMs = Math.max(1, tEnd - t0);

  const spans: Span[] = [];

  // Index results by their use-id field for O(1) pairing.
  const toolResults = new Map<string, Event>();
  const mcpResults = new Map<string, Event>();
  const customResults = new Map<string, Event>();
  for (const e of events) {
    if (e.type === "agent.tool_result" && e.tool_use_id) toolResults.set(e.tool_use_id, e);
    else if (e.type === "agent.mcp_tool_result" && e.mcp_tool_use_id) mcpResults.set(e.mcp_tool_use_id, e);
    else if (e.type === "user.custom_tool_result" && (e as Event).id) customResults.set(String(e.id), e);
  }

  // Track previous completed-span end so we can derive a "model" span as the
  // gap between the last result/user.message and the next agent.message.
  let lastEnd = 0;

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e.ts) continue;
    const startMs = new Date(e.ts).getTime() - t0;

    if (e.type === "agent.tool_use" || e.type === "agent.custom_tool_use") {
      const result = e.type === "agent.tool_use"
        ? toolResults.get(String(e.id))
        : customResults.get(String(e.id));
      const endMs = result?.ts ? new Date(result.ts).getTime() - t0 : startMs;
      spans.push({
        key: `tool-${e.id ?? i}`,
        family: e.type === "agent.tool_use" ? "tool" : "custom_tool",
        label: String(e.name ?? "tool"),
        detail: result ? "completed" : "no result",
        startMs,
        durationMs: Math.max(0, endMs - startMs),
      });
      lastEnd = Math.max(lastEnd, endMs);
    } else if (e.type === "agent.mcp_tool_use") {
      const result = mcpResults.get(String(e.id));
      const endMs = result?.ts ? new Date(result.ts).getTime() - t0 : startMs;
      spans.push({
        key: `mcp-${e.id ?? i}`,
        family: "mcp",
        label: `${String(e.mcp_server_name ?? "mcp")}:${String(e.name ?? "?")}`,
        detail: result ? "completed" : "no result",
        startMs,
        durationMs: Math.max(0, endMs - startMs),
      });
      lastEnd = Math.max(lastEnd, endMs);
    } else if (
      e.type === "agent.tool_result" ||
      e.type === "agent.mcp_tool_result" ||
      e.type === "user.custom_tool_result"
    ) {
      // consumed via pairing above — skip the row
      continue;
    } else if (e.type === "user.message") {
      spans.push({ key: `u-${i}`, family: "user", label: "user.message", startMs, durationMs: 0 });
      lastEnd = Math.max(lastEnd, startMs);
    } else if (e.type === "agent.message") {
      // Derive a model span from the last completed event up to here, so the
      // chart shows where time was spent waiting on the model vs tools.
      const modelStart = Math.max(0, Math.min(lastEnd, startMs));
      if (startMs > modelStart) {
        spans.push({
          key: `m-${i}`,
          family: "model",
          label: "model",
          startMs: modelStart,
          durationMs: startMs - modelStart,
        });
      }
      spans.push({ key: `a-${i}`, family: "agent", label: "agent.message", startMs, durationMs: 0 });
      lastEnd = startMs;
    } else if (e.type === "session.error") {
      spans.push({
        key: `err-${i}`,
        family: "error",
        label: "session.error",
        detail: typeof e.error === "string" ? e.error : JSON.stringify(e.error),
        startMs,
        durationMs: 0,
      });
    } else if (e.type === "session.warning") {
      spans.push({
        key: `warn-${i}`,
        family: "warn",
        label: `warning:${String(e.source ?? "")}`,
        detail: String(e.message ?? ""),
        startMs,
        durationMs: 0,
      });
    } else if (e.type.startsWith("session.")) {
      spans.push({ key: `s-${i}`, family: "system", label: e.type, startMs, durationMs: 0 });
    }
  }

  return { spans, totalMs };
}

function TimelineView({ events }: { events: Event[] }) {
  const { spans, totalMs } = useMemo(() => deriveSpans(events), [events]);

  if (spans.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-fg-subtle">
        No timing data yet — send a message to populate the timeline.
      </div>
    );
  }

  // Tick marks at sensible intervals based on total duration.
  const tickStep = pickTickStep(totalMs);
  const ticks: number[] = [];
  for (let t = 0; t <= totalMs; t += tickStep) ticks.push(t);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-8 py-3 border-b border-border text-xs text-fg-subtle font-mono flex items-center gap-4">
        <span>{spans.length} spans</span>
        <span>·</span>
        <span>total {formatDuration(totalMs)}</span>
      </div>

      {/* Time axis */}
      <div className="px-8 pt-3 sticky top-0 bg-bg z-10">
        <div className="flex items-center">
          <div className="w-56 shrink-0" />
          <div className="flex-1 relative h-5 border-b border-border">
            {ticks.map((t) => (
              <div
                key={t}
                className="absolute top-0 h-full flex flex-col items-start text-[10px] text-fg-subtle font-mono"
                style={{ left: `${(t / totalMs) * 100}%` }}
              >
                <span className="-translate-x-1/2 px-1">{formatDuration(t)}</span>
                <div className="w-px flex-1 bg-border" />
              </div>
            ))}
          </div>
          <div className="w-20 shrink-0" />
        </div>
      </div>

      {/* Rows */}
      <div className="px-8 pb-8">
        {spans.map((s) => {
          const left = (s.startMs / totalMs) * 100;
          const width = s.durationMs > 0 ? Math.max(0.4, (s.durationMs / totalMs) * 100) : 0;
          return (
            <div
              key={s.key}
              className="flex items-center py-1 border-b border-border/40 hover:bg-bg-surface/60 group"
              title={
                s.detail
                  ? `${s.label} — ${formatDuration(s.durationMs)} — ${s.detail}`
                  : `${s.label} — ${formatDuration(s.durationMs)}`
              }
            >
              <div className="w-56 shrink-0 flex items-center gap-2 text-xs">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${FAMILY_DOT[s.family]}`} />
                <span className="truncate text-fg-muted font-mono">{s.label}</span>
              </div>
              <div className="flex-1 relative h-5">
                {width > 0 ? (
                  <div
                    className={`absolute h-3 top-1 rounded-sm ${FAMILY_BAR[s.family]} group-hover:opacity-100 opacity-90`}
                    style={{ left: `${left}%`, width: `${width}%` }}
                  />
                ) : (
                  <div
                    className={`absolute top-0 bottom-0 w-px ${FAMILY_DOT[s.family]}`}
                    style={{ left: `${left}%` }}
                  />
                )}
              </div>
              <div className="w-20 shrink-0 text-right text-xs font-mono text-fg-subtle pr-1">
                {s.durationMs > 0 ? formatDuration(s.durationMs) : "·"}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function pickTickStep(totalMs: number): number {
  // Roughly 6 ticks across the chart, snapped to a friendly unit.
  const target = totalMs / 6;
  const candidates = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000];
  for (const c of candidates) if (c >= target) return c;
  return candidates[candidates.length - 1];
}
