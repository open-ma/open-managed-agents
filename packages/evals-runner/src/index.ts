// Public surface — runtime-agnostic eval runner.
//
//   - `tickEvalRuns(ctx)` is the entry point both runtimes call once per
//     cron tick. CF + Node both build their EvalRunnerContext from their
//     services bundle and a sandbox-binding resolver.
//
//   - Wire types (EvalRunRecord, EvalTaskSpec, …) re-exported here so
//     tests + admin tooling can deserialize the opaque results JSON
//     without re-importing from the route file.

export {
  tickEvalRuns,
  loadRun,
  type EvalRunnerContext,
  type EvalRunnerServices,
  type SandboxFetcher,
} from "./tick";
export type {
  EvalRunRecord,
  EvalTaskSpec,
  EvalTaskResult,
  EvalTrialResult,
  EvalRunStatus,
} from "./types";
export { rowToRecord, extractResults, kvKey } from "./types";
