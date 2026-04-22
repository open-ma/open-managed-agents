// Cloudflare adapter wiring. Exports concrete implementations of every
// MemoryStoreService port against Cloudflare bindings (D1, Workers AI,
// Vectorize), plus a `createCfMemoryStoreService` factory that callers in
// apps/main and apps/agent use to instantiate the service.

export { D1MemoryStoreRepo } from "./d1-store-repo";
export { D1MemoryRepo } from "./d1-memory-repo";
export { D1MemoryVersionRepo } from "./d1-version-repo";
export { WorkersAiEmbeddingProvider, NoopEmbeddingProvider } from "./workers-ai-embedding";
export { CfVectorIndex, NoopVectorIndex } from "./cf-vectorize";

import { D1MemoryStoreRepo } from "./d1-store-repo";
import { D1MemoryRepo } from "./d1-memory-repo";
import { D1MemoryVersionRepo } from "./d1-version-repo";
import { WorkersAiEmbeddingProvider, NoopEmbeddingProvider } from "./workers-ai-embedding";
import { CfVectorIndex, NoopVectorIndex } from "./cf-vectorize";
import { MemoryStoreService } from "../service";
import type { Logger } from "../ports";

/**
 * Production wiring: build a MemoryStoreService backed by Cloudflare bindings.
 *
 * AI and Vectorize are optional — when absent (e.g. dev/test), the service
 * falls back to NoopEmbeddingProvider + NoopVectorIndex, which makes
 * `searchMemories` return [] and writes still succeed (vector_synced_at stays
 * NULL forever; nothing to reconcile against). Production deployments MUST
 * bind both for semantic search to function.
 */
export function createCfMemoryStoreService(env: {
  AUTH_DB: D1Database;
  AI?: Ai;
  VECTORIZE?: VectorizeIndex;
}, opts?: { logger?: Logger }): MemoryStoreService {
  return new MemoryStoreService({
    storeRepo: new D1MemoryStoreRepo(env.AUTH_DB),
    memoryRepo: new D1MemoryRepo(env.AUTH_DB),
    versionRepo: new D1MemoryVersionRepo(env.AUTH_DB),
    embedding: env.AI ? new WorkersAiEmbeddingProvider(env.AI) : new NoopEmbeddingProvider(),
    vectorIndex: env.VECTORIZE ? new CfVectorIndex(env.VECTORIZE) : new NoopVectorIndex(),
    logger: opts?.logger,
  });
}
