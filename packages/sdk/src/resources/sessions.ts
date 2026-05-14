import type { Client } from "../client.js";
import { parseSSE } from "../sse.js";
import type {
  ContentBlock,
  PaginatedResponse,
  SessionEvent,
  SessionSummary,
  StoredEvent,
} from "../types.js";

export interface CreateSessionInput {
  agent: string;
  environment_id: string;
  title?: string;
  vault_ids?: string[];
  resources?: unknown[];
}

export interface ListSessionsOptions {
  agent_id?: string;
  status?: "idle" | "running" | "error";
  limit?: number;
  cursor?: string;
}

export interface ChatOptions {
  signal?: AbortSignal;
}

export interface ChatCompleteOptions extends ChatOptions {
  /** Called once per chunk event so callers can render incrementally
   *  without iterating the full stream themselves. Receives the same
   *  delta strings the server emitted. */
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
}

/** Aggregated result of a `chatComplete()` call — the assembled
 *  assistant text + every thinking block + every tool call/result
 *  that landed during the turn. Useful when you don't need
 *  token-level rendering but want a structured turn summary. */
export interface ChatCompleteResult {
  text: string;
  thinking: string[];
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  toolResults: Array<{ tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }>;
  events: SessionEvent[];
}

export interface TailOptions {
  signal?: AbortSignal;
  /** Resume from a specific seq (server-side). Sent as `Last-Event-ID`
   *  per the SSE-native resume contract; presence of this option causes
   *  history > seq to replay before live events stream in, regardless of
   *  the `replay` flag below. */
  after_seq?: number;
  /** Comma-list of OMA extension buckets to admit. Default `["chunks"]`
   *  preserves the SDK's historical behavior (token-level chunks +
   *  session.warning + system.user_message_* etc.) so existing callers
   *  keep getting everything they used to. Pass `[]` for strict
   *  Anthropic-spec event types only. */
  include?: string[];
  /** Replay full persisted history before tailing. Default `true` to
   *  preserve historical SDK behavior (the server-side default is the
   *  opposite — Anthropic-spec-aligned no-replay). Pass `false` to
   *  match Anthropic's open-then-list-then-dedupe pattern. */
  replay?: boolean;
}

export interface ListEventsOptions {
  limit?: number;
  order?: "asc" | "desc";
  after_seq?: number;
}

/**
 * `oma.sessions` — create, list, drive, and read sessions.
 *
 *     for await (const ev of oma.sessions.chat(id, "Hello")) {
 *       if (ev.type === "agent.message_chunk") process.stdout.write(ev.delta);
 *     }
 *
 *     const reply = await oma.sessions.chatComplete(id, "Hello");
 *     console.log(reply.text);
 *
 *     for await (const ev of oma.sessions.tail(id)) { ... }   // never closes
 */
export class SessionsResource {
  constructor(private readonly client: Client) {}

  async list(opts: ListSessionsOptions = {}): Promise<PaginatedResponse<SessionSummary>> {
    return this.client.request<PaginatedResponse<SessionSummary>>(
      "GET",
      "/v1/sessions",
      { query: opts as Record<string, string | number | boolean | undefined> },
    );
  }

  async get(sessionId: string): Promise<SessionSummary> {
    return this.client.request<SessionSummary>("GET", `/v1/sessions/${sessionId}`);
  }

  async create(input: CreateSessionInput): Promise<SessionSummary> {
    return this.client.request<SessionSummary>("POST", "/v1/sessions", { body: input });
  }

  async archive(sessionId: string): Promise<void> {
    await this.client.request("POST", `/v1/sessions/${sessionId}/archive`);
  }

  async delete(sessionId: string): Promise<void> {
    await this.client.request("DELETE", `/v1/sessions/${sessionId}`);
  }

  /** Paginated JSON event log. Use `chat` / `tail` for live streams. */
  async events(sessionId: string, opts: ListEventsOptions = {}): Promise<PaginatedResponse<StoredEvent>> {
    return this.client.request<PaginatedResponse<StoredEvent>>(
      "GET",
      `/v1/sessions/${sessionId}/events`,
      { query: { limit: opts.limit ?? 100, order: opts.order ?? "asc", after_seq: opts.after_seq } },
    );
  }

  /**
   * Fire-and-forget user message. The server returns 202; subscribe
   * separately via `tail()` if you want the response. Use `chat()` for
   * the common "post + stream the reply in one call" pattern.
   */
  async message(sessionId: string, content: string | ContentBlock[]): Promise<void> {
    const blocks: ContentBlock[] = typeof content === "string"
      ? [{ type: "text", text: content }]
      : content;
    await this.client.request("POST", `/v1/sessions/${sessionId}/events`, {
      body: { events: [{ type: "user.message", content: blocks }] },
    });
  }

  /**
   * Chatbot one-shot: post a user turn AND stream the response in one
   * HTTP call. The async iterator yields every event of THIS turn —
   * lifecycle events (status_running / status_idle), live chunks
   * (agent.message_chunk / agent.thinking_chunk / agent.tool_use_input_chunk),
   * canonical events (agent.message / agent.thinking / agent.tool_use),
   * tool results, and any session.warning. Iteration ends when the
   * server closes the stream (on the first session.status_idle).
   *
   * Discriminated union: switch on `event.type` for type-safe access
   * to fields like `event.delta` (chunks) or `event.content`
   * (canonical message).
   */
  async *chat(
    sessionId: string,
    content: string | ContentBlock[],
    opts: ChatOptions = {},
  ): AsyncIterable<SessionEvent> {
    const blocks: ContentBlock[] = typeof content === "string"
      ? [{ type: "text", text: content }]
      : content;
    const res = await this.client.raw("POST", `/v1/sessions/${sessionId}/messages`, {
      body: JSON.stringify({ content: blocks }),
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      signal: opts.signal,
    });
    yield* parseSSE<SessionEvent>(res, opts.signal);
  }

  /**
   * Convenience over `chat()` — accumulates the stream into a
   * structured summary. Calls `onText` / `onThinking` per chunk if
   * provided (useful for incremental rendering without writing the
   * iterator boilerplate). Resolves when the turn finishes.
   */
  async chatComplete(
    sessionId: string,
    content: string | ContentBlock[],
    opts: ChatCompleteOptions = {},
  ): Promise<ChatCompleteResult> {
    const result: ChatCompleteResult = {
      text: "",
      thinking: [],
      toolCalls: [],
      toolResults: [],
      events: [],
    };
    let activeThinking = "";
    for await (const ev of this.chat(sessionId, content, { signal: opts.signal })) {
      result.events.push(ev);
      switch (ev.type) {
        case "agent.message_chunk":
          result.text += ev.delta;
          opts.onText?.(ev.delta);
          break;
        case "agent.thinking_chunk":
          activeThinking += ev.delta;
          opts.onThinking?.(ev.delta);
          break;
        case "agent.thinking":
          if (activeThinking) {
            result.thinking.push(activeThinking);
            activeThinking = "";
          } else if (ev.text) {
            result.thinking.push(ev.text);
          }
          break;
        case "agent.message": {
          // Canonical text replaces any partial we accumulated for this id.
          const txt = ev.content
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join("");
          if (txt) result.text = txt;
          break;
        }
        case "agent.tool_use":
        case "agent.mcp_tool_use":
        case "agent.custom_tool_use":
          result.toolCalls.push({ id: ev.id, name: ev.name, input: ev.input });
          break;
        case "agent.tool_result":
          result.toolResults.push({ tool_use_id: ev.tool_use_id, content: ev.content, is_error: ev.is_error });
          break;
        case "agent.mcp_tool_result":
          result.toolResults.push({ tool_use_id: ev.mcp_tool_use_id, content: ev.content, is_error: ev.is_error });
          break;
      }
    }
    return result;
  }

  /**
   * Long-lived event tail. Yields every event the platform broadcasts
   * for this session — past (replayed on connect from the persisted
   * log) and future (live). Never closes on its own; pass an
   * AbortSignal or `break` out of the loop to stop.
   *
   * Defaults preserve historical SDK behavior (`include: ["chunks"]`,
   * `replay: true`) so the OMA-extension chunk events that
   * `chatComplete` and similar consumers depend on keep landing. The
   * server-side default is stricter (Anthropic-spec, no replay, spec
   * event types only) — pass `{ include: [], replay: false }` for that.
   */
  async *tail(sessionId: string, opts: TailOptions = {}): AsyncIterable<SessionEvent> {
    const include = opts.include ?? ["chunks"];
    const replay = opts.replay ?? true;
    const query: Record<string, string | number | boolean | undefined> = {};
    if (include.length > 0) query.include = include.join(",");
    if (replay) query.replay = 1;
    // `after_seq` rides as Last-Event-ID — SSE-native resume contract.
    // Server treats Last-Event-ID presence as implicit replay-from-seq.
    const headers: Record<string, string> = { accept: "text/event-stream" };
    if (opts.after_seq !== undefined) {
      headers["Last-Event-ID"] = String(opts.after_seq);
    }
    const res = await this.client.raw("GET", `/v1/sessions/${sessionId}/events/stream`, {
      headers,
      query: Object.keys(query).length > 0 ? query : undefined,
      signal: opts.signal,
    });
    yield* parseSSE<SessionEvent>(res, opts.signal);
  }

  /** Send `user.interrupt` to abort the running harness loop. */
  async interrupt(sessionId: string): Promise<void> {
    await this.client.request("POST", `/v1/sessions/${sessionId}/events`, {
      body: { events: [{ type: "user.interrupt" }] },
    });
  }
}
