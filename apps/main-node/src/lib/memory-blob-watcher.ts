// Memory blob watcher — keeps the SQL memories index in sync with direct
// filesystem writes from the sandbox.
//
// Why: agents write to /mnt/memory/<storeName>/<path> via tools, which the
// sandbox resolves through a symlink onto the BlobStore's on-disk layout
// at <memoryRoot>/<storeId>/<path>. main-node's memoryService.writeByPath
// is NOT called for these writes, so the SQL `memories` table doesn't
// learn about them and /v1/memories listings get stale.
//
// On Cloudflare the same problem is solved by R2 event notifications →
// Queue → memory-events consumer → memoryRepo.upsertFromEvent. We use
// chokidar to play the role of "R2 event source" on the local filesystem,
// dispatching to the same upsertFromEvent / deleteFromEvent the CF queue
// consumer uses — single source of truth for the index update logic.
//
// Loop avoidance:
//   - Writes that ALREADY went through memoryService.writeByPath also hit
//     this watcher (the file change is the same). The upsertFromEvent path
//     is idempotent on (storeId, path, contentSha256) — re-running it on
//     unchanged content is a no-op besides bumping updated_at, which is
//     acceptable. We could maintain a debounce/skip list but the
//     additional complexity isn't worth it in a single-instance build.
//
//   - .meta.json sidecar writes from LocalFsBlobStore trigger events too;
//     we filter those out by suffix.

import { promises as fs } from "node:fs";
import { join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { watch as chokidarWatch } from "chokidar";
import { generateMemoryVersionId } from "@open-managed-agents/shared";
import type { MemoryRepo } from "@open-managed-agents/memory-store";

export interface MemoryBlobWatcherOptions {
  memoryRoot: string;        // absolute path to LocalFsBlobStore.baseDir
  memoryRepo: MemoryRepo;    // sql-memory-repo instance
  logger?: { log: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
}

export function startMemoryBlobWatcher(opts: MemoryBlobWatcherOptions): { stop: () => Promise<void> } {
  const log = opts.logger ?? console;
  const watcher = chokidarWatch(opts.memoryRoot, {
    ignored: (p) => p.endsWith(".meta.json"),
    persistent: true,
    ignoreInitial: true,        // initial scan is unnecessary — anything
                                // already on disk is either a memory we
                                // wrote ourselves (already indexed) or a
                                // stale orphan that the agent will rewrite.
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  watcher.on("add", (p) => void onWrite(p, opts, log).catch((err) =>
    log.warn(`[memory-watcher] add ${p} failed:`, err.message),
  ));
  watcher.on("change", (p) => void onWrite(p, opts, log).catch((err) =>
    log.warn(`[memory-watcher] change ${p} failed:`, err.message),
  ));
  watcher.on("unlink", (p) => void onUnlink(p, opts, log).catch((err) =>
    log.warn(`[memory-watcher] unlink ${p} failed:`, err.message),
  ));
  watcher.on("error", (err) => log.warn(`[memory-watcher] error:`, err));

  log.log(`[memory-watcher] watching ${opts.memoryRoot}`);

  return {
    async stop() {
      await watcher.close();
    },
  };
}

function parseKey(absPath: string, root: string): { storeId: string; memoryPath: string } | null {
  const rel = relative(root, absPath);
  if (rel.startsWith("..")) return null;
  // First path segment is the storeId; remainder is the memory path.
  const parts = rel.split(sep);
  if (parts.length < 2) return null;
  const [storeId, ...rest] = parts;
  if (!storeId) return null;
  // Mirror service.ts's r2Key — memory paths lead with "/".
  return { storeId, memoryPath: "/" + rest.join("/") };
}

async function onWrite(
  absPath: string,
  opts: MemoryBlobWatcherOptions,
  log: NonNullable<MemoryBlobWatcherOptions["logger"]>,
): Promise<void> {
  const parsed = parseKey(absPath, opts.memoryRoot);
  if (!parsed) return;
  let buf: Buffer;
  try {
    buf = await fs.readFile(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // raced with delete
    throw err;
  }
  const text = buf.toString("utf8");
  const sha = createHash("sha256").update(buf).digest("hex");
  const result = await opts.memoryRepo.upsertFromEvent({
    storeId: parsed.storeId,
    path: parsed.memoryPath,
    contentSha256: sha,
    etag: sha,                    // LocalFsBlobStore uses sha256 as etag
    sizeBytes: buf.byteLength,
    actor: { type: "agent_session", id: "fs-watcher" },
    nowMs: Date.now(),
    versionId: generateMemoryVersionId(),
    content: text,
  });
  if (result.wrote) {
    log.log(`[memory-watcher] indexed ${parsed.storeId}${parsed.memoryPath} (${result.row?.id ?? "?"})`);
  }
}

async function onUnlink(
  absPath: string,
  opts: MemoryBlobWatcherOptions,
  log: NonNullable<MemoryBlobWatcherOptions["logger"]>,
): Promise<void> {
  const parsed = parseKey(absPath, opts.memoryRoot);
  if (!parsed) return;
  const result = await opts.memoryRepo.deleteFromEvent({
    storeId: parsed.storeId,
    path: parsed.memoryPath,
    actor: { type: "agent_session", id: "fs-watcher" },
    nowMs: Date.now(),
    versionId: generateMemoryVersionId(),
  });
  if (result.wrote) {
    log.log(`[memory-watcher] removed ${parsed.storeId}${parsed.memoryPath}`);
  }
}

// Re-export the path helper join for tests / parity with the service.
export { join };
