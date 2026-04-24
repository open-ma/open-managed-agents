/** Typed errors so HTTP handlers can map to status codes without leaking internals. */

export class AgentNotFoundError extends Error {
  readonly code = "agent_not_found";
  constructor(message = "Agent not found") {
    super(message);
  }
}

export class AgentVersionNotFoundError extends Error {
  readonly code = "agent_version_not_found";
  constructor(message = "Agent version not found") {
    super(message);
  }
}

/**
 * Optimistic concurrency violation: caller passed an `expectedVersion` that
 * didn't match the agent's current version. Mirrors the agents.ts:232-234
 * version-check behavior.
 */
export class AgentVersionMismatchError extends Error {
  readonly code = "agent_version_mismatch";
  constructor(
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(`Version mismatch. Expected ${expected}, got ${actual}.`);
  }
}
