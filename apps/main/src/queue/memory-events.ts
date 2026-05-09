import {
  generateMemoryVersionId,
  log,
  logError,
  logWarn,
  type Env,
  type R2EventMessage,
} from "@open-managed-agents/shared";
import {
  CfR2BlobStore,
  SqlMemoryRepo,
  parseR2Key,
  sha256Hex,
  type Actor,
} from "@open-managed-agents/memory-store";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { buildCfTenantDbProvider } from "@open-managed-agents/services";

/**
 * Cloudflare Queue consumer for R2 Event Notifications on MEMORY_BUCKET.
 *
 * Pipeline (per the Anthropic-aligned memory architecture):
 *   R2 PUT/DELETE on `<store_id>/<memory_path>`
 *      → R2 Event Notification (set up out-of-band via
 *        `wrangler r2 bucket notification create`)
 *      → Cloudflare Queue `managed-agents-memory-events`
 *      → this consumer
 *      → D1 [memories index UPSERT, memory_versions INSERT]
 *
 * Why a queue: agent FUSE writes to /mnt/memory/<store>/<path> bypass our REST
 * service. R2 Event Notifications are how we observe those writes and reflect
 * them into D1 for audit + index consistency. REST writes ALSO produce events
 * but the service has already written the version row inline; the consumer
 * dedupes by (store_id, path, etag) so duplicates are no-ops.
 *
 * Idempotency: R2 events are at-least-once. The consumer's dedupe key is
 * (store_id, path, etag) — same etag = same R2 object = same logical write.
 *
 * Error handling: per-message failures throw and let the runtime ack-with-retry
 * (configured in wrangler.jsonc max_retries + DLQ). Batch-level failures
 * (D1 down) propagate up so the whole batch retries.
 */
export async function handleMemoryEvents(
  batch: MessageBatch<R2EventMessage>,
  env: Env,
): Promise<void> {
  if (!env.MEMORY_BUCKET) {
    logError(
      { op: "queue.memory_events", batch_size: batch.messages.length },
      "MEMORY_BUCKET binding missing — cannot process memory events",
    );
    // Don't ack — let messages retry on a deploy with the binding present.
    for (const m of batch.messages) m.retry();
    return;
  }
  if (!env.AUTH_DB) {
    logError(
      { op: "queue.memory_events", batch_size: batch.messages.length },
      "AUTH_DB binding missing — cannot process memory events",
    );
    for (const m of batch.messages) m.retry();
    return;
  }

  const blobs = new CfR2BlobStore(env.MEMORY_BUCKET);
  const provider = buildCfTenantDbProvider(env);
  const controlPlaneDb = env.ROUTER_DB ?? env.AUTH_DB;
  // Per-batch cache of store_id → SqlMemoryRepo. The repo wraps the
  // resolved per-tenant shard's SqlClient. Avoids one ROUTER_DB lookup
  // per message when a batch has many events for the same store
  // (typical agent burst writes).
  const repoCache = new Map<string, SqlMemoryRepo>();
  const resolveRepo = async (storeId: string): Promise<SqlMemoryRepo> => {
    const cached = repoCache.get(storeId);
    if (cached) return cached;
    const tenantId = await lookupTenantForStore(controlPlaneDb, storeId);
    if (!tenantId) {
      // Legacy / pre-shard fallback: store_id has no entry in
      // memory_store_tenant. All such stores live on AUTH_DB_00 (= AUTH_DB)
      // since they were created before this index existed. Wrap and cache.
      const fallback = new SqlMemoryRepo(new CfD1SqlClient(env.AUTH_DB));
      repoCache.set(storeId, fallback);
      return fallback;
    }
    const db = await provider.resolve(tenantId);
    const repo = new SqlMemoryRepo(new CfD1SqlClient(db));
    repoCache.set(storeId, repo);
    return repo;
  };
  const now = Date.now();

  for (const message of batch.messages) {
    try {
      await processOne(message.body, { blobs, resolveRepo, nowMs: now });
      message.ack();
    } catch (err) {
      logWarn(
        {
          op: "queue.memory_events.process_failed",
          action: message.body.action,
          key: message.body.object?.key,
          err,
        },
        "memory event processing failed; will retry",
      );
      message.retry();
    }
  }
}

/**
 * Look up which tenant owns a memory store. Reads from ROUTER_DB.memory_store_tenant
 * (populated synchronously at memory store creation in routes/memory.ts).
 * Returns null for stores that pre-date the index — caller falls back
 * to AUTH_DB.
 */
async function lookupTenantForStore(
  controlPlaneDb: D1Database,
  storeId: string,
): Promise<string | null> {
  try {
    const row = await controlPlaneDb
      .prepare("SELECT tenant_id FROM memory_store_tenant WHERE store_id = ?")
      .bind(storeId)
      .first<{ tenant_id: string }>();
    return row?.tenant_id ?? null;
  } catch (err) {
    // ROUTER_DB unreachable or table missing (legacy deploy). Fall back —
    // the caller treats null as "use AUTH_DB". Don't throw, that would
    // retry the whole batch indefinitely.
    logWarn(
      { op: "queue.memory_events.lookup_failed", store_id: storeId, err },
      "memory_store_tenant lookup failed; falling back to AUTH_DB",
    );
    return null;
  }
}

async function processOne(
  event: R2EventMessage,
  ctx: {
    blobs: CfR2BlobStore;
    resolveRepo: (storeId: string) => Promise<SqlMemoryRepo>;
    nowMs: number;
  },
): Promise<void> {
  const key = event.object?.key;
  if (!key) return;

  const parsed = parseR2Key(key);
  if (!parsed) {
    // Key shape doesn't match <store_id>/<memory_path> — likely a different
    // namespace (we don't expect any in MEMORY_BUCKET, but be defensive).
    logWarn({ op: "queue.memory_events.skip_bad_key", key }, "unexpected R2 key shape");
    return;
  }

  const { storeId, memoryPath } = parsed;
  // Route to the shard owning this store. Falls back to AUTH_DB for
  // pre-shard stores via lookupTenantForStore returning null.
  const memoryRepo = await ctx.resolveRepo(storeId);

  if (event.action === "DeleteObject" || event.action === "LifecycleDeletion") {
    const result = await memoryRepo.deleteFromEvent({
      storeId,
      path: memoryPath,
      actor: deriveActor(undefined),
      nowMs: ctx.nowMs,
      versionId: generateMemoryVersionId(),
    });
    log(
      { op: "queue.memory_events.delete", key, store_id: storeId, wrote: result.wrote },
      "memory delete event processed",
    );
    return;
  }

  if (
    event.action === "PutObject" ||
    event.action === "CopyObject" ||
    event.action === "CompleteMultipartUpload"
  ) {
    // GET the object to read its bytes (for the version row) + authoritative
    // etag/size (event payload may be best-effort). 100KB cap ensures this is
    // a small read.
    const blob = await ctx.blobs.getText(key);
    if (!blob) {
      // Object vanished between event fire and consumer run — treat as
      // delete-after-write race. Skip (next event will be the delete).
      logWarn(
        { op: "queue.memory_events.put_but_missing", key },
        "PUT event but R2 head returned null — skipping",
      );
      return;
    }

    const sha = await sha256Hex(blob.text);

    // Best-effort: read actor metadata stamped by the original writer.
    // For agent FUSE writes there's no metadata; we record actor=agent_session
    // with id=unknown.
    const head = await ctx.blobs.head(key);
    const actor = deriveActor(head ? null : undefined);

    const result = await memoryRepo.upsertFromEvent({
      storeId,
      path: memoryPath,
      contentSha256: sha,
      etag: blob.etag,
      sizeBytes: blob.size,
      actor,
      nowMs: ctx.nowMs,
      versionId: generateMemoryVersionId(),
      content: blob.text,
    });
    log(
      {
        op: "queue.memory_events.upsert",
        key,
        store_id: storeId,
        wrote: result.wrote,
      },
      "memory upsert event processed",
    );
    return;
  }

  logWarn({ op: "queue.memory_events.unknown_action", action: event.action, key }, "unknown action");
}

function deriveActor(_metadata: Record<string, string> | null | undefined): Actor {
  // R2 customMetadata round-trip via R2 Event Notifications is not currently
  // exposed in the event body (the message has key/size/etag but no custom
  // metadata). We attribute event-derived versions as agent_session to match
  // the most likely producer (agent sandbox FUSE write); the REST API path
  // already wrote its own version row inline before the event fired.
  return { type: "agent_session", id: "unknown" };
}
