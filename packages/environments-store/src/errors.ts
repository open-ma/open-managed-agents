/** Typed errors so HTTP handlers can map to status codes without leaking internals. */

export class EnvironmentNotFoundError extends Error {
  readonly code = "environment_not_found";
  constructor(message = "Environment not found") {
    super(message);
  }
}
