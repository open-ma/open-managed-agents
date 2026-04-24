// Public surface of @open-managed-agents/environments-store.
//
//   - types       : EnvironmentRow, EnvironmentStatus
//   - errors      : typed errors so HTTP handlers can map → status codes
//   - ports       : abstract dependencies the service requires
//   - service     : EnvironmentService (pure business logic) + toEnvironmentConfig
//   - adapters    : Cloudflare-specific implementations + factory
//
// Callers in apps/main and apps/agent normally only need:
//   import { createCfEnvironmentService, toEnvironmentConfig }
//     from "@open-managed-agents/environments-store";
// Tests use:
//   import { createInMemoryEnvironmentService }
//     from "@open-managed-agents/environments-store/test-fakes";

export * from "./types";
export * from "./errors";
export * from "./ports";
export { EnvironmentService, toEnvironmentConfig } from "./service";
export type { EnvironmentServiceDeps } from "./service";

export { createCfEnvironmentService, D1EnvironmentRepo } from "./adapters";
