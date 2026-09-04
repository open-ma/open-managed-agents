import type { Session, SessionStatus } from "../domain/session";
import type {
  RecordSessionRuntimeEventsCommand,
  RecordSessionRuntimeEventsResult,
  RuntimeProducedSessionEvent,
  SessionRuntimeProjectionApplicationPort,
} from "./port";
import type { SessionRuntimeProjectionPersistencePort } from "./projection-persistence";

export interface SessionRuntimeProjectionApplicationServiceDependencies {
  workspaceId: string;
  persistence: SessionRuntimeProjectionPersistencePort;
}

function statusFromEvent(
  event: RuntimeProducedSessionEvent,
): SessionStatus | null {
  switch (event.type) {
    case "session.status_running":
      return "running";
    case "session.status_rescheduled":
      return "rescheduling";
    case "session.status_idle":
      return "idle";
    case "session.status_terminated":
      return "terminated";
    default:
      return null;
  }
}

function applyRuntimeEvents(
  current: Session,
  events: RuntimeProducedSessionEvent[],
): Session {
  let next = structuredClone(current);
  for (const event of events) {
    const status = statusFromEvent(event);
    if (status !== null) next.status = status;
    if (event.type === "session.usage") {
      next.usage = structuredClone(event.usage);
      if (event.budget !== undefined) next.budget = event.budget;
    }
    if (event.type === "session.updated") {
      if (event.agent !== undefined && event.agent !== null) {
        next.agent = structuredClone(event.agent);
      }
      if (event.budget !== undefined) next.budget = event.budget;
      if (event.metadata !== undefined) {
        next.metadata = structuredClone(event.metadata);
      }
      if (event.title !== undefined) next.title = event.title;
    }
    if (
      event.type === "span.outcome_evaluation_start" ||
      event.type === "span.outcome_evaluation_ongoing" ||
      event.type === "span.outcome_evaluation_end"
    ) {
      const evaluation = next.outcomeEvaluations.find(
        (candidate) => candidate.outcomeId === event.outcomeId,
      );
      if (evaluation !== undefined) {
        evaluation.iteration = event.iteration;
        if (event.type === "span.outcome_evaluation_end") {
          evaluation.result = event.result;
          evaluation.explanation = event.explanation;
          evaluation.completedAt = new Set([
            "satisfied",
            "max_iterations_reached",
            "failed",
            "interrupted",
          ]).has(event.result)
            ? event.processedAt
            : null;
        } else {
          evaluation.result = "evaluating";
          evaluation.explanation = null;
          evaluation.completedAt = null;
        }
      }
    }
    if (event.processedAt > next.updatedAt) next.updatedAt = event.processedAt;
  }
  return next;
}

export class SessionRuntimeProjectionApplicationService
  implements SessionRuntimeProjectionApplicationPort
{
  constructor(
    private readonly dependencies: SessionRuntimeProjectionApplicationServiceDependencies,
  ) {}

  async recordSessionRuntimeEvents(
    command: RecordSessionRuntimeEventsCommand,
  ): Promise<RecordSessionRuntimeEventsResult> {
    const current = await this.dependencies.persistence.findCurrent({
      workspaceId: this.dependencies.workspaceId,
      sessionId: command.sessionId,
    });
    if (current === null) return { type: "not_found" };
    if (command.events.length === 0) {
      return { type: "recorded", session: current.session };
    }
    const projected = await this.dependencies.persistence.project({
      workspaceId: this.dependencies.workspaceId,
      sessionId: command.sessionId,
      expectedRevision: current.revision,
      events: command.events,
      next: applyRuntimeEvents(current.session, command.events),
      ...(command.executionFence !== undefined && {
        executionFence: command.executionFence,
      }),
    });
    if (projected.type === "not_found") return { type: "not_found" };
    if (projected.type === "execution_fence_lost") {
      return { type: "execution_fence_lost" };
    }
    if (projected.type === "revision_conflict") {
      return {
        type: "version_conflict",
        message: `Session changed concurrently at revision ${projected.actualRevision}`,
      };
    }
    return { type: "recorded", session: projected.record.session };
  }
}
