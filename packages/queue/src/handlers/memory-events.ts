// memory-events handler — runtime-agnostic core that takes a single
// `MemoryEvent` (R2-style PUT/DELETE message body) and reflects it into
// the SQL `memories` index + `memory_versions` audit.
//
// Used by:
//   - apps/main (CF) `queue(batch, env)` entry — wraps in dispatchCfBatch
//     to convert the CF MessageBatch into per-message handler() calls.
//   - apps/main-node — chokidar watcher / S3 poller already do the
//     index update inline today; the handler is also wired through the
//     in-memory or PG queue so a future "deferred memory event" path
//     (e.g. retry on transient repo error) goes through the same code.
//
// Idempotency: dedupe key is (storeId, path, etag) — same etag = same
// content = no work. Inherits this from MemoryRepo.upsertFromEvent.

import {
  generateMemoryVersionId,
  type R2EventMessage,
} from "@open-managed-agents/shared";
import {
  type MemoryRepo,
  type Actor,
  parseR2Key,
  sha256Hex,
} from "@open-managed-agents/memory-store";
import type { QueueHandler, QueueMessage } from "../ports";

export interface MemoryEventsDeps {
  /** Resolve the per-shard memory repo for a given store_id. CF builds
   *  this off the tenant-shard index + a CfD1SqlClient; Node returns its
   *  single SqlMemoryRepo. */
  resolveRepo: (storeId: string) => Promise<MemoryRepo> | MemoryRepo;
  /** Read R2 / blob bytes by key. CF wraps a CfR2BlobStore; Node has its
   *  Local / S3 BlobStore — both implement getText + head. */
  blobs: {
    getText(key: string): Promise<{ text: string; etag: string; size: number } | null>;
    head?(key: string): Promise<unknown | null>;
  };
  logger?: {
    log: (ctx: Record<string, unknown>, msg: string) => void;
    warn: (ctx: Record<string, unknown>, msg: string) => void;
  };
}

export type MemoryEvent = R2EventMessage;

/**
 * Per-message processor. Throws on transient failure (repo down, R2
 * unreachable) so the queue adapter retries; returns silently on
 * permanent skip (bad key shape, missing object).
 */
export async function processMemoryEvent(
  event: MemoryEvent,
  deps: MemoryEventsDeps,
): Promise<void> {
  const log = deps.logger ?? {
    log: (c, m) => console.log(m, c),
    warn: (c, m) => console.warn(m, c),
  };
  const key = event.object?.key;
  if (!key) return;
  const parsed = parseR2Key(key);
  if (!parsed) {
    log.warn({ op: "queue.memory_events.skip_bad_key", key }, "unexpected key shape");
    return;
  }
  const { storeId, memoryPath } = parsed;
  const memoryRepo = await deps.resolveRepo(storeId);
  const nowMs = Date.now();

  if (event.action === "DeleteObject" || event.action === "LifecycleDeletion") {
    const result = await memoryRepo.deleteFromEvent({
      storeId,
      path: memoryPath,
      actor: deriveActor(),
      nowMs,
      versionId: generateMemoryVersionId(),
    });
    log.log(
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
    const blob = await deps.blobs.getText(key);
    if (!blob) {
      // Object vanished between event and consumer — treat as
      // delete-after-write race. Skip; the next event will be delete.
      log.warn({ op: "queue.memory_events.put_but_missing", key }, "PUT event but blob missing");
      return;
    }
    const sha = await sha256Hex(blob.text);
    const result = await memoryRepo.upsertFromEvent({
      storeId,
      path: memoryPath,
      contentSha256: sha,
      etag: blob.etag,
      sizeBytes: blob.size,
      actor: deriveActor(),
      nowMs,
      versionId: generateMemoryVersionId(),
      content: blob.text,
    });
    log.log(
      { op: "queue.memory_events.upsert", key, store_id: storeId, wrote: result.wrote },
      "memory upsert event processed",
    );
    return;
  }

  log.warn({ op: "queue.memory_events.unknown_action", action: event.action, key }, "unknown action");
}

/** Adapter helper — wrap processMemoryEvent into the QueueHandler shape. */
export function memoryEventsHandler(deps: MemoryEventsDeps): QueueHandler<MemoryEvent> {
  return (msg: QueueMessage<MemoryEvent>) => processMemoryEvent(msg.body, deps);
}

function deriveActor(): Actor {
  // R2 customMetadata round-trip via R2 Event Notifications is not currently
  // exposed in the event body. Attribute event-derived versions as
  // agent_session to match the most likely producer (FUSE write); REST
  // writes already wrote their own version row inline before the event fired.
  return { type: "agent_session", id: "unknown" };
}
