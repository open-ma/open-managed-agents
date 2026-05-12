// Domain errors. CAP only throws on integrity violations — every other
// failure mode is encoded as a return-value variant (see HttpHandleResult /
// ExecHandleResult).

export class CapError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Thrown when handleExec is called with a cli_id not present in the
 * registry, or when handleHttp's mid-stream lookup hits a hostname that
 * resolves to an unknown cli_id (should never happen — registry is the
 * source of truth for both lookups).
 */
export class UnknownCliError extends CapError {
  constructor(cli_id: string) {
    super(`No spec registered for cli_id="${cli_id}"`);
  }
}

/**
 * Thrown when the helper input doesn't conform to the spec's protocol —
 * e.g. git credential helper got stdin that doesn't terminate with a blank
 * line, docker got a sub-action that isn't get/store/erase/list. L4 should
 * map this to exit=2 with the message on stderr.
 */
export class MalformedHelperInputError extends CapError {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Wraps anything thrown by the consumer's Resolver impl. Lets L4 distinguish
 * "your resolver crashed" from "CAP misuse". The original throw value is
 * exposed via the standard ES2022 `cause` field on Error.
 */
export class ResolverError extends CapError {
  constructor(cause: unknown) {
    super(
      `Resolver threw: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}
