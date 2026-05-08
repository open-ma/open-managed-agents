// EventStreamHub — in-process pub/sub that fans out broadcast(sid, event)
// to every SSE writer subscribed to that sid. Phase B-resume PoC scope:
// single-instance only. Multi-instance fanout (PG LISTEN/NOTIFY or Redis)
// becomes a different EventStreamHub implementation behind the same
// interface, no consumer changes.
//
// Why this lives here (not in @open-managed-agents/runtime-node yet):
// the runtime-node package doesn't exist; the hub is small enough to
// inline into the main-node app for the PoC and gets extracted when a
// second consumer (apps/agent's NodeSessionRuntime, future Phase D) needs
// it.

import type { SessionEvent } from "@open-managed-agents/shared";

export interface EventWriter {
  /** True after .close() or after the underlying stream errored. The hub
   *  drops closed writers from its subscription set on the next publish. */
  closed: boolean;
  /** Emit one event to the wire. Implementations decide framing
   *  (SSE: data:\n\n; WS: ws.send(JSON)). */
  write(event: SessionEvent & { seq?: number }): void;
  /** Close the underlying transport. Idempotent. */
  close(): void;
}

export interface EventStreamHub {
  /** Subscribe a writer to events for one session. Returns an unsubscribe. */
  attach(sessionId: string, writer: EventWriter): () => void;
  /** Broadcast an event to every writer subscribed to `sessionId`. */
  publish(sessionId: string, event: SessionEvent & { seq?: number }): void;
  /** Drop every writer for a session — use on session destroy. */
  closeSession(sessionId: string): void;
}

export class InProcessEventStreamHub implements EventStreamHub {
  private subs = new Map<string, Set<EventWriter>>();

  attach(sessionId: string, writer: EventWriter): () => void {
    let set = this.subs.get(sessionId);
    if (!set) {
      set = new Set();
      this.subs.set(sessionId, set);
    }
    set.add(writer);
    return () => {
      set!.delete(writer);
      if (set!.size === 0) this.subs.delete(sessionId);
    };
  }

  publish(sessionId: string, event: SessionEvent & { seq?: number }): void {
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
        // Writer probably half-closed mid-fanout — sweep on next publish.
      }
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
  }
}
