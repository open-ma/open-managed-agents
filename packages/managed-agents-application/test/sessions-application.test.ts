import { describe, expect, it } from "vitest";
import type {
  SessionStore,
  StoredSession,
} from "@open-managed-agents/session-store";
import type { Agent } from "../src/domain/agent";
import type { Environment } from "../src/domain/environment";
import type { SessionView } from "../src/ports/sessions";
import { SessionsApplicationService } from "../src/index";

class MemorySessionStore implements SessionStore {
  private readonly records = new Map<string, StoredSession>();
  lastInsert: object | null = null;

  constructor(private readonly forceConflict = false) {}

  async insert(input: {
    workspaceId: string;
    session: SessionView;
    initialEvents: object[];
    resourceSecrets: object[];
  }): Promise<StoredSession> {
    this.lastInsert = structuredClone(input);
    const record = { session: structuredClone(input.session), revision: 1 };
    this.records.set(`${input.workspaceId}:${input.session.id}`, record);
    return structuredClone(record);
  }

  async findCurrent(input: {
    workspaceId: string;
    sessionId: string;
  }): Promise<StoredSession | null> {
    const record = this.records.get(`${input.workspaceId}:${input.sessionId}`);
    return record === undefined ? null : structuredClone(record);
  }

  async replaceCurrent(input: {
    workspaceId: string;
    sessionId: string;
    expectedRevision: number;
    next: SessionView;
  }): Promise<
    | { type: "replaced"; record: StoredSession }
    | { type: "not_found" }
    | { type: "revision_conflict"; actualRevision: number }
  > {
    const key = `${input.workspaceId}:${input.sessionId}`;
    const current = this.records.get(key);
    if (current === undefined) return { type: "not_found" };
    if (this.forceConflict) {
      return {
        type: "revision_conflict",
        actualRevision: current.revision + 1,
      };
    }
    if (current.revision !== input.expectedRevision) {
      return { type: "revision_conflict", actualRevision: current.revision };
    }
    const record = {
      session: structuredClone(input.next),
      revision: current.revision + 1,
    };
    this.records.set(key, record);
    return { type: "replaced", record: structuredClone(record) };
  }

  async archiveCurrent(input: {
    workspaceId: string;
    sessionId: string;
    archivedAt: string;
  }): Promise<
    | { type: "archived"; record: StoredSession }
    | { type: "not_found" }
  > {
    const key = `${input.workspaceId}:${input.sessionId}`;
    const current = this.records.get(key);
    if (current === undefined) return { type: "not_found" };
    const record = {
      session: {
        ...current.session,
        archivedAt: input.archivedAt,
        updatedAt: input.archivedAt,
      },
      revision: current.revision + 1,
    };
    this.records.set(key, structuredClone(record));
    return { type: "archived", record: structuredClone(record) };
  }

  async deleteCurrent(input: {
    workspaceId: string;
    sessionId: string;
  }): Promise<{ type: "deleted" } | { type: "not_found" }> {
    const deleted = this.records.delete(
      `${input.workspaceId}:${input.sessionId}`,
    );
    return deleted ? { type: "deleted" } : { type: "not_found" };
  }

  async listCurrent(input: {
    workspaceId: string;
    limit: number;
    includeArchived: boolean;
    order: "asc" | "desc";
    statuses?: SessionView["status"][];
    position?: {
      createdAt: string;
      sessionId: string;
      direction: "next" | "previous";
    };
  }): Promise<StoredSession[]> {
    const multiplier = input.order === "asc" ? 1 : -1;
    const ordered = Array.from(this.records.entries())
      .filter(([key]) => key.startsWith(`${input.workspaceId}:`))
      .map(([, record]) => record)
      .filter(
        (record) => input.includeArchived || record.session.archivedAt === null,
      )
      .filter(
        (record) =>
          input.statuses === undefined ||
          input.statuses.includes(record.session.status),
      )
      .sort(
        (left, right) =>
          multiplier *
          (left.session.createdAt.localeCompare(right.session.createdAt) ||
            left.session.id.localeCompare(right.session.id)),
      );
    const positioned =
      input.position === undefined
        ? ordered
        : ordered.filter((record) => {
            const comparison =
              multiplier *
              (record.session.createdAt.localeCompare(
                input.position!.createdAt,
              ) || record.session.id.localeCompare(input.position!.sessionId));
            return input.position!.direction === "next"
              ? comparison > 0
              : comparison < 0;
          });
    if (input.position?.direction === "previous") positioned.reverse();
    return positioned.slice(0, input.limit).map((record) => structuredClone(record));
  }
}

const emptySessionResources = {
  resolve: async () => ({
    type: "resolved" as const,
    resources: [],
    secrets: [],
  }),
};

const silentSessionLifecycle = {
  sessionStarted: async () => {},
  sessionStopped: async () => {},
};

const agent: Agent = {
  id: "agent_01",
  archivedAt: null,
  createdAt: "2026-08-26T00:00:00.000Z",
  description: "Pinned coding agent",
  mcpServers: [{ type: "url", name: "docs", url: "https://mcp.test" }],
  metadata: { owner: "agents" },
  model: { id: "claude-opus-5", effort: "high", speed: "standard" },
  multiagent: null,
  name: "Coding Agent",
  openma: {
    auxiliaryModel: { id: "deepseek-chat", speed: "fast" },
    appendablePrompts: ["prompt_review"],
    harness: "pi",
  },
  skills: [{ type: "anthropic", skillId: "pdf", version: "latest" }],
  system: "Work carefully",
  tools: [
    {
      type: "agent_toolset_20260401",
      configs: [],
      defaultConfig: {
        enabled: true,
        permissionPolicy: { type: "always_allow" },
      },
    },
  ],
  updatedAt: "2026-08-26T01:00:00.000Z",
  version: 3,
};

const environment: Environment = {
  id: "env_01",
  archivedAt: null,
  config: { type: "self_hosted" },
  createdAt: "2026-08-26T00:00:00.000Z",
  description: null,
  metadata: {},
  name: "Local runtime",
  updatedAt: "2026-08-26T00:00:00.000Z",
};

const availableSessionEnvironment = {
  find: async (input: { workspaceId: string; environmentId: string }) =>
    input.workspaceId === "workspace_01" &&
    input.environmentId === environment.id
      ? structuredClone(environment)
      : null,
};

describe("SessionsApplicationService", () => {
  it("rejects a missing or archived environment before persisting a session", async () => {
    const store = new MemorySessionStore();
    const service = new SessionsApplicationService({
      workspaceId: "workspace_01",
      store,
      agents: {
        findCurrent: async () => structuredClone(agent),
        findVersion: async () => null,
      },
      environments: { find: async () => null },
      resources: emptySessionResources,
      lifecycle: silentSessionLifecycle,
      clock: { now: () => new Date("2026-08-26T02:00:00.000Z") },
      ids: { nextSessionId: () => "session_missing_environment" },
    });

    await expect(
      service.createSession({
        agent: { type: "latest", agentId: agent.id },
        environmentId: "env_missing",
      }),
    ).resolves.toEqual({
      type: "dependency_not_found",
      message: "Environment env_missing was not found",
    });
    expect(store.lastInsert).toBeNull();
  });

  it("rejects an archived Environment entity before persisting a session", async () => {
    const store = new MemorySessionStore();
    const service = new SessionsApplicationService({
      workspaceId: "workspace_01",
      store,
      agents: {
        findCurrent: async () => structuredClone(agent),
        findVersion: async () => null,
      },
      environments: {
        find: async () => ({
          ...structuredClone(environment),
          archivedAt: "2026-08-26T02:00:00.000Z",
        }),
      },
      resources: emptySessionResources,
      lifecycle: silentSessionLifecycle,
      clock: { now: () => new Date("2026-08-26T02:00:00.000Z") },
      ids: { nextSessionId: () => "session_archived_environment" },
    });

    await expect(
      service.createSession({
        agent: { type: "latest", agentId: agent.id },
        environmentId: environment.id,
      }),
    ).resolves.toEqual({
      type: "dependency_not_found",
      message: `Environment ${environment.id} was not found`,
    });
    expect(store.lastInsert).toBeNull();
  });

  it("rejects latest and pinned selections when the current Agent is archived", async () => {
    const store = new MemorySessionStore();
    const service = new SessionsApplicationService({
      workspaceId: "workspace_01",
      store,
      agents: {
        findCurrent: async () => ({
          ...structuredClone(agent),
          archivedAt: "2026-08-26T02:00:00.000Z",
        }),
        findVersion: async () => ({
          ...structuredClone(agent),
          archivedAt: null,
          version: 2,
        }),
      },
      environments: availableSessionEnvironment,
      resources: emptySessionResources,
      lifecycle: silentSessionLifecycle,
      clock: { now: () => new Date("2026-08-26T02:00:00.000Z") },
      ids: { nextSessionId: () => "session_forbidden" },
    });

    for (const selector of [
      { type: "latest" as const, agentId: agent.id },
      { type: "versioned" as const, agentId: agent.id, version: 2 },
    ]) {
      await expect(
        service.createSession({
          agent: selector,
          environmentId: environment.id,
        }),
      ).resolves.toEqual({
        type: "dependency_not_found",
        message: `Agent ${agent.id} was not found`,
      });
    }
    expect(store.lastInsert).toBeNull();
  });

  it("creates a session with an immutable versioned agent snapshot", async () => {
    const store = new MemorySessionStore();
    const lifecycleSignals: object[] = [];
    const service = new SessionsApplicationService({
      workspaceId: "workspace_01",
      store,
      agents: {
        findCurrent: async () => null,
        findVersion: async (input: {
          workspaceId: string;
          agentId: string;
          version: number;
        }) =>
          input.workspaceId === "workspace_01" &&
          input.agentId === agent.id &&
          input.version === agent.version
            ? structuredClone(agent)
            : null,
      },
      environments: availableSessionEnvironment,
      resources: {
        resolve: async () => ({
          type: "resolved" as const,
          resources: [
            {
              id: "session_resource_01",
              type: "file" as const,
              createdAt: "2026-08-26T02:00:00.000Z",
              fileId: "file_01",
              mountPath: "/mnt/input.pdf",
              updatedAt: "2026-08-26T02:00:00.000Z",
            },
          ],
          secrets: [],
        }),
      },
      lifecycle: {
        sessionStarted: async (input: object) => {
          lifecycleSignals.push(input);
        },
        sessionStopped: async () => {},
      },
      clock: { now: () => new Date("2026-08-26T02:00:00.000Z") },
      ids: { nextSessionId: () => "session_01" },
    });

    const created = await service.createSession({
      agent: { type: "versioned", agentId: agent.id, version: 3 },
      environmentId: "env_01",
      budget: { amountMinor: "2500", currency: "USD" },
      metadata: { owner: "platform" },
      resources: [
        { type: "file", fileId: "file_01", mountPath: "/mnt/input.pdf" },
      ],
      title: "Ship the migration",
      vaultIds: ["vault_01"],
    });
    const retrieved = await service.retrieveSession({ sessionId: "session_01" });

    expect(created).toEqual({
      type: "created",
      session: {
        id: "session_01",
        agent: {
          id: "agent_01",
          description: "Pinned coding agent",
          mcpServers: [
            { type: "url", name: "docs", url: "https://mcp.test" },
          ],
          model: {
            id: "claude-opus-5",
            effort: "high",
            speed: "standard",
          },
          multiagent: null,
          name: "Coding Agent",
          openma: {
            auxiliaryModel: { id: "deepseek-chat", speed: "fast" },
            appendablePrompts: ["prompt_review"],
            harness: "pi",
          },
          skills: [
            { type: "anthropic", skillId: "pdf", version: "latest" },
          ],
          system: "Work carefully",
          tools: [
            {
              type: "agent_toolset_20260401",
              configs: [],
              defaultConfig: {
                enabled: true,
                permissionPolicy: { type: "always_allow" },
              },
            },
          ],
          version: 3,
        },
        archivedAt: null,
        budget: { amountMinor: "2500", currency: "USD" },
        createdAt: "2026-08-26T02:00:00.000Z",
        environmentId: "env_01",
        metadata: { owner: "platform" },
        outcomeEvaluations: [],
        resources: [
          {
            id: "session_resource_01",
            type: "file",
            createdAt: "2026-08-26T02:00:00.000Z",
            fileId: "file_01",
            mountPath: "/mnt/input.pdf",
            updatedAt: "2026-08-26T02:00:00.000Z",
          },
        ],
        stats: {},
        status: "running",
        title: "Ship the migration",
        updatedAt: "2026-08-26T02:00:00.000Z",
        usage: {},
        vaultIds: ["vault_01"],
      },
    });
    expect(retrieved).toEqual({
      type: "found",
      session: created.type === "created" ? created.session : null,
    });
    expect(lifecycleSignals).toEqual([
      {
        workspaceId: "workspace_01",
        sessionId: "session_01",
        session: created.type === "created" ? created.session : null,
        environment,
        initialEvents: [],
      },
    ]);
  });

  it("selects an explicitly pinned current Agent without treating it as history", async () => {
    const store = new MemorySessionStore();
    const versionLookups: object[] = [];
    const service = new SessionsApplicationService({
      workspaceId: "workspace_01",
      store,
      agents: {
        findCurrent: async () => structuredClone(agent),
        findVersion: async (input) => {
          versionLookups.push(input);
          return null;
        },
      },
      environments: availableSessionEnvironment,
      resources: emptySessionResources,
      lifecycle: silentSessionLifecycle,
      clock: { now: () => new Date("2026-08-26T02:00:00.000Z") },
      ids: { nextSessionId: () => "session_current_version" },
    });

    const created = await service.createSession({
      agent: { type: "versioned", agentId: agent.id, version: agent.version },
      environmentId: environment.id,
    });

    expect(created).toMatchObject({
      type: "created",
      session: { id: "session_current_version", agent: { version: 3 } },
    });
    expect(versionLookups).toEqual([]);
  });

  it("passes resolved GitHub credentials into the atomic session insert", async () => {
    const store = new MemorySessionStore();
    const service = new SessionsApplicationService({
      workspaceId: "workspace_01",
      store,
      agents: {
        findCurrent: async () => structuredClone(agent),
        findVersion: async () => null,
      },
      environments: availableSessionEnvironment,
      resources: {
        resolve: async () => ({
          type: "resolved" as const,
          resources: [
            {
              id: "sesrsc_repo_01",
              type: "github_repository" as const,
              createdAt: "2026-08-26T02:00:00.000Z",
              mountPath: "/workspace/openma",
              updatedAt: "2026-08-26T02:00:00.000Z",
              url: "https://github.com/openma-ai/open-managed-agents",
            },
          ],
          secrets: [
            {
              type: "github_token" as const,
              resourceId: "sesrsc_repo_01",
              authorizationToken: "ghp_create",
            },
          ],
        }),
      },
      lifecycle: silentSessionLifecycle,
      clock: { now: () => new Date("2026-08-26T02:00:00.000Z") },
      ids: { nextSessionId: () => "session_github" },
    });

    await service.createSession({
      agent: { type: "latest", agentId: agent.id },
      environmentId: "env_01",
      resources: [
        {
          type: "github_repository",
          authorizationToken: "ghp_create",
          url: "https://github.com/openma-ai/open-managed-agents",
        },
      ],
    });

    expect(store.lastInsert).toMatchObject({
      workspaceId: "workspace_01",
      session: {
        id: "session_github",
        resources: [{ id: "sesrsc_repo_01", type: "github_repository" }],
      },
      resourceSecrets: [
        {
          type: "github_token",
          resourceId: "sesrsc_repo_01",
          authorizationToken: "ghp_create",
        },
      ],
    });
  });

  it("applies session-only agent overrides to the selected snapshot", async () => {
    const store = new MemorySessionStore();
    const service = new SessionsApplicationService({
      workspaceId: "workspace_01",
      store,
      agents: {
        findCurrent: async () => null,
        findVersion: async () => structuredClone(agent),
      },
      environments: availableSessionEnvironment,
      resources: emptySessionResources,
      lifecycle: silentSessionLifecycle,
      clock: { now: () => new Date("2026-08-26T02:00:00.000Z") },
      ids: { nextSessionId: () => "session_override" },
    });

    const created = await service.createSession({
      agent: {
        type: "overrides",
        agentId: agent.id,
        version: 3,
        mcpServers: [],
        model: {
          id: "claude-sonnet-4-6",
          inferenceGeo: "us",
          speed: "fast",
        },
        skills: [],
        system: null,
        tools: [
          {
            type: "custom",
            name: "deploy",
            description: "Deploy the application",
            inputSchema: { type: "object" },
          },
        ],
      },
      environmentId: "env_01",
    });

    expect(created).toMatchObject({
      type: "created",
      session: {
        agent: {
          id: "agent_01",
          name: "Coding Agent",
          description: "Pinned coding agent",
          mcpServers: [],
          model: {
            id: "claude-sonnet-4-6",
            inferenceGeo: "us",
            speed: "fast",
          },
          multiagent: null,
          skills: [],
          system: null,
          tools: [{ type: "custom", name: "deploy" }],
          version: 3,
        },
      },
    });
    expect(agent).toMatchObject({
      model: { id: "claude-opus-5", effort: "high", speed: "standard" },
      mcpServers: [{ name: "docs" }],
      system: "Work carefully",
    });
  });

  it("expands a pinned roster member from the current Agent record when its version matches", async () => {
    const store = new MemorySessionStore();
    const member: Agent = {
      ...structuredClone(agent),
      id: "agent_member",
      name: "Roster Member",
      version: 7,
    };
    const coordinator: Agent = {
      ...structuredClone(agent),
      id: "agent_coordinator",
      name: "Coordinator",
      multiagent: {
        type: "coordinator",
        agents: [{ type: "agent", agentId: member.id, version: member.version }],
      },
      version: 4,
    };
    const versionLookups: object[] = [];
    const service = new SessionsApplicationService({
      workspaceId: "workspace_01",
      store,
      agents: {
        findCurrent: async ({ agentId }) =>
          structuredClone(
            agentId === coordinator.id
              ? coordinator
              : agentId === member.id
                ? member
                : null,
          ),
        findVersion: async (input) => {
          versionLookups.push(input);
          return null;
        },
      },
      environments: availableSessionEnvironment,
      resources: emptySessionResources,
      lifecycle: silentSessionLifecycle,
      clock: { now: () => new Date("2026-08-26T02:00:00.000Z") },
      ids: { nextSessionId: () => "session_coordinator" },
    });

    const created = await service.createSession({
      agent: { type: "latest", agentId: coordinator.id },
      environmentId: environment.id,
    });

    expect(created).toMatchObject({
      type: "created",
      session: {
        agent: {
          id: coordinator.id,
          multiagent: {
            type: "coordinator",
            agents: [
              {
                type: "agent",
                id: member.id,
                name: member.name,
                version: member.version,
              },
            ],
          },
        },
      },
    });
    expect(versionLookups).toEqual([]);
  });

  it("updates mutable session fields through an optimistic revision", async () => {
    let now = new Date("2026-08-26T02:00:00.000Z");
    const store = new MemorySessionStore();
    const service = new SessionsApplicationService({
      workspaceId: "workspace_01",
      store,
      agents: {
        findCurrent: async () => structuredClone(agent),
        findVersion: async () => null,
      },
      environments: availableSessionEnvironment,
      resources: emptySessionResources,
      lifecycle: silentSessionLifecycle,
      clock: { now: () => now },
      ids: { nextSessionId: () => "session_update" },
    });
    await service.createSession({
      agent: { type: "latest", agentId: agent.id },
      environmentId: "env_01",
      budget: { amountMinor: "2500", currency: "USD" },
      metadata: { owner: "platform", obsolete: "remove" },
      title: "Initial title",
      vaultIds: ["vault_01"],
    });
    now = new Date("2026-08-26T03:00:00.000Z");

    const updated = await service.updateSession({
      sessionId: "session_update",
      agent: {
        mcpServers: [],
        tools: [
          {
            type: "custom",
            name: "release",
            description: "Release the application",
            inputSchema: { type: "object" },
          },
        ],
      },
      budget: null,
      metadata: { owner: "runtime", obsolete: null },
      title: null,
      vaultIds: ["vault_02"],
    });
    const retrieved = await service.retrieveSession({
      sessionId: "session_update",
    });

    expect(updated).toMatchObject({
      type: "updated",
      session: {
        agent: {
          id: "agent_01",
          version: 3,
          mcpServers: [],
          tools: [{ type: "custom", name: "release" }],
        },
        budget: null,
        metadata: { owner: "runtime" },
        title: null,
        updatedAt: "2026-08-26T03:00:00.000Z",
        vaultIds: ["vault_02"],
      },
    });
    expect(retrieved).toEqual({
      type: "found",
      session: updated.type === "updated" ? updated.session : null,
    });
  });

  it("returns an explicit version conflict when the stored revision changes", async () => {
    const store = new MemorySessionStore(true);
    const service = new SessionsApplicationService({
      workspaceId: "workspace_01",
      store,
      agents: {
        findCurrent: async () => structuredClone(agent),
        findVersion: async () => null,
      },
      environments: availableSessionEnvironment,
      resources: emptySessionResources,
      lifecycle: silentSessionLifecycle,
      clock: { now: () => new Date("2026-08-26T02:00:00.000Z") },
      ids: { nextSessionId: () => "session_conflict" },
    });
    await service.createSession({
      agent: { type: "latest", agentId: agent.id },
      environmentId: "env_01",
    });

    const result = await service.updateSession({
      sessionId: "session_conflict",
      title: "Conflicting update",
    });

    expect(result).toEqual({
      type: "version_conflict",
      message: "Session changed concurrently at revision 2",
    });
  });

  it("archives a session through the atomic persistence capability", async () => {
    let now = new Date("2026-08-26T02:00:00.000Z");
    const lifecycleSignals: object[] = [];
    const service = new SessionsApplicationService({
      workspaceId: "workspace_01",
      store: new MemorySessionStore(),
      agents: {
        findCurrent: async () => structuredClone(agent),
        findVersion: async () => null,
      },
      environments: availableSessionEnvironment,
      resources: emptySessionResources,
      lifecycle: {
        sessionStarted: async (input: object) => {
          lifecycleSignals.push({ type: "started", ...input });
        },
        sessionStopped: async (input: object) => {
          lifecycleSignals.push({ type: "stopped", ...input });
        },
      },
      clock: { now: () => now },
      ids: { nextSessionId: () => "session_archive" },
    });
    await service.createSession({
      agent: { type: "latest", agentId: agent.id },
      environmentId: "env_01",
    });
    now = new Date("2026-08-26T04:00:00.000Z");

    const archived = await service.archiveSession({
      sessionId: "session_archive",
    });

    expect(archived).toMatchObject({
      type: "archived",
      session: {
        id: "session_archive",
        archivedAt: "2026-08-26T04:00:00.000Z",
        updatedAt: "2026-08-26T04:00:00.000Z",
      },
    });
    expect(lifecycleSignals).toEqual([
      {
        type: "started",
        workspaceId: "workspace_01",
        sessionId: "session_archive",
        session: expect.objectContaining({ id: "session_archive" }),
        environment,
        initialEvents: [],
      },
      {
        type: "stopped",
        workspaceId: "workspace_01",
        sessionId: "session_archive",
        session:
          archived.type === "archived" ? archived.session : null,
        reason: "archived",
      },
    ]);
  });

  it("deletes a session so it can no longer be retrieved", async () => {
    const lifecycleSignals: object[] = [];
    const service = new SessionsApplicationService({
      workspaceId: "workspace_01",
      store: new MemorySessionStore(),
      agents: {
        findCurrent: async () => structuredClone(agent),
        findVersion: async () => null,
      },
      environments: availableSessionEnvironment,
      resources: emptySessionResources,
      lifecycle: {
        sessionStarted: async () => {},
        sessionStopped: async (input: object) => {
          lifecycleSignals.push(input);
        },
      },
      clock: { now: () => new Date("2026-08-26T02:00:00.000Z") },
      ids: { nextSessionId: () => "session_delete" },
    });
    await service.createSession({
      agent: { type: "latest", agentId: agent.id },
      environmentId: "env_01",
    });

    const deleted = await service.deleteSession({ sessionId: "session_delete" });
    const retrieved = await service.retrieveSession({
      sessionId: "session_delete",
    });

    expect(deleted).toEqual({
      type: "deleted",
      sessionId: "session_delete",
    });
    expect(retrieved).toEqual({ type: "not_found" });
    expect(lifecycleSignals).toEqual([
      {
        workspaceId: "workspace_01",
        sessionId: "session_delete",
        session: expect.objectContaining({
          id: "session_delete",
          environmentId: "env_01",
        }),
        reason: "deleted",
      },
    ]);
  });

  it("paginates sessions forward and backward with a stable cursor", async () => {
    let now = new Date("2026-08-26T00:00:00.000Z");
    let nextId = 0;
    const service = new SessionsApplicationService({
      workspaceId: "workspace_01",
      store: new MemorySessionStore(),
      agents: {
        findCurrent: async () => structuredClone(agent),
        findVersion: async () => null,
      },
      environments: availableSessionEnvironment,
      resources: emptySessionResources,
      lifecycle: silentSessionLifecycle,
      clock: { now: () => now },
      ids: { nextSessionId: () => `session_0${++nextId}` },
    });
    await service.createSession({
      agent: { type: "latest", agentId: agent.id },
      environmentId: "env_01",
      title: "Oldest",
    });
    now = new Date("2026-08-26T01:00:00.000Z");
    await service.createSession({
      agent: { type: "latest", agentId: agent.id },
      environmentId: "env_01",
      title: "Middle",
    });
    now = new Date("2026-08-26T02:00:00.000Z");
    await service.createSession({
      agent: { type: "latest", agentId: agent.id },
      environmentId: "env_01",
      title: "Newest",
    });

    const first = await service.listSessions({ pageSize: 1, order: "desc" });
    if (first.type !== "page") throw new Error("expected first sessions page");
    const second = await service.listSessions({
      pageSize: 1,
      order: "desc",
      cursor: first.page.nextCursor ?? undefined,
    });
    if (second.type !== "page") throw new Error("expected second sessions page");
    const previous = await service.listSessions({
      pageSize: 1,
      order: "desc",
      cursor: second.page.previousCursor ?? undefined,
    });

    expect(first).toMatchObject({
      type: "page",
      page: {
        sessions: [{ title: "Newest" }],
        nextCursor: expect.any(String),
        previousCursor: null,
      },
    });
    expect(second).toMatchObject({
      type: "page",
      page: {
        sessions: [{ title: "Middle" }],
        nextCursor: expect.any(String),
        previousCursor: expect.any(String),
      },
    });
    expect(previous).toMatchObject({
      type: "page",
      page: {
        sessions: [{ title: "Newest" }],
        nextCursor: expect.any(String),
        previousCursor: null,
      },
    });
  });
});
