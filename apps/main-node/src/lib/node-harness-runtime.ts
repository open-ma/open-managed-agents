// NodeHarnessRuntime — implements the apps/agent HarnessRuntime port for the
// CFless Node host. Maps the harness's broadcast/history/sandbox calls onto
// the SqlEventLog + EventStreamHub + a stub SandboxExecutor.
//
// Phase B-harness scope: text-only completion. The stub SandboxExecutor
// throws on every method, which is fine if the agent's tool config doesn't
// register sandbox-dependent tools (bash, read, write, edit, glob, grep).
// Phase C-sandbox swaps the stub for E2B / docker / whatever.

import type { ModelMessage } from "ai";
import type {
  HarnessRuntime,
  HistoryStore,
  SandboxExecutor,
} from "@open-managed-agents/agent/harness/interface";
import type { SessionEvent } from "@open-managed-agents/shared";
import type { SqlEventLog } from "@open-managed-agents/event-log/sql";
import { eventsToMessages } from "@open-managed-agents/agent/runtime/history";
import type { InProcessEventStreamHub } from "./event-stream-hub";

/**
 * HistoryStore backed by a SqlEventLog. The interface is sync (matches the
 * CF DO contract); we call refresh() before each turn so the cache is
 * current. Adapt() returns the cached events; mutations via broadcast
 * persist to SQL and refresh the cache so subsequent getEvents reflect them.
 */
class SqlHistoryStore implements HistoryStore {
  private cache: SessionEvent[] = [];
  constructor(private log: SqlEventLog) {}

  async refresh(): Promise<void> {
    this.cache = await this.log.getEventsAsync();
  }

  appendInPlace(event: SessionEvent): void {
    // Mark with a tentative seq so eventsToMessages projection is stable.
    // The persisted seq from SQL may differ; we re-refresh after the turn.
    this.cache.push(event);
  }

  // ── HistoryStore ────────────────────────────────────────────────────────
  append(event: SessionEvent): void {
    this.cache.push(event);
  }
  getEvents(afterSeq?: number): SessionEvent[] {
    if (afterSeq === undefined) return this.cache.slice();
    return this.cache.filter((e) => (e as { seq?: number }).seq! > afterSeq);
  }
  getMessages(): ModelMessage[] {
    return eventsToMessages(this.cache);
  }
}

export interface NodeHarnessRuntimeOptions {
  sessionId: string;
  log: SqlEventLog;
  hub: InProcessEventStreamHub;
  /** Sandbox to use for tool execution. Caller picks the implementation:
   *  LocalSubprocessSandbox for local dev, E2BSandbox / CloudflareSandbox
   *  in production. */
  sandbox: SandboxExecutor;
}

export class NodeHarnessRuntime implements HarnessRuntime {
  history: SqlHistoryStore;
  sandbox: SandboxExecutor;
  pendingConfirmations?: string[];
  /**
   * Per-runtime serial chain for SqlEventLog writes. The harness fires
   * many `broadcast()` calls in close succession (span_start, span_first_
   * token, tool_use, tool_result, …); each used to do a fire-and-forget
   * appendAsync. SqlEventLog mints `seq` via `SELECT COALESCE(MAX(seq),
   * 0) + 1`, which races on Postgres (true concurrent connections) and
   * occasionally collides on the sessions PK. Better-sqlite3 hides the
   * race because its underlying I/O is sync, but PG users hit
   * `duplicate key value violates unique constraint
   * "session_events_pkey"`. Serialising the writes through a single
   * Promise chain preserves logical event order AND eliminates the seq
   * collision without needing per-row locking.
   */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private opts: NodeHarnessRuntimeOptions) {
    this.history = new SqlHistoryStore(opts.log);
    this.sandbox = opts.sandbox;
  }

  /** Call before each harness.run() so getEvents reflects DB state. */
  async refreshHistory(): Promise<void> {
    await this.history.refresh();
  }

  /**
   * Single write path. Persists the event to SqlEventLog (durable,
   * survives crash) AND publishes to the in-process hub for live SSE
   * subscribers. The order matters: persist first so a hub subscriber
   * that races a DB read after the publish always sees the event.
   *
   * Persists are serialised through `writeChain` so concurrent calls
   * don't collide on the per-session seq counter (see writeChain
   * comment above).
   */
  broadcast = (event: SessionEvent): void => {
    this.history.appendInPlace(event);
    this.writeChain = this.writeChain
      .then(() => this.opts.log.appendAsync(event))
      .then(() => this.opts.log.getEventsAsync())
      .then((all) => {
        const last = all[all.length - 1];
        if (last) this.opts.hub.publish(this.opts.sessionId, last);
      })
      .catch((err) => {
        console.warn("[node-harness] broadcast persist failed", err);
        // Reset the chain so a single failure doesn't poison every
        // subsequent broadcast (the SQL adapter typically recovers on
        // the next attempt — connection wasn't lost, just a constraint
        // hit).
      });
  };

  // Stream lifecycle events: broadcast-only (NOT persisted to events log,
  // matching the CF contract — the eventual agent.message is the canonical
  // record). For PoC simplicity we publish a synthetic event without a seq.
  broadcastStreamStart = async (messageId: string): Promise<void> => {
    this.opts.hub.publish(this.opts.sessionId, {
      type: "agent.message_stream_start",
      message_id: messageId,
    } as unknown as SessionEvent);
  };
  broadcastChunk = async (messageId: string, delta: string): Promise<void> => {
    this.opts.hub.publish(this.opts.sessionId, {
      type: "agent.message_chunk",
      message_id: messageId,
      delta,
    } as unknown as SessionEvent);
  };
  broadcastStreamEnd = async (
    messageId: string,
    status: "completed" | "aborted",
    errorText?: string,
  ): Promise<void> => {
    this.opts.hub.publish(this.opts.sessionId, {
      type: "agent.message_stream_end",
      message_id: messageId,
      status,
      error_text: errorText,
    } as unknown as SessionEvent);
  };

  broadcastThinkingStart = async (thinkingId: string): Promise<void> => {
    this.opts.hub.publish(this.opts.sessionId, {
      type: "agent.thinking_stream_start",
      thinking_id: thinkingId,
    } as unknown as SessionEvent);
  };
  broadcastThinkingChunk = async (thinkingId: string, delta: string): Promise<void> => {
    this.opts.hub.publish(this.opts.sessionId, {
      type: "agent.thinking_chunk",
      thinking_id: thinkingId,
      delta,
    } as unknown as SessionEvent);
  };
  broadcastThinkingEnd = async (
    thinkingId: string,
    status: "completed" | "aborted",
  ): Promise<void> => {
    this.opts.hub.publish(this.opts.sessionId, {
      type: "agent.thinking_stream_end",
      thinking_id: thinkingId,
      status,
    } as unknown as SessionEvent);
  };

  broadcastToolInputStart = async (
    toolUseId: string,
    toolName?: string,
  ): Promise<void> => {
    this.opts.hub.publish(this.opts.sessionId, {
      type: "agent.tool_use_input_stream_start",
      tool_use_id: toolUseId,
      tool_name: toolName,
    } as unknown as SessionEvent);
  };
  broadcastToolInputChunk = async (toolUseId: string, delta: string): Promise<void> => {
    this.opts.hub.publish(this.opts.sessionId, {
      type: "agent.tool_use_input_chunk",
      tool_use_id: toolUseId,
      delta,
    } as unknown as SessionEvent);
  };
  broadcastToolInputEnd = async (
    toolUseId: string,
    status: "completed" | "aborted",
  ): Promise<void> => {
    this.opts.hub.publish(this.opts.sessionId, {
      type: "agent.tool_use_input_stream_end",
      tool_use_id: toolUseId,
      status,
    } as unknown as SessionEvent);
  };
}
