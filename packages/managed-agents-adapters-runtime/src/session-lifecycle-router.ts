import type {
  Environment,
  EnvironmentSessionWorkEnqueuerPort,
  EnvironmentWorkEnvironmentSourcePort,
  SessionEventStreamPort,
  SessionThreadEventStreamPort,
  StreamSessionEvent,
  SubscribeSessionEvents,
  SubscribeSessionThreadEvents,
} from "@open-managed-agents/managed-agents-application";
import type {
  AcceptedSessionEvents,
  SessionEventDispatchPort,
} from "@open-managed-agents/session-runtime-contract/dispatch";
import type {
  SessionLifecycleCommandPort,
  StartSessionExecution,
  StopSessionExecution,
} from "@open-managed-agents/session-runtime-contract/lifecycle";

export interface EnvironmentAwareSessionLifecycleRouterDependencies {
  environments: EnvironmentWorkEnvironmentSourcePort;
  runtime: SessionLifecycleCommandPort;
  selfHostedWork: EnvironmentSessionWorkEnqueuerPort;
  /**
   * Remove session-scoped files and output artifacts after a managed session
   * is deleted. This is deliberately an adapter hook: providers own the
   * storage implementation (R2, S3, or local FS), while the router owns the
   * ordering relative to runtime shutdown.
   */
  cleanupSession?: (input: {
    workspaceId: string;
    sessionId: string;
    reason: "deleted";
  }) => Promise<void>;
}

export type EnvironmentExecutionAuthority =
  | "session_execution"
  | "environment_work";

/**
 * Select the sole scheduling authority for a Session. Self-hosted placement
 * gives the Environment Worker one claim over the combined sandbox+harness
 * executor; managed placement keeps the harness on Session execution.
 */
export function environmentExecutionAuthority(
  environment: Pick<Environment, "config">,
): EnvironmentExecutionAuthority {
  return environment.config.type === "self_hosted"
    ? "environment_work"
    : "session_execution";
}

export class EnvironmentAwareSessionLifecycleRouter
  implements SessionLifecycleCommandPort
{
  constructor(
    private readonly dependencies: EnvironmentAwareSessionLifecycleRouterDependencies,
  ) {}

  async sessionStarted(input: StartSessionExecution): Promise<void> {
    if (environmentExecutionAuthority(input.environment) === "session_execution") {
      await this.dependencies.runtime.sessionStarted(input);
      return;
    }
    const result = await this.dependencies.selfHostedWork.enqueue({
      workspaceId: input.workspaceId,
      environment: input.environment,
      session: input.session,
    });
    if (result.type === "rejected") throw new Error(result.message);
  }

  async sessionStopped(input: StopSessionExecution): Promise<void> {
    const environment = await this.dependencies.environments.find({
      workspaceId: input.workspaceId,
      environmentId: input.session.environmentId,
    });
    if (environment === null) {
      throw new Error(
        `Environment ${input.session.environmentId} was not found while stopping Session ${input.sessionId}`,
      );
    }
    if (environmentExecutionAuthority(environment) === "session_execution") {
      await this.dependencies.runtime.sessionStopped(input);
    } else {
      const result = await this.dependencies.selfHostedWork.stop({
        workspaceId: input.workspaceId,
        session: input.session,
        reason: input.reason,
      });
      if (result.type === "conflict") throw new Error(result.message);
    }

    // The session row is already gone by the time this hook runs. Cleanup is
    // therefore best-effort and must not turn a successful DELETE into a 500;
    // operators can reconcile any provider-side orphan from its manifest.
    if (input.reason === "deleted" && this.dependencies.cleanupSession) {
      try {
        await this.dependencies.cleanupSession({
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          reason: input.reason,
        });
      } catch (error) {
        console.warn("[session-lifecycle] deletion cleanup failed", {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          error,
        });
      }
    }
  }
}

export interface EnvironmentAwareSessionEventDispatchRouterDependencies {
  runtime: SessionEventDispatchPort;
}

/**
 * Routes accepted inputs to exactly one brain. The application has already
 * committed these events to the canonical log before this hook runs. A
 * self-hosted Environment Work keeps its sandbox-side control channel open
 * and consumes that log, so dispatching here as well would execute the same
 * turn a second time outside the sandbox.
 */
export class EnvironmentAwareSessionEventDispatchRouter
  implements SessionEventDispatchPort
{
  constructor(
    private readonly dependencies: EnvironmentAwareSessionEventDispatchRouterDependencies,
  ) {}

  async sessionEventsAccepted(input: AcceptedSessionEvents): Promise<void> {
    if (environmentExecutionAuthority(input.environment) === "session_execution") {
      await this.dependencies.runtime.sessionEventsAccepted(input);
    }
  }
}

type CompleteSessionEventStream =
  & SessionEventStreamPort
  & SessionThreadEventStreamPort;

export interface EnvironmentAwareSessionEventStreamRouterDependencies {
  environments: EnvironmentWorkEnvironmentSourcePort;
  runtime: CompleteSessionEventStream;
  selfHosted: CompleteSessionEventStream;
}

/**
 * Selects the live event source using the same single-authority rule as
 * lifecycle and dispatch. A self-hosted worker persists its output directly
 * into the canonical log, whereas a managed runtime may expose transient
 * start/delta frames through its own stream.
 */
export class EnvironmentAwareSessionEventStreamRouter
  implements SessionEventStreamPort, SessionThreadEventStreamPort
{
  constructor(
    private readonly dependencies: EnvironmentAwareSessionEventStreamRouterDependencies,
  ) {}

  subscribe(input: SubscribeSessionEvents): AsyncIterable<StreamSessionEvent>;
  subscribe(input: SubscribeSessionThreadEvents): AsyncIterable<StreamSessionEvent>;
  subscribe(
    input: SubscribeSessionEvents | SubscribeSessionThreadEvents,
  ): AsyncIterable<StreamSessionEvent> {
    return this.route(input);
  }

  private async *route(
    input: SubscribeSessionEvents | SubscribeSessionThreadEvents,
  ): AsyncIterable<StreamSessionEvent> {
    const environment = await this.dependencies.environments.find({
      workspaceId: input.workspaceId,
      environmentId: input.session.environmentId,
    });
    if (environment === null) {
      throw new Error(
        `Environment ${input.session.environmentId} was not found while streaming Session ${input.sessionId}`,
      );
    }
    const stream = environmentExecutionAuthority(environment) === "session_execution"
      ? this.dependencies.runtime
      : this.dependencies.selfHosted;
    if ("threadId" in input) {
      yield* stream.subscribe(input);
    } else {
      yield* stream.subscribe(input);
    }
  }
}
