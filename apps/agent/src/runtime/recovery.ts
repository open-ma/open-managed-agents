// Back-compat re-export. The implementation moved to
// `@open-managed-agents/session-runtime` so the same logic runs on both
// CF (this worker) and Node (apps/main-node). New code should import
// from the package directly; this shim exists so apps/agent's existing
// callers (session-do.ts, tests) don't have to change in Phase 1.
//
// To be removed in Phase 3 once session-do.ts is refactored to use the
// SessionStateMachine directly.

export {
  recoverInterruptedState,
  type RecoveryReport,
  type RecoveryWarning,
} from "@open-managed-agents/session-runtime/recovery";
