/** Typed errors so HTTP handlers can map to status codes without leaking internals. */

export class EvalRunNotFoundError extends Error {
  readonly code = "eval_run_not_found";
  constructor(message = "Eval run not found") {
    super(message);
  }
}
