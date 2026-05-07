// Public surface of @open-managed-agents/evals-store.
//
//   - types       : EvalRunRow, EvalRunStatus
//   - errors      : typed errors so HTTP handlers can map → status codes
//   - ports       : abstract dependencies the service requires
//   - service     : EvalRunService (pure business logic, port-only deps)
//   - adapters    : Cloudflare-specific implementations + factory
//
// Callers in apps/main normally only need:
//   import { createCfEvalRunService } from "@open-managed-agents/evals-store";
// Tests use:
//   import { createInMemoryEvalRunService } from "@open-managed-agents/evals-store/test-fakes";

export * from "./types";
export * from "./errors";
export * from "./ports";
export { EvalRunService } from "./service";
export type { EvalRunServiceDeps } from "./service";

export { createCfEvalRunService, createSqliteEvalRunService, SqlEvalRunRepo } from "./adapters";
