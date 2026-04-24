/** Typed errors so HTTP handlers can map to status codes without leaking internals. */

export class SessionNotFoundError extends Error {
  readonly code = "session_not_found";
  constructor(message = "Session not found") {
    super(message);
  }
}

export class SessionResourceNotFoundError extends Error {
  readonly code = "session_resource_not_found";
  constructor(message = "Session resource not found") {
    super(message);
  }
}

/** Per-session resource count exceeded MAX_RESOURCES_PER_SESSION. */
export class SessionResourceMaxExceededError extends Error {
  readonly code = "session_resource_max_exceeded";
  constructor(public readonly limit: number) {
    super(`Maximum ${limit} resources per session`);
  }
}

/** Per-session memory_store count exceeded MAX_MEMORY_STORE_RESOURCES_PER_SESSION. */
export class SessionMemoryStoreMaxExceededError extends Error {
  readonly code = "session_memory_store_max_exceeded";
  constructor(public readonly limit: number) {
    super(`Maximum ${limit} memory_store resources per session`);
  }
}

/** Mutation attempted against an archived session (sessions.ts:541). */
export class SessionArchivedError extends Error {
  readonly code = "session_archived";
  constructor(message = "Session is archived and cannot receive new events") {
    super(message);
  }
}
