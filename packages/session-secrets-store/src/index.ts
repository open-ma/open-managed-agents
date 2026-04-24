// Public surface of @open-managed-agents/session-secrets-store.
//
//   - types       : SecretValue type alias
//   - errors      : (currently empty — kept for symmetry with credentials-store)
//   - ports       : abstract dependencies the service requires
//   - service     : SessionSecretService (pure pass-through, port-only deps)
//   - adapters    : Cloudflare-specific implementations + factory
//
// Callers in apps/main and apps/agent normally only need:
//   import { createCfSessionSecretService } from "@open-managed-agents/session-secrets-store";
// Tests use:
//   import { createInMemorySessionSecretService } from "@open-managed-agents/session-secrets-store/test-fakes";

export * from "./types";
export * from "./errors";
export * from "./ports";
export { SessionSecretService } from "./service";
export type { SessionSecretServiceDeps } from "./service";

export { createCfSessionSecretService, KvSessionSecretRepo } from "./adapters";
