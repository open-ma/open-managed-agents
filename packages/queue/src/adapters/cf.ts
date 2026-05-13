// CF Queues adapter.
//
// Producer: `enqueue` → `binding.send(body)`. enqueueBatch uses sendBatch
// when the binding is present (CF supports it).
//
// Consumer: register the handler via `subscribe()`. The CF entry's
// `queue(batch, env)` export then calls `dispatchCfBatch(handler, batch)`
// which iterates and ack/retries per-message. Same contract for the
// DLQ binding.

import type {
  DeadLetterQueue,
  EnqueueOptions,
  Queue,
  QueueHandler,
  QueueMessage,
  QueueStats,
} from "../ports";

export interface CfQueueDeps<T> {
  /** CF Queue binding for the producer side. Pass null when the worker
   *  only consumes (rare). */
  binding: {
    send(body: T, opts?: { delaySeconds?: number }): Promise<void>;
    sendBatch?(
      messages: Array<{ body: T; delaySeconds?: number }>,
    ): Promise<void>;
  } | null;
}

interface CfBatchMessage<T> {
  id: string;
  timestamp: Date;
  attempts: number;
  body: T;
  ack(): void;
  retry(): void;
}

interface CfBatch<T> {
  queue: string;
  messages: ReadonlyArray<CfBatchMessage<T>>;
}

export function createCfQueue<T>(deps: CfQueueDeps<T>): Queue<T> & {
  /** Internal — exposed for dispatchCfBatch. Never null after subscribe. */
  __handler: QueueHandler<T> | null;
} {
  let handler: QueueHandler<T> | null = null;
  return {
    get __handler() { return handler; },
    async enqueue(message, opts) {
      if (!deps.binding) throw new Error("CF queue binding missing");
      await deps.binding.send(message, opts?.delaySec ? { delaySeconds: opts.delaySec } : undefined);
    },
    async enqueueBatch(messages, opts) {
      if (!deps.binding) throw new Error("CF queue binding missing");
      if (deps.binding.sendBatch) {
        await deps.binding.sendBatch(
          messages.map((body) =>
            opts?.delaySec ? { body, delaySeconds: opts.delaySec } : { body },
          ),
        );
        return;
      }
      // Fallback: serial sends if the binding doesn't expose sendBatch.
      for (const m of messages) await deps.binding.send(m);
    },
    subscribe(h) {
      handler = h;
      return () => { handler = null; };
    },
    async getStats(): Promise<QueueStats> {
      // CF Queues doesn't surface backlog/inflight cheaply; report 0.
      return { inflight: 0, pending: 0 };
    },
  };
}

/**
 * Dispatch a CF queue batch to the registered handler. ack on success,
 * retry on throw — the wrangler `max_retries` + DLQ wiring handles the
 * deferred-retry semantics. Per-message try/catch so one bad message
 * doesn't poison the whole batch.
 */
export async function dispatchCfBatch<T>(
  queue: Queue<T> & { __handler: QueueHandler<T> | null },
  batch: CfBatch<T>,
): Promise<void> {
  const handler = queue.__handler;
  if (!handler) throw new Error("dispatchCfBatch: no subscriber registered");
  for (const m of batch.messages) {
    const msg: QueueMessage<T> = {
      id: m.id,
      body: m.body,
      attempts: m.attempts,
      enqueuedAt: m.timestamp.getTime(),
    };
    try {
      await handler(msg);
      m.ack();
    } catch {
      m.retry();
    }
  }
}

export function createCfDlq<T>(): DeadLetterQueue<T> & {
  __handler: QueueHandler<T> | null;
} {
  let handler: QueueHandler<T> | null = null;
  return {
    get __handler() { return handler; },
    subscribe(h) {
      handler = h;
      return () => { handler = null; };
    },
    async replay() {
      // CF DLQ replay is a manual ops action via `wrangler queues consumer
      // put` + an inline filter; we don't expose it programmatically here.
      // Returning 0 keeps the contract honest.
      return 0;
    },
  };
}
