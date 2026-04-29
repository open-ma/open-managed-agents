// Cloudflare adapter wiring. Exports concrete implementations of every
// MemoryStoreService port against Cloudflare bindings (D1 + R2), plus a
// `createCfMemoryStoreService` factory that callers in apps/main and
// apps/agent use to instantiate the service.

export { D1MemoryStoreRepo } from "./d1-store-repo";
export { D1MemoryRepo } from "./d1-memory-repo";
export { D1MemoryVersionRepo } from "./d1-version-repo";
export { CfR2BlobStore } from "./cf-r2";

import { D1MemoryStoreRepo } from "./d1-store-repo";
import { D1MemoryRepo } from "./d1-memory-repo";
import { D1MemoryVersionRepo } from "./d1-version-repo";
import { CfR2BlobStore } from "./cf-r2";
import { MemoryStoreService } from "../service";
import type { Logger } from "../ports";

/**
 * Production wiring: build a MemoryStoreService backed by Cloudflare bindings.
 *
 * The R2 binding is REQUIRED — memory content lives there. There is no noop
 * blob store fallback; if MEMORY_BUCKET isn't bound, the entire memory
 * subsystem is non-functional and we fail loudly at construction.
 */
export function createCfMemoryStoreService(
  deps: { db: D1Database; r2: R2Bucket },
  opts?: { logger?: Logger },
): MemoryStoreService {
  return new MemoryStoreService({
    storeRepo: new D1MemoryStoreRepo(deps.db),
    memoryRepo: new D1MemoryRepo(deps.db),
    versionRepo: new D1MemoryVersionRepo(deps.db),
    blobs: new CfR2BlobStore(deps.r2),
    logger: opts?.logger,
  });
}
