import type {
  EnvironmentSessionWorkEnqueuerPort,
  EnvironmentWorkEnvironmentSourcePort,
} from "@open-managed-agents/managed-agents-application";
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

export class EnvironmentAwareSessionLifecycleRouter
  implements SessionLifecycleCommandPort
{
  constructor(
    private readonly dependencies: EnvironmentAwareSessionLifecycleRouterDependencies,
  ) {}

  async sessionStarted(input: StartSessionExecution): Promise<void> {
    if (input.environment.config.type !== "self_hosted") {
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
    if (environment.config.type !== "self_hosted") {
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
