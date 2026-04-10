import { useEffect, useState, useRef } from "react";
import { useParams, Link } from "react-router";
import { useApi } from "../lib/api";
import { Markdown } from "../components/Markdown";

interface Event {
  type: string;
  content?: Array<{ type: string; text: string }>;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  error?: string;
  stop_reason?: { type: string };
  [key: string]: unknown;
}

export function SessionDetail() {
  const { id } = useParams();
  const { api, streamEvents } = useApi();
  const [events, setEvents] = useState<Event[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [title, setTitle] = useState("");
  const [agentId, setAgentId] = useState("");
  const [status, setStatus] = useState("idle");
  const scrollRef = useRef<HTMLDivElement>(null);
  const seenKeys = useRef(new Set<string>());
  const abortRef = useRef<AbortController | null>(null);

  const eventKey = (e: Event) => `${e.type}:${JSON.stringify(e.content || e.id || e.tool_use_id || e.error || "").slice(0, 120)}`;

  const addEvent = (e: Event) => {
    const key = eventKey(e);
    if (seenKeys.current.has(key)) return;
    seenKeys.current.add(key);

    if (e.type === "session.status_running") { setStatus("running"); return; }
    if (e.type === "session.status_idle") { setStatus("idle"); return; }
    if (e.type?.startsWith("span.") || e.type === "agent.thinking") return;

    setEvents((prev) => [...prev, e]);
  };

  useEffect(() => {
    if (!id) return;
    seenKeys.current.clear();

    // Load session info
    api<{ title?: string; agent_id?: string }>(`/v1/sessions/${id}`)
      .then((s) => { setTitle(s.title || id); setAgentId(s.agent_id || ""); })
      .catch(() => {});

    // Load history
    api<{ data: Array<{ type: string; data: Event }> }>(`/v1/sessions/${id}/events?limit=1000&order=asc`)
      .then((res) => { for (const e of res.data) addEvent(e.data || (e as unknown as Event)); })
      .catch(() => {});

    // Connect SSE
    const abort = new AbortController();
    abortRef.current = abort;
    streamEvents(id, addEvent, abort.signal);

    return () => { abort.abort(); };
  }, [id]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [events]);

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
      <div className="px-8 py-4 border-b border-stone-200/60 flex items-center gap-3 shrink-0">
        <Link to="/sessions" className="text-stone-400 hover:text-stone-600 text-sm">&larr; Sessions</Link>
        <h2 className="font-[family-name:var(--font-display)] text-lg font-semibold flex-1">{title}</h2>
        <div className="flex items-center gap-2">
          {status === "running" && (
            <span className="flex items-center gap-1.5 text-xs text-blue-600">
              <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
              Running
            </span>
          )}
          <span className="text-xs text-stone-400 font-mono">{agentId}</span>
        </div>
      </div>

      {/* Events */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-8 py-6 space-y-4">
        {events.map((e, i) => (
          <EventBubble key={i} event={e} />
        ))}
        {status === "running" && (
          <div className="flex gap-1 py-2">
            <span className="w-1.5 h-1.5 bg-stone-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
            <span className="w-1.5 h-1.5 bg-stone-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
            <span className="w-1.5 h-1.5 bg-stone-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
          </div>
        )}
      </div>

      {/* Input */}
      <div className="px-8 py-4 border-t border-stone-200/60 flex gap-2 shrink-0">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
          placeholder="Send a message..."
          className="flex-1 border border-stone-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-stone-400 transition-colors"
          disabled={sending}
        />
        <button
          onClick={send}
          disabled={sending || !input.trim()}
          className="px-5 py-2.5 bg-stone-900 text-white rounded-xl text-sm font-medium hover:bg-stone-800 disabled:opacity-40 transition-colors"
        >
          Send
        </button>
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
            <div className="text-xs text-stone-400 text-right mb-1">You</div>
            <div className="bg-stone-900 text-stone-50 rounded-2xl rounded-br-sm px-4 py-3 text-sm leading-relaxed">
              {event.content?.[0]?.text}
            </div>
          </div>
        </div>
      );

    case "agent.message":
      return (
        <div className="max-w-2xl">
          <div className="text-xs text-stone-400 mb-1">Agent</div>
          <div className="bg-stone-100 rounded-2xl rounded-bl-sm px-4 py-3 text-sm leading-relaxed">
            <Markdown>{(event.content || []).map((b) => b.text).join("")}</Markdown>
          </div>
        </div>
      );

    case "agent.tool_use":
      return (
        <div className="max-w-2xl">
          <button
            onClick={() => setToolOpen(!toolOpen)}
            className="flex items-center gap-2 px-3 py-2 border border-stone-200 rounded-lg text-sm hover:bg-stone-50 transition-colors w-full text-left"
          >
            <svg className="w-3.5 h-3.5 text-blue-500 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
            </svg>
            <span className="font-medium">{event.name}</span>
            <svg className={`w-3 h-3 ml-auto text-stone-400 transition-transform ${toolOpen ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {toolOpen && (
            <pre className="mt-1 bg-stone-50 border border-stone-200 rounded-lg p-3 text-xs font-[family-name:var(--font-mono)] overflow-x-auto max-h-48 overflow-y-auto text-stone-600">
              {JSON.stringify(event.input, null, 2)}
            </pre>
          )}
        </div>
      );

    case "agent.tool_result":
      return (
        <div className="max-w-2xl">
          <div className="border-l-3 border-green-500 bg-stone-50 rounded-r-lg px-3 py-2 text-xs font-[family-name:var(--font-mono)] max-h-40 overflow-y-auto text-stone-600 whitespace-pre-wrap">
            {typeof event.content === "string" ? event.content : JSON.stringify(event.content)}
          </div>
        </div>
      );

    case "session.error":
      return (
        <div className="max-w-2xl bg-red-50 border border-red-200 rounded-lg px-4 py-2.5 text-sm text-red-700">
          Error: {event.error}
        </div>
      );

    default:
      return null;
  }
}
