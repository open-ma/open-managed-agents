// Public surface of @open-managed-agents/session-runtime.
//
// Phase 1: only `recovery.ts` is here, lifted from
// apps/agent/src/runtime/recovery.ts so the CF SessionDO shell and the
// Node SessionRegistry shell can call the same logic. The
// `RuntimeAdapter` port + `SessionStateMachine` body land in Phase 2 (Node
// adoption first) and Phase 3 (CF refactor).
//
// See nifty-prancing-flamingo.md plan for the full architecture.

export {
  recoverInterruptedState,
  type RecoveryReport,
  type RecoveryWarning,
} from "./recovery";

export type { RuntimeAdapter, TurnId, OrphanTurn } from "./ports";
