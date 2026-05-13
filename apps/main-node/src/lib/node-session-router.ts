// Node SessionRouter — wraps the existing SessionRegistry + SqlEventLog +
// EventStreamHub behind the runtime-agnostic SessionRouter contract.
// Used by `@open-managed-agents/http-routes` to mount the same
// /v1/sessions/* paths the CF worker mounts, sharing one source of
// route handlers across runtimes.

import type { SqlClient } from "@open-managed-agents/sql-client";
import { SqlEventLog } from "@open-managed-agents/event-log/sql";
import type { SessionEvent, StoredEvent } from "@open-managed-agents/shared";
import { buildTrajectory, type SessionRecord, type EnvironmentConfig } from "@open-managed-agents/shared";
import { getLogger } from "@open-managed-agents/observability";

const moduleLog = getLogger("node-session-router");
import type {
  SessionRouter,
  SessionInitParams,
  SessionEventsPage,
  SessionEventsQuery,
  SessionFullStatus,
  SessionExecResult,
  SessionAppendResult,
  SessionStreamFrame,
  SessionStreamHandle,
} from "@open-managed-agents/session-runtime";
import type { SessionRegistry } from "../registry.js";
import type { EventStreamHub } from "./event-stream-hub.js";

interface NodeSessionRouterDeps {
  sql: SqlClient;
  hub: EventStreamHub;
  registry: SessionRegistry;
  newEventLog: (sessionId: string) => SqlEventLog;
}

export class NodeSessionRouter implements SessionRouter {
  constructor(private deps: NodeSessionRouterDeps) {}

  async init(_sessionId: string, params: SessionInitParams): Promise<void> {
    // Node has no warmup-on-init step (sandbox is lazy on first event).
    // We still need to persist any init events so trajectory + SSE see them.
    if (!params.initEvents?.length) return;
    const log = this.deps.newEventLog(_sessionId);
    for (const ev of params.initEvents) {
      await log.appendAsync(ev);
      const stored = await log.getEventsAsync();
      this.deps.hub.publish(_sessionId, stored[stored.length - 1]);
    }
  }

  async destroy(sessionId: string): Promise<void> {
    // Best-effort sandbox teardown via registry. On Node this is a no-op
    // when the entry isn't realized yet.
    this.deps.registry.interrupt(sessionId);
    // Hub disposal — drop SSE writers.
    this.deps.hub.closeSession?.(sessionId);
  }

  async appendEvent(
    sessionId: string,
    event: SessionEvent,
  ): Promise<SessionAppendResult> {
    const log = this.deps.newEventLog(sessionId);
    if (event.type === "user.interrupt") {
      this.deps.registry.interrupt(sessionId);
      return { status: 202, body: '{"accepted":true,"interrupted":true}' };
    }
    await log.appendAsync(event);
    const stored = await log.getEventsAsync();
    const last = stored[stored.length - 1];
    this.deps.hub.publish(sessionId, last);

    if (event.type === "user.message") {
      // Look up the agent_id off the sessions row; SessionRegistry
      // expects (sid, tenantId, agentId, event).
      const row = await this.deps.sql
        .prepare(`SELECT tenant_id, agent_id FROM sessions WHERE id = ?`)
        .bind(sessionId)
        .first<{ tenant_id: string; agent_id: string | null }>();
      if (row?.agent_id) {
        const entry = await this.deps.registry.getOrCreate(sessionId, row.tenant_id);
        void entry.machine
          .runHarnessTurn(
            row.agent_id,
            event as import("@open-managed-agents/shared").UserMessageEvent,
          )
          .catch((err) => {
            moduleLog.error({ err, op: "node_session_router.harness_turn_failed", session_id: sessionId }, "harness turn failed");
          });
      }
    }
    return { status: 202, body: JSON.stringify({ accepted: true }) };
  }

  async getEvents(
    sessionId: string,
    opts: SessionEventsQuery = {},
  ): Promise<SessionEventsPage> {
    const log = this.deps.newEventLog(sessionId);
    const events = await log.getEventsAsync(opts.afterSeq);
    const limit = opts.limit ?? 100;
    const data = events.slice(0, limit) as unknown as StoredEvent[];
    return { data, has_more: events.length > limit };
  }

  async getThreadEvents(
    sessionId: string,
    threadId: string,
    opts: SessionEventsQuery = {},
  ): Promise<SessionEventsPage> {
    // Filter by session_thread_id at the SQL level so primary-thread
    // legacy rows (NULL thread id) only land on the primary view.
    const after = opts.afterSeq ?? -1;
    const limit = opts.limit ?? 100;
    const rows = await this.deps.sql
      .prepare(
        `SELECT seq, type, data, ts FROM session_events
          WHERE session_id = ? AND seq > ?
            AND COALESCE(session_thread_id, 'sthr_primary') = ?
          ORDER BY seq LIMIT ?`,
      )
      .bind(sessionId, after, threadId, limit + 1)
      .all<{ seq: number; type: string; data: string; ts: number }>();
    const list = (rows.results ?? []).slice(0, limit).map((row) => {
      const ev = JSON.parse(row.data) as StoredEvent;
      ev.seq = row.seq;
      return ev;
    });
    return { data: list, has_more: (rows.results?.length ?? 0) > limit };
  }

  async streamEvents(
    sessionId: string,
    opts: { threadId?: string; lastEventId?: number } = {},
  ): Promise<SessionStreamHandle> {
    const buf: SessionStreamFrame[] = [];
    let waker: ((v: IteratorResult<SessionStreamFrame>) => void) | null = null;
    let closed = false;

    const enqueue = (raw: string) => {
      if (closed) return;
      const frame: SessionStreamFrame = { data: raw };
      if (waker) {
        const w = waker;
        waker = null;
        w({ value: frame, done: false });
      } else if (buf.length < 1024) {
        buf.push(frame);
      }
    };

    // Replay history > lastEventId before subscribing.
    const log = this.deps.newEventLog(sessionId);
    const history = await log.getEventsAsync(opts.lastEventId ?? undefined);
    for (const ev of history) {
      const tid =
        (ev as { session_thread_id?: string }).session_thread_id ??
        "sthr_primary";
      if (opts.threadId && tid !== opts.threadId) continue;
      enqueue(JSON.stringify(ev));
    }

    const writer = {
      closed: false,
      write(ev: unknown) {
        const tid =
          (ev as { session_thread_id?: string }).session_thread_id ??
          "sthr_primary";
        if (opts.threadId && tid !== opts.threadId) return;
        enqueue(JSON.stringify(ev));
      },
      close() {
        if (closed) return;
        closed = true;
        if (waker) {
          const w = waker;
          waker = null;
          w({ value: undefined as unknown as SessionStreamFrame, done: true });
        }
      },
    };
    const detach = this.deps.hub.attach(sessionId, writer);

    return {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (buf.length > 0) {
              return Promise.resolve({ value: buf.shift()!, done: false });
            }
            if (closed) {
              return Promise.resolve({
                value: undefined as unknown as SessionStreamFrame,
                done: true,
              });
            }
            return new Promise<IteratorResult<SessionStreamFrame>>((resolve) => {
              waker = resolve;
            });
          },
        };
      },
      close() {
        writer.close();
        detach();
      },
    };
  }

  async interrupt(sessionId: string): Promise<void> {
    this.deps.registry.interrupt(sessionId);
  }

  async exec(
    sessionId: string,
    body: { command: string; timeout_ms?: number },
  ): Promise<SessionExecResult> {
    // Reach into the registry for the active sandbox. Sandbox.exec
    // returns "exit=N\n<stdout>" — peel and report.
    const row = await this.deps.sql
      .prepare(`SELECT tenant_id FROM sessions WHERE id = ?`)
      .bind(sessionId)
      .first<{ tenant_id: string }>();
    if (!row) {
      return { exit_code: 1, output: "session not found", truncated: false };
    }
    const entry = await this.deps.registry.getOrCreate(sessionId, row.tenant_id);
    const out = await entry.sandbox.exec(body.command, body.timeout_ms ?? 60_000);
    const m = /^exit=(-?\d+)\n([\s\S]*)$/.exec(out);
    if (!m) return { exit_code: 0, output: out, truncated: false };
    return {
      exit_code: parseInt(m[1], 10),
      output: m[2],
      truncated: false,
    };
  }

  async getFullStatus(sessionId: string): Promise<SessionFullStatus | null> {
    // Aggregate from session_events: usage from agent.message_stream_end,
    // status from sessions.status. Cheap fallback — Node has no DO-side
    // live state to consult.
    const sess = await this.deps.sql
      .prepare(`SELECT status FROM sessions WHERE id = ?`)
      .bind(sessionId)
      .first<{ status: string }>();
    if (!sess) return null;
    const log = this.deps.newEventLog(sessionId);
    const events = await log.getEventsAsync();
    let input = 0;
    let output = 0;
    for (const ev of events) {
      const u = (ev as { usage?: { input_tokens?: number; output_tokens?: number } })
        .usage;
      if (u) {
        input += u.input_tokens ?? 0;
        output += u.output_tokens ?? 0;
      }
    }
    return {
      status: sess.status,
      usage: { input_tokens: input, output_tokens: output },
    };
  }

  async readSandboxFile(
    sessionId: string,
    path: string,
  ): Promise<ArrayBuffer | null> {
    const row = await this.deps.sql
      .prepare(`SELECT tenant_id FROM sessions WHERE id = ?`)
      .bind(sessionId)
      .first<{ tenant_id: string }>();
    if (!row) return null;
    const entry = await this.deps.registry.getOrCreate(sessionId, row.tenant_id);
    if (!entry.sandbox.readFileBytes) return null;
    const bytes = await entry.sandbox.readFileBytes(path);
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
  }

  async triggerDebugRecovery(
    sessionId: string,
    _token: string,
  ): Promise<{ status: number; body: string }> {
    // Node injects a synthetic session.error so the SSE consumer sees a
    // recovery probe land. Mirrors the package handler's previous inline
    // implementation.
    const log = this.deps.newEventLog(sessionId);
    const ev = {
      type: "session.error",
      error: "debug_recovery",
      message: "synthetic recovery event injected via __debug_recovery__",
    } as unknown as SessionEvent;
    await log.appendAsync(ev);
    const stored = await log.getEventsAsync();
    const last = stored[stored.length - 1];
    this.deps.hub.publish(sessionId, last);
    return { status: 202, body: JSON.stringify({ injected: last }) };
  }

  async getTrajectory(
    session: SessionRecord,
    helpers: { fetchEnvironmentConfig: () => Promise<EnvironmentConfig | null> },
  ): Promise<unknown> {
    const log = this.deps.newEventLog(session.id);
    return buildTrajectory(session, {
      fetchAllEvents: async () => (await log.getEventsAsync()) as unknown as StoredEvent[],
      fetchFullStatus: async () => this.getFullStatus(session.id),
      fetchEnvironmentConfig: helpers.fetchEnvironmentConfig,
    });
  }

  async listThreads(sessionId: string): Promise<unknown> {
    const rows = await this.deps.sql
      .prepare(
        `SELECT DISTINCT COALESCE(session_thread_id, 'sthr_primary') AS id
           FROM session_events WHERE session_id = ?`,
      )
      .bind(sessionId)
      .all<{ id: string }>();
    return { data: (rows.results ?? []).map((r) => ({ id: r.id })) };
  }

  async getThread(
    sessionId: string,
    threadId: string,
  ): Promise<{ status: number; body: string }> {
    const r = await this.deps.sql
      .prepare(
        `SELECT 1 AS one FROM session_events
          WHERE session_id = ? AND COALESCE(session_thread_id, 'sthr_primary') = ? LIMIT 1`,
      )
      .bind(sessionId, threadId)
      .first<{ one: number }>();
    if (!r && threadId !== "sthr_primary") {
      return { status: 404, body: JSON.stringify({ error: "Thread not found" }) };
    }
    return { status: 200, body: JSON.stringify({ id: threadId }) };
  }

  async archiveThread(
    _sessionId: string,
    threadId: string,
  ): Promise<{ status: number; body: string }> {
    if (threadId === "sthr_primary") {
      return { status: 400, body: JSON.stringify({ error: "Cannot archive primary thread" }) };
    }
    // Node has no thread-row to flip; reflect the call back as 200 so
    // SDK callers can chain idempotently. Future SQL migration could
    // add a session_threads table for hard archive semantics.
    return { status: 200, body: JSON.stringify({ id: threadId, archived: true }) };
  }
}
