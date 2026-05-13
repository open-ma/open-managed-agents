// CF queue wiring — runtime-agnostic Queue + DLQ adapters built once per
// process, dispatched to from the CF entry's `queue(batch, env)` handler.
//
// The producer side (binding.send) isn't currently used in apps/main —
// R2 Event Notifications publish to the queue out-of-band via wrangler
// config. Future "deferred memory event" callers (e.g. a bulk-replay
// route) will go through `cfMemoryQueue.enqueue(...)`.

import {
  errFields,
  log,
  logError,
  recordEvent,
  type Env,
  type R2EventMessage,
} from "@open-managed-agents/shared";
import {
  CfR2BlobStore,
  SqlMemoryRepo,
  type Actor,
} from "@open-managed-agents/memory-store";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { buildCfTenantDbProvider } from "@open-managed-agents/services";
import { createCfMemoryStoreTenantIndexService } from "@open-managed-agents/tenant-dbs-store";
import {
  createCfQueue,
  createCfDlq,
  dispatchCfBatch,
  type Queue,
  type DeadLetterQueue,
  type QueueHandler,
} from "@open-managed-agents/queue";
import {
  processMemoryEvent,
  type MemoryEvent,
} from "@open-managed-agents/queue/handlers/memory-events";

interface CfQueueBindings {
  /** Optional producer binding — present in tests/local where main also
   *  publishes; absent in prod where R2 events publish directly. */
  producer?: {
    send(body: R2EventMessage): Promise<void>;
    sendBatch?(messages: Array<{ body: R2EventMessage }>): Promise<void>;
  };
}

export function buildCfMemoryQueue(env: Env, bindings: CfQueueBindings = {}): {
  queue: Queue<MemoryEvent> & { __handler: QueueHandler<MemoryEvent> | null };
  dlq: DeadLetterQueue<MemoryEvent> & { __handler: QueueHandler<MemoryEvent> | null };
} {
  // Per-isolate caches keyed by store_id — same pattern the pre-extract
  // handler used. New entries on cache miss; never invalidated (a
  // worker isolate is short-lived enough that staleness can't bite).
  const repoCache = new Map<string, SqlMemoryRepo>();
  const provider = buildCfTenantDbProvider(env);

  const queue = createCfQueue<MemoryEvent>({
    binding: bindings.producer ?? null,
  });

  queue.subscribe(async (msg) => {
    if (!env.MEMORY_BUCKET) {
      throw new Error("MEMORY_BUCKET binding missing");
    }
    if (!env.AUTH_DB) {
      throw new Error("AUTH_DB binding missing");
    }
    const blobs = new CfR2BlobStore(env.MEMORY_BUCKET);
    const tenantIndex = createCfMemoryStoreTenantIndexService({
      controlPlaneDb: env.ROUTER_DB ?? env.AUTH_DB,
    });
    const resolveRepo = async (storeId: string): Promise<SqlMemoryRepo> => {
      const cached = repoCache.get(storeId);
      if (cached) return cached;
      let tenantId: string | null = null;
      try {
        tenantId = await tenantIndex.lookup(storeId);
      } catch (err) {
        log(
          { op: "queue.memory_events.lookup_failed", store_id: storeId, err },
          "memory_store_tenant lookup failed; falling back to AUTH_DB",
        );
      }
      if (!tenantId) {
        const fallback = new SqlMemoryRepo(new CfD1SqlClient(env.AUTH_DB));
        repoCache.set(storeId, fallback);
        return fallback;
      }
      const db = await provider.resolve(tenantId);
      const repo = new SqlMemoryRepo(new CfD1SqlClient(db));
      repoCache.set(storeId, repo);
      return repo;
    };

    await processMemoryEvent(msg.body, {
      blobs: {
        getText: (key) => blobs.getText(key),
        head: (key) => blobs.head(key),
      },
      resolveRepo,
    });
  });

  // DLQ subscriber — log + AE + best-effort ops webhook. Never throws.
  const dlq = createCfDlq<MemoryEvent>();
  dlq.subscribe(async (msg) => {
    try {
      const body = msg.body;
      const action = (body as { action?: string })?.action ?? "(no action)";
      const key = (body as { object?: { key?: string } })?.object?.key ?? "(no key)";

      logError(
        {
          op: "queue.dlq.memory_events.message",
          message_id: msg.id,
          attempts: msg.attempts,
          r2_action: action,
          r2_key: key,
          body,
        },
        "memory event reached DLQ — main consumer failed past retry limit",
      );

      recordEvent(env.ANALYTICS, {
        op: "queue.dlq.memory_events",
        tenant_id: storeIdFromKey(key),
        error_name: "DLQReached",
        error_message: `${action} ${key} attempts=${msg.attempts}`,
      });

      await maybeNotify(env, {
        action,
        key,
        attempts: msg.attempts,
        message_id: msg.id,
      });
    } catch (err) {
      logError(
        {
          op: "queue.dlq.memory_events.handler_failed",
          message_id: msg.id,
          ...errFields(err),
        },
        "DLQ handler threw — swallowing to keep DLQ draining",
      );
    }
  });

  return { queue, dlq };
}

/** Dispatch a CF queue batch through the queue OR dlq based on
 *  `batch.queue`. Mirrors the pre-extract `if (batch.queue.endsWith("-dlq"))`
 *  switch in apps/main/src/index.ts. */
export async function dispatchCfMemoryQueueBatch(
  batch: MessageBatch<MemoryEvent>,
  q: ReturnType<typeof buildCfMemoryQueue>,
): Promise<void> {
  if (batch.queue.endsWith("-dlq")) {
    // DLQ adapter doesn't have its own dispatcher because it's terminal —
    // we always ack (no retry semantics). Inline that here.
    const handler = q.dlq.__handler;
    if (!handler) return;
    log(
      { op: "queue.dlq.memory_events", batch_size: batch.messages.length },
      "memory-events DLQ batch received",
    );
    for (const m of batch.messages) {
      try {
        await handler({
          id: m.id,
          body: m.body,
          attempts: m.attempts,
          enqueuedAt: m.timestamp.getTime(),
        });
      } finally {
        m.ack(); // never throw — keep DLQ draining
      }
    }
    return;
  }
  // Main queue: ack on success, retry on throw — handled by dispatchCfBatch.
  // Pre-flight check on bindings: if MEMORY_BUCKET / AUTH_DB are missing
  // we want every message to retry (next deploy with bindings present),
  // matching the pre-extract behaviour.
  if (!env_has_required(batch, q)) return;
  await dispatchCfBatch(q.queue, batch);
}

function env_has_required(_batch: MessageBatch<MemoryEvent>, _q: ReturnType<typeof buildCfMemoryQueue>): boolean {
  // The handler itself throws when bindings are missing → retries kick in.
  // No extra pre-check needed. Retained as a hook for future early-exit logic.
  return true;
}

// ---------- DLQ helpers (kept here so handler can stay tiny) ----------

function storeIdFromKey(key: string): string {
  const i = key.indexOf("/");
  if (i <= 0) return "";
  return key.slice(0, i);
}

interface DlqAlert {
  action: string;
  key: string;
  attempts: number;
  message_id: string;
}

async function maybeNotify(env: Env, alert: DlqAlert): Promise<void> {
  const url = (env as unknown as { OPS_WEBHOOK_URL?: string }).OPS_WEBHOOK_URL;
  if (!url) return;
  const text =
    `:warning: memory-events DLQ\n` +
    `action=\`${alert.action}\`\n` +
    `key=\`${alert.key}\`\n` +
    `attempts=${alert.attempts}\n` +
    `message_id=\`${alert.message_id}\``;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      log(
        { op: "queue.dlq.memory_events.notify_non_ok", status: res.status },
        "ops webhook returned non-OK; alert not delivered",
      );
    }
  } catch (err) {
    log(
      { op: "queue.dlq.memory_events.notify_failed", ...errFields(err) },
      "ops webhook fetch threw; alert not delivered",
    );
  }
}

// Re-export for convenience.
export { type Actor };
