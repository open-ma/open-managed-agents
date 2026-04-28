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
        await this.#onTextChunk(upd.content?.text ?? "");
        break;
      case "agent_thought_chunk":
        await this.#onThinkingChunk(upd.content?.text ?? "");
        break;
      case "tool_call":
        // New tool call — close any in-flight message/thinking first since
        // ACP doesn't have an explicit "message complete" marker.
        await this.#closeMessage();
        await this.#closeThinking();
        await this.#emitToolUse(upd);
        break;
      case "tool_call_update":
        // Tool finished or progress update. We only emit a tool_result on
        // status=completed (or first non-pending update with rawOutput).
        if (upd.status && upd.status !== "in_progress" && upd.status !== "pending") {
          await this.#emitToolResult(upd);
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

  /** Close any open message/thinking at turn boundary. */
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
      return;
    }
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

  async #emitToolUse(upd: AcpSessionUpdate): Promise<void> {
    const id = upd.toolCallId ?? generateEventId();
    const name = upd.title ?? upd.kind ?? "tool";
    const input = (upd.rawInput as Record<string, unknown>) ?? {};
    this.#runtime.broadcast({
      type: "agent.tool_use",
      id,
      name,
      input,
    });
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
