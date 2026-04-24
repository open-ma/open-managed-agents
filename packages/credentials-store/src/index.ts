// Public surface of @open-managed-agents/credentials-store.
//
//   - types       : CredentialRow, MAX_CREDENTIALS_PER_VAULT, SECRET_AUTH_FIELDS
//   - errors      : typed errors so HTTP handlers can map → status codes
//   - ports       : abstract dependencies the service requires
//   - service     : CredentialService (pure business logic, port-only deps) + stripSecrets
//   - adapters    : Cloudflare-specific implementations + factory
//
// Callers in apps/main and apps/agent normally only need:
//   import { createCfCredentialService, stripSecrets } from "@open-managed-agents/credentials-store";
// Tests use:
//   import { createInMemoryCredentialService } from "@open-managed-agents/credentials-store/test-fakes";

export * from "./types";
export * from "./errors";
export * from "./ports";
export { CredentialService, stripSecrets } from "./service";
export type { CredentialServiceDeps } from "./service";

export { createCfCredentialService, D1CredentialRepo } from "./adapters";
