import type { Agent } from "../domain/agent";
import type { Session, SessionAgent } from "../domain/session";
import type { SessionBootstrapEvent } from "../domain/session-bootstrap";
import type { SessionThreadAgent } from "../domain/session-thread";
import {
  resolveAgentSkills,
  resolveAgentTools,
} from "../agents/definition-resolution";
import type { AgentModelInput } from "../ports/agents";
import type {
  ArchiveSessionCommand,
  ArchiveSessionResult,
  CreateSessionCommand,
  CreateSessionResult,
  DeleteSessionCommand,
  DeleteSessionResult,
  ListSessionsQuery,
  ListSessionsResult,
  RetrieveSessionQuery,
  RetrieveSessionResult,
  SessionsApplicationPort,
  SessionResourceInput,
  SpendLimit,
  UpdateSessionCommand,
  UpdateSessionResult,
} from "../ports/sessions";
import type { SessionAgentSelector } from "../ports/sessions";
import type { SessionAgentSourcePort } from "./agent-source";
import type { SessionEnvironmentSourcePort } from "./environment-source";
import type { SessionStore } from "@open-managed-agents/session-store";
import type { SessionResourceResolverPort } from "./resource-resolver";
import type { SessionLifecycleCommandPort } from "../session-execution/lifecycle";
import type {
  DeploymentSessionLauncherPort,
  LaunchDeploymentSession,
  LaunchDeploymentSessionResult,
} from "../deployments/session-launcher";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function encodeCursorPart(value: string): string {
  return btoa(encodeURIComponent(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeCursorPart(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  try {
    const decoded = decodeURIComponent(atob(padded));
    return encodeCursorPart(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

interface SessionCursor {
  order: "asc" | "desc";
  direction: "next" | "previous";
  createdAt: string;
  sessionId: string;
}

function encodeSessionCursor(
  session: Session,
  order: SessionCursor["order"],
  direction: SessionCursor["direction"],
): string {
  return `sessions.${order}.${direction}.${encodeCursorPart(session.createdAt)}.${encodeCursorPart(session.id)}`;
}

function decodeSessionCursor(value: string): SessionCursor | null {
  const [scope, order, direction, createdAt, sessionId, extra] = value.split(".");
  if (
    scope !== "sessions" ||
    (order !== "asc" && order !== "desc") ||
    (direction !== "next" && direction !== "previous") ||
    createdAt === undefined ||
    sessionId === undefined ||
    extra !== undefined
  ) return null;
  const decodedCreatedAt = decodeCursorPart(createdAt);
  const decodedSessionId = decodeCursorPart(sessionId);
  if (
    decodedCreatedAt === null ||
    decodedSessionId === null ||
    decodedSessionId.length === 0 ||
    Number.isNaN(Date.parse(decodedCreatedAt)) ||
    new Date(decodedCreatedAt).toISOString() !== decodedCreatedAt
  ) return null;
  return { order, direction, createdAt: decodedCreatedAt, sessionId: decodedSessionId };
}

export interface SessionsApplicationServiceDependencies {
  workspaceId: string;
  store: SessionStore;
  agents: SessionAgentSourcePort;
  environments: SessionEnvironmentSourcePort;
  resources: SessionResourceResolverPort;
  lifecycle: SessionLifecycleCommandPort;
  clock: { now(): Date };
  ids: { nextSessionId(): string };
}

function snapshotThreadAgent(agent: Agent): SessionThreadAgent {
  return {
    type: "agent",
    id: agent.id,
    description: agent.description,
    mcpServers: agent.mcpServers,
    model: agent.model,
    name: agent.name,
    ...(agent.openma !== undefined && { openma: agent.openma }),
    skills: agent.skills,
    system: agent.system,
    tools: agent.tools,
    version: agent.version,
  };
}

async function findPinnedAgent(
  source: SessionAgentSourcePort,
  workspaceId: string,
  agentId: string,
  version: number,
): Promise<Agent | null> {
  const current = await source.findCurrent({ workspaceId, agentId });
  if (current !== null && current.archivedAt !== null) return null;
  if (current?.version === version) return current;
  return source.findVersion({ workspaceId, agentId, version });
}

async function snapshotAgent(
  agent: Agent,
  source: SessionAgentSourcePort,
  workspaceId: string,
): Promise<SessionAgent | null> {
  const roster: SessionThreadAgent[] = [];
  for (const entry of agent.multiagent?.agents ?? []) {
    if (entry.type === "advisor") {
      roster.push({ type: entry.type, model: entry.model });
      continue;
    }
    const member = await findPinnedAgent(
      source,
      workspaceId,
      entry.agentId,
      entry.version,
    );
    if (member === null) return null;
    roster.push(snapshotThreadAgent(member));
  }
  return {
    id: agent.id,
    description: agent.description,
    mcpServers: agent.mcpServers,
    model: agent.model,
    multiagent:
      agent.multiagent === null
        ? null
        : { type: "coordinator", agents: roster },
    name: agent.name,
    ...(agent.openma !== undefined && { openma: agent.openma }),
    skills: agent.skills,
    system: agent.system,
    tools: agent.tools,
    version: agent.version,
  };
}

function normalizeModel(model: string | AgentModelInput): SessionAgent["model"] {
  if (typeof model === "string") return { id: model };
  return {
    id: model.id,
    ...(model.effort != null && { effort: model.effort }),
    ...(model.inferenceGeo != null && { inferenceGeo: model.inferenceGeo }),
    ...(model.speed != null && { speed: model.speed }),
  };
}

async function applyOverrides(
  agent: Agent,
  selector: SessionAgentSelector,
  source: SessionAgentSourcePort,
  workspaceId: string,
): Promise<SessionAgent | null> {
  const snapshot = await snapshotAgent(agent, source, workspaceId);
  if (snapshot === null) return null;
  if (selector.type !== "overrides") return snapshot;
  return {
    ...snapshot,
    ...(selector.mcpServers !== undefined && {
      mcpServers: selector.mcpServers,
    }),
    ...(selector.model !== undefined && {
      model: normalizeModel(selector.model),
    }),
    ...(selector.skills !== undefined && {
      skills: resolveAgentSkills(selector.skills),
    }),
    ...(selector.system !== undefined && { system: selector.system }),
    ...(selector.tools !== undefined && {
      tools: resolveAgentTools(selector.tools),
    }),
  };
}

function patchMetadata(
  current: Record<string, string>,
  patch: Record<string, string | null> | null,
): Record<string, string> {
  if (patch === null) return {};
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

interface InternalCreateSessionCommand {
  agent: SessionAgentSelector;
  environmentId: string;
  initialEvents: SessionBootstrapEvent[];
  deploymentId: string | null;
  budget?: SpendLimit;
  metadata?: Record<string, string>;
  resources?: SessionResourceInput[];
  title?: string | null;
  vaultIds?: string[];
}

export class SessionsApplicationService
  implements SessionsApplicationPort, DeploymentSessionLauncherPort
{
  constructor(private readonly dependencies: SessionsApplicationServiceDependencies) {}

  async createSession(command: CreateSessionCommand): Promise<CreateSessionResult> {
    return this.createSessionRecord({
      ...command,
      initialEvents: command.initialEvents ?? [],
      deploymentId: null,
    });
  }

  private async createSessionRecord(
    command: InternalCreateSessionCommand,
  ): Promise<CreateSessionResult> {
    const selectedVersion =
      command.agent.type === "versioned" || command.agent.type === "overrides"
        ? command.agent.version
        : undefined;
    const agent =
      selectedVersion !== undefined
        ? await findPinnedAgent(
            this.dependencies.agents,
            this.dependencies.workspaceId,
            command.agent.agentId,
            selectedVersion,
          )
        : await this.dependencies.agents.findCurrent({
            workspaceId: this.dependencies.workspaceId,
            agentId: command.agent.agentId,
          });
    if (agent === null || agent.archivedAt !== null) {
      return {
        type: "dependency_not_found",
        message: `Agent ${command.agent.agentId} was not found`,
      };
    }
    const sessionAgent = await applyOverrides(
      agent,
      command.agent,
      this.dependencies.agents,
      this.dependencies.workspaceId,
    );
    if (sessionAgent === null) {
      return {
        type: "dependency_not_found",
        message: `A multiagent roster member for Agent ${agent.id} was not found`,
      };
    }

    const environment = await this.dependencies.environments.find({
      workspaceId: this.dependencies.workspaceId,
      environmentId: command.environmentId,
    });
    if (environment === null || environment.archivedAt !== null) {
      return {
        type: "dependency_not_found",
        message: `Environment ${command.environmentId} was not found`,
      };
    }

    const timestamp = this.dependencies.clock.now().toISOString();
    const sessionId = this.dependencies.ids.nextSessionId();
    const resolvedResources =
      command.resources === undefined || command.resources.length === 0
        ? { type: "resolved" as const, resources: [], secrets: [] }
        : await this.dependencies.resources.resolve({
            workspaceId: this.dependencies.workspaceId,
            sessionId,
            createdAt: timestamp,
            resources: command.resources,
          });
    if (resolvedResources.type !== "resolved") return resolvedResources;
    const session: Session = {
      id: sessionId,
      agent: sessionAgent,
      archivedAt: null,
      budget: command.budget ?? null,
      createdAt: timestamp,
      environmentId: command.environmentId,
      metadata: command.metadata ?? {},
      outcomeEvaluations: [],
      resources: resolvedResources.resources,
      stats: {},
      status: "running",
      title: command.title ?? null,
      updatedAt: timestamp,
      usage: {},
      vaultIds: command.vaultIds ?? [],
      ...(command.deploymentId !== null && {
        deploymentId: command.deploymentId,
      }),
    };
    const inserted = await this.dependencies.store.insert({
      workspaceId: this.dependencies.workspaceId,
      session,
      initialEvents: command.initialEvents,
      resourceSecrets: resolvedResources.secrets,
    });
    await this.dependencies.lifecycle.sessionStarted({
      workspaceId: this.dependencies.workspaceId,
      sessionId: inserted.session.id,
      session: inserted.session,
      environment,
      initialEvents: command.initialEvents,
    });
    return { type: "created", session: inserted.session };
  }

  async launch(
    input: LaunchDeploymentSession,
  ): Promise<LaunchDeploymentSessionResult> {
    if (input.workspaceId !== this.dependencies.workspaceId) {
      return {
        type: "rejected",
        errorType: "session_creation_rejected_error",
        message: "Deployment Session workspace does not match its application scope",
      };
    }
    const resources: SessionResourceInput[] = [];
    for (const [resourceIndex, resource] of input.deployment.resources.entries()) {
      if (resource.kind === "file") {
        resources.push({
          type: "file",
          fileId: resource.fileId,
          ...(resource.mountPath !== undefined && {
            mountPath: resource.mountPath,
          }),
        });
        continue;
      }
      if (resource.kind === "memory_store") {
        resources.push({
          type: "memory_store",
          memoryStoreId: resource.memoryStoreId,
          ...(resource.access !== undefined && { access: resource.access }),
          ...(resource.instructions !== undefined && {
            instructions: resource.instructions,
          }),
        });
        continue;
      }
      const secret = input.resourceSecrets.find(
        (candidate) => candidate.resourceIndex === resourceIndex,
      );
      if (secret === undefined) {
        return {
          type: "rejected",
          errorType: "session_resource_not_found_error",
          message: `Deployment resource ${resourceIndex} has no authorization token`,
        };
      }
      resources.push({
        type: "github_repository",
        authorizationToken: secret.authorizationToken,
        url: resource.url,
        ...(resource.checkout !== undefined && { checkout: resource.checkout }),
        ...(resource.mountPath !== undefined && {
          mountPath: resource.mountPath,
        }),
      });
    }
    const created = await this.createSessionRecord({
      agent: {
        type: "versioned",
        agentId: input.deployment.agent.id,
        version: input.deployment.agent.version,
      },
      environmentId: input.deployment.environmentId,
      initialEvents: input.deployment.initialEvents,
      deploymentId: input.deployment.id,
      ...(input.deployment.budget != null && {
        budget: input.deployment.budget,
      }),
      metadata: input.deployment.metadata,
      resources,
      title: input.deployment.name,
      vaultIds: input.deployment.vaultIds,
    });
    if (created.type === "created") {
      return { type: "launched", sessionId: created.session.id };
    }
    return {
      type: "rejected",
      errorType:
        created.type === "dependency_not_found"
          ? "session_resource_not_found_error"
          : "session_creation_rejected_error",
      message: created.message,
    };
  }

  async retrieveSession(query: RetrieveSessionQuery): Promise<RetrieveSessionResult> {
    const record = await this.dependencies.store.findCurrent({
      workspaceId: this.dependencies.workspaceId,
      sessionId: query.sessionId,
    });
    return record === null
      ? { type: "not_found" }
      : { type: "found", session: record.session };
  }

  async updateSession(command: UpdateSessionCommand): Promise<UpdateSessionResult> {
    const current = await this.dependencies.store.findCurrent({
      workspaceId: this.dependencies.workspaceId,
      sessionId: command.sessionId,
    });
    if (current === null) return { type: "not_found" };

    const next: Session = {
      ...current.session,
      ...(command.agent !== undefined && {
        agent: {
          ...current.session.agent,
          ...(command.agent.mcpServers !== undefined && {
            mcpServers: command.agent.mcpServers,
          }),
          ...(command.agent.tools !== undefined && {
            tools: resolveAgentTools(command.agent.tools),
          }),
        },
      }),
      ...(command.budget !== undefined && { budget: command.budget }),
      ...(command.metadata !== undefined && {
        metadata: patchMetadata(current.session.metadata, command.metadata),
      }),
      ...(command.title !== undefined && { title: command.title }),
      ...(command.vaultIds !== undefined && { vaultIds: command.vaultIds }),
      updatedAt: this.dependencies.clock.now().toISOString(),
    };
    const replaced = await this.dependencies.store.replaceCurrent({
      workspaceId: this.dependencies.workspaceId,
      sessionId: command.sessionId,
      expectedRevision: current.revision,
      next,
    });
    if (replaced.type === "not_found") return { type: "not_found" };
    if (replaced.type === "revision_conflict") {
      return {
        type: "version_conflict",
        message: `Session changed concurrently at revision ${replaced.actualRevision}`,
      };
    }
    return { type: "updated", session: replaced.record.session };
  }

  async archiveSession(
    command: ArchiveSessionCommand,
  ): Promise<ArchiveSessionResult> {
    const result = await this.dependencies.store.archiveCurrent({
      workspaceId: this.dependencies.workspaceId,
      sessionId: command.sessionId,
      archivedAt: this.dependencies.clock.now().toISOString(),
    });
    if (result.type === "archived") {
      await this.dependencies.lifecycle.sessionStopped({
        workspaceId: this.dependencies.workspaceId,
        sessionId: command.sessionId,
        session: result.record.session,
        reason: "archived",
      });
    }
    return result.type === "not_found"
      ? { type: "not_found" }
      : { type: "archived", session: result.record.session };
  }

  async deleteSession(
    command: DeleteSessionCommand,
  ): Promise<DeleteSessionResult> {
    const current = await this.dependencies.store.findCurrent({
      workspaceId: this.dependencies.workspaceId,
      sessionId: command.sessionId,
    });
    if (current === null) return { type: "not_found" };
    const result = await this.dependencies.store.deleteCurrent({
      workspaceId: this.dependencies.workspaceId,
      sessionId: command.sessionId,
    });
    if (result.type === "deleted") {
      await this.dependencies.lifecycle.sessionStopped({
        workspaceId: this.dependencies.workspaceId,
        sessionId: command.sessionId,
        session: current.session,
        reason: "deleted",
      });
    }
    return result.type === "not_found"
      ? { type: "not_found" }
      : { type: "deleted", sessionId: command.sessionId };
  }

  async listSessions(query: ListSessionsQuery): Promise<ListSessionsResult> {
    const order = query.order ?? "desc";
    const cursor =
      query.cursor === undefined ? undefined : decodeSessionCursor(query.cursor);
    if (cursor === null || (cursor !== undefined && cursor.order !== order)) {
      return { type: "invalid_request", message: "Invalid sessions page cursor" };
    }
    const pageSize = Math.min(
      Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const records = await this.dependencies.store.listCurrent({
      workspaceId: this.dependencies.workspaceId,
      limit: pageSize + 1,
      includeArchived: query.includeArchived ?? false,
      order,
      ...(query.agentId !== undefined && { agentId: query.agentId }),
      ...(query.agentVersion !== undefined && {
        agentVersion: query.agentVersion,
      }),
      ...(query.createdAfter !== undefined && {
        createdAfter: query.createdAfter,
      }),
      ...(query.createdAtOrAfter !== undefined && {
        createdAtOrAfter: query.createdAtOrAfter,
      }),
      ...(query.createdBefore !== undefined && {
        createdBefore: query.createdBefore,
      }),
      ...(query.createdAtOrBefore !== undefined && {
        createdAtOrBefore: query.createdAtOrBefore,
      }),
      ...(query.deploymentId !== undefined && {
        deploymentId: query.deploymentId,
      }),
      ...(query.memoryStoreId !== undefined && {
        memoryStoreId: query.memoryStoreId,
      }),
      ...(query.statuses !== undefined && { statuses: query.statuses }),
      ...(cursor !== undefined && {
        position: {
          createdAt: cursor.createdAt,
          sessionId: cursor.sessionId,
          direction: cursor.direction,
        },
      }),
    });
    const hasMore = records.length > pageSize;
    const selected = hasMore ? records.slice(0, pageSize) : records;
    const sessions = selected.map((record) => record.session);
    if (cursor?.direction === "previous") sessions.reverse();
    const first = sessions[0];
    const last = sessions[sessions.length - 1];
    const hasPrevious =
      cursor === undefined
        ? false
        : cursor.direction === "previous"
          ? hasMore
          : sessions.length > 0;
    const hasNext =
      cursor?.direction === "previous" ? sessions.length > 0 : hasMore;
    return {
      type: "page",
      page: {
        sessions,
        previousCursor:
          hasPrevious && first !== undefined
            ? encodeSessionCursor(first, order, "previous")
            : null,
        nextCursor:
          hasNext && last !== undefined
            ? encodeSessionCursor(last, order, "next")
            : null,
      },
    };
  }
}
