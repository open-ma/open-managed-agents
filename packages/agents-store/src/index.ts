// Public surface of @open-managed-agents/agents-store.
//
//   - types       : AgentRow, AgentVersionRow
//   - errors      : typed errors so HTTP handlers can map → status codes
//   - ports       : abstract dependencies the service requires
//   - service     : AgentService (pure business logic, port-only deps)
//   - adapters    : Cloudflare-specific implementations + factory
//
// Callers in apps/main and apps/agent normally only need:
//   import { createCfAgentService } from "@open-managed-agents/agents-store";
// Tests use:
//   import { createInMemoryAgentService } from "@open-managed-agents/agents-store/test-fakes";

export * from "./types";
export * from "./errors";
export * from "./ports";
export { AgentService } from "./service";
export type { AgentServiceDeps, NewAgentInput, UpdateAgentInput } from "./service";

export { createCfAgentService, D1AgentRepo } from "./adapters";
