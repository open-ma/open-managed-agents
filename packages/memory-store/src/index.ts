// Public surface of @open-managed-agents/memory-store.
//
//   - types       : domain DTOs (MemoryRow, MemoryStoreRow, etc.)
//   - errors      : typed errors so HTTP handlers can map → status codes
//   - ports       : abstract dependencies the service requires
//   - service     : MemoryStoreService (pure business logic, port-only deps)
//   - adapters    : Cloudflare-specific implementations + factory
//
// Callers in apps/main and apps/agent normally only need:
//   import { createCfMemoryStoreService } from "@open-managed-agents/memory-store";
// Tests use:
//   import { createInMemoryMemoryStoreService } from "@open-managed-agents/memory-store/test-fakes";

export * from "./types";
export * from "./errors";
export * from "./ports";
export { MemoryStoreService } from "./service";
export type { MemoryStoreServiceDeps } from "./service";

// Re-export the CF factory at the top level so callers don't have to know
// about the adapters subdir.
export { createCfMemoryStoreService } from "./adapters";
export {
  D1MemoryStoreRepo,
  D1MemoryRepo,
  D1MemoryVersionRepo,
  WorkersAiEmbeddingProvider,
  NoopEmbeddingProvider,
  CfVectorIndex,
  NoopVectorIndex,
} from "./adapters";
