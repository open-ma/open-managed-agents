// Public surface of @open-managed-agents/files-store.
//
//   - types       : FileRow, FileScope, toFileRecord, DEFAULT/MAX_LIST_LIMIT
//   - errors      : typed errors so HTTP handlers can map → status codes
//   - ports       : abstract dependencies the service requires
//   - service     : FileService (pure business logic, port-only deps)
//   - adapters    : Cloudflare-specific implementations + factory
//
// Callers in apps/main and apps/agent normally only need:
//   import { createCfFileService } from "@open-managed-agents/files-store";
// Tests use:
//   import { createInMemoryFileService } from "@open-managed-agents/files-store/test-fakes";

export * from "./types";
export * from "./errors";
export * from "./ports";
export { FileService } from "./service";
export type { FileServiceDeps } from "./service";

export { createCfFileService, D1FileRepo } from "./adapters";
