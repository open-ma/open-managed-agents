// @open-managed-agents/eval-core
//
// Evaluation toolkit:
//   - trajectory : OMA Trajectory v1 schema, builder, projections (Anthropic
//                  Messages → HF datasets / SWE-bench / Inspect AI)
//   - scorers    : pure Trajectory → Score functions for offline eval and RL
//
// Depends only on @oma/api-types (DTO shapes). No runtime workspace deps.
// Consumers: apps/main (eval runner, trajectory route), rl/ (RL bridge),
// tests.

export * from "./trajectory/types";
export * from "./trajectory/build";
export * from "./trajectory/projections/anthropic-messages";
export * from "./scorers";
export * from "./verifier";
