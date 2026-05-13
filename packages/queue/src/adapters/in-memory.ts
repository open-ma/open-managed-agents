// In-memory Queue + DLQ. For SQLite single-instance deployments and unit
// tests. Messages are dispatched synchronously via setImmediate after
// enqueue so the consumer runs before the next event-loop tick — gives
// queue.subscribe consumers the same "fire then process" causal order
// they get from the CF / PG adapters.
//
// On handler throw, attempts increments and the message re-enqueues
// (also via setImmediate). After `maxRetries` failures it lands in the
// DLQ. No persistence: a process restart loses pending messages.

import type {
  DeadLetterQueue,
  EnqueueOptions,
  Queue,
  QueueHandler,
  QueueMessage,
  QueueStats,
} from "../ports";

interface InMemoryEntry<T> {
  id: string;
  body: T;
  attempts: number;
  enqueuedAt: number;
}

export interface InMemoryQueueOptions<T> {
  /** DLQ to land messages in after maxRetries failures. Pass an
   *  in-memory DLQ from createInMemoryDlq, or null to drop on exhaustion
   *  (still logged via `onDrop`). */
  dlq?: DeadLetterQueue<T> | null;
  maxRetries?: number;
  /** Called when a message exhausts retries with no DLQ. Defaults to
   *  console.warn. */
  onDrop?: (msg: QueueMessage<T>, err: unknown) => void;
}

export function createInMemoryQueue<T>(opts: InMemoryQueueOptions<T> = {}): Queue<T> {
  const maxRetries = opts.maxRetries ?? 5;
  let handler: QueueHandler<T> | null = null;
  const inflight = new Set<string>();
  const pending: InMemoryEntry<T>[] = [];

  function dispatch(entry: InMemoryEntry<T>): void {
    setImmediate(async () => {
      if (!handler) {
        // Re-queue so the next subscribe picks it up.
        pending.push(entry);
        return;
      }
      inflight.add(entry.id);
      try {
        const msg: QueueMessage<T> = {
          id: entry.id,
          body: entry.body,
          attempts: entry.attempts,
          enqueuedAt: entry.enqueuedAt,
        };
        await handler(msg);
      } catch (err) {
        if (entry.attempts >= maxRetries) {
          // Exhausted. Hand to DLQ via the same in-memory plumbing or drop.
          if (opts.dlq && (opts.dlq as InMemoryDlq<T>).__push) {
            (opts.dlq as InMemoryDlq<T>).__push(entry);
          } else {
            (opts.onDrop ?? ((m, e) => console.warn(`[queue] message dropped after ${m.attempts} attempts:`, e)))(
              { id: entry.id, body: entry.body, attempts: entry.attempts, enqueuedAt: entry.enqueuedAt },
              err,
            );
          }
        } else {
          entry.attempts += 1;
          // Backoff: 100ms * attempts. Bounded since maxRetries is small.
          setTimeout(() => dispatch(entry), 100 * entry.attempts);
        }
      } finally {
        inflight.delete(entry.id);
      }
    });
  }

  return {
    async enqueue(body, _opts) {
      const entry: InMemoryEntry<T> = {
        id: nanoLikeId(),
        body,
        attempts: 1,
        enqueuedAt: Date.now(),
      };
      // Drop opts.delaySec on the floor for the in-memory adapter — single
      // instance, retention sweeps run via the scheduler, not through here.
      pending.push(entry);
      // Drain immediately if there's a handler attached.
      if (handler) {
        const e = pending.shift();
        if (e) dispatch(e);
      }
    },
    async enqueueBatch(messages, opts) {
      for (const m of messages) await this.enqueue(m, opts);
    },
    subscribe(h) {
      handler = h;
      // Drain whatever was enqueued before subscribe arrived.
      while (pending.length > 0) {
        const e = pending.shift();
        if (e) dispatch(e);
      }
      return () => {
        handler = null;
      };
    },
    async getStats(): Promise<QueueStats> {
      return { inflight: inflight.size, pending: pending.length };
    },
  };
}

interface InMemoryDlq<T> extends DeadLetterQueue<T> {
  __push(entry: InMemoryEntry<T>): void;
}

export function createInMemoryDlq<T>(): DeadLetterQueue<T> {
  let handler: QueueHandler<T> | null = null;
  const messages = new Map<string, InMemoryEntry<T>>();

  const dlq: InMemoryDlq<T> = {
    __push(entry) {
      messages.set(entry.id, entry);
      if (handler) {
        const h = handler;
        setImmediate(async () => {
          try {
            await h({
              id: entry.id,
              body: entry.body,
              attempts: entry.attempts,
              enqueuedAt: entry.enqueuedAt,
            });
          } catch (e) {
            // DLQ subscriber must never throw; log and move on.
            console.warn("[queue] DLQ subscriber threw:", e);
          }
        });
      }
    },
    subscribe(h) {
      handler = h;
      // Drain any messages that arrived before subscribe.
      for (const entry of messages.values()) {
        const m: QueueMessage<T> = {
          id: entry.id,
          body: entry.body,
          attempts: entry.attempts,
          enqueuedAt: entry.enqueuedAt,
        };
        setImmediate(() => Promise.resolve(h(m)).catch((e) => console.warn("[queue] DLQ subscriber threw:", e)));
      }
      return () => { handler = null; };
    },
    async replay(ids) {
      // For the in-memory adapter "replay" just removes from DLQ; the
      // caller is responsible for re-enqueueing onto the main queue
      // since we don't carry a back-reference.
      let n = 0;
      for (const id of ids) if (messages.delete(id)) n++;
      return n;
    },
  };
  return dlq;
}

let counter = 0;
function nanoLikeId(): string {
  counter = (counter + 1) & 0xffffff;
  return `mem_${Date.now().toString(36)}_${counter.toString(36)}`;
}
