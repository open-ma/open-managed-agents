// In-memory adapter — for unit tests and the in-memory thread history
// case (sub-agent runs that don't need persistence). Faster than the CF
// SQLite adapter in tests because there's no SQL round-trip; same shape
// so consumer code is identical.

import type { SessionEvent } from "@open-managed-agents/shared";
import type { EventLogRepo, StreamBufferRepo, StreamBuffer } from "../ports";

export class InMemoryEventLog implements EventLogRepo {
  private events: Array<{ seq: number; type: string; data: string }> = [];
  private nextSeq = 1;

  constructor(private stamp: (e: SessionEvent) => void) {}

  append(event: SessionEvent): void {
    this.stamp(event);
    this.events.push({
      seq: this.nextSeq++,
      type: event.type,
      data: JSON.stringify(event),
    });
  }

  getEvents(afterSeq?: number): SessionEvent[] {
    const filtered =
      afterSeq !== undefined ? this.events.filter((e) => e.seq > afterSeq) : this.events;
    return filtered.map((e) => JSON.parse(e.data) as SessionEvent);
  }

  getLastEventSeq(type: string): number {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].type === type) return this.events[i].seq;
    }
    return -1;
  }

  getFirstEventAfter(
    afterSeq: number,
    types: string[],
  ): { seq: number; data: string } | null {
    const set = new Set(types);
    for (const e of this.events) {
      if (e.seq > afterSeq && set.has(e.type)) {
        return { seq: e.seq, data: e.data };
      }
    }
    return null;
  }
}

export class InMemoryStreamBuffer implements StreamBufferRepo {
  private buffer: StreamBuffer | null = null;

  async put(buffer: StreamBuffer): Promise<void> {
    this.buffer = { ...buffer, chunks: [...buffer.chunks] };
  }

  async get(): Promise<StreamBuffer | null> {
    return this.buffer ? { ...this.buffer, chunks: [...this.buffer.chunks] } : null;
  }

  async clear(): Promise<void> {
    this.buffer = null;
  }
}
