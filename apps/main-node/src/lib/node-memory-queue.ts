// Node memory-events wiring — bridges chokidar fs events into the same
// processMemoryEvent path the CF queue handler uses.
//
// Why: keeps a single canonical "what to do when a memory blob changes"
// implementation in packages/queue/handlers/memory-events. Differences:
//   - CF source: R2 Event Notifications → CF Queue → batch handler
//   - Node source: chokidar fs watcher (this file) → in-memory or PG
//     queue → same handler
//
// SQLite single-instance: in-memory queue. PG multi-replica: PG-table
// queue with FOR UPDATE SKIP LOCKED so two replicas don't double-process.
//
// Loop avoidance + idempotency are inherited from the handler — same
// (storeId, path, etag) dedupe.

import { promises as fs } from "node:fs";
import { join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { watch as chokidarWatch } from "chokidar";
import type { R2EventMessage } from "@open-managed-agents/shared";
import {
  type MemoryRepo,
  type BlobStore as MemoryBlobStore,
} from "@open-managed-agents/memory-store";
import type { SqlClient } from "@open-managed-agents/sql-client";
import {
  createInMemoryQueue,
  createInMemoryDlq,
  createPgQueue,
  createPgDlq,
  ensureQueueSchema,
  type Queue,
  type DeadLetterQueue,
} from "@open-managed-agents/queue";
import {
  processMemoryEvent,
  type MemoryEvent,
} from "@open-managed-agents/queue/handlers/memory-events";

export interface NodeMemoryQueueDeps {
  /** "in-memory" for SQLite single-instance; "pg" for multi-replica.
   *  PG-mode requires `sql` to be a PG SqlClient. */
  mode: "in-memory" | "pg";
  sql?: SqlClient;
  memoryRepo: MemoryRepo;
  memoryBlobs: MemoryBlobStore;
  memoryRoot: string;
  logger?: { log: (m: string, c?: unknown) => void; warn: (m: string, c?: unknown) => void };
}

export interface NodeMemoryQueueHandle {
  queue: Queue<MemoryEvent>;
  dlq: DeadLetterQueue<MemoryEvent>;
  stop(): Promise<void>;
}

export async function startNodeMemoryQueue(
  deps: NodeMemoryQueueDeps,
): Promise<NodeMemoryQueueHandle> {
  const log = deps.logger ?? console;

  // Ensure the queue table exists in PG mode. SQLite single-instance
  // uses the in-memory queue, no schema needed.
  if (deps.mode === "pg") {
    if (!deps.sql) throw new Error("startNodeMemoryQueue: PG mode requires sql");
    await ensureQueueSchema(deps.sql);
  }

  const dlq: DeadLetterQueue<MemoryEvent> =
    deps.mode === "pg"
      ? createPgDlq<MemoryEvent>({ name: "memory-events", sql: deps.sql! })
      : createInMemoryDlq<MemoryEvent>();

  const queue: Queue<MemoryEvent> =
    deps.mode === "pg"
      ? createPgQueue<MemoryEvent>({
          name: "memory-events",
          sql: deps.sql!,
          maxRetries: 5,
        })
      : createInMemoryQueue<MemoryEvent>({ dlq, maxRetries: 5 });

  // Subscriber. Wrap memoryBlobs into the {getText} contract the handler
  // expects. Local-FS adapter already has getText/head; we forward.
  const stopMain = queue.subscribe((msg) =>
    processMemoryEvent(msg.body, {
      blobs: {
        getText: async (key) => {
          const r = await deps.memoryBlobs.getText(key);
          return r ?? null;
        },
      },
      resolveRepo: () => deps.memoryRepo,
    }),
  );

  // DLQ subscriber — log loudly. Node has no AE / Slack webhook by default;
  // operators can override this by replacing this with their own subscriber
  // before this file runs (advanced).
  const stopDlq = dlq.subscribe(async (msg) => {
    log.warn(`[node-memory-queue] DLQ message id=${msg.id} attempts=${msg.attempts}`, msg.body);
  });

  // chokidar watcher — same logic as the existing memory-blob-watcher,
  // but instead of calling memoryRepo directly, it enqueues a synthetic
  // R2EventMessage and lets the queue subscriber drive the upsert.
  const watcher = chokidarWatch(deps.memoryRoot, {
    ignored: (p) => p.endsWith(".meta.json"),
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  watcher.on("add", (p) => void onWrite(p, deps, queue, log));
  watcher.on("change", (p) => void onWrite(p, deps, queue, log));
  watcher.on("unlink", (p) => void onUnlink(p, deps, queue, log));
  watcher.on("error", (err) => log.warn(`[node-memory-queue] watcher error:`, err));

  log.log(`[node-memory-queue] watching ${deps.memoryRoot} mode=${deps.mode}`);

  return {
    queue,
    dlq,
    async stop() {
      await Promise.resolve(stopMain());
      await Promise.resolve(stopDlq());
      await watcher.close();
    },
  };
}

function parseKey(absPath: string, root: string): { storeId: string; memoryPath: string } | null {
  const rel = relative(root, absPath);
  if (rel.startsWith("..")) return null;
  const parts = rel.split(sep);
  if (parts.length < 2) return null;
  const [storeId, ...rest] = parts;
  if (!storeId) return null;
  return { storeId, memoryPath: "/" + rest.join("/") };
}

async function onWrite(
  absPath: string,
  deps: NodeMemoryQueueDeps,
  queue: Queue<MemoryEvent>,
  log: NonNullable<NodeMemoryQueueDeps["logger"]>,
): Promise<void> {
  try {
    const parsed = parseKey(absPath, deps.memoryRoot);
    if (!parsed) return;
    let buf: Buffer;
    try {
      buf = await fs.readFile(absPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    const sha = createHash("sha256").update(buf).digest("hex");
    const evt: R2EventMessage = {
      account: "node",
      action: "PutObject",
      bucket: "local",
      object: { key: `${parsed.storeId}${parsed.memoryPath}`, size: buf.byteLength, eTag: sha },
      eventTime: new Date().toISOString(),
    };
    await queue.enqueue(evt);
  } catch (err) {
    log.warn(`[node-memory-queue] enqueue add ${absPath} failed:`, err);
  }
}

async function onUnlink(
  absPath: string,
  deps: NodeMemoryQueueDeps,
  queue: Queue<MemoryEvent>,
  log: NonNullable<NodeMemoryQueueDeps["logger"]>,
): Promise<void> {
  try {
    const parsed = parseKey(absPath, deps.memoryRoot);
    if (!parsed) return;
    const evt: R2EventMessage = {
      account: "node",
      action: "DeleteObject",
      bucket: "local",
      object: { key: `${parsed.storeId}${parsed.memoryPath}` },
      eventTime: new Date().toISOString(),
    };
    await queue.enqueue(evt);
  } catch (err) {
    log.warn(`[node-memory-queue] enqueue unlink ${absPath} failed:`, err);
  }
}

export { join };
