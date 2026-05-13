// EventStreamHub backed by Postgres LISTEN/NOTIFY.
//
// Replaces InProcessEventStreamHub when DATABASE_URL is postgres://.
// Same publisher API; the difference is that broadcasts cross replicas
// via PG NOTIFY instead of being confined to one process's Map.
//
// Channel choice: one shared channel `oma_session_events` for all
// sessions. Per-session channels would mean LISTEN/UNLISTEN on every
// session create/destroy; one channel keeps the LISTEN connection
// stable. Each NOTIFY payload carries `{sid, seq}` so subscribers can
// filter cheaply (skip when there's no local writer for sid).
//
// Missed-notify recovery: postgres.js auto-reconnects, but NOTIFYs
// emitted while the LISTEN socket is down are lost. We track the last
// forwarded seq per session and on every NOTIFY fetch
// `seq > lastForwarded` so a single notify also flushes any gap.
//
// publish() does the local fanout AND issues NOTIFY. Local writers on
// the originating replica receive the event immediately; the NOTIFY
// echo is filtered out by the lastForwarded watermark (we bump it
// before NOTIFY, so the LISTEN callback's getEventsAfter returns []).

import type { SessionEvent } from "@open-managed-agents/shared";
import { getLogger } from "@open-managed-agents/observability";
import type { EventStreamHub, EventWriter } from "./event-stream-hub";

const log = getLogger("pg-hub");

type PgRow = Record<string, unknown>;
interface PgQueryResult extends Array<PgRow> {
  count?: number;
}
interface PgListenHandle {
  unlisten: () => Promise<void>;
}
interface PgSql {
  unsafe(text: string, params?: unknown[]): Promise<PgQueryResult>;
  notify(channel: string, payload: string): Promise<unknown>;
  listen(
    channel: string,
    onPayload: (payload: string) => void,
    onListen?: () => void,
  ): Promise<PgListenHandle>;
  end?(opts?: { timeout?: number }): Promise<void>;
}

const CHANNEL = "oma_session_events";

/** Caller-supplied event fetcher. Mirrors SqlEventLog.getEventsAsync(sid,
 *  afterSeq); kept as a callback so the hub doesn't import event-log
 *  directly and the tests can inject a fake. */
export type FetchEventsAfter = (
  sessionId: string,
  afterSeq: number,
) => Promise<Array<SessionEvent & { seq?: number }>>;

export interface PgEventStreamHubOptions {
  dsn: string;
  fetchEventsAfter: FetchEventsAfter;
}

export class PgEventStreamHub implements EventStreamHub {
  private subs = new Map<string, Set<EventWriter>>();
  private lastForwarded = new Map<string, number>();
  private listenHandle: PgListenHandle | null = null;
  private listenSql: PgSql | null = null;
  private notifySql: PgSql | null = null;

  private constructor(private opts: PgEventStreamHubOptions) {}

  static async create(opts: PgEventStreamHubOptions): Promise<PgEventStreamHub> {
    type PgFactory = (dsn: string, opts?: unknown) => PgSql;
    type PgModule = { default: PgFactory };
    const mod = (await import(/* @vite-ignore */ "postgres" as string)) as PgModule;
    const hub = new PgEventStreamHub(opts);
    // Two short-lived clients: postgres.js pins LISTEN to a single backend
    // connection (max:1), and we keep notify on its own small pool so
    // bursts of NOTIFYs don't starve the LISTEN reconnect path.
    hub.listenSql = mod.default(opts.dsn, { max: 1 });
    hub.notifySql = mod.default(opts.dsn, { max: 2 });
    hub.listenHandle = await hub.listenSql.listen(CHANNEL, (payload) =>
      void hub.onNotify(payload),
    );
    return hub;
  }

  attach(sessionId: string, writer: EventWriter): () => void {
    let set = this.subs.get(sessionId);
    if (!set) {
      set = new Set();
      this.subs.set(sessionId, set);
    }
    set.add(writer);
    return () => {
      set!.delete(writer);
      if (set!.size === 0) {
        this.subs.delete(sessionId);
        this.lastForwarded.delete(sessionId);
      }
    };
  }

  publish(sessionId: string, event: SessionEvent & { seq?: number }): void {
    // Local fanout first so the originating replica's clients see the
    // event even if NOTIFY round-trips slowly. Bump lastForwarded BEFORE
    // notifying so the echo callback short-circuits on the local side.
    this.localFanout(sessionId, event);
    if (event.seq !== undefined) {
      const cur = this.lastForwarded.get(sessionId) ?? -1;
      if (event.seq > cur) this.lastForwarded.set(sessionId, event.seq);
    }
    const payload = JSON.stringify({ sid: sessionId, seq: event.seq ?? null });
    if (this.notifySql) {
      void this.notifySql.notify(CHANNEL, payload).catch((err) => {
        log.warn({ err, op: "pg_hub.notify_failed" }, "NOTIFY failed");
      });
    }
  }

  closeSession(sessionId: string): void {
    const set = this.subs.get(sessionId);
    if (!set) return;
    for (const w of set) {
      try {
        w.close();
      } catch {
        // ignore
      }
    }
    this.subs.delete(sessionId);
    this.lastForwarded.delete(sessionId);
  }

  async stop(): Promise<void> {
    try {
      await this.listenHandle?.unlisten();
    } catch {
      /* best-effort */
    }
    try {
      await this.listenSql?.end?.({ timeout: 1 });
    } catch {
      /* best-effort */
    }
    try {
      await this.notifySql?.end?.({ timeout: 1 });
    } catch {
      /* best-effort */
    }
  }

  // ── internals ──────────────────────────────────────────────────────

  /** NOTIFY callback. Fetches events newer than what this replica has
   *  already forwarded for the session and pushes to local writers. */
  private async onNotify(payload: string): Promise<void> {
    let sid: string;
    try {
      const parsed = JSON.parse(payload) as { sid?: string };
      if (typeof parsed.sid !== "string") return;
      sid = parsed.sid;
    } catch {
      return;
    }
    const set = this.subs.get(sid);
    if (!set || set.size === 0) return;
    const after = this.lastForwarded.get(sid) ?? -1;
    let events: Array<SessionEvent & { seq?: number }> = [];
    try {
      events = await this.opts.fetchEventsAfter(sid, after);
    } catch (err) {
      log.warn({ err, op: "pg_hub.fetch_events_failed", session_id: sid }, "fetchEventsAfter failed");
      return;
    }
    if (events.length === 0) return;
    for (const ev of events) this.localFanout(sid, ev);
    const last = events[events.length - 1];
    const lastSeq = (last as { seq?: number }).seq;
    if (lastSeq !== undefined) this.lastForwarded.set(sid, lastSeq);
  }

  private localFanout(sessionId: string, event: SessionEvent & { seq?: number }): void {
    const set = this.subs.get(sessionId);
    if (!set) return;
    for (const w of set) {
      if (w.closed) {
        set.delete(w);
        continue;
      }
      try {
        w.write(event);
      } catch {
        // half-closed; sweep next time
      }
    }
  }
}
