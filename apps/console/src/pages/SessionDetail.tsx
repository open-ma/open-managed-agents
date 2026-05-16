import { useEffect, useState, useRef } from "react";
import { useParams, Link } from "react-router";
import { useApi } from "../lib/api";
import { Markdown } from "../components/Markdown";
import { formatDuration, formatRelative, shortenId } from "../lib/format";
import { Badge, StatusPill } from "../components/Badge";
import { Modal } from "../components/Modal";
import { Button } from "../components/Button";
import { AgentIcon, ClockIcon, DurationIcon, EnvIcon, VaultIcon } from "../components/icons";
import { TimelineView } from "../components/timeline/TimelineView";
import type { Event } from "../lib/events";
import type { Trajectory, TrajectoryOutcome } from "../lib/trajectory";
import { rewardHeadline, outcomeToStatusTone } from "../lib/trajectory";
// ai-elements primitives — used to render the chat surface (messages,
// reasoning blocks, tool calls, prompt input). The components/ai-elements/
// directory is shadcn-style copy-paste so we own + customize them locally.
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "../components/ai-elements/conversation";
import { Message, MessageContent } from "../components/ai-elements/message";
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from "../components/ai-elements/reasoning";
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
} from "../components/ai-elements/tool";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputSubmit,
} from "../components/ai-elements/prompt-input";
import { CodeBlock } from "../components/ai-elements/code-block";

type View = "chat" | "timeline";

/** A user.* event sitting in the server-side pending_events queue.
 *  Maintained client-side via system.user_message_pending /
 *  _promoted / _cancelled SSE frames. Server is authoritative on what's
 *  pending; client mirrors the row for outbox rendering only. */
interface PendingEntry {
  event_id: string;
  pending_seq: number;
  enqueued_at: number;
  session_thread_id: string;
  /** The full canonical user.* event the server enqueued. */
  event: Event;
}

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
  // Optimistic outbox slot — what the user typed, between hitting Send
  // and the server-side pending broadcast (system.user_message_pending)
  // arriving over SSE. Without this, hitting Send clears the input
  // field instantly and the user stares at a blank conversation for the
  // 100-500ms POST → SSE roundtrip. With it, the message appears in the
  // queued-state EventBubble immediately and is replaced by the server's
  // pending row the moment SSE delivers it. Single slot is intentional
  // (we never let two POSTs be in flight at once — Send is disabled
  // while `sending`). Set to null when SSE confirms or POST settles.
  const [localPending, setLocalPending] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [agentId, setAgentId] = useState("");
  const [sessionMeta, setSessionMeta] = useState<{
    environmentId?: string;
    vaultIds?: string[];
    vaults?: Array<{ id: string; display_name?: string }>;
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
  const [showFiles, setShowFiles] = useState(false);
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
  /** Lazy-fetched Trajectory v1 envelope. Drives the outcome + reward
   *  chips in the header strip and the Trajectory viewer modal. We don't
   *  block initial render on this — chips render as `—` until it lands.
   *  Sentinels mirror EvalRunDetail: "loading" while in flight, "error"
   *  if the fetch failed (404 = trajectory not built yet, 5xx = sandbox
   *  flaky); both keep the trigger from re-firing every render. */
  const [trajectory, setTrajectory] = useState<Trajectory | "loading" | "error" | undefined>(undefined);
  /** Sub-agent threads in this session. Primary is implicit at index 0
   *  (label "Main"). Empty when the session has only the primary thread,
   *  in which case the selector UI is hidden entirely. Refreshed on
   *  `session.thread_created` events arriving over SSE.
   *  parent_thread_id powers the tree view (coordinator → worker → sub-
   *  worker); missing parents fall back to the primary root. */
  const [threads, setThreads] = useState<
    Array<{ id: string; agent_name?: string; parent_thread_id?: string | null }>
  >([]);
  /** Currently-active thread id. Defaults to 'sthr_primary'. Filters
   *  the events array at render time. SSE-driven new threads don't
   *  auto-switch — the operator stays on whatever they're watching. */
  const [activeThreadId, setActiveThreadId] = useState<string>("sthr_primary");
  /** Server-mirrored pending queue, keyed by event_id. Populated from
   *  the initial GET /pending plus live system.user_message_pending /
   *  _promoted / _cancelled SSE frames. Pending entries render as a
   *  separate "outbox" section at the bottom of the timeline; once the
   *  server promotes the row (system.user_message_promoted), the entry
   *  is removed from this map and the canonical user.* event takes its
   *  place in the events array via the regular SSE broadcast. */
  const [pendingByEventId, setPendingByEventId] = useState<Map<string, PendingEntry>>(new Map());
  const [showTrajectory, setShowTrajectory] = useState(false);
  const seenKeys = useRef(new Set<string>());
  const abortRef = useRef<AbortController | null>(null);

  // Dedup key for SSE re-delivery + initial-fetch overlap. `id` is stamped
  // on every event by the server (sevt-* for tool_results / stream events;
  // toolCallId for tool_use overrides) so it's a uniqueness guarantee
  // across the wire. The previous content-based key dropped legitimate
  // distinct events whose payloads happened to be byte-identical (two
  // back-to-back `gh repo list` calls both timing out with the same
  // 401 stderr was the repro). Fallback only kicks in for legacy events
  // that pre-date stamping.
  const eventKey = (e: Event) =>
    (e as { id?: string }).id
    ?? `${e.type}:${JSON.stringify(e.content || e.tool_use_id || e.error || "").slice(0, 120)}`;

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
    if (ev.type === "agent.thinking_stream_start" && typeof ev.thinking_id === "string") {
      const tid = ev.thinking_id;
      setThinkingStreams((prev) => {
        if (prev.has(tid)) return prev;
        const next = new Map(prev);
        next.set(tid, "");
        return next;
      });
      return;
    }
    if (ev.type === "agent.thinking_chunk" && typeof ev.thinking_id === "string" && typeof ev.delta === "string") {
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
      const tid = typeof ev.thinking_id === "string" ? ev.thinking_id : undefined;
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
    // session.error → idle: defense-in-depth for the catch-all status_idle
    // emit (processUserMessage finally) in case a future code path forgets
    // to pair status_running with status_idle. Note: do NOT also map
    // status_rescheduled — that's a transient retry-pending state, not a
    // terminal one. Mapping it caused observed pill flicker
    // running→idle→running→idle×3 during exponential-backoff retries
    // (sess-y2bfxm1de4e1zqxm 2026-05-11). The next status_running event
    // for the retry attempt naturally restores the pill.
    if (ev.type === "session.error") {
      setStatus("idle");
      // session.error implies the active turn is dead; the harness won't
      // pick anything else off the queue until the next user.message.
      // Drop the outbox so the user doesn't see ghosts of inputs that
      // can never run on this session state.
      setPendingByEventId(new Map());
    }

    // AMA-spec pending-queue notifications. The server is authoritative
    // on what's queued; we mirror its state into pendingByEventId so the
    // outbox renders without polling /pending.
    if (ev.type === "system.user_message_pending") {
      const p = ev as unknown as {
        event_id: string;
        pending_seq: number;
        enqueued_at: number;
        session_thread_id: string;
        event: Event;
      };
      // Server claimed our optimistic outbox slot — drop the client-only
      // mirror so we don't double-render the same user message (server
      // entry has more metadata + a stable event_id; ours has neither).
      const inner = p.event;
      const innerText =
        inner && (inner as { content?: Array<{ type?: string; text?: string }> }).content
          ?.find((c) => c.type === "text")?.text;
      if (innerText) setLocalPending((cur) => (cur === innerText ? null : cur));
      if (p.event_id) {
        setPendingByEventId((prev) => {
          const next = new Map(prev);
          next.set(p.event_id, {
            event_id: p.event_id,
            pending_seq: p.pending_seq,
            enqueued_at: p.enqueued_at,
            session_thread_id: p.session_thread_id ?? "sthr_primary",
            event: p.event,
          });
          return next;
        });
      }
      // System frame — don't add to events list. The canonical user.*
      // event arrives separately at drain time.
      return;
    }
    if (ev.type === "system.user_message_promoted") {
      const p = ev as unknown as { event_id?: string };
      if (p.event_id) {
        setPendingByEventId((prev) => {
          if (!prev.has(p.event_id!)) return prev;
          const next = new Map(prev);
          next.delete(p.event_id!);
          return next;
        });
      }
      return;
    }
    if (ev.type === "system.user_message_cancelled") {
      const p = ev as unknown as { event_id?: string };
      if (p.event_id) {
        setPendingByEventId((prev) => {
          if (!prev.has(p.event_id!)) return prev;
          const next = new Map(prev);
          next.delete(p.event_id!);
          return next;
        });
      }
      return;
    }
    // user.interrupt also clears the outbox client-side (server emits
    // _cancelled per row above; this is defensive for the case where the
    // SDK posts user.interrupt without a thread filter and we want to
    // drop everything for the active thread).
    if (ev.type === "user.interrupt") {
      const tid = (ev as { session_thread_id?: string }).session_thread_id ?? "sthr_primary";
      setPendingByEventId((prev) => {
        if (prev.size === 0) return prev;
        const next = new Map(prev);
        for (const [k, v] of prev) {
          if (v.session_thread_id === tid) next.delete(k);
        }
        return next;
      });
    }
    // Live-update the thread selector when a sub-agent spawns. We don't
    // auto-switch the operator's view — they stay on whatever they're
    // watching; the new tab just appears alongside.
    if (ev.type === "session.thread_created") {
      const tc = ev as {
        session_thread_id?: string;
        agent_name?: string;
        parent_thread_id?: string | null;
      };
      if (tc.session_thread_id && tc.session_thread_id !== "sthr_primary") {
        setThreads((prev) =>
          prev.some((t) => t.id === tc.session_thread_id)
            ? prev
            : [
                ...prev,
                {
                  id: tc.session_thread_id!,
                  agent_name: tc.agent_name,
                  // SessionDO emits thread_created with parent_thread_id;
                  // older sessions (pre-Phase 1) may not — fall back to
                  // primary so the tree stays well-formed.
                  parent_thread_id: tc.parent_thread_id ?? "sthr_primary",
                },
              ],
        );
      }
    }
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
    // Full per-session state reset before loading the new id. The
    // canonical bug this fixes: clicking from /sessions/A to /sessions/B
    // re-runs this effect with a new id, but `events` (and the other
    // session-scoped state below) was retained from session A. Same
    // SessionDetail component instance handles both routes — React only
    // re-runs the effect, doesn't unmount/remount — so without an
    // explicit reset the user sees session A's content under session B's
    // URL until the SSE refill catches up. Hard refresh works because
    // it re-mounts the whole tree from a fresh state. Reported 2026-05-13.
    seenKeys.current.clear();
    setEvents([]);
    setStreams(new Map());
    setThinkingStreams(new Map());
    setToolInputStreams(new Map());
    setTitle("");
    setAgentId("");
    setSessionMeta({});
    setStatus("idle");
    setTrajectory(undefined);
    setThreads([]);
    setActiveThreadId("sthr_primary");
    setPendingByEventId(new Map());
    setLocalPending(null);

    // Load session info
    api<{
      title?: string | null;
      environment_id?: string;
      vault_ids?: string[];
      created_at?: string;
      agent?: { id?: string; name?: string; model?: string | { id: string }; description?: string; version?: number };
      metadata?: Record<string, unknown>;
    }>(`/v1/sessions/${id}`)
      .then((s) => {
        setTitle(s.title || id);
        setAgentId(s.agent?.id || "");
        setSessionMeta({
          environmentId: s.environment_id,
          vaultIds: s.vault_ids,
          createdAt: s.created_at,
          agentSnapshot: s.agent,
        });

        // Live-resolve env + vault names by id. Per the id-only ref decision
        // (memory: session-resource-refs), the session API does not pre-bake
        // display data — clients fetch resources on demand. Names appear a
        // tick later than the badge frame; until then the badge falls back
        // to the short-id label.
        if (s.environment_id) {
          api<{ id: string; name?: string; description?: string }>(`/v1/environments/${s.environment_id}`)
            .then((env) => setSessionMeta((prev) => ({ ...prev, envSnapshot: env })))
            .catch(() => {});
        }
        if (s.vault_ids?.length) {
          Promise.all(
            s.vault_ids.map((vid) =>
              api<{ id: string; display_name?: string }>(`/v1/vaults/${vid}`)
                .then((v) => ({ id: v.id, display_name: v.display_name }))
                .catch(() => ({ id: vid })),
            ),
          ).then((vaults) => setSessionMeta((prev) => ({ ...prev, vaults })));
        }
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
    // Paginate ASC from seq 0 in pages of 200 — long sessions stream older
    // events progressively rather than blocking the UI on a single 1000-row
    // payload (the legacy `limit=1000` would also silently truncate at the
    // hard ceiling for ultra-long histories). Each page is added as it
    // arrives, so the timeline starts populating after the first roundtrip.
    void (async () => {
      let afterSeq = 0;
      const pageLimit = 200;
      // Bound the loop so a malformed `next_page` never spins forever.
      // Even at 200/page this covers 100k events, well past anything the
      // sandbox SQL store retains in practice.
      for (let i = 0; i < 500; i++) {
        try {
          const res = await api<{
            data: Array<{ seq?: number; type: string; ts?: string; data: Event }>;
            has_more?: boolean;
            next_page?: string | null;
          }>(`/v1/sessions/${id}/events?limit=${pageLimit}&order=asc&after_seq=${afterSeq}`);
          for (const e of res.data) {
            const inner = e.data || (e as unknown as Event);
            if (e.ts && !inner.ts) inner.ts = e.ts;
            if (e.seq !== undefined && inner.seq === undefined) inner.seq = e.seq;
            addEvent(inner);
          }
          if (!res.has_more || !res.next_page) break;
          // next_page is "seq_<n>" per session-do.ts:1568.
          const m = /^seq_(\d+)$/.exec(res.next_page);
          if (!m) break;
          const nextAfter = parseInt(m[1], 10);
          if (!Number.isFinite(nextAfter) || nextAfter <= afterSeq) break;
          afterSeq = nextAfter;
        } catch {
          break;
        }
      }
    })();

    // Connect SSE
    const abort = new AbortController();
    abortRef.current = abort;
    streamEvents(id, addEvent, abort.signal);

    // Lazy-fetch the Trajectory envelope so the header chips have the
    // outcome + reward to show. Decoupled from session/events fetches —
    // trajectory builds on-demand off the events log, so a 5xx here is
    // independent of session metadata loading. We do this once per
    // session id and let the user reopen the page to refresh. Live
    // sessions intentionally don't poll: trajectory.outcome === "running"
    // is fine, the StatusPill already shows the live status.
    setTrajectory("loading");
    api<Trajectory>(`/v1/sessions/${id}/trajectory`)
      .then((t) => setTrajectory(t))
      .catch(() => setTrajectory("error"));

    // Threads list (primary + sub-agent). Primary is always present
    // (seeded by SessionDO on /init). Filter to non-primary so the
    // selector only renders when there's something to switch between
    // — single-thread sessions get zero UI clutter.
    api<{
      data: Array<{ id: string; agent_name?: string; parent_thread_id?: string | null }>;
    }>(`/v1/sessions/${id}/threads`)
      .then((res) => {
        const subThreads = (res.data ?? []).filter((t) => t.id !== "sthr_primary");
        setThreads(subThreads);
      })
      .catch(() => setThreads([]));

    // Initial pending queue snapshot. The SSE bridge picks up live
    // changes from system.user_message_{pending,promoted,cancelled}
    // frames; this fetch seeds the map so a page-reload during an
    // in-flight queue still shows the outbox correctly. Best-effort —
    // a 404/5xx leaves pendingByEventId empty (the SSE will repopulate
    // when the next pending event lands).
    api<{
      data: Array<{
        pending_seq: number;
        enqueued_at: number;
        type: string;
        event_id: string;
        session_thread_id: string;
        cancelled_at: number | null;
        data: Event;
      }>;
    }>(`/v1/sessions/${id}/pending`)
      .then((res) => {
        const next = new Map<string, PendingEntry>();
        for (const r of res.data ?? []) {
          if (!r.event_id) continue;
          next.set(r.event_id, {
            event_id: r.event_id,
            pending_seq: r.pending_seq,
            enqueued_at: r.enqueued_at,
            session_thread_id: r.session_thread_id,
            event: r.data,
          });
        }
        if (next.size > 0) setPendingByEventId(next);
      })
      .catch(() => {/* leave empty */});

    return () => { abort.abort(); };
  }, [id]);

  const send = async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || !id) return;
    setInput("");
    setLocalPending(text);
    setSending(true);
    try {
      await api(`/v1/sessions/${id}/events`, {
        method: "POST",
        body: JSON.stringify({
          events: [{ type: "user.message", content: [{ type: "text", text }] }],
        }),
      });
      // POST resolved → server already inserted the row + broadcast
      // system.user_message_pending. The outbox map will pick it up
      // (and likely already has by the time await unblocks here).
      // Clear our local slot so we don't double-render with the server
      // entry — but only if the server's pending hasn't already cleared
      // it via the system.user_message_pending handler.
      setLocalPending((cur) => (cur === text ? null : cur));
    } catch {
      // api() already toasted the error; clear the optimistic slot so
      // the user doesn't keep seeing a "stuck" pending row that will
      // never actually run.
      setLocalPending(null);
    }
    setSending(false);
  };

  // Stop button — posts user.interrupt to abort whatever turn(s) are
  // running on the active thread. Server-side this triggers the
  // thread-scoped AbortController, marks pending events cancelled, and
  // emits status_idle. Recovery path for the "stuck Running" failure
  // mode where a DO eviction killed an in-flight stream and no clean
  // status_idle was ever broadcast.
  const [interrupting, setInterrupting] = useState(false);
  const interrupt = async () => {
    if (!id) return;
    setInterrupting(true);
    try {
      await api(`/v1/sessions/${id}/events`, {
        method: "POST",
        body: JSON.stringify({
          events: [{
            type: "user.interrupt",
            ...(activeThreadId !== "sthr_primary" ? { session_thread_id: activeThreadId } : {}),
          }],
        }),
      });
    } catch (e) {
      console.error("interrupt failed", e);
    }
    setInterrupting(false);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 sm:px-8 py-3 border-b border-border flex flex-col gap-2 shrink-0">
        <div className="flex items-center gap-3">
          <Link to="/sessions" className="text-fg-subtle hover:text-fg-muted text-sm">&larr; Sessions</Link>
          <span className="text-fg-subtle">/</span>
          <h1 className="font-mono text-sm text-fg-muted truncate flex-1" title={id}>{title}</h1>
          {/* Stop / Interrupt — only while the session is actively running.
              Posts user.interrupt scoped to the active thread; server fires
              thread AbortController + flushes pending events + emits
              status_idle. Recovery path for stuck-Running sessions where a
              DO eviction killed the stream and no clean status_idle ever
              landed. */}
          {status === "running" && (
            <button
              onClick={() => void interrupt()}
              disabled={interrupting}
              className="inline-flex items-center justify-center px-2.5 py-1 min-h-11 sm:min-h-0 rounded-md text-xs font-medium border border-border bg-bg-surface text-fg-muted hover:text-fg hover:border-border-strong disabled:opacity-50 transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
              title="Interrupt the active turn on this thread"
            >
              {interrupting ? "Stopping…" : "Stop"}
            </button>
          )}
          <button
            onClick={() => setShowFiles((v) => !v)}
            className={`inline-flex items-center justify-center px-2.5 py-1 min-h-11 sm:min-h-0 rounded-md text-xs font-medium border transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
              showFiles
                ? "bg-bg-surface text-fg border-border-strong"
                : "bg-bg-surface text-fg-muted border-border hover:text-fg hover:border-border-strong"
            }`}
            title="Files the agent wrote to /mnt/session/outputs/"
          >
            Files
          </button>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <StatusPill status={status as "idle" | "running" | "terminated" | "error" | string} />
          {/* Trajectory outcome chip — only when the trajectory has actually
              finished. While the session is still running we let StatusPill
              carry the "Running…" signal alone (per Phase 3 spec) instead of
              double-pilling. */}
          <TrajectoryOutcomeChip trajectory={trajectory} />
          {/* Reward chip — final_reward + verifier_id tooltip. Hidden when
              the verifier hasn't run (no trajectory.reward) so we don't
              imply "no reward = score 0". */}
          <TrajectoryRewardChip trajectory={trajectory} />
          {/* Always render env + agent + vault badges so an operator can
              see what makes up this session at a glance. Name falls back
              to a short ID slice if the snapshot didn't carry one — better
              "agent_…XYZ" than nothing. */}
          {(sessionMeta.agentSnapshot?.id || agentId) && (
            <Badge
              icon={<AgentIcon />}
              label={sessionMeta.agentSnapshot?.name || shortenId(sessionMeta.agentSnapshot?.id || agentId)}
              onClick={() =>
                setResourcePanel({ kind: "agent", id: sessionMeta.agentSnapshot?.id || agentId })
              }
            />
          )}
          {sessionMeta.environmentId && (
            <Badge
              icon={<EnvIcon />}
              label={sessionMeta.envSnapshot?.name || shortenId(sessionMeta.environmentId)}
              onClick={() =>
                setResourcePanel({ kind: "environment", id: sessionMeta.environmentId! })
              }
            />
          )}
          {(sessionMeta.vaults ?? sessionMeta.vaultIds?.map((id) => ({ id, display_name: undefined })) ?? []).map((v) => (
            <Badge
              key={v.id}
              icon={<VaultIcon />}
              label={v.display_name || shortenId(v.id)}
              onClick={() => setResourcePanel({ kind: "vault", id: v.id })}
            />
          ))}
          <SessionDurationBadge events={events} />
          {sessionMeta.createdAt && <RelativeTimeBadge iso={sessionMeta.createdAt} />}
        </div>
      </div>

      {/* Thread selector — only when sub-agent threads exist. Primary
          is implicit at index 0 ("Main"); sub-agent tabs appear as new
          threads spawn (live-updated by session.thread_created handler).
          Selecting a thread filters both Conversation and Timeline views.
          Renders as a depth-indented tree when sub-agents themselves
          spawn sub-workers — flat horizontal row for the common case
          (single layer of workers under primary). */}
      {threads.length > 0 && (
        <ThreadTree
          threads={threads}
          activeThreadId={activeThreadId}
          onSelect={setActiveThreadId}
        />
      )}

      {/* View tabs */}
      <div role="tablist" aria-label="Session view" className="px-4 sm:px-8 border-b border-border flex items-center gap-1 shrink-0">
        <ViewTab label="Conversation" active={view === "chat"} onClick={() => setView("chat")} />
        <ViewTab label="Timeline" active={view === "timeline"} onClick={() => setView("timeline")} />
        {view === "timeline" && (
          <span className="ml-auto text-xs text-fg-subtle font-mono">{events.length} events</span>
        )}
        {/* Trajectory viewer trigger — pushed to the right edge of the tab
            row. Disabled until the lazy fetch resolves so the click never
            opens an empty modal. Errors keep the button enabled (the modal
            shows the error). */}
        <button
          onClick={() => setShowTrajectory(true)}
          disabled={trajectory === undefined || trajectory === "loading"}
          className={`${view === "timeline" ? "ml-3" : "ml-auto"} inline-flex items-center min-h-11 sm:min-h-0 text-xs text-fg-muted hover:text-fg disabled:opacity-40 disabled:cursor-not-allowed border border-border hover:border-border-strong rounded px-2 py-1 transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] my-1.5`}
          title={
            trajectory === "loading"
              ? "Loading trajectory…"
              : trajectory === "error"
              ? "Trajectory unavailable — click to inspect error"
              : "View raw Trajectory v1 envelope"
          }
        >
          Trajectory
        </button>
      </div>

      {/* Linear context (when triggered by a Linear webhook) */}
      {linear && (
        <div className="px-4 sm:px-8 py-2 border-b border-border bg-info-subtle text-xs flex items-center gap-2 text-info">
          <span>🔗</span>
          <span className="font-medium">Linear</span>
          <span className="opacity-60">·</span>
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
        <div className="px-4 sm:px-8 py-2 border-b border-border bg-accent-violet-subtle text-xs flex items-center gap-2 text-accent-violet">
          <span>💬</span>
          <span className="font-medium">Slack</span>
          <span className="opacity-60">·</span>
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
            <span className="opacity-60 font-mono uppercase tracking-wider text-[10px]">
              {slack.eventKind}
            </span>
          )}
        </div>
      )}

      {/* Filter by selected thread. Untagged events (legacy + spans
          that haven't been thread-stamped yet) are treated as primary —
          matches the bridge filter in handleSSEStream. */}
      {(() => null)()}
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 flex flex-col min-w-0">
      {view === "chat" ? (
        <>
          {/* Conversation surface. ai-elements <Conversation> wraps
              StickToBottom, which auto-pins to the latest message while
              the user is at the bottom and surfaces a "jump to latest"
              affordance via <ConversationScrollButton> the moment they
              scroll up — replaces the hand-rolled scrollTo effect.

              Render order intentionally mirrors the pre-migration layout:
                1) canonical events (filtered to the active thread)
                2) optimistic outbox slot (instant feedback on Send)
                3) server-mirrored pending outbox (queued user.* events)
                4) in-flight thinking streams
                5) in-flight tool-input streams
                6) in-flight assistant text streams
                7) typing dots when only the agent is "thinking" with
                   nothing else streaming yet */}
          <Conversation className="flex-1 min-h-0">
            <ConversationContent className="px-4 sm:px-8 py-6 gap-4">
              {(() => {
                // Server-returned events are now in canonical drain order
                // (events.seq = INSERT order = what the model saw). The
                // pre-3a3e7ec client-side sort by processed_at_ms is
                // retired; pending events live in a separate outbox below
                // and never mix into this seq-ordered timeline.
                const filtered = events.filter((e) => {
                  const tid = (e as { session_thread_id?: string }).session_thread_id ?? "sthr_primary";
                  return tid === activeThreadId;
                });
                // Pre-pair tool_use ↔ result events. Three flavors per the
                // wire spec emitted in default-loop.ts:emitToolCallEvent /
                // emitToolResultEvent:
                //   • builtin tools  → agent.tool_use         + agent.tool_result        (key: tool_use_id)
                //   • custom tools   → agent.custom_tool_use  + agent.tool_result        (key: tool_use_id) ← same result type
                //   • MCP tools      → agent.mcp_tool_use     + agent.mcp_tool_result    (key: mcp_tool_use_id)
                // The previous pairing only covered builtin → custom tools
                // (e.g. general_subagent) showed their result as an "unpaired"
                // orphan block because the use side was custom_tool_use.
                const resultByToolUseId = new Map<string, typeof filtered[number]>();
                for (const ev of filtered) {
                  if (ev.type === "agent.tool_result") {
                    const id = (ev as { tool_use_id?: string }).tool_use_id;
                    if (id) resultByToolUseId.set(id, ev);
                  } else if (ev.type === "agent.mcp_tool_result") {
                    const id = (ev as { mcp_tool_use_id?: string }).mcp_tool_use_id;
                    if (id) resultByToolUseId.set(id, ev);
                  }
                }
                const pairedResultIds = new Set<string>();
                return filtered.map((e, i) => {
                  // Stable React key — `e.id` (sevt_*) lives on every event
                  // server-side via the stamp callback in session-do.ts, so
                  // SSE-arrived rows already have it. Fall back to seq for
                  // legacy events that pre-date the stamp, and to a synthetic
                  // marker (type + index) as last resort. Index alone broke
                  // because new events appended mid-list re-keyed every later
                  // bubble → React unmount/remount → the entire conversation
                  // appeared to flicker on every chunk delivery.
                  const stableKey =
                    (e as { id?: string }).id
                    ?? (e as { seq?: number }).seq
                    ?? `idx-${e.type}-${i}`;
                  // Tool-result that's been folded into its use card —
                  // skip standalone render. Both wire shapes: agent.tool_result
                  // (covers builtin + custom) keys on tool_use_id;
                  // agent.mcp_tool_result keys on mcp_tool_use_id.
                  if (e.type === "agent.tool_result") {
                    const tuid = (e as { tool_use_id?: string }).tool_use_id;
                    if (tuid && pairedResultIds.has(tuid)) return null;
                  }
                  if (e.type === "agent.mcp_tool_result") {
                    const tuid = (e as { mcp_tool_use_id?: string }).mcp_tool_use_id;
                    if (tuid && pairedResultIds.has(tuid)) return null;
                  }
                  // Tool-use of any flavor: pair with its result if present,
                  // render as one card. All three use-types carry the
                  // call id on EventBase.id (overrides the inherited field
                  // per emitToolCallEvent), so the lookup is uniform.
                  let pairedResult: typeof filtered[number] | undefined;
                  if (
                    e.type === "agent.tool_use"
                    || e.type === "agent.custom_tool_use"
                    || e.type === "agent.mcp_tool_use"
                  ) {
                    const tuid = (e as { id?: string }).id;
                    if (tuid && resultByToolUseId.has(tuid)) {
                      pairedResult = resultByToolUseId.get(tuid);
                      pairedResultIds.add(tuid);
                    }
                  }
                  return (
                    <EventRender
                      key={stableKey}
                      event={e}
                      livePending={false}
                      pairedResult={pairedResult}
                    />
                  );
                });
              })()}
              {/* Optimistic outbox slot — what the user just typed before
                  the server's system.user_message_pending broadcast lands.
                  Rendered above the server-mirrored outbox so the typed
                  text appears INSTANTLY (no 100-500ms void after Send).
                  Cleared by the SSE handler the moment the server picks it
                  up; rendered with the same hourglass treatment as the
                  server-side rows so the UI is visually consistent. */}
              {localPending && activeThreadId === "sthr_primary" && (
                <EventRender
                  key="local-pending"
                  event={{ type: "user.message", content: [{ type: "text", text: localPending }] } as Event}
                  livePending={true}
                />
              )}
              {/* Pending outbox — server-mirrored queue rows that haven't
                  been drained yet. Keyed by event_id; rendered below the
                  timeline, never inline. The hourglass treatment is the
                  visual tell ("queued, not yet ingested by the agent").
                  Filtered to the active thread. */}
              {(() => {
                const outbox = Array.from(pendingByEventId.values())
                  .filter((p) => p.session_thread_id === activeThreadId)
                  .sort((a, b) => a.pending_seq - b.pending_seq);
                return outbox.map((p) => (
                  <EventRender
                    key={`pending-${p.event_id}`}
                    event={p.event}
                    livePending={true}
                  />
                ));
              })()}
              {/* In-flight thinking streams. Render before message/tool
                  streams so the visual order roughly matches what the
                  LLM produced (Anthropic emits reasoning before text/tool).
                  <Reasoning isStreaming> auto-opens, shows a shimmering
                  "Thinking…" trigger, computes the duration when streaming
                  ends, and auto-collapses on completion. */}
              {Array.from(thinkingStreams.entries()).map(([tid, text]) => (
                <Reasoning key={`think-${tid}`} isStreaming defaultOpen>
                  <ReasoningTrigger />
                  <ReasoningContent>{text}</ReasoningContent>
                </Reasoning>
              ))}
              {/* In-flight tool inputs — partial JSON shown in a code box
                  inside a Tool card with state="input-streaming" ("Pending"
                  badge). Replaced by the canonical tool_use card the
                  moment the matching agent.tool_use lands. */}
              {Array.from(toolInputStreams.entries()).map(([tid, { name, partial }]) => (
                <Tool key={`tin-${tid}`} defaultOpen>
                  <ToolHeader
                    type="dynamic-tool"
                    toolName={name ?? "tool"}
                    state="input-streaming"
                  />
                  <ToolContent>
                    {partial && (
                      <div className="space-y-2 overflow-hidden">
                        <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                          Streaming input
                        </h4>
                        <div className="rounded-md bg-muted/50">
                          <CodeBlock code={partial} language="json" />
                        </div>
                      </div>
                    )}
                  </ToolContent>
                </Tool>
              ))}
              {/* In-flight assistant message text streams — rendered as a
                  regular assistant Message whose body grows as chunks
                  arrive. Cursor block keeps the "still writing" cue from
                  the old StreamingBubble. */}
              {Array.from(streams.entries()).map(([mid, text]) => (
                <Message key={`stream-${mid}`} from="assistant">
                  <MessageContent>
                    <Markdown>{text}</Markdown>
                    <span className="inline-block w-1.5 h-3.5 bg-fg-subtle/50 align-middle ml-0.5 animate-pulse" />
                  </MessageContent>
                </Message>
              ))}
              {/* Typing dots only when the agent is running and nothing
                  else is streaming — avoids duplicate activity indicators. */}
              {status === "running"
                && streams.size === 0
                && thinkingStreams.size === 0
                && toolInputStreams.size === 0 && (
                <div className="flex gap-1 py-2">
                  <span className="w-1.5 h-1.5 bg-fg-subtle rounded-full animate-pulse" style={{ animationDelay: "0ms" }} />
                  <span className="w-1.5 h-1.5 bg-fg-subtle rounded-full animate-pulse" style={{ animationDelay: "150ms" }} />
                  <span className="w-1.5 h-1.5 bg-fg-subtle rounded-full animate-pulse" style={{ animationDelay: "300ms" }} />
                </div>
              )}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>

          {/* Prompt input. ai-elements <PromptInput> wraps a <form> with
              an InputGroup-based textarea; we hand it our own onSubmit so
              the existing send() (POST /events) stays the source of truth.
              The textarea is uncontrolled — we read `text` from onSubmit
              and the form clears itself on resolve. Mirrors the local
              `input` state into the disabled-submit check so empty sends
              are blocked. */}
          <div className="px-4 sm:px-8 py-4 border-t border-border shrink-0">
            <PromptInput
              onSubmit={async ({ text }) => {
                // PromptInput captured the textarea's value into `text`
                // and already triggered form.reset() before this handler
                // runs. send() owns clearing the mirrored `input` state
                // and the optimistic outbox slot, so we just hand off.
                await send(text);
              }}
            >
              <PromptInputTextarea
                placeholder="Send a message..."
                disabled={sending}
                onChange={(e) => setInput(e.currentTarget.value)}
              />
              <PromptInputFooter>
                <PromptInputTools />
                <PromptInputSubmit
                  status={sending ? "submitted" : undefined}
                  disabled={sending || !input.trim()}
                />
              </PromptInputFooter>
            </PromptInput>
          </div>
        </>
      ) : (
        <TimelineView
          events={events.filter((e) => {
            const tid = (e as { session_thread_id?: string }).session_thread_id ?? "sthr_primary";
            return tid === activeThreadId;
          })}
        />
      )}
        </div>
        {resourcePanel && (
          <ResourcePanel
            panel={resourcePanel}
            onClose={() => setResourcePanel(null)}
          />
        )}
        {showFiles && id && (
          <FilesPanel sessionId={id} onClose={() => setShowFiles(false)} />
        )}
      </div>
      <TrajectoryViewerModal
        open={showTrajectory}
        onClose={() => setShowTrajectory(false)}
        sessionId={id ?? ""}
        trajectory={trajectory}
      />
    </div>
  );
}

/** Outcome chip rendered in the session header strip. Hidden while
 *  the trajectory is loading / errored / still running so we never
 *  paint an inaccurate state. The "running" outcome is intentionally
 *  squelched here — StatusPill already renders the live status. */
function TrajectoryOutcomeChip({
  trajectory,
}: {
  trajectory: Trajectory | "loading" | "error" | undefined;
}) {
  if (!trajectory || trajectory === "loading" || trajectory === "error") return null;
  if (trajectory.outcome === "running") return null;
  const tone = outcomeToStatusTone(trajectory.outcome);
  return (
    <StatusPill
      status={tone}
      label={`Outcome: ${trajectory.outcome}`}
    />
  );
}

/** Reward chip rendered in the session header strip. Pure read-out of
 *  the verifier output; tooltip shows verifier_id for debugging. */
function TrajectoryRewardChip({
  trajectory,
}: {
  trajectory: Trajectory | "loading" | "error" | undefined;
}) {
  if (!trajectory || trajectory === "loading" || trajectory === "error") return null;
  const r = trajectory.reward;
  if (!r) return null;
  const headline = rewardHeadline(r);
  const isPass = r.final_reward >= 0.99;
  const isFail = r.final_reward <= 0;
  // Reuse StatusPill tone tokens so the visual language stays consistent
  // with the outcome chip next to it (success = same green, failure = red).
  const tone = isPass ? "completed" : isFail ? "errored" : "neutral";
  const titleParts = [
    `Reward: ${r.final_reward.toFixed(4)}`,
    r.verifier_id ? `verifier: ${r.verifier_id}` : null,
    r.computed_at ? `computed: ${new Date(r.computed_at).toLocaleString()}` : null,
  ].filter(Boolean) as string[];
  return (
    <span title={titleParts.join(" · ")}>
      <StatusPill status={tone} label={`Reward: ${headline}`} />
    </span>
  );
}

/** Trajectory viewer modal — Phase 3 minimum-viable: pretty-printed
 *  JSON with a Download button. Anthropic Messages / Inspect AI / OTel
 *  projections are Phase 4. The download uses an in-memory blob URL
 *  so we don't have to round-trip to a server endpoint. */
function TrajectoryViewerModal({
  open,
  onClose,
  sessionId,
  trajectory,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  trajectory: Trajectory | "loading" | "error" | undefined;
}) {
  const ready = trajectory && trajectory !== "loading" && trajectory !== "error";
  const json = ready ? JSON.stringify(trajectory, null, 2) : "";

  function download() {
    if (!ready) return;
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `trajectory-${sessionId}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Trajectory"
      subtitle={ready ? `${trajectory.trajectory_id} · session ${sessionId}` : `session ${sessionId}`}
      maxWidth="max-w-4xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button onClick={download} disabled={!ready}>Download JSON</Button>
        </>
      }
    >
      {trajectory === "loading" && (
        <div className="text-sm text-fg-subtle">Loading trajectory…</div>
      )}
      {trajectory === "error" && (
        <div className="text-sm text-danger">
          Trajectory unavailable. The session may not have any events yet, or the
          sandbox worker is unreachable. Retry by reloading the page.
        </div>
      )}
      {trajectory === undefined && (
        <div className="text-sm text-fg-subtle">No trajectory loaded yet.</div>
      )}
      {ready && (
        <pre className="font-mono text-[11px] bg-bg-surface border border-border rounded px-3 py-2 overflow-auto max-h-[60vh] text-fg whitespace-pre">
          {json}
        </pre>
      )}
    </Modal>
  );
}

function ViewTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      className={`inline-flex items-center justify-center px-3 py-2.5 min-h-11 sm:min-h-0 text-sm border-b-2 transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
        active
          ? "border-brand text-fg font-medium"
          : "border-transparent text-fg-subtle hover:text-fg-muted"
      }`}
    >
      {label}
    </button>
  );
}

/** Tighter visual than ViewTab — sub-agent tabs typically need to fit
 *  more than the 2-3 view options. Smaller padding + horizontal scroll
 *  in the parent keeps long sub-agent rosters readable. */
function ThreadTab({
  label,
  active,
  onClick,
  depth = 0,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  depth?: number;
}) {
  return (
    <button
      onClick={onClick}
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      className={`py-1.5 min-h-11 sm:min-h-0 text-xs whitespace-nowrap border-b-2 transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] flex items-center gap-1 ${
        active
          ? "border-info text-fg font-medium"
          : "border-transparent text-fg-subtle hover:text-fg-muted"
      }`}
      style={{ paddingLeft: `${0.75 + depth * 0.75}rem`, paddingRight: "0.75rem" }}
    >
      {/* Tree branch glyph for depth>0 — visual cue that this thread
          was spawned by another (rather than being a sibling of Main).
          Plain text (not a unicode-only flair) so it survives in both
          dark and light themes without needing a separate icon. */}
      {depth > 0 && <span className="text-fg-subtle">└</span>}
      <span>{label}</span>
    </button>
  );
}

/**
 * Depth-indented thread tree. Root = sthr_primary (rendered as "Main");
 * children indented by parent_thread_id. DFS pre-order so the tree
 * reads top-to-bottom like a stack trace: parents above their children.
 *
 * Orphans (parent_thread_id pointing at a thread we don't know about
 * — possible mid-spawn race or stale snapshot) get re-parented to
 * sthr_primary so they stay visible instead of being hidden in a
 * dangling subtree.
 */
function ThreadTree({
  threads,
  activeThreadId,
  onSelect,
}: {
  threads: Array<{ id: string; agent_name?: string; parent_thread_id?: string | null }>;
  activeThreadId: string;
  onSelect: (id: string) => void;
}) {
  const knownIds = new Set<string>(["sthr_primary", ...threads.map((t) => t.id)]);
  const childrenOf = new Map<string, typeof threads>();
  for (const t of threads) {
    const parent =
      t.parent_thread_id && knownIds.has(t.parent_thread_id)
        ? t.parent_thread_id
        : "sthr_primary";
    const arr = childrenOf.get(parent) ?? [];
    arr.push(t);
    childrenOf.set(parent, arr);
  }
  const flat: Array<{ id: string; label: string; depth: number }> = [
    { id: "sthr_primary", label: "Main", depth: 0 },
  ];
  const walk = (parentId: string, depth: number) => {
    const kids = childrenOf.get(parentId) ?? [];
    for (const k of kids) {
      flat.push({ id: k.id, label: k.agent_name ?? k.id.slice(0, 12), depth });
      walk(k.id, depth + 1);
    }
  };
  walk("sthr_primary", 1);
  const maxDepth = flat.reduce((m, n) => Math.max(m, n.depth), 0);
  // When the tree is shallow (one layer of workers under Main), keep
  // the original horizontal row for zero visual change vs Phase 3.
  // Deeper trees switch to a vertical stacked layout so the indentation
  // is actually readable.
  const isFlat = maxDepth <= 1;
  const containerClass = isFlat
    ? "px-4 sm:px-8 border-b border-border flex items-center gap-1 shrink-0 overflow-x-auto"
    : "px-4 sm:px-8 py-1 border-b border-border flex flex-col items-stretch gap-0 shrink-0 overflow-y-auto max-h-40";
  return (
    <div role="tablist" aria-label="Threads" className={containerClass}>
      {flat.map((n) => (
        <ThreadTab
          key={n.id}
          label={n.label}
          depth={isFlat ? 0 : n.depth}
          active={activeThreadId === n.id}
          onClick={() => onSelect(n.id)}
        />
      ))}
    </div>
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
    <Badge
      icon={<DurationIcon />}
      label={formatDuration(last - first)}
      title="Wall-clock from first to last event"
    />
  );
}

function RelativeTimeBadge({ iso }: { iso: string }) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return (
    <Badge
      icon={<ClockIcon />}
      label={formatRelative(Date.now() - t)}
      title={new Date(iso).toLocaleString()}
    />
  );
}

function ResourcePanel({
  panel,
  onClose,
}: {
  panel: { kind: "agent" | "environment" | "vault"; id: string };
  onClose: () => void;
}) {
  // useApi returns { api, streamEvents } — destructure the call function
  // explicitly. A previous version assigned the whole object to `api` and
  // then called `api(url)`, which threw "api is not a function" and white-
  // screened the page on first badge click.
  const { api } = useApi();
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
          className="text-fg-subtle hover:text-fg-muted text-lg leading-none inline-flex items-center justify-center min-w-11 min-h-11 sm:min-w-8 sm:min-h-8 rounded hover:bg-bg-surface transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
          title="Close"
          aria-label="Close panel"
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

interface SessionOutputFile {
  filename: string;
  size_bytes: number;
  uploaded_at: string;
  media_type: string;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function FilesPanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { api } = useApi();
  const [files, setFiles] = useState<SessionOutputFile[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setFiles(null);
    setErr(null);
    api<{ data: SessionOutputFile[]; has_more: boolean }>(
      `/v1/sessions/${sessionId}/outputs`,
    )
      .then((d) => setFiles(d.data ?? []))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
    // api closure changes every render; sessionId is the only stable input
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  return (
    <aside className="w-[420px] shrink-0 border-l border-border bg-bg flex flex-col min-h-0">
      <div className="px-4 py-3 border-b border-border flex items-start gap-3 shrink-0">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wide text-fg-subtle font-mono">
            Files
          </div>
          <div className="text-base font-semibold text-fg">Session outputs</div>
          <div className="text-xs text-fg-muted mt-0.5">
            Files the agent wrote to <code className="font-mono">/mnt/session/outputs/</code>
          </div>
        </div>
        <button
          onClick={onClose}
          className="text-fg-subtle hover:text-fg-muted text-lg leading-none inline-flex items-center justify-center min-w-11 min-h-11 sm:min-w-8 sm:min-h-8 rounded hover:bg-bg-surface transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
          title="Close"
          aria-label="Close panel"
        >
          ×
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 text-xs">
        {err && <div className="text-danger">Failed to load: {err}</div>}
        {!files && !err && <div className="text-fg-subtle">Loading…</div>}
        {files && files.length === 0 && (
          <div className="text-fg-subtle">
            No files yet. The agent must write under <code className="font-mono">/mnt/session/outputs/</code> for files to appear here.
          </div>
        )}
        {files && files.length > 0 && (
          <ul className="space-y-1">
            {files.map((f) => (
              <li
                key={f.filename}
                className="flex items-center gap-3 py-2 border-b border-border/40 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <a
                    href={`/v1/sessions/${sessionId}/outputs/${encodeURIComponent(f.filename)}`}
                    download={f.filename}
                    className="font-mono text-fg hover:text-info truncate block"
                    title={f.filename}
                  >
                    {f.filename}
                  </a>
                  <div className="text-[10px] text-fg-subtle mt-0.5">
                    {formatBytes(f.size_bytes)} · {f.media_type} · {new Date(f.uploaded_at).toLocaleString()}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

/**
 * Renders a single canonical event using ai-elements primitives. Replaces
 * the pre-migration EventBubble + StreamingBubble + ThinkingStreamingBubble
 * + ToolInputStreamingBubble quartet — the in-flight streaming bubbles are
 * now inlined where they're consumed (using Reasoning isStreaming, Tool
 * input-streaming state, and an assistant Message with a cursor) so this
 * function only needs to handle the canonical event shapes.
 *
 * Type mapping:
 *   user.message              → <Message from="user|system">  (system for wakeups)
 *   agent.message             → <Message from="assistant"> + <Markdown>
 *   agent.thinking            → <Reasoning> + <ReasoningContent>
 *   agent.{tool_use,custom_tool_use,mcp_tool_use} → <Tool> + <ToolHeader> + <ToolInput> + <ToolOutput>
 *   agent.tool_result (orphan only, paired ones folded into use above)
 *                             → <Tool state="output-available"> with only ToolOutput
 *   session.error             → red alert div  (no ai-elements equivalent)
 *   session.warning           → amber alert div  (same)
 *   anything else             → null  (timeline-only events that shouldn't appear in chat)
 */
function EventRender({
  event,
  livePending = false,
  pairedResult,
}: {
  event: Event;
  /**
   * Caller-derived "no agent.* event has followed this user.* event
   * yet on the same thread" hint. The wire-level processed_at_ms
   * doesn't update live (no SSE re-broadcast on server UPDATE), so
   * we combine: pending iff (livePending AND wire-level says NULL)
   * OR (livePending true and we have no wire info yet). When livePending
   * is false we KNOW the agent has responded — drop the hourglass
   * regardless of wire state, otherwise the bubble would stay pending
   * for the entire turn even while the agent is mid-stream.
   */
  livePending?: boolean;
  /**
   * The matching `agent.tool_result` (or `agent.mcp_tool_result`) for
   * an `agent.tool_use` (or `custom_tool_use` / `mcp_tool_use`) event,
   * when present in the same filtered list. Caller pre-pairs by id and
   * suppresses the orphan tool_result render. Lets the Tool card show
   * input + output in one collapsible block instead of two disconnected
   * bubbles.
   */
  pairedResult?: Event;
}) {
  // AMA pending lifecycle (set by event-log adapter from row.processed_at /
  // row.cancelled_at). Cancelled events stay in the log for audit but
  // the LLM never sees them (eventsToMessages skips); show them with
  // strikethrough so operators know the user retracted them.
  const meta = event as { processed_at_ms?: number | null; cancelled_at_ms?: number | null };
  // The hourglass shows when BOTH conditions hold:
  //   1. Caller says no later non-user event has arrived (livePending)
  //   2. Wire-level processed_at_ms agrees (still null)
  // Either condition flipping → no longer pending.
  const isPending =
    livePending &&
    meta.processed_at_ms == null &&
    meta.cancelled_at_ms == null;
  const isCancelled = meta.cancelled_at_ms != null;

  switch (event.type) {
    case "user.message": {
      // Wakeups synthesized by the schedule tool's onScheduledWakeup callback
      // also wire-type as user.message (per EventBase metadata convention),
      // but the user did NOT send them — visually distinguish so operators
      // don't get confused. metadata.harness === "schedule" + kind === "wakeup"
      // is the contract: see apps/agent/src/runtime/session-do.ts:onScheduledWakeup.
      const metadata = (event as { metadata?: { harness?: string; kind?: string; scheduled_at?: string } }).metadata;
      const isWakeup = metadata?.harness === "schedule" && metadata?.kind === "wakeup";
      const text = Array.isArray(event.content) ? event.content[0]?.text ?? "" : "";

      if (isWakeup) {
        // System-origin: left-aligned via from="system" (Message only
        // applies its right-aligned brand bubble for from="user"; anything
        // else lays out as plain assistant text). Layered on top is a
        // small info chip identifying the wakeup + the scheduled time
        // tooltip for traceability.
        const scheduledAt = metadata?.scheduled_at;
        return (
          <Message from="system">
            <div className="flex items-center gap-1.5 text-xs text-fg-subtle mb-1">
              <span
                className="inline-flex items-center gap-1 rounded-full bg-info-subtle text-info px-2 py-0.5 font-medium text-[11px]"
                title={scheduledAt ? `Scheduled at ${scheduledAt}` : undefined}
              >
                <span aria-hidden>🕒</span>
                Scheduled wakeup
              </span>
            </div>
            <MessageContent className="border border-info/30 rounded-2xl rounded-bl-sm px-4 py-3 bg-bg-surface">
              {text}
            </MessageContent>
          </Message>
        );
      }

      // Cancelled: render strikethrough + muted so the audit trail is
      // visible without competing with live messages. Pending: dotted
      // border + hourglass label since drainEventQueue hasn't picked it
      // up yet. Live: default ai-elements user bubble (right-aligned,
      // bg-secondary which we've aliased to OMA's bg-surface).
      const cancelledOverride = "border border-border-strong line-through opacity-70";
      const pendingOverride = "border border-border-strong";
      return (
        <Message from="user">
          {(isPending || isCancelled) && (
            <div className="text-xs text-fg-subtle text-right flex items-center justify-end gap-1">
              {isPending && <span aria-hidden>⏳</span>}
              {isCancelled && <span aria-hidden>✗</span>}
              <span>{isCancelled ? "Retracted" : "Pending…"}</span>
            </div>
          )}
          <MessageContent
            className={isCancelled ? cancelledOverride : isPending ? pendingOverride : undefined}
          >
            {text}
          </MessageContent>
        </Message>
      );
    }

    case "agent.message": {
      const text = (Array.isArray(event.content) ? event.content : [])
        .map((b) => b.text)
        .join("");
      return (
        <Message from="assistant">
          <MessageContent>
            <Markdown>{text}</Markdown>
          </MessageContent>
        </Message>
      );
    }

    case "agent.thinking": {
      // Canonical reasoning block — keep it visible after streaming
      // finishes. <Reasoning> defaults closed unless isStreaming; we
      // pass defaultOpen={false} so committed thoughts don't push the
      // active conversation off-screen but stay one click away.
      const text = (event as { text?: string }).text ?? "";
      if (!text) return null;
      return (
        <Reasoning isStreaming={false} defaultOpen={false}>
          <ReasoningTrigger />
          <ReasoningContent>{text}</ReasoningContent>
        </Reasoning>
      );
    }

    case "agent.tool_use":
    case "agent.custom_tool_use":
    case "agent.mcp_tool_use": {
      // All three use-types share the same shape (id + name + input);
      // MCP additionally carries mcp_server_name which we append to
      // the title so operators can tell built-in vs MCP at a glance.
      const mcpServerName =
        event.type === "agent.mcp_tool_use"
          ? (event as { mcp_server_name?: string }).mcp_server_name
          : undefined;
      const baseName = event.name ?? "tool";
      const title = mcpServerName ? `${baseName} (mcp · ${mcpServerName})` : baseName;
      // Result text — Tool's <ToolOutput> takes the raw value and will
      // either CodeBlock-stringify an object or render a string in a
      // CodeBlock. We pre-stringify content arrays since they're an
      // OMA-specific shape, not a JSON-friendly object.
      const rawContent = pairedResult
        ? (pairedResult as { content?: unknown }).content
        : undefined;
      const output: unknown = rawContent === undefined
        ? undefined
        : typeof rawContent === "string"
          ? rawContent
          : JSON.stringify(rawContent, null, 2);
      // State maps to the Tool badge: input-available (Running) while
      // we have args but no result; output-available (Completed) once
      // the paired result lands. We don't surface output-error because
      // the OMA tool_result spec doesn't carry a failure flag.
      const state = pairedResult ? "output-available" : "input-available";
      return (
        <Tool>
          <ToolHeader type="dynamic-tool" toolName={title} state={state} />
          <ToolContent>
            <ToolInput input={event.input ?? {}} />
            <ToolOutput output={output} errorText={undefined} />
          </ToolContent>
        </Tool>
      );
    }

    case "agent.tool_result":
    case "agent.mcp_tool_result": {
      // Orphan tool_result — caller couldn't pair it with a tool_use
      // (race / out-of-order delivery, or recovery-injected placeholder).
      // Render a degenerate Tool with output-only so the visual is still
      // a "tool" card (matching the rest of the timeline) but the header
      // signals it stands alone.
      const rawContent = (event as { content?: unknown }).content;
      const output: unknown = rawContent === undefined
        ? undefined
        : typeof rawContent === "string"
          ? rawContent
          : JSON.stringify(rawContent, null, 2);
      return (
        <Tool>
          <ToolHeader
            type="dynamic-tool"
            toolName="tool result (unpaired)"
            state="output-available"
          />
          <ToolContent>
            <ToolOutput output={output} errorText={undefined} />
          </ToolContent>
        </Tool>
      );
    }

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


