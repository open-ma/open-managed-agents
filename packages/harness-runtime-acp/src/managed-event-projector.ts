import type { SessionHostEvent } from "@openma/common/session-kernel";
import { parseAcpEvent, sessionUpdateInner, type ToolEntry } from "@openma/common/session-events/acp";
import { decodeChildActivities, type ChildActivity } from "./acp-subagents.js";

export type ManagedRuntimeEventWire = Record<string, unknown> & {
  id: string;
  type: string;
  processed_at: string;
};

export interface ManagedAcpEventProjectorOptions {
  nextEventId(): string;
  now(): Date;
}

interface AcpUpdate {
  sessionUpdate?: string;
  content?: { type?: string; text?: string };
  toolCallId?: string;
  title?: string;
  kind?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  status?: string;
}

interface AcpTerminal {
  type?: string;
  response?: {
    usage?: {
      inputTokens?: number | null;
      outputTokens?: number | null;
      cachedReadTokens?: number | null;
      cachedWriteTokens?: number | null;
    } | null;
  };
  error?: string;
}

type AcpUsage = NonNullable<NonNullable<AcpTerminal["response"]>["usage"]>;

interface TurnProjection {
  laneId?: string;
  modelRequestStartId: string;
  message: { id: string; text: string } | null;
  thinking: { id: string; text: string } | null;
  pendingTools: Map<string, { name: string; input: Record<string, unknown> }>;
  emittedTools: Set<string>;
  spanClosed: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

/**
 * Stateful ACP-to-Managed-Events boundary for one Work generation.
 *
 * The projector intentionally emits only persisted canonical events. Stream
 * chunks stay local until their message boundary closes; retrying the HTTP
 * publication is then safe because every projected record has a stable ID.
 */
export class ManagedAcpEventProjector {
  readonly #turns = new Map<string, TurnProjection>();
  readonly #completedTurns = new Set<string>();
  readonly #children = new Map<string, { name: string; parentThreadId?: string; state: TurnProjection; status: ChildActivity["status"] }>();
  readonly #childByParentTool = new Map<string, string>();
  readonly #toolLanes = new Map<string, string>();
  readonly #observedTools = new Map<string, ToolEntry>();
  readonly #seenCanonicalEvents = new Set<string>();

  constructor(private readonly options: ManagedAcpEventProjectorOptions) {}

  project(event: SessionHostEvent): ManagedRuntimeEventWire[] {
    switch (event.type) {
      case "session.ready":
        return [];
      case "session.disposed":
        return [this.#event("session.status_terminated")];
      case "session.complete": {
        if (this.#completedTurns.has(event.turnId)) return [];
        const output = this.#closeTurn(event.turnId, false);
        output.push(this.#event("session.status_idle", {
          stop_reason: { type: "end_turn" },
        }));
        this.#completedTurns.add(event.turnId);
        return output;
      }
      case "session.error": {
        const output = event.turnId === undefined
          ? []
          : this.#closeTurn(event.turnId, true);
        output.push(this.#event("session.error", {
          error: {
            type: "unknown_error",
            message: event.message,
            retry_status: "terminal",
          },
        }));
        if (event.turnId !== undefined) this.#completedTurns.add(event.turnId);
        return output;
      }
      case "session.event":
        return this.#projectTurnEvent(event.turnId, event.event);
    }
  }

  #projectTurnEvent(turnId: string, value: unknown): ManagedRuntimeEventWire[] {
    if (this.#completedTurns.has(turnId)) return [];
    let { turn, opened } = this.#turn(turnId);
    const output = opened ? this.#openTurn(turn) : [];
    const terminal = record(value) as AcpTerminal | null;
    if (terminal?.type === "promptComplete") {
      output.push(...this.#flushPendingTools(turn));
      output.push(...this.#closeContent(turn));
      output.push(...this.#flushChildren());
      output.push(...this.#closeSpan(turn, false, terminal.response?.usage));
      return output;
    }
    if (terminal?.type === "promptError") {
      output.push(...this.#flushPendingTools(turn));
      output.push(...this.#closeContent(turn));
      output.push(...this.#flushChildren());
      output.push(...this.#closeSpan(turn, true));
      return output;
    }

    const envelope = record(value);
    if (envelope?.schema_version === "oma.event.v1" && typeof envelope.event_id === "string") {
      if (this.#seenCanonicalEvents.has(envelope.event_id)) return output;
      this.#seenCanonicalEvents.add(envelope.event_id);
    }
    const parsed = parseAcpEvent(value);
    const normalizedTool = parsed.kind === "tool_call" ? parsed.tool : undefined;
    const observedTool = normalizedTool ? { ...this.#observedTools.get(normalizedTool.toolCallId), ...normalizedTool } : undefined;
    if (observedTool) this.#observedTools.set(observedTool.toolCallId, observedTool);
    const parentToolId = parsed.kind === "text" || parsed.kind === "thought" ? parsed.parentToolUseId : observedTool?.parentToolUseId;
    const sourceLaneId = typeof envelope?.session_thread_id === "string" ? envelope.session_thread_id
      : parentToolId ? this.#childByParentTool.get(parentToolId)
      : observedTool ? this.#toolLanes.get(observedTool.toolCallId) : undefined;
    const laneId = sourceLaneId === "root" || sourceLaneId === "main" ? undefined : sourceLaneId;
    for (const activity of decodeChildActivities(value, observedTool)) {
      output.push(...this.#childActivity({ ...activity, parentThreadId: activity.parentThreadId ?? laneId }));
    }
    if (laneId !== undefined) {
      const child = this.#children.get(laneId);
      if (!child) return output; // Never leak an unattributed child into root.
      turn = child.state;
      if (observedTool) this.#toolLanes.set(observedTool.toolCallId, laneId);
    } else if (parentToolId) {
      return output; // Parent correlation is evidence of a child, not root text.
    }
    let update = record(sessionUpdateInner(value)) as AcpUpdate | null;
    if (envelope?.schema_version === "oma.event.v1") {
      if (parsed.kind === "text" || parsed.kind === "thought") update = { sessionUpdate: parsed.kind === "text" ? "agent_message_chunk" : "agent_thought_chunk", content: { text: parsed.text } };
      else if (observedTool) update = { toolCallId: observedTool.toolCallId, title: observedTool.title, kind: observedTool.kind, status: observedTool.status, rawInput: observedTool.rawInput, rawOutput: observedTool.rawOutput, sessionUpdate: envelope.type === "tool.started" ? "tool_call" : "tool_call_update" };
    }
    if (update === null) return output;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        output.push(...this.#flushPendingTools(turn));
        output.push(...this.#closeThinking(turn));
        if (turn.message === null) {
          turn.message = { id: this.options.nextEventId(), text: "" };
        }
        turn.message.text += update.content?.text ?? "";
        break;
      case "agent_thought_chunk":
        output.push(...this.#flushPendingTools(turn));
        output.push(...this.#closeMessage(turn));
        if (turn.thinking === null) {
          turn.thinking = { id: this.options.nextEventId(), text: "" };
        }
        turn.thinking.text += update.content?.text ?? "";
        break;
      case "tool_call":
        output.push(...this.#closeContent(turn));
        this.#mergeTool(turn, update);
        break;
      case "tool_call_update":
        this.#mergeTool(turn, update);
        if (
          update.toolCallId !== undefined
          && update.status !== undefined
          && update.status !== "pending"
          && update.status !== "in_progress"
        ) {
          output.push(...this.#flushTool(turn, update.toolCallId));
          output.push(this.#toolResult(update, turn));
        }
        break;
    }
    return output;
  }

  #childActivity(activity: ChildActivity): ManagedRuntimeEventWire[] {
    let child = this.#children.get(activity.id);
    const output: ManagedRuntimeEventWire[] = [];
    if (!child) {
      if (activity.status !== "running") return output;
      child = { name: activity.name ?? "", parentThreadId: activity.parentThreadId, state: this.#newTurn(activity.id), status: "running" };
      this.#children.set(activity.id, child);
      output.push(this.#event("session.thread_created", {
        session_thread_id: activity.id, agent_name: child.name,
        ...(activity.parentThreadId ? { parent_thread_id: activity.parentThreadId } : {}),
        ...(activity.parentToolId ? { parent_tool_use_id: activity.parentToolId } : {}),
      }));
    } else if (child.status === activity.status) {
      return output;
    }
    if (activity.parentToolId) this.#childByParentTool.set(activity.parentToolId, activity.id);
    const fields = { session_thread_id: activity.id, agent_name: child.name };
    if (activity.status !== "running") {
      output.push(...this.#flushPendingTools(child.state), ...this.#closeContent(child.state));
    }
    child.status = activity.status;
    switch (activity.status) {
      case "running": output.push(this.#event("session.thread_status_running", fields)); break;
      case "completed": output.push(this.#event("session.thread_status_idle", { ...fields, stop_reason: { type: "end_turn" } })); break;
      case "failed": output.push(this.#event("session.error", { session_thread_id: activity.id, error: { type: "unknown_error", message: activity.error ?? "Subagent failed", retry_status: "terminal" } })); break;
      case "cancelled": output.push(this.#event("session.thread_status_idle", { ...fields, stop_reason: { type: "end_turn" }, interrupted: true })); break;
      case "closed": output.push(this.#event("session.thread_status_terminated", fields)); break;
    }
    return output;
  }

  #flushChildren(): ManagedRuntimeEventWire[] {
    return [...this.#children.values()].flatMap(child => [...this.#flushPendingTools(child.state), ...this.#closeContent(child.state)]);
  }

  #turn(turnId: string): { turn: TurnProjection; opened: boolean } {
    const current = this.#turns.get(turnId);
    if (current !== undefined) return { turn: current, opened: false };
    const turn = this.#newTurn();
    this.#turns.set(turnId, turn);
    return { turn, opened: true };
  }

  #newTurn(laneId?: string): TurnProjection {
    return {
      ...(laneId ? { laneId } : {}),
      modelRequestStartId: "",
      message: null,
      thinking: null,
      pendingTools: new Map(),
      emittedTools: new Set(),
      spanClosed: false,
    };
  }

  #openTurn(turn: TurnProjection): ManagedRuntimeEventWire[] {
    const running = this.#event("session.status_running");
    turn.modelRequestStartId = this.options.nextEventId();
    return [
      running,
      this.#event("span.model_request_start", {}, turn.modelRequestStartId),
    ];
  }

  #closeTurn(turnId: string, error: boolean): ManagedRuntimeEventWire[] {
    const { turn, opened } = this.#turn(turnId);
    const output = opened ? this.#openTurn(turn) : [];
    output.push(...this.#flushPendingTools(turn));
    output.push(...this.#closeContent(turn));
    output.push(...this.#flushChildren());
    output.push(...this.#closeSpan(turn, error));
    this.#turns.delete(turnId);
    return output;
  }

  #closeContent(turn: TurnProjection): ManagedRuntimeEventWire[] {
    return [...this.#closeMessage(turn), ...this.#closeThinking(turn)];
  }

  #closeMessage(turn: TurnProjection): ManagedRuntimeEventWire[] {
    const message = turn.message;
    if (message === null) return [];
    turn.message = null;
    return [this.#event("agent.message", {
      ...(turn.laneId ? { session_thread_id: turn.laneId } : {}),
      message_id: message.id,
      content: [{ type: "text", text: message.text.replace(/\s+$/u, "") }],
    }, message.id)];
  }

  #closeThinking(turn: TurnProjection): ManagedRuntimeEventWire[] {
    const thinking = turn.thinking;
    if (thinking === null) return [];
    turn.thinking = null;
    return [this.#event("agent.thinking", turn.laneId ? { session_thread_id: turn.laneId } : {}, thinking.id)];
  }

  #closeSpan(
    turn: TurnProjection,
    isError: boolean,
    usage?: AcpUsage | null,
  ): ManagedRuntimeEventWire[] {
    if (turn.spanClosed) return [];
    turn.spanClosed = true;
    return [this.#event("span.model_request_end", {
      is_error: isError,
      model_request_start_id: turn.modelRequestStartId,
      model_usage: {
        input_tokens: nonNegative(usage?.inputTokens),
        output_tokens: nonNegative(usage?.outputTokens),
        cache_read_input_tokens: nonNegative(usage?.cachedReadTokens),
        cache_creation_input_tokens: nonNegative(usage?.cachedWriteTokens),
      },
    })];
  }

  #mergeTool(turn: TurnProjection, update: AcpUpdate): void {
    const id = update.toolCallId;
    if (id === undefined || turn.emittedTools.has(id)) return;
    const previous = turn.pendingTools.get(id);
    const incomingInput = record(update.rawInput) ?? {};
    const previousName = previous?.name ?? "";
    const incomingName = update.title ?? update.kind ?? "";
    turn.pendingTools.set(id, {
      name: incomingName.length > previousName.length
        ? incomingName
        : previousName || "tool",
      input: Object.keys(incomingInput).length > 0
        ? incomingInput
        : previous?.input ?? {},
    });
  }

  #flushTool(turn: TurnProjection, id: string): ManagedRuntimeEventWire[] {
    const pending = turn.pendingTools.get(id);
    if (pending === undefined || turn.emittedTools.has(id)) return [];
    turn.pendingTools.delete(id);
    turn.emittedTools.add(id);
    return [this.#event("agent.tool_use", {
      ...(turn.laneId ? { session_thread_id: turn.laneId } : {}),
      name: pending.name,
      input: pending.input,
    }, id)];
  }

  #flushPendingTools(turn: TurnProjection): ManagedRuntimeEventWire[] {
    return [...turn.pendingTools.keys()].flatMap((id) => this.#flushTool(turn, id));
  }

  #toolResult(update: AcpUpdate, turn: TurnProjection): ManagedRuntimeEventWire {
    const text = typeof update.rawOutput === "string"
      ? update.rawOutput
      : update.rawOutput == null
        ? `(status: ${update.status ?? "unknown"})`
        : JSON.stringify(update.rawOutput);
    return this.#event("agent.tool_result", {
      ...(turn.laneId ? { session_thread_id: turn.laneId } : {}),
      tool_use_id: update.toolCallId,
      content: [{ type: "text", text }],
      is_error: update.status === "failed",
    });
  }

  #event(
    type: string,
    fields: Record<string, unknown> = {},
    id = this.options.nextEventId(),
  ): ManagedRuntimeEventWire {
    return {
      id,
      type,
      processed_at: this.options.now().toISOString(),
      ...fields,
    };
  }
}
