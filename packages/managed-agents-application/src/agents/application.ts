import type {
  AgentsApplicationPort,
  AgentModelInput,
  AgentModelView,
  AgentView,
  ArchiveAgentCommand,
  ArchiveAgentResult,
  CreateAgentCommand,
  CreateAgentResult,
  ListAgentsPage,
  ListAgentsQuery,
  ListAgentsResult,
  ListAgentVersionsQuery,
  ListAgentVersionsResult,
  RetrieveAgentQuery,
  RetrieveAgentResult,
  UpdateAgentCommand,
  UpdateAgentResult,
} from "./port";
import type { AgentStore } from "@open-managed-agents/agent-store";
import type {
  AgentMultiagent,
  AgentMultiagentInput,
} from "../domain/agent-definition";
import {
  resolveAgentSkills,
  resolveAgentTools,
} from "./definition-resolution";

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

function encodeAgentCursor(agent: AgentView): string {
  return `agents.${encodeCursorPart(agent.createdAt)}.${encodeCursorPart(agent.id)}`;
}

function decodeAgentCursor(cursor: string): {
  createdAt: string;
  agentId: string;
} | null {
  const [scope, createdAt, agentId, extra] = cursor.split(".");
  if (scope !== "agents" || createdAt === undefined || agentId === undefined || extra !== undefined) {
    return null;
  }
  const decodedCreatedAt = decodeCursorPart(createdAt);
  const decodedAgentId = decodeCursorPart(agentId);
  if (
    decodedCreatedAt === null ||
    decodedAgentId === null ||
    decodedAgentId.length === 0 ||
    Number.isNaN(Date.parse(decodedCreatedAt)) ||
    new Date(decodedCreatedAt).toISOString() !== decodedCreatedAt
  ) return null;
  return {
    createdAt: decodedCreatedAt,
    agentId: decodedAgentId,
  };
}

function encodeAgentVersionCursor(agent: AgentView): string {
  return `agent-versions.${encodeCursorPart(agent.id)}.${agent.version}`;
}

function decodeAgentVersionCursor(
  cursor: string,
  expectedAgentId: string,
): number | null {
  const [scope, agentId, versionText, extra] = cursor.split(".");
  const version = Number(versionText);
  const decodedAgentId = agentId === undefined ? null : decodeCursorPart(agentId);
  if (
    scope !== "agent-versions" ||
    decodedAgentId !== expectedAgentId ||
    !Number.isInteger(version) ||
    version < 1 ||
    extra !== undefined
  ) {
    return null;
  }
  return version;
}

function normalizeModel(model: string | AgentModelInput): AgentModelView {
  if (typeof model === "string") return { id: model };
  return {
    id: model.id,
    ...(model.effort != null && { effort: model.effort }),
    ...(model.inferenceGeo != null && { inferenceGeo: model.inferenceGeo }),
    ...(model.speed != null && { speed: model.speed }),
  };
}

function normalizeOpenMaCreate(
  input: CreateAgentCommand["openma"],
): AgentView["openma"] {
  if (input === undefined) return undefined;
  const extension = {
    ...(input.auxiliaryModel != null && {
      auxiliaryModel: normalizeModel(input.auxiliaryModel),
    }),
    ...(input.appendablePrompts != null && {
      appendablePrompts: input.appendablePrompts,
    }),
    ...(input.harness != null && { harness: input.harness }),
    ...(input.acp != null && { acp: input.acp }),
    ...(input.runtimeBinding != null && {
      runtimeBinding: input.runtimeBinding,
    }),
    ...(input.enableGeneralSubagent != null && {
      enableGeneralSubagent: input.enableGeneralSubagent,
    }),
  };
  return Object.keys(extension).length === 0 ? undefined : extension;
}

function patchOpenMa(
  current: AgentView["openma"],
  patch: UpdateAgentCommand["openma"],
): AgentView["openma"] {
  if (patch === undefined) return current;
  const next = { ...current };
  const assign = <Key extends keyof NonNullable<AgentView["openma"]>>(
    key: Key,
    value: NonNullable<AgentView["openma"]>[Key] | null | undefined,
  ) => {
    if (value === undefined) return;
    if (value === null) delete next[key];
    else next[key] = value;
  };
  assign(
    "auxiliaryModel",
    patch.auxiliaryModel == null
      ? patch.auxiliaryModel
      : normalizeModel(patch.auxiliaryModel),
  );
  assign("appendablePrompts", patch.appendablePrompts);
  assign("harness", patch.harness);
  assign("acp", patch.acp);
  assign("runtimeBinding", patch.runtimeBinding);
  assign("enableGeneralSubagent", patch.enableGeneralSubagent);
  return Object.keys(next).length === 0 ? undefined : next;
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

type ResolveMultiagentResult =
  | { type: "resolved"; multiagent: AgentMultiagent | null }
  | { type: "invalid_request"; message: string };

async function resolveMultiagent(
  store: AgentStore,
  workspaceId: string,
  input: AgentMultiagentInput | null | undefined,
  self: { agentId: string; version: number },
): Promise<ResolveMultiagentResult> {
  if (input === null || input === undefined) {
    return { type: "resolved", multiagent: input ?? null };
  }
  const agents: AgentMultiagent["agents"] = [];
  for (const entry of input.agents) {
    if (typeof entry !== "string" && entry.type === "advisor") {
      agents.push({ type: entry.type, model: entry.model });
      continue;
    }
    if (typeof entry !== "string" && entry.type === "self") {
      agents.push({ type: "agent", ...self });
      continue;
    }
    const agentId = typeof entry === "string" ? entry : entry.agentId;
    const requestedVersion =
      typeof entry === "string" ? undefined : entry.version;
    const current = await store.findCurrent({ workspaceId, agentId });
    const referenced =
      requestedVersion === undefined || current?.version === requestedVersion
        ? current
        : await store.findVersion({
            workspaceId,
            agentId,
            version: requestedVersion,
          });
    if (referenced === null || referenced.archivedAt !== null) {
      return {
        type: "invalid_request",
        message: `Multiagent roster agent ${agentId} was not found`,
      };
    }
    if (referenced.multiagent !== null) {
      return {
        type: "invalid_request",
        message: `Multiagent roster agent ${agentId} cannot be a coordinator`,
      };
    }
    agents.push({
      type: "agent",
      agentId: referenced.id,
      version: referenced.version,
    });
  }
  return { type: "resolved", multiagent: { type: input.type, agents } };
}

export interface AgentsApplicationServiceDependencies {
  workspaceId: string;
  store: AgentStore;
  clock: { now(): Date };
  ids: { nextAgentId(): string };
}

export class AgentsApplicationService implements AgentsApplicationPort {
  constructor(private readonly dependencies: AgentsApplicationServiceDependencies) {}

  async createAgent(command: CreateAgentCommand): Promise<CreateAgentResult> {
    const timestamp = this.dependencies.clock.now().toISOString();
    const agentId = this.dependencies.ids.nextAgentId();
    const resolvedMultiagent = await resolveMultiagent(
      this.dependencies.store,
      this.dependencies.workspaceId,
      command.multiagent,
      { agentId, version: 1 },
    );
    if (resolvedMultiagent.type === "invalid_request") {
      return resolvedMultiagent;
    }
    const openma = normalizeOpenMaCreate(command.openma);
    const agent = await this.dependencies.store.insert({
      workspaceId: this.dependencies.workspaceId,
      agent: {
        id: agentId,
        archivedAt: null,
        createdAt: timestamp,
        description: command.description ?? null,
        mcpServers: command.mcpServers ?? [],
        metadata: command.metadata ?? {},
        model: normalizeModel(command.model),
        multiagent: resolvedMultiagent.multiagent,
        name: command.name,
        ...(openma !== undefined && { openma }),
        skills: resolveAgentSkills(command.skills ?? []),
        system: command.system ?? null,
        tools: resolveAgentTools(command.tools ?? []),
        updatedAt: timestamp,
        version: 1,
      },
    });
    return { type: "created", agent };
  }

  async retrieveAgent(query: RetrieveAgentQuery): Promise<RetrieveAgentResult> {
    const agent = await this.dependencies.store.findCurrent({
      workspaceId: this.dependencies.workspaceId,
      agentId: query.agentId,
    });
    if (agent === null) return { type: "not_found" };
    if (query.version !== undefined && query.version !== agent.version) {
      const version = await this.dependencies.store.findVersion({
        workspaceId: this.dependencies.workspaceId,
        agentId: query.agentId,
        version: query.version,
      });
      return version === null
        ? { type: "not_found" }
        : { type: "found", agent: version };
    }
    return { type: "found", agent };
  }

  async updateAgent(command: UpdateAgentCommand): Promise<UpdateAgentResult> {
    const current = await this.dependencies.store.findCurrent({
      workspaceId: this.dependencies.workspaceId,
      agentId: command.agentId,
    });
    if (current === null) return { type: "not_found" };
    if (current.archivedAt !== null) {
      return {
        type: "version_conflict",
        message: `Agent ${command.agentId} is archived and read-only`,
      };
    }
    if (
      command.expectedVersion !== undefined &&
      command.expectedVersion !== current.version
    ) {
      return {
        type: "version_conflict",
        message: `Agent version does not match: expected ${command.expectedVersion}, current ${current.version}`,
      };
    }
    const resolvedMultiagent =
      command.multiagent === undefined
        ? { type: "resolved" as const, multiagent: current.multiagent }
        : await resolveMultiagent(
            this.dependencies.store,
            this.dependencies.workspaceId,
            command.multiagent,
            { agentId: current.id, version: current.version + 1 },
          );
    if (resolvedMultiagent.type === "invalid_request") {
      return resolvedMultiagent;
    }
    const openma = patchOpenMa(current.openma, command.openma);
    const next: AgentView = {
      ...current,
      ...(command.description !== undefined && {
        description: command.description,
      }),
      ...(command.mcpServers !== undefined && {
        mcpServers: command.mcpServers ?? [],
      }),
      ...(command.metadata !== undefined && {
        metadata: patchMetadata(current.metadata, command.metadata),
      }),
      ...(command.model !== undefined && {
        model: normalizeModel(command.model),
      }),
      multiagent: resolvedMultiagent.multiagent,
      ...(command.name !== undefined && { name: command.name }),
      ...(command.skills !== undefined && {
        skills: resolveAgentSkills(command.skills ?? []),
      }),
      ...(command.system !== undefined && { system: command.system }),
      ...(command.tools !== undefined && {
        tools: resolveAgentTools(command.tools ?? []),
      }),
      updatedAt: this.dependencies.clock.now().toISOString(),
      version: current.version + 1,
    };
    if (command.openma !== undefined) {
      if (openma === undefined) delete next.openma;
      else next.openma = openma;
    }

    const result = await this.dependencies.store.replaceCurrent({
      workspaceId: this.dependencies.workspaceId,
      agentId: command.agentId,
      expectedVersion: current.version,
      next,
    });
    if (result.type === "not_found") return { type: "not_found" };
    if (result.type === "version_conflict") {
      return {
        type: "version_conflict",
        message: `Agent version changed concurrently: current ${result.actualVersion}`,
      };
    }
    return { type: "updated", agent: result.agent };
  }

  async archiveAgent(command: ArchiveAgentCommand): Promise<ArchiveAgentResult> {
    const result = await this.dependencies.store.archiveCurrent({
      workspaceId: this.dependencies.workspaceId,
      agentId: command.agentId,
      archivedAt: this.dependencies.clock.now().toISOString(),
    });
    if (result.type === "not_found") return { type: "not_found" };
    return { type: "archived", agent: result.agent };
  }

  async listAgents(query: ListAgentsQuery): Promise<ListAgentsResult> {
    const pageSize = Math.min(
      Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const after =
      query.cursor === undefined ? undefined : decodeAgentCursor(query.cursor);
    if (after === null) {
      return {
        type: "invalid_request",
        message: "Invalid agents page cursor",
      };
    }
    const records = await this.dependencies.store.listCurrent({
      workspaceId: this.dependencies.workspaceId,
      limit: pageSize + 1,
      includeArchived: query.includeArchived ?? false,
      ...(query.createdAtOrAfter !== undefined && {
        createdAtOrAfter: query.createdAtOrAfter,
      }),
      ...(query.createdAtOrBefore !== undefined && {
        createdAtOrBefore: query.createdAtOrBefore,
      }),
      ...(after !== undefined && { after }),
    });
    const hasMore = records.length > pageSize;
    const agents = hasMore ? records.slice(0, pageSize) : records;
    return {
      type: "page",
      page: {
        agents,
        nextCursor:
          hasMore && agents.length > 0
            ? encodeAgentCursor(agents[agents.length - 1]!)
            : null,
      },
    };
  }

  async listAgentVersions(
    query: ListAgentVersionsQuery,
  ): Promise<ListAgentVersionsResult> {
    const current = await this.dependencies.store.findCurrent({
      workspaceId: this.dependencies.workspaceId,
      agentId: query.agentId,
    });
    if (current === null) return { type: "not_found" };

    const pageSize = Math.min(
      Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const cursorVersion =
      query.cursor === undefined
        ? undefined
        : decodeAgentVersionCursor(query.cursor, query.agentId);
    if (cursorVersion === null) {
      return {
        type: "invalid_request",
        message: "Invalid agent versions page cursor",
      };
    }
    const historical = await this.dependencies.store.listVersions({
      workspaceId: this.dependencies.workspaceId,
      agentId: query.agentId,
      beforeVersion: cursorVersion ?? current.version,
      limit: pageSize + 1,
    });
    const candidates =
      cursorVersion === undefined ? [current, ...historical] : historical;
    const hasMore = candidates.length > pageSize;
    const agents = hasMore ? candidates.slice(0, pageSize) : candidates;
    return {
      type: "page",
      page: {
        agents,
        nextCursor:
          hasMore && agents.length > 0
            ? encodeAgentVersionCursor(agents[agents.length - 1]!)
            : null,
      },
    };
  }
}
