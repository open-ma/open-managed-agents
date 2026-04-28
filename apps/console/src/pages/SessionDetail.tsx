import { useEffect, useMemo, useState, useRef, Fragment } from "react";
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
  const [sessionMeta, setSessionMeta] = useState<{
    environmentId?: string;
    vaultIds?: string[];
    createdAt?: string;
    agentSnapshot?: { id?: string; name?: string; model?: string | { id: string }; description?: string; version?: number };
    envSnapshot?: { id?: string; name?: string; description?: string };
  }>({});
  const [resourcePanel, setResourcePanel] = useState<
    | { kind: "agent"; id: string }
    | { kind: "environment"; id: string }
    | { kind: "vault"; id: string }
    | null
  >(null);
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

    if (ev.type === "session.status_running") setStatus("running");
    if (ev.type === "session.status_idle") setStatus("idle");
    // Don't return — Timeline's bucketIntoTurns uses these as the close
    // boundary of a turn. Conversation view's EventBubble switch silently
    // skips unknown types so leaving them in `events` is harmless there.
    // Previously this dropped every span.* and agent.thinking event before
    // they reached `events` state, so Timeline saw none of model/wakeup/
    // compaction/outcome spans (entire reason waterfall looked empty).
    // Conversation view's EventBubble silently ignores unknown types via
    // its switch — keeping the events here costs the chat view nothing
    // and gives Timeline the full trajectory it needs.

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
      environment_id?: string;
      vault_ids?: string[];
      created_at?: string;
      agent?: { id?: string; name?: string; model?: string | { id: string }; description?: string; version?: number };
      environment?: { id?: string; name?: string; description?: string };
      metadata?: Record<string, unknown>;
    }>(`/v1/sessions/${id}`)
      .then((s) => {
        setTitle(s.title || id);
        setAgentId(s.agent_id || "");
        setSessionMeta({
          environmentId: s.environment_id,
          vaultIds: s.vault_ids,
          createdAt: s.created_at,
          agentSnapshot: s.agent,
          envSnapshot: s.environment,
        });
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
      <div className="px-8 py-3 border-b border-border flex flex-col gap-2 shrink-0">
        <div className="flex items-center gap-3">
          <Link to="/sessions" className="text-fg-subtle hover:text-fg-muted text-sm">&larr; Sessions</Link>
          <span className="text-fg-subtle">/</span>
          <h2 className="font-mono text-sm text-fg-muted truncate flex-1" title={id}>{title}</h2>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <StatusPill status={status as "idle" | "running" | "terminated" | "error" | string} />
          {sessionMeta.agentSnapshot?.name && (
            <ResourceBadge
              icon={<AgentIcon />}
              label={sessionMeta.agentSnapshot.name}
              onClick={() =>
                setResourcePanel({ kind: "agent", id: sessionMeta.agentSnapshot?.id || agentId })
              }
            />
          )}
          {sessionMeta.envSnapshot?.name && sessionMeta.environmentId && (
            <ResourceBadge
              icon={<EnvIcon />}
              label={sessionMeta.envSnapshot.name}
              onClick={() =>
                setResourcePanel({ kind: "environment", id: sessionMeta.environmentId! })
              }
            />
          )}
          {(sessionMeta.vaultIds ?? []).map((vid) => (
            <ResourceBadge
              key={vid}
              icon={<VaultIcon />}
              label={vid.slice(0, 12) + "…"}
              onClick={() => setResourcePanel({ kind: "vault", id: vid })}
            />
          ))}
          <SessionDurationBadge events={events} />
          {sessionMeta.createdAt && <RelativeTimeBadge iso={sessionMeta.createdAt} />}
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

      <div className="flex-1 flex min-h-0">
        <div className="flex-1 flex flex-col min-w-0">
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
        {resourcePanel && (
          <ResourcePanel
            panel={resourcePanel}
            onClose={() => setResourcePanel(null)}
          />
        )}
      </div>
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

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "running"
      ? "bg-info-subtle text-info"
      : status === "terminated" || status === "error"
      ? "bg-danger-subtle text-danger"
      : "bg-bg-surface text-fg-muted";
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded font-medium ${tone}`}>
      {status === "running" && (
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-info animate-pulse mr-1.5 align-middle" />
      )}
      {status[0]?.toUpperCase() + status.slice(1)}
    </span>
  );
}

function ResourceBadge({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="text-[11px] px-2 py-0.5 rounded border border-border hover:border-border-strong hover:bg-bg-surface text-fg-muted flex items-center gap-1.5 font-mono max-w-xs"
      title={label}
    >
      <span className="text-fg-subtle shrink-0 flex">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}

function SessionDurationBadge({ events }: { events: Event[] }) {
  if (events.length === 0) return null;
  let first = Infinity;
  let last = -Infinity;
  for (const e of events) {
    const ts = (e as { processed_at?: string }).processed_at;
    if (typeof ts !== "string") continue;
    const t = new Date(ts).getTime();
    if (!Number.isFinite(t)) continue;
    if (t < first) first = t;
    if (t > last) last = t;
  }
  if (!Number.isFinite(first) || last <= first) return null;
  return (
    <span className="text-[11px] px-2 py-0.5 text-fg-subtle font-mono flex items-center gap-1.5" title="Wall-clock from first to last event">
      <DurationIcon />
      {formatDuration(last - first)}
    </span>
  );
}

function RelativeTimeBadge({ iso }: { iso: string }) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const diffMs = Date.now() - t;
  const text = formatRelative(diffMs);
  return (
    <span className="text-[11px] px-2 py-0.5 text-fg-subtle font-mono flex items-center gap-1.5" title={new Date(iso).toLocaleString()}>
      <ClockIcon />
      {text}
    </span>
  );
}

const iconBase = "w-3.5 h-3.5";
function AgentIcon() {
  return (
    <svg className={iconBase} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2M20 14h2M15 13v2M9 13v2" />
    </svg>
  );
}
function EnvIcon() {
  return (
    <svg className={iconBase} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.5 19a4.5 4.5 0 1 0-1.18-8.85 6 6 0 1 0-11.32 4.34A4 4 0 0 0 6.5 19h11Z" />
    </svg>
  );
}
function VaultIcon() {
  return (
    <svg className={iconBase} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="m21 2-9.6 9.6" />
      <path d="m15.5 7.5 3 3L22 7l-3-3" />
    </svg>
  );
}
function DurationIcon() {
  return (
    <svg className={iconBase} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 22h14M5 2h14M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2" />
    </svg>
  );
}
function ClockIcon() {
  return (
    <svg className={iconBase} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function formatRelative(diffMs: number): string {
  if (diffMs < 0) diffMs = -diffMs;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

function ResourcePanel({
  panel,
  onClose,
}: {
  panel: { kind: "agent" | "environment" | "vault"; id: string };
  onClose: () => void;
}) {
  const api = useApi();
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setErr(null);
    const url =
      panel.kind === "agent"
        ? `/v1/agents/${panel.id}`
        : panel.kind === "environment"
        ? `/v1/environments/${panel.id}`
        : `/v1/vaults/${panel.id}`;
    api<Record<string, unknown>>(url)
      .then((d) => setData(d))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
    // `api` from useApi() is a fresh closure every render — including it in
    // deps caused setData → re-render → new api → effect refire → infinite
    // loop. The stable inputs are kind + id; api itself is callable as-is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel.kind, panel.id]);

  const linkPath =
    panel.kind === "agent"
      ? `/agents/${panel.id}`
      : panel.kind === "environment"
      ? `/environments/${panel.id}`
      : `/vaults/${panel.id}`;
  const titleKind = panel.kind[0].toUpperCase() + panel.kind.slice(1);

  // For agent / env, prefer name + description in the visible header.
  const displayName = (data?.name as string | undefined) ?? panel.id;
  const description = (data?.description as string | undefined) ?? null;

  return (
    <aside className="w-[420px] shrink-0 border-l border-border bg-bg flex flex-col min-h-0">
      <div className="px-4 py-3 border-b border-border flex items-start gap-3 shrink-0">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wide text-fg-subtle font-mono">
            {titleKind}
          </div>
          <div className="text-base font-semibold text-fg truncate">{displayName}</div>
          {description && (
            <div className="text-xs text-fg-muted mt-0.5 line-clamp-2">{description}</div>
          )}
          <div className="text-[10px] font-mono text-fg-subtle mt-1 truncate">{panel.id}</div>
        </div>
        <button
          onClick={onClose}
          className="text-fg-subtle hover:text-fg-muted text-lg leading-none px-1"
          title="Close"
        >
          ×
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-3 text-xs">
        {err && <div className="text-danger">Failed to load: {err}</div>}
        {!data && !err && <div className="text-fg-subtle">Loading…</div>}
        {data && (
          <pre className="font-mono text-fg-muted bg-bg-surface/40 border border-border/40 rounded px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all text-[11px]">
            {JSON.stringify(data, null, 2)}
          </pre>
        )}
      </div>
      <div className="px-4 py-3 border-t border-border shrink-0">
        <Link
          to={linkPath}
          className="inline-flex items-center gap-1.5 text-sm text-info hover:text-info/80 font-medium"
        >
          Go to {panel.kind} →
        </Link>
      </div>
    </aside>
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
    case "user.message": {
      // Wakeups synthesized by the schedule tool's onScheduledWakeup callback
      // also wire-type as user.message (per EventBase metadata convention),
      // but the user did NOT send them — visually distinguish so operators
      // don't get confused. metadata.harness === "schedule" + kind === "wakeup"
      // is the contract: see apps/agent/src/runtime/session-do.ts:onScheduledWakeup.
      const metadata = (event as { metadata?: { harness?: string; kind?: string; scheduled_at?: string } }).metadata;
      const isWakeup = metadata?.harness === "schedule" && metadata?.kind === "wakeup";
      const text = Array.isArray(event.content) ? event.content[0]?.text : "";

      if (isWakeup) {
        // System-origin: left-aligned (not "You"), info-toned bubble + clock
        // glyph + "Scheduled wakeup" label. Title bar tooltips the schedule
        // time from metadata for traceability.
        const scheduledAt = metadata?.scheduled_at;
        return (
          <div className="max-w-2xl">
            <div className="flex items-center gap-1.5 text-xs text-fg-subtle mb-1">
              <span
                className="inline-flex items-center gap-1 rounded-full bg-info-subtle text-info px-2 py-0.5 font-medium text-[11px]"
                title={scheduledAt ? `Scheduled at ${scheduledAt}` : undefined}
              >
                <span aria-hidden>🕒</span>
                Scheduled wakeup
              </span>
            </div>
            <div className="bg-bg-surface border border-info/30 rounded-2xl rounded-bl-sm px-4 py-3 text-sm leading-relaxed">
              {text}
            </div>
          </div>
        );
      }

      return (
        <div className="flex justify-end">
          <div className="max-w-lg">
            <div className="text-xs text-fg-subtle text-right mb-1">You</div>
            <div className="bg-brand text-brand-fg rounded-2xl rounded-br-sm px-4 py-3 text-sm leading-relaxed">
              {text}
            </div>
          </div>
        </div>
      );
    }

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

type SpanFamily =
  | "model"
  | "tool"
  | "mcp"
  | "custom_tool"
  | "user"
  | "agent"
  | "system"
  | "warn"
  | "error"
  | "schedule"     // schedule tool's "waiting for alarm" window (10s, 1h, …)
  | "wakeup"       // user.message synthesized by onScheduledWakeup
  | "compaction"   // span.compaction_summarize_*
  | "outcome"      // span.outcome_evaluation_*
  | "thread"       // sub-agent thread lifecycle / messages
  | "aux"          // aux.model_call (web_fetch summarizer etc.)
  | "thinking"     // agent.thinking marker
  | "marker";      // catch-all for unrecognized event types

interface Span {
  key: string;
  family: SpanFamily;
  label: string;
  detail?: string;
  /** ms since the first event */
  startMs: number;
  /** 0 for instants */
  durationMs: number;
  /** Optional: ms from this span's start to first-token (model spans only).
   *  Used to render a TTFT divider inside the bar. */
  ttftMs?: number;
  /** Source events that contributed to this span (1 for instants,
   *  2 for paired spans, possibly more for tool calls with streaming
   *  input chunks). Click-to-expand renders the raw JSON of these. */
  events: Event[];
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
  schedule: "bg-info",
  wakeup: "bg-info",
  compaction: "bg-purple-400",
  outcome: "bg-emerald-400",
  thread: "bg-fg-muted",
  aux: "bg-fg-subtle",
  thinking: "bg-fg-subtle",
  marker: "bg-fg-subtle",
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
  schedule: "bg-info/40",
  wakeup: "bg-info/70",
  compaction: "bg-purple-400/70",
  outcome: "bg-emerald-400/70",
  thread: "bg-fg-muted/50",
  aux: "bg-fg-subtle/70",
  thinking: "bg-fg-subtle/40",
  marker: "bg-fg-subtle/40",
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
  // Each event carries a millisecond-precision `processed_at` ISO string AND
  // a `ts` Unix-seconds integer. The seconds-precision ts collapses every
  // event in the same second to identical timestamps and made schedule's
  // 10-second wait window render as a 22ms timeline. processed_at (set at
  // SessionDO write time) is what the rest of the UI uses for ordering and
  // is the right basis for waterfall timing too.
  const tsMs = (e: Event): number | null => {
    const pa = (e.data as { processed_at?: string } | undefined)?.processed_at
      ?? (e as { processed_at?: string }).processed_at;
    if (typeof pa === "string") {
      const t = Date.parse(pa);
      if (Number.isFinite(t)) return t;
    }
    if (typeof e.ts === "number") return e.ts * 1000; // ts is unix SECONDS — multiply
    return null;
  };

  const timed = events.map((e) => ({ e, t: tsMs(e) })).filter((x): x is { e: Event; t: number } => x.t !== null);
  if (timed.length === 0) return { spans: [], totalMs: 0 };

  const t0 = timed[0].t;
  const tEnd = timed[timed.length - 1].t;
  const totalMs = Math.max(1, tEnd - t0);

  const spans: Span[] = [];

  // Index look-ahead pairings. O(1) instead of nested scans.
  // Each map stores both timestamp (for span math) and the source Event
  // (for click-to-expand JSON inspection).
  const toolResults = new Map<string, { t: number; e: Event }>();
  const mcpResults = new Map<string, { t: number; e: Event }>();
  const customResults = new Map<string, { t: number; e: Event }>();
  // model_request_start_id → end's timestamp + usage. Anthropic's wire
  // format pairs the per-call span pair this way (rather than positional
  // FIFO), so multiple parallel or nested model calls stay correctly
  // associated. FIFO fallback below for events that predate the field.
  const modelEndsById = new Map<string, { t: number; e: Event; usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }; finishReason?: string }>();
  const modelEndsFifo: { t: number; e: Event }[] = [];
  // OMA-extension span — pairs to model_request_start the same way the end
  // does. Lets the model bar split into TTFT (start→first_token) and
  // generation (first_token→end). FIFO fallback for events without ids.
  const modelFirstTokensById = new Map<string, { t: number; e: Event }>();
  const modelFirstTokensFifo: { t: number; e: Event }[] = [];
  const compactEnds: { t: number; e: Event }[] = [];
  const outcomeEnds: { t: number; e: Event }[] = [];
  // parent_event_id → child {t, event}. Used to pair span.wakeup_scheduled
  // (parent) with its eventual user.message (child) — same EventBase field
  // tool_result→tool_use uses, so this generalizes to any future
  // schedule→fire / outcome→eval / etc. causal pair without needing custom
  // id fields per kind.
  const childByParent = new Map<string, { t: number; e: Event }>();
  for (const { e, t } of timed) {
    if (e.type === "agent.tool_result" && e.tool_use_id) toolResults.set(e.tool_use_id, { t, e });
    else if (e.type === "agent.mcp_tool_result" && e.mcp_tool_use_id) mcpResults.set(e.mcp_tool_use_id, { t, e });
    else if (e.type === "user.custom_tool_result" && (e as Event).id) customResults.set(String(e.id), { t, e });
    else if (e.type === "span.model_request_end") {
      modelEndsFifo.push({ t, e });
      const data = (e.data as { model_request_start_id?: string; model_usage?: any; finish_reason?: string } | undefined);
      const sid = (e as { model_request_start_id?: string }).model_request_start_id ?? data?.model_request_start_id;
      if (sid) modelEndsById.set(sid, { t, e, usage: data?.model_usage, finishReason: data?.finish_reason });
    }
    else if (e.type === "span.model_first_token") {
      modelFirstTokensFifo.push({ t, e });
      const data = (e.data as { model_request_start_id?: string } | undefined);
      const sid = (e as { model_request_start_id?: string }).model_request_start_id ?? data?.model_request_start_id;
      if (sid) modelFirstTokensById.set(sid, { t, e });
    }
    else if (e.type === "span.compaction_summarize_end") compactEnds.push({ t, e });
    else if (e.type === "span.outcome_evaluation_end") outcomeEnds.push({ t, e });
    const pid = (e as { parent_event_id?: string }).parent_event_id
      ?? (e.data as { parent_event_id?: string } | undefined)?.parent_event_id;
    if (pid) childByParent.set(pid, { t, e });
  }

  // FIFO fallback indices for events that lack id-based pairing.
  let modelEndFifoIdx = 0;
  let modelFirstTokenFifoIdx = 0;
  let compactEndIdx = 0;
  let outcomeEndIdx = 0;

  // Streaming chunks (deltas + start/end markers from incremental rendering)
  // are broadcast-only; the canonical event (agent.message / agent.thinking)
  // lands on commit and is what timeline should show.
  const STREAMING_NOISE = new Set([
    "agent.message_chunk",
    "agent.message_stream_start",
    "agent.message_stream_end",
    "agent.thinking_chunk",
    "agent.thinking_stream_start",
    "agent.thinking_stream_end",
    "agent.tool_use_input_chunk",
    "agent.tool_use_input_stream_start",
    "agent.tool_use_input_stream_end",
  ]);

  // Index look-back: event id → original Event so we can attach matched
  // partner events (the `_end` of a paired span, the tool_result of a
  // tool_use) to the resulting span row. Click-to-expand renders these.
  const eventById = new Map<string, Event>();
  for (const { e } of timed) {
    const eid = (e as { id?: string }).id ?? (e.data as { id?: string } | undefined)?.id;
    if (eid) eventById.set(eid, e);
  }

  for (let i = 0; i < timed.length; i++) {
    const { e, t } = timed[i];
    const startMs = t - t0;

    if (STREAMING_NOISE.has(e.type)) continue;

    // Default source-events list. Each push site below may extend it with
    // the matched partner (end / result) when one exists.
    const sourceEvents: Event[] = [e];
    const pushSpan = (span: Omit<Span, "events">) => spans.push({ ...span, events: sourceEvents });

    if (e.type === "agent.tool_use" || e.type === "agent.custom_tool_use") {
      const result = e.type === "agent.tool_use"
        ? toolResults.get(String(e.id))
        : customResults.get(String(e.id));
      const endMs = result ? result.t - t0 : startMs;
      if (result) sourceEvents.push(result.e);
      pushSpan({
        key: `tool-${e.id ?? i}`,
        family: e.type === "agent.tool_use" ? "tool" : "custom_tool",
        label: String(e.name ?? "tool"),
        detail: result ? "completed" : "no result",
        startMs,
        durationMs: Math.max(0, endMs - startMs),
      });
    } else if (e.type === "agent.mcp_tool_use") {
      const result = mcpResults.get(String(e.id));
      const endMs = result ? result.t - t0 : startMs;
      if (result) sourceEvents.push(result.e);
      pushSpan({
        key: `mcp-${e.id ?? i}`,
        family: "mcp",
        label: `${String(e.mcp_server_name ?? "mcp")}:${String(e.name ?? "?")}`,
        detail: result ? "completed" : "no result",
        startMs,
        durationMs: Math.max(0, endMs - startMs),
      });
    } else if (
      e.type === "agent.tool_result" ||
      e.type === "agent.mcp_tool_result" ||
      e.type === "user.custom_tool_result"
    ) {
      // consumed via pairing above — no row
      continue;
    } else if (e.type === "span.model_request_start") {
      // One pair per ai-sdk step (= one model API call). Pair via the
      // start event id; old data without ids falls back to FIFO order.
      const sid = String((e as { id?: string }).id ?? (e.data as { id?: string } | undefined)?.id ?? "");
      const matched = sid ? modelEndsById.get(sid) : (modelEndsFifo[modelEndFifoIdx++] ?? undefined);
      const ftMatch = sid ? modelFirstTokensById.get(sid) : (modelFirstTokensFifo[modelFirstTokenFifoIdx++] ?? undefined);
      const end = matched?.t ?? t;
      const usage = matched?.usage;
      if (matched?.e) sourceEvents.push(matched.e);
      if (ftMatch?.e) sourceEvents.push(ftMatch.e);
      // Bar label gets a token count when we have it — useful at-a-glance
      // ("did this turn read 100k tokens or 1k?") without opening details.
      const tokSummary = usage
        ? `${usage.input_tokens}↓ ${usage.output_tokens}↑${usage.cache_read_input_tokens ? ` ⚡${usage.cache_read_input_tokens}` : ""}`
        : undefined;
      const ttftMs = ftMatch ? Math.max(0, ftMatch.t - t) : undefined;
      const ttftSummary = typeof ttftMs === "number" ? `TTFT ${formatDuration(ttftMs)}` : undefined;
      pushSpan({
        key: `model-${sid || i}`,
        family: "model",
        label: "model call",
        detail: [matched?.finishReason, ttftSummary, tokSummary].filter(Boolean).join(" · ") || undefined,
        startMs,
        durationMs: Math.max(0, end - t0 - startMs),
        ttftMs,
      });
    } else if (e.type === "span.compaction_summarize_start") {
      const matched = compactEnds[compactEndIdx++];
      const end = matched?.t ?? t;
      if (matched?.e) sourceEvents.push(matched.e);
      pushSpan({
        key: `compact-${i}`,
        family: "compaction",
        label: "compaction",
        startMs,
        durationMs: Math.max(0, end - t0 - startMs),
      });
    } else if (e.type === "span.outcome_evaluation_start") {
      const matched = outcomeEnds[outcomeEndIdx++];
      const end = matched?.t ?? t;
      if (matched?.e) sourceEvents.push(matched.e);
      pushSpan({
        key: `outcome-${i}`,
        family: "outcome",
        label: "outcome eval",
        startMs,
        durationMs: Math.max(0, end - t0 - startMs),
      });
    } else if (
      e.type === "span.model_request_end" ||
      e.type === "span.model_first_token" ||
      e.type === "span.compaction_summarize_end" ||
      e.type === "span.outcome_evaluation_end" ||
      e.type === "span.outcome_evaluation_ongoing"
    ) {
      continue; // paired or progress noise
    } else if (e.type === "span.wakeup_scheduled") {
      // Pair via parent_event_id: the eventual wakeup user.message sets its
      // parent_event_id to this span's id (mint-then-emit, see
      // session-do.ts:scheduleWakeup). Bar runs scheduled → fired and
      // visualizes the actual wait, which dwarfs everything else (10s, 1h,
      // 1d…); without it the operator can't see the wait at all on the
      // waterfall.
      const sid = String((e as { id?: string }).id ?? (e.data as { id?: string } | undefined)?.id ?? "");
      const fired = sid ? childByParent.get(sid) : undefined;
      const endMs = fired ? fired.t - t0 : startMs;
      if (fired?.e) sourceEvents.push(fired.e);
      pushSpan({
        key: `sched-${sid || i}`,
        family: "schedule",
        label: "schedule waiting",
        detail: fired ? "fired" : "pending",
        startMs,
        durationMs: Math.max(0, endMs - startMs),
      });
    } else if (e.type === "user.message") {
      const md = (e as { metadata?: { harness?: string; kind?: string } }).metadata;
      const isWakeup = md?.harness === "schedule" && md?.kind === "wakeup";
      pushSpan({
        key: `u-${i}`,
        family: isWakeup ? "wakeup" : "user",
        label: isWakeup ? "user.message (wakeup)" : "user.message",
        startMs,
        durationMs: 0,
      });
    } else if (e.type === "agent.message") {
      pushSpan({ key: `a-${i}`, family: "agent", label: "agent.message", startMs, durationMs: 0 });
    } else if (e.type === "agent.thinking") {
      pushSpan({ key: `think-${i}`, family: "thinking", label: "agent.thinking", startMs, durationMs: 0 });
    } else if (e.type === "aux.model_call") {
      pushSpan({ key: `aux-${i}`, family: "aux", label: "aux.model_call", startMs, durationMs: 0 });
    } else if (
      e.type === "agent.thread_message_sent" ||
      e.type === "agent.thread_message_received" ||
      e.type === "agent.thread_message" ||
      e.type === "session.thread_created" ||
      e.type === "session.thread_idle"
    ) {
      pushSpan({ key: `thread-${i}`, family: "thread", label: e.type.replace(/^.*\./, ""), startMs, durationMs: 0 });
    } else if (e.type === "agent.thread_context_compacted") {
      pushSpan({ key: `compact-marker-${i}`, family: "compaction", label: "thread compacted", startMs, durationMs: 0 });
    } else if (e.type === "session.error") {
      pushSpan({
        key: `err-${i}`,
        family: "error",
        label: "session.error",
        detail: typeof e.error === "string" ? e.error : JSON.stringify(e.error),
        startMs,
        durationMs: 0,
      });
    } else if (e.type === "session.warning") {
      pushSpan({
        key: `warn-${i}`,
        family: "warn",
        label: `warning:${String(e.source ?? "")}`,
        detail: String(e.message ?? ""),
        startMs,
        durationMs: 0,
      });
    } else if (e.type.startsWith("session.")) {
      pushSpan({ key: `s-${i}`, family: "system", label: e.type, startMs, durationMs: 0 });
    } else {
      // Catch-all: surface unknown types as instant markers rather than
      // silently dropping. New event types added later show up immediately
      // and the operator can decide whether to give them dedicated visuals.
      pushSpan({ key: `mk-${i}`, family: "marker", label: e.type, startMs, durationMs: 0 });
    }
  }

  return { spans, totalMs };
}

/**
 * A "turn" is the unit of agent work between a user trigger event
 * (user.message / user.tool_confirmation / user.custom_tool_result) and
 * the next session.status_idle / .status_terminated / .error. This is the
 * same definition the harness uses internally (see drainEventQueue in
 * apps/agent/src/runtime/session-do.ts) and matches Conversation view's
 * notion of a turn — so a Timeline burst card lines up 1:1 with a chat
 * exchange. Time-based bucketing breaks under both fast follow-ups and
 * 40-minute cron gaps; semantic bucketing handles both uniformly.
 */
type TurnTriggerKind =
  | "user_message"
  | "wakeup"
  | "tool_confirmation"
  | "custom_tool_result"
  | "init";

type TurnStatus = "completed" | "running" | "errored" | "terminated";

interface Turn {
  id: string;
  triggerKind: TurnTriggerKind;
  trigger?: Event;
  /** Wall-clock ms epoch of the trigger (or first event for init turn). */
  triggerTs: number;
  /** Inclusive: trigger event + everything until the closing status event. */
  events: Event[];
  status: TurnStatus;
  /** Wall-clock ms epoch when the turn closed; undefined while still running. */
  endedAt?: number;
}

function parseEventTs(e: Event): number {
  const ts = (e as { processed_at?: string }).processed_at;
  if (typeof ts === "string") {
    const t = new Date(ts).getTime();
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

function bucketIntoTurns(events: Event[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;

  // user.message metadata.harness === "schedule" + kind === "wakeup" is
  // the wire convention for cron-fired turns (see SessionDO.onScheduledWakeup).
  // Distinguish them in the trigger badge so an operator scanning the
  // timeline can tell at a glance "the agent woke itself" from "the user
  // sent something".
  const triggerKindOf = (e: Event): TurnTriggerKind | null => {
    if (e.type === "user.message") {
      const md = (e as { metadata?: { harness?: string; kind?: string } }).metadata;
      if (md?.harness === "schedule" && md?.kind === "wakeup") return "wakeup";
      return "user_message";
    }
    if (e.type === "user.tool_confirmation") return "tool_confirmation";
    if (e.type === "user.custom_tool_result") return "custom_tool_result";
    return null;
  };

  for (const e of events) {
    const k = triggerKindOf(e);
    if (k) {
      current = {
        id: `turn-${turns.length}`,
        triggerKind: k,
        trigger: e,
        triggerTs: parseEventTs(e),
        events: [e],
        status: "running",
      };
      turns.push(current);
      continue;
    }
    if (!current) {
      // Pre-trigger init events (init_events injected by /init handler,
      // platform reminders, etc.) — bucket into a synthetic init turn so
      // they get a card rather than being silently dropped.
      current = {
        id: `turn-init`,
        triggerKind: "init",
        triggerTs: parseEventTs(e),
        events: [e],
        status: "running",
      };
      turns.push(current);
      continue;
    }
    current.events.push(e);
    if (e.type === "session.status_idle") {
      current.status = "completed";
      current.endedAt = parseEventTs(e);
    } else if (e.type === "session.status_terminated") {
      current.status = "terminated";
      current.endedAt = parseEventTs(e);
    } else if (e.type === "session.error") {
      current.status = "errored";
      current.endedAt = parseEventTs(e);
    }
  }

  return turns;
}

const TRIGGER_LABEL: Record<TurnTriggerKind, string> = {
  user_message: "user message",
  wakeup: "scheduled wakeup",
  tool_confirmation: "tool confirmation",
  custom_tool_result: "custom tool result",
  init: "session init",
};

const TRIGGER_DOT: Record<TurnTriggerKind, string> = {
  user_message: "bg-brand",
  wakeup: "bg-info",
  tool_confirmation: "bg-amber-500",
  custom_tool_result: "bg-amber-500",
  init: "bg-fg-subtle",
};

const STATUS_TEXT: Record<TurnStatus, string> = {
  completed: "text-fg-subtle",
  running: "text-info",
  errored: "text-danger",
  terminated: "text-danger",
};

/** What's currently selected for the side detail panel. Lifted up to
 *  TimelineView so a click in any TurnCard updates one shared panel. */
interface TimelineSelection {
  spanKey: string;
  spanLabel: string;
  events: Event[];
}

function TimelineView({ events }: { events: Event[] }) {
  const turns = useMemo(() => bucketIntoTurns(events), [events]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [selection, setSelection] = useState<TimelineSelection | null>(null);

  // Auto-scroll to the latest turn when new ones land. Skip if user has
  // scrolled up (we can detect this with scrollHeight - scrollTop ≈ clientHeight)
  // — they're inspecting an older turn and shouldn't get yanked.
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (nearBottom) {
      el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
    }
  }, [turns.length]);

  if (turns.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-fg-subtle">
        No timing data yet — send a message to populate the timeline.
      </div>
    );
  }

  return (
    <div className="flex-1 flex min-h-0">
      <div ref={containerRef} className="flex-1 min-w-0 overflow-y-auto px-8 py-6 space-y-3">
        {turns.map((turn, i) => {
          const prev = i > 0 ? turns[i - 1] : null;
          const idleMs =
            prev && prev.endedAt && turn.triggerTs && turn.triggerTs > prev.endedAt
              ? turn.triggerTs - prev.endedAt
              : 0;
          return (
            <Fragment key={turn.id}>
              {idleMs > 0 && <IdleDivider ms={idleMs} nextKind={turn.triggerKind} />}
              <TurnCard
                turn={turn}
                selection={selection}
                onSelectSpan={(span) =>
                  setSelection((prev) =>
                    prev?.spanKey === span.key
                      ? null
                      : { spanKey: span.key, spanLabel: span.label, events: span.events },
                  )
                }
              />
            </Fragment>
          );
        })}
      </div>
      {selection && (
        <DetailPanel
          selection={selection}
          onClose={() => setSelection(null)}
        />
      )}
    </div>
  );
}

function DetailPanel({
  selection,
  onClose,
}: {
  selection: TimelineSelection;
  onClose: () => void;
}) {
  return (
    <aside className="w-[420px] shrink-0 border-l border-border bg-bg flex flex-col min-h-0">
      <div className="px-4 py-3 border-b border-border flex items-center gap-3 shrink-0">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wide text-fg-subtle font-mono">
            {selection.events.length === 1
              ? "source event"
              : `source events (${selection.events.length})`}
          </div>
          <div className="text-sm font-mono text-fg-muted truncate">{selection.spanLabel}</div>
        </div>
        <button
          onClick={onClose}
          className="text-fg-subtle hover:text-fg-muted text-lg leading-none px-2"
          title="Close"
        >
          ×
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {selection.events.map((ev, idx) => (
          <div key={idx} className="border border-border/60 rounded">
            <div className="px-3 py-1.5 border-b border-border/60 bg-bg-surface/40 flex items-center gap-2 text-[11px] font-mono">
              <span className="text-fg-muted">{ev.type}</span>
              {typeof ev.processed_at === "string" && (
                <span className="text-fg-subtle ml-auto">
                  {new Date(ev.processed_at).toISOString().slice(11, 23)}
                </span>
              )}
            </div>
            <pre className="text-[11px] font-mono text-fg-muted px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all">
              {JSON.stringify(ev, null, 2)}
            </pre>
          </div>
        ))}
      </div>
    </aside>
  );
}

function IdleDivider({ ms, nextKind }: { ms: number; nextKind: TurnTriggerKind }) {
  return (
    <div className="flex items-center gap-3 text-xs text-fg-subtle font-mono py-1">
      <div className="flex-1 border-t border-dashed border-border" />
      <span>
        ↓ {formatDuration(ms)} idle
        {nextKind === "wakeup" && " · scheduled wakeup"}
      </span>
      <div className="flex-1 border-t border-dashed border-border" />
    </div>
  );
}

function TurnCard({
  turn,
  selection,
  onSelectSpan,
}: {
  turn: Turn;
  selection: TimelineSelection | null;
  onSelectSpan: (span: Span) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const { spans, totalMs } = useMemo(() => deriveSpans(turn.events), [turn.events]);

  // Per-card scroll + zoom state (same shape as the old global TimelineView,
  // now scoped to one turn — each card auto-densifies independently so a
  // 30-min turn doesn't impose its scale on a 2-second turn next to it).
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [pxPerMs, setPxPerMs] = useState<number | null>(null);
  const [mode, setMode] = useState<"auto" | "manual">("auto");

  useEffect(() => {
    if (collapsed || mode === "manual" || !scrollRef.current || totalMs <= 0) return;
    const viewportChartPx = scrollRef.current.clientWidth - 224 - 80 - 64;
    if (viewportChartPx <= 0) return;
    const times: number[] = [];
    for (const s of spans) {
      times.push(s.startMs);
      if (s.durationMs > 0) times.push(s.startMs + s.durationMs);
    }
    times.sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < times.length; i++) {
      const g = times[i] - times[i - 1];
      if (g > 0) gaps.push(g);
    }
    let candidate: number;
    if (gaps.length === 0) {
      candidate = viewportChartPx / totalMs;
    } else {
      const sorted = [...gaps].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] || 1;
      candidate = 25 / median;
    }
    const auto = Math.min(5, Math.max(candidate, viewportChartPx / totalMs));
    setPxPerMs(Math.max(auto, viewportChartPx / totalMs));
  }, [collapsed, mode, spans, totalMs]);

  const effectivePxPerMs = pxPerMs ?? 0.05;
  const chartPx = Math.max(200, totalMs * effectivePxPerMs);

  const zoomBy = (factor: number) => {
    setMode("manual");
    setPxPerMs((p) => Math.min(50, Math.max(0.0001, (p ?? 0.05) * factor)));
  };
  const fitToViewport = () => {
    if (!scrollRef.current) return;
    const viewportChartPx = scrollRef.current.clientWidth - 224 - 80 - 64;
    if (viewportChartPx > 0 && totalMs > 0) setPxPerMs(viewportChartPx / totalMs);
    setMode("manual");
  };
  const resetAuto = () => {
    setMode("auto");
    setPxPerMs(null);
  };

  // Tick spacing: aim for ~120px between labels at the current pixel
  // density. pickTickStep takes a "total span across 6 ticks" arg, so
  // multiply the target step by 6 to get a step matching ~120px gaps.
  const targetTickPx = 120;
  const desiredStepMs = targetTickPx / effectivePxPerMs;
  const tickStep = pickTickStep(desiredStepMs * 6);
  const ticks: number[] = [];
  for (let t = 0; t <= totalMs; t += tickStep) ticks.push(t);

  const fmtRate = (ppms: number) => {
    const pps = ppms * 1000;
    if (pps >= 100) return `${Math.round(pps)} px/s`;
    if (pps >= 1) return `${pps.toFixed(1)} px/s`;
    return `${pps.toFixed(2)} px/s`;
  };

  // Aggregate per-turn cost / token totals from span events that carry
  // model_usage. Cheap walk — span events are already in memory.
  const tokens = useMemo(() => {
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let calls = 0;
    for (const e of turn.events) {
      if (e.type !== "span.model_request_end") continue;
      const usage =
        (e as { model_usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } }).model_usage ??
        (e.data as { model_usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } } | undefined)?.model_usage;
      if (usage) {
        input += usage.input_tokens ?? 0;
        output += usage.output_tokens ?? 0;
        cacheRead += usage.cache_read_input_tokens ?? 0;
        calls += 1;
      }
    }
    return { input, output, cacheRead, calls };
  }, [turn.events]);

  const turnDurationMs =
    turn.endedAt && turn.triggerTs ? turn.endedAt - turn.triggerTs : totalMs;

  const triggerTitleText = (() => {
    if (!turn.trigger) return null;
    const c = (turn.trigger as { content?: Array<{ type: string; text?: string }> }).content;
    if (!Array.isArray(c)) return null;
    const t = c.find((b) => b.type === "text")?.text;
    return t ? t.slice(0, 80) : null;
  })();

  const borderClass =
    turn.status === "errored" || turn.status === "terminated"
      ? "border-danger/50"
      : "border-border";

  return (
    <div className={`border ${borderClass} rounded-lg bg-bg-surface/30`}>
      {/* Header */}
      <div className="px-4 py-2.5 flex items-center gap-3 text-xs">
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="text-fg-subtle hover:text-fg-muted font-mono w-4 text-center"
          title={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? "▸" : "▾"}
        </button>
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${TRIGGER_DOT[turn.triggerKind]}`} />
        <span className="font-mono text-fg-muted">{TRIGGER_LABEL[turn.triggerKind]}</span>
        {triggerTitleText && (
          <span className="text-fg-subtle truncate max-w-md italic">"{triggerTitleText}"</span>
        )}
        <span className="ml-auto flex items-center gap-3 font-mono text-fg-subtle">
          <span>{spans.length} spans</span>
          <span>{formatDuration(turnDurationMs)}</span>
          {tokens.calls > 0 && (
            <span title={`${tokens.calls} model call${tokens.calls === 1 ? "" : "s"}`}>
              {tokens.input}↓ {tokens.output}↑
              {tokens.cacheRead > 0 && ` ⚡${tokens.cacheRead}`}
            </span>
          )}
          <span className={STATUS_TEXT[turn.status]}>{turn.status}</span>
        </span>
      </div>

      {!collapsed && spans.length > 0 && (
        <>
          {/* Zoom controls — per-card, since each card has its own pxPerMs */}
          <div className="px-4 pb-2 flex items-center gap-1 text-xs">
            <button
              onClick={() => zoomBy(0.5)}
              className="px-2 py-0.5 rounded border border-border hover:bg-bg-surface text-fg-muted"
              title="Zoom out"
            >
              −
            </button>
            <button
              onClick={resetAuto}
              className={`px-2 py-0.5 rounded border hover:bg-bg-surface ${mode === "auto" ? "border-info text-info" : "border-border text-fg-muted"}`}
              title="Auto-pick scale by event density"
            >
              auto
            </button>
            <button
              onClick={fitToViewport}
              className="px-2 py-0.5 rounded border border-border hover:bg-bg-surface text-fg-muted"
              title="Fit turn duration to viewport"
            >
              fit
            </button>
            <button
              onClick={() => zoomBy(2)}
              className="px-2 py-0.5 rounded border border-border hover:bg-bg-surface text-fg-muted"
              title="Zoom in"
            >
              +
            </button>
            <span className="ml-2 font-mono text-fg-subtle">{fmtRate(effectivePxPerMs)}</span>
          </div>

          {/* Chart — same waterfall layout as before, scoped to this turn */}
          <div ref={scrollRef} className="overflow-x-auto pb-3 border-t border-border/40">
            {/* Time axis */}
            <div className="pt-2 sticky top-0 bg-bg-surface/30 z-10" style={{ width: 224 + chartPx + 80 }}>
              <div className="flex items-center">
                <div className="w-56 shrink-0 sticky left-0 bg-bg-surface/30 z-30" />
                <div className="relative h-5 border-b border-border" style={{ width: chartPx }}>
                  {ticks.map((t) => (
                    <div
                      key={t}
                      className="absolute top-0 h-full flex flex-col items-start text-[10px] text-fg-subtle font-mono"
                      style={{ left: `${t * effectivePxPerMs}px` }}
                    >
                      <span className="-translate-x-1/2 px-1">{formatDuration(t)}</span>
                      <div className="w-px flex-1 bg-border" />
                    </div>
                  ))}
                </div>
                <div className="w-20 shrink-0 sticky right-0 bg-bg-surface/30 z-30" />
              </div>
            </div>

            {/* Rows */}
            {spans.map((s) => {
              const left = s.startMs * effectivePxPerMs;
              const width = s.durationMs > 0 ? Math.max(2, s.durationMs * effectivePxPerMs) : 0;
              const isSelected = selection?.spanKey === s.key;
              return (
                <div key={s.key} style={{ width: 224 + chartPx + 80 }}>
                  <div
                    className={`flex items-center py-1 border-b border-border/30 hover:bg-bg/40 group cursor-pointer ${isSelected ? "bg-info-subtle/40" : ""}`}
                    title={
                      s.detail
                        ? `${s.label} — ${formatDuration(s.durationMs)} — ${s.detail}`
                        : `${s.label} — ${formatDuration(s.durationMs)}`
                    }
                    onClick={() => onSelectSpan(s)}
                  >
                    <div className={`w-56 shrink-0 sticky left-0 group-hover:bg-bg/40 z-20 flex items-center gap-2 text-xs px-4 ${isSelected ? "bg-info-subtle/40" : "bg-bg-surface/30"}`}>
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${FAMILY_DOT[s.family]}`} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-fg-muted font-mono">{s.label}</div>
                        {s.detail && (
                          <div className="truncate text-fg-subtle font-mono text-[10px]">{s.detail}</div>
                        )}
                      </div>
                    </div>
                    <div className="relative h-5 shrink-0" style={{ width: chartPx }}>
                      {width > 0 ? (
                        <>
                          <div
                            className={`absolute h-3 top-1 rounded-sm ${FAMILY_BAR[s.family]} group-hover:opacity-100 opacity-90`}
                            style={{ left: `${left}px`, width: `${width}px` }}
                          />
                          {typeof s.ttftMs === "number" && s.durationMs > 0 && (
                            <div
                              className="absolute h-3 top-1 w-px bg-bg-surface"
                              style={{ left: `${left + s.ttftMs * effectivePxPerMs}px` }}
                              title={`TTFT ${formatDuration(s.ttftMs)}`}
                            />
                          )}
                        </>
                      ) : (
                        <div
                          className={`absolute top-0 bottom-0 w-px ${FAMILY_DOT[s.family]}`}
                          style={{ left: `${left}px` }}
                        />
                      )}
                    </div>
                    <div className={`w-20 shrink-0 sticky right-0 group-hover:bg-bg/40 z-20 text-right text-xs font-mono text-fg-subtle pr-3 ${isSelected ? "bg-info-subtle/40" : "bg-bg-surface/30"}`}>
                      {s.durationMs > 0 ? formatDuration(s.durationMs) : "·"}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
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
