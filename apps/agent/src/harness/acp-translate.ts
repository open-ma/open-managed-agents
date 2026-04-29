/**
 * Translate ACP `sessionUpdate` notifications into OMA `SessionEvent`s.
 *
 * ACP streams agent_message_chunk / agent_thought_chunk per token, with no
 * explicit "message done" marker — the message is implicitly closed when a
 * different sessionUpdate type arrives, or the turn completes (`session.complete`
 * from the daemon side). This translator owns that boundary detection: it
 * accumulates chunks per (kind, session) and flushes on transition.
 *
 * Output contract — for each closed message:
 *   - `agent.message_chunk` for every delta during streaming (broadcast-only,
 *     not persisted to events log)
 *   - `agent.message_stream_start` once at first chunk
 *   - `agent.message` once with the final concatenated text (this IS persisted)
 *   - `agent.message_stream_end` once when the message closes
 * For thinking, same shape with `agent.thinking_*` events.
 *
 * Tool calls (sessionUpdate "tool_call" / "tool_call_update") become OMA
 * `agent.tool_use` + `agent.tool_result`. The ACP child runs the tool itself
 * (claude-code-acp ships its own bash/edit/read), so OMA never executes —
 * we only mirror the trace for replay/audit.
 *
 * Why tool_call frames are buffered: Claude Code's ACP child sends multiple
 * `tool_call` notifications for the same `toolCallId` — first a skeleton with
 * `title=<kind>` and `rawInput={}`, then a filled-in update with the real
 * command and arguments. ACP also exposes `tool_call_update` with non-terminal
 * status as the canonical "we know more now" channel. Eagerly emitting on
 * every tool_call produced N duplicate `agent.tool_use` events per actual
 * invocation, the first of which only had the skeleton (useless to render).
 *
 * Fix: defer the agent.tool_use emission until either
 *   1. a `tool_call_update` with terminal status arrives — flush, then emit
 *      tool_result (gives us the richest input data we'll ever see),
 *   2. another sessionUpdate that breaks the tool's "scope" arrives (text
 *      chunk, thinking chunk, a different tool_call_id, turn end) — flush
 *      with whatever data we've accumulated.
 * Result: exactly one agent.tool_use per actual invocation, carrying the
 * filled-in input rather than the empty skeleton. Subsequent duplicate
 * `tool_call` notifications for an already-flushed id are suppressed via
 * `#emittedToolUses`.
 */

import { generateEventId } from "@open-managed-agents/shared";
import type { HarnessRuntime } from "./interface";

interface AcpSessionUpdate {
  sessionUpdate: string;
  // ContentChunk shape
  content?: { type?: string; text?: string };
  // ToolCall / ToolCallUpdate shape
  toolCallId?: string;
  title?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  status?: string;
  kind?: string;
}

/** Wire shape of an ACP `session/update` notification. The agent SDK
 *  yields these to the Client.sessionUpdate callback as
 *  `{ sessionId, update: { sessionUpdate, ... } }` — the actual update
 *  payload is nested one level under `update`. */
interface AcpNotification {
  sessionId?: string;
  update?: AcpSessionUpdate;
}

interface AcpEvent {
  type?: string;
  // session.event wrapper
  event?: AcpNotification;
  // session.error / session.complete carry these
  message?: string;
}

/**
 * Per-turn streaming-translator. One instance per call to `harness.run`.
 * Holds the accumulating message id + buffer for the in-flight ACP message
 * or thinking block. Call `consume(event)` on every daemon-relayed message,
 * `flush()` at turn end to emit any trailing messages still open.
 */
export class AcpTranslator {
  #runtime: HarnessRuntime;
  #activeMessage: { id: string; text: string } | null = null;
  #activeThinking: { id: string; text: string } | null = null;
  /** Tool calls observed but not yet emitted as agent.tool_use. ACP child
   *  may send multiple `tool_call` / `tool_call_update` frames per actual
   *  invocation; we accumulate the richest seen `name`/`input` here and
   *  flush exactly once. Keyed by toolCallId. */
  #pendingToolUses: Map<string, { name: string; input: Record<string, unknown> }> = new Map();
  /** Tool call ids already emitted as agent.tool_use. Subsequent duplicate
   *  `tool_call` notifications for the same id (a Claude Code ACP behaviour
   *  — see file header) are dropped; the canonical "I have richer info now"
   *  channel is `tool_call_update` with non-terminal status, which we still
   *  honor by patching pending state but never re-emit a second tool_use. */
  #emittedToolUses: Set<string> = new Set();

  constructor(runtime: HarnessRuntime) {
    this.#runtime = runtime;
  }

  /** Process one message from the daemon-relayed stream. */
  async consume(msg: AcpEvent): Promise<void> {
    if (msg.type !== "session.event" || !msg.event) return;
    const upd = msg.event.update;
    if (!upd) return;
    switch (upd.sessionUpdate) {
      case "agent_message_chunk":
        // Agent transitioning from "running tools" to "talking" — flush any
        // tool_use we've been buffering so it appears before the message in
        // the events log. (We only ever buffer skeleton frames whose terminal
        // tool_call_update never arrived; without flushing here, the eventual
        // turn-end flush would put them AFTER the assistant's text.)
        await this.#flushAllPendingToolUses();
        await this.#onTextChunk(upd.content?.text ?? "");
        break;
      case "agent_thought_chunk":
        await this.#flushAllPendingToolUses();
        await this.#onThinkingChunk(upd.content?.text ?? "");
        break;
      case "tool_call":
        // New tool call — close any in-flight message/thinking first since
        // ACP doesn't have an explicit "message complete" marker.
        await this.#closeMessage();
        await this.#closeThinking();
        this.#bufferToolUse(upd);
        break;
      case "tool_call_update":
        // Terminal status (completed / failed / cancelled / anything not
        // "in_progress"|"pending") closes the call — flush our buffered
        // tool_use first so the persisted order is `tool_use → tool_result`,
        // then emit the result. Non-terminal updates carry richer
        // name/input data; merge into pending without emitting.
        if (upd.status && upd.status !== "in_progress" && upd.status !== "pending") {
          if (upd.toolCallId) await this.#flushPendingToolUse(upd.toolCallId);
          await this.#emitToolResult(upd);
        } else {
          this.#mergeIntoPendingToolUse(upd);
        }
        break;
      case "user_message_chunk":
        // Echo of the user's own message — ignore. We already wrote the
        // user.message event when SessionDO accepted the prompt.
        break;
      case "plan":
      case "available_commands_update":
      case "current_mode_update":
      case "config_option_update":
      case "session_info_update":
      case "usage_update":
        // Useful telemetry but no canonical OMA event yet. Drop silently
        // for v1; revisit when Console grows surfaces for them.
        break;
      default:
        // Unknown sessionUpdate — keep the conversation alive.
        break;
    }
  }

  /** Close any open message/thinking + buffered tool_uses at turn boundary. */
  async flush(reason: "completed" | "aborted" = "completed"): Promise<void> {
    if (reason === "aborted") {
      if (this.#activeMessage) {
        await this.#runtime.broadcastStreamEnd(this.#activeMessage.id, "aborted");
        this.#activeMessage = null;
      }
      if (this.#activeThinking) {
        await this.#runtime.broadcastThinkingEnd(this.#activeThinking.id, "aborted");
        this.#activeThinking = null;
      }
      // Drop unflushed tool_uses on abort — they'd be misleading without a
      // matching tool_result, and the user already knows the turn was killed.
      this.#pendingToolUses.clear();
      return;
    }
    await this.#flushAllPendingToolUses();
    await this.#closeMessage();
    await this.#closeThinking();
  }

  async #onTextChunk(delta: string): Promise<void> {
    if (this.#activeThinking) await this.#closeThinking();
    if (!this.#activeMessage) {
      const id = generateEventId();
      this.#activeMessage = { id, text: "" };
      await this.#runtime.broadcastStreamStart(id);
    }
    this.#activeMessage.text += delta;
    await this.#runtime.broadcastChunk(this.#activeMessage.id, delta);
  }

  async #onThinkingChunk(delta: string): Promise<void> {
    if (this.#activeMessage) await this.#closeMessage();
    if (!this.#activeThinking) {
      const id = generateEventId();
      this.#activeThinking = { id, text: "" };
      await this.#runtime.broadcastThinkingStart(id);
    }
    this.#activeThinking.text += delta;
    await this.#runtime.broadcastThinkingChunk(this.#activeThinking.id, delta);
  }

  async #closeMessage(): Promise<void> {
    const m = this.#activeMessage;
    if (!m) return;
    this.#activeMessage = null;
    await this.#runtime.broadcastStreamEnd(m.id, "completed");
    this.#runtime.broadcast({
      type: "agent.message",
      message_id: m.id,
      content: [{ type: "text", text: m.text.replace(/\s+$/, "") }],
    });
  }

  async #closeThinking(): Promise<void> {
    const t = this.#activeThinking;
    if (!t) return;
    this.#activeThinking = null;
    await this.#runtime.broadcastThinkingEnd(t.id, "completed");
    this.#runtime.broadcast({
      type: "agent.thinking",
      text: t.text.replace(/\s+$/, ""),
    });
  }

  /** Buffer a fresh tool_call frame — caller responsible for closing any
   *  active message/thinking first. Idempotent against already-emitted ids
   *  (Claude Code re-sends `tool_call` for the same id after sending the
   *  filled-in version, sometimes after the terminal update; we drop those). */
  #bufferToolUse(upd: AcpSessionUpdate): void {
    if (!upd.toolCallId) {
      // ACP missing toolCallId is malformed — emit anonymously so the
      // event stream stays useful for debugging, but skip dedup tracking.
      this.#runtime.broadcast({
        type: "agent.tool_use",
        id: generateEventId(),
        name: upd.title ?? upd.kind ?? "tool",
        input: (upd.rawInput as Record<string, unknown>) ?? {},
      });
      return;
    }
    if (this.#emittedToolUses.has(upd.toolCallId)) return;
    const existing = this.#pendingToolUses.get(upd.toolCallId);
    this.#pendingToolUses.set(upd.toolCallId, this.#mergeFrames(existing, upd));
  }

  /** Apply a non-terminal `tool_call_update` to existing pending state. No
   *  emission yet — we wait for the terminal update or a flush trigger. */
  #mergeIntoPendingToolUse(upd: AcpSessionUpdate): void {
    if (!upd.toolCallId) return;
    if (this.#emittedToolUses.has(upd.toolCallId)) return;
    const existing = this.#pendingToolUses.get(upd.toolCallId);
    this.#pendingToolUses.set(upd.toolCallId, this.#mergeFrames(existing, upd));
  }

  /** Combine a previous pending state with an incoming ACP frame, preferring
   *  whichever side carries non-empty data. ACP sends a skeleton (kind only,
   *  empty input) followed by a filled frame (title=<command>, input=<args>);
   *  we want the filled values to win without losing the skeleton's kind. */
  #mergeFrames(
    existing: { name: string; input: Record<string, unknown> } | undefined,
    upd: AcpSessionUpdate,
  ): { name: string; input: Record<string, unknown> } {
    const incomingInput = (upd.rawInput as Record<string, unknown> | undefined) ?? {};
    const incomingName = upd.title ?? upd.kind ?? "";
    const richer = (a: string, b: string): string => {
      // Prefer a non-empty name; if both non-empty, prefer the longer
      // one (the filled-in title is typically more descriptive than
      // the skeleton's kind label).
      if (!a) return b;
      if (!b) return a;
      return b.length > a.length ? b : a;
    };
    return {
      input: Object.keys(incomingInput).length > 0
        ? incomingInput
        : (existing?.input ?? {}),
      name: existing
        ? richer(existing.name, incomingName)
        : (incomingName || "tool"),
    };
  }

  async #flushPendingToolUse(id: string): Promise<void> {
    const pending = this.#pendingToolUses.get(id);
    if (!pending) return;
    this.#pendingToolUses.delete(id);
    this.#emittedToolUses.add(id);
    this.#runtime.broadcast({
      type: "agent.tool_use",
      id,
      name: pending.name,
      input: pending.input,
    });
  }

  async #flushAllPendingToolUses(): Promise<void> {
    for (const id of Array.from(this.#pendingToolUses.keys())) {
      await this.#flushPendingToolUse(id);
    }
  }

  async #emitToolResult(upd: AcpSessionUpdate): Promise<void> {
    if (!upd.toolCallId) return;
    const out = upd.rawOutput;
    const text =
      typeof out === "string" ? out
      : out == null ? `(status: ${upd.status ?? "unknown"})`
      : JSON.stringify(out);
    this.#runtime.broadcast({
      type: "agent.tool_result",
      tool_use_id: upd.toolCallId,
      content: text,
    });
  }
}
