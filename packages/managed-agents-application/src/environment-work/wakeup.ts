export interface NotifyEnvironmentWorkRunStarted {
  workspaceId: string;
  environmentId: string;
  sessionId: string;
  workId: string;
  occurredAt: string;
}

/**
 * Best-effort wake-up after durable enqueue. Poll remains the authority and
 * recovery path; an implementation may schedule delivery asynchronously.
 */
export interface EnvironmentWorkWakeupPort {
  notifyRunStarted(input: NotifyEnvironmentWorkRunStarted): Promise<void>;
}
