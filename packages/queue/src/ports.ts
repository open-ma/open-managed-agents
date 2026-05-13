// Queue / DeadLetterQueue ports.
//
// The two interfaces are kept narrow on purpose — no JobOptions base, no
// QueueAdmin, no abstract Subscription. CF Queues, PG-table polling, and
// in-memory dispatch all collapse onto the same four methods.

export interface QueueMessage<T> {
  /** Message id (CF: from the Queues binding; PG: row pkey). */
  id: string;
  body: T;
  /** 1-based delivery attempt count. The consumer reports >maxRetries
   *  as DLQ via the adapter's contract. */
  attempts: number;
  /** Caller-set timestamp from the original enqueue. */
  enqueuedAt: number;
}

export interface EnqueueOptions {
  /** Delay in seconds before the message becomes visible to consumers.
   *  CF supports it natively; the PG adapter uses next_visible_at. */
  delaySec?: number;
}

export type QueueHandler<T> = (
  msg: QueueMessage<T>,
) => Promise<void> | void;

export interface QueueStats {
  /** Inflight = currently locked or being processed. PG adapter knows;
   *  CF returns 0 (CF Queues doesn't expose it cheaply). */
  inflight: number;
  /** Backlog of pending messages. Same caveat. */
  pending: number;
}

export interface Queue<T> {
  enqueue(message: T, opts?: EnqueueOptions): Promise<void>;
  enqueueBatch(messages: T[], opts?: EnqueueOptions): Promise<void>;
  /** Register the consumer. The PG / in-memory adapters start a polling
   *  loop here; the CF adapter wires the handler so dispatchCfBatch can
   *  invoke it from the runtime's `queue(batch, env)` entry. Returns a
   *  function to stop the subscription. */
  subscribe(handler: QueueHandler<T>): () => void | Promise<void>;
  getStats(): Promise<QueueStats>;
}

export interface DeadLetterQueue<T> {
  /** Subscribe to messages that exhausted retries on the main queue.
   *  Same return-to-stop contract as Queue.subscribe. */
  subscribe(handler: QueueHandler<T>): () => void | Promise<void>;
  /** Re-enqueue specific message ids back onto the main queue (manual ops
   *  action). Returns the count actually replayed. */
  replay(ids: string[]): Promise<number>;
}
