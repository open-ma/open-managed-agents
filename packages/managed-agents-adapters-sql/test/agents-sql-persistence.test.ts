import { beforeEach, describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { AgentRecord } from "@open-managed-agents/managed-agents-application/agents-persistence-port";
import { AgentsApplicationService } from "@open-managed-agents/managed-agents-application";
import { SqlAgentPersistence } from "../src";
import { agentStorePortContract } from "./contracts/store-port-contracts";

const SCHEMA_SQL = `
CREATE TABLE agents (
  id text PRIMARY KEY NOT NULL,
  tenant_id text NOT NULL,
  config text NOT NULL,
  version integer NOT NULL,
  created_at integer NOT NULL,
  updated_at integer,
  archived_at integer
);
CREATE INDEX idx_agents_tenant_created_id
  ON agents (tenant_id, created_at, id);

CREATE TABLE agent_versions (
  agent_id text NOT NULL,
  tenant_id text NOT NULL,
  version integer NOT NULL,
  snapshot text NOT NULL,
  created_at integer NOT NULL,
  PRIMARY KEY (agent_id, version)
);
CREATE INDEX idx_agent_versions_tenant_agent
  ON agent_versions (tenant_id, agent_id, version);

CREATE TABLE managed_agents (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL,
  document text NOT NULL,
  version integer NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  archived_at integer
);
CREATE INDEX idx_managed_agents_workspace_created_id
  ON managed_agents (workspace_id, created_at, id);

CREATE TABLE managed_agent_versions (
  agent_id text NOT NULL,
  workspace_id text NOT NULL,
  version integer NOT NULL,
  document text NOT NULL,
  created_at integer NOT NULL,
  PRIMARY KEY (agent_id, version)
);
CREATE INDEX idx_managed_agent_versions_workspace_agent
  ON managed_agent_versions (workspace_id, agent_id, version);
`;

const agent: AgentRecord = {
  id: "agent_01",
  archivedAt: null,
  createdAt: "2026-08-26T00:00:00.000Z",
  description: null,
  mcpServers: [
    { type: "url", name: "docs", url: "https://mcp.example.test" },
    {
      type: "stdio",
      name: "workspace",
      command: "/usr/local/bin/workspace-mcp",
      args: ["--root", "/workspace"],
      env: { LOG_LEVEL: "info" },
    },
  ],
  metadata: { owner: "platform" },
  model: {
    id: "claude-opus-5",
    effort: "high",
    providerOptions: {
      anthropic: {
        beta: ["context-1m"],
        request: { priority: null },
      },
    },
    speed: "fast",
  },
  multiagent: null,
  name: "Coding Assistant",
  openma: {
    auxiliaryModel: {
      id: "deepseek-chat",
      providerOptions: {
        pi: { reasoning: "off", sampling: { temperature: 0 } },
      },
    },
  },
  skills: [{ type: "custom", skillId: "skill_review", version: "3" }],
  system: "Write tested code.",
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
  updatedAt: "2026-08-26T00:00:00.000Z",
  version: 1,
};

function agentAt(id: string, createdAt: string): AgentRecord {
  return {
    ...agent,
    id,
    name: id,
    createdAt,
    updatedAt: createdAt,
  };
}

let client: SqlClient;

beforeEach(async () => {
  client = await createBetterSqlite3SqlClient(":memory:");
  await client.exec(SCHEMA_SQL);
});

describe("SqlAgentPersistence", () => {
  it("inserts and retrieves an agent inside its workspace boundary", async () => {
    const persistence = new SqlAgentPersistence(client);

    await persistence.insert({ workspaceId: "workspace_01", agent });

    await expect(
      persistence.findCurrent({
        workspaceId: "workspace_01",
        agentId: agent.id,
      }),
    ).resolves.toEqual(agent);
    await expect(
      persistence.findCurrent({
        workspaceId: "workspace_other",
        agentId: agent.id,
      }),
    ).resolves.toBeNull();
  });

  it("stores official Managed Agents independently from the legacy agents table", async () => {
    await client
      .prepare(
        `INSERT INTO agents
          (id, tenant_id, config, version, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        agent.id,
        "workspace_legacy",
        JSON.stringify({ legacy: true }),
        99,
        1,
        1,
        null,
      )
      .run();
    const persistence = new SqlAgentPersistence(client);

    await persistence.insert({ workspaceId: "workspace_01", agent });

    await expect(
      client
        .prepare("SELECT config FROM agents WHERE id = ?")
        .bind(agent.id)
        .first<{ config: string }>(),
    ).resolves.toEqual({ config: JSON.stringify({ legacy: true }) });
    await expect(
      client
        .prepare(
          "SELECT COUNT(*) AS count FROM managed_agents WHERE workspace_id = ? AND id = ?",
        )
        .bind("workspace_01", agent.id)
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 1 });
  });

  it("atomically replaces the current agent, snapshots the prior version, and rejects stale CAS", async () => {
    const persistence = new SqlAgentPersistence(client);
    await persistence.insert({ workspaceId: "workspace_01", agent });
    const next: AgentRecord = {
      ...agent,
      name: "Coding Assistant v2",
      updatedAt: "2026-08-26T01:00:00.000Z",
      version: 2,
    };

    await expect(
      persistence.replaceCurrent({
        workspaceId: "workspace_01",
        agentId: agent.id,
        expectedVersion: 1,
        next,
      }),
    ).resolves.toEqual({ type: "replaced", agent: next });
    await expect(
      persistence.findVersion({
        workspaceId: "workspace_01",
        agentId: agent.id,
        version: 1,
      }),
    ).resolves.toEqual(agent);

    const staleNext: AgentRecord = {
      ...next,
      name: "Stale overwrite",
    };
    await expect(
      persistence.replaceCurrent({
        workspaceId: "workspace_01",
        agentId: agent.id,
        expectedVersion: 1,
        next: staleNext,
      }),
    ).resolves.toEqual({ type: "version_conflict", actualVersion: 2 });
    await expect(
      persistence.findCurrent({
        workspaceId: "workspace_01",
        agentId: agent.id,
      }),
    ).resolves.toEqual(next);
  });

  it("archives lifecycle state without creating a configuration version", async () => {
    const persistence = new SqlAgentPersistence(client);
    await persistence.insert({ workspaceId: "workspace_01", agent });

    await expect(
      persistence.archiveCurrent({
        workspaceId: "workspace_01",
        agentId: agent.id,
        archivedAt: "2026-08-26T02:00:00.000Z",
      }),
    ).resolves.toEqual({
      type: "archived",
      agent: {
        ...agent,
        archivedAt: "2026-08-26T02:00:00.000Z",
        updatedAt: "2026-08-26T02:00:00.000Z",
      },
    });
    await expect(
      persistence.findVersion({
        workspaceId: "workspace_01",
        agentId: agent.id,
        version: 1,
      }),
    ).resolves.toBeNull();
  });

  it("lists current agents by workspace, lifecycle, time range, and composite position", async () => {
    const persistence = new SqlAgentPersistence(client);
    const first = agentAt("agent_01", "2026-08-26T00:00:00.000Z");
    const archived = agentAt("agent_02", "2026-08-26T01:00:00.000Z");
    const third = agentAt("agent_03", "2026-08-26T02:00:00.000Z");
    const fourth = agentAt("agent_04", "2026-08-26T02:00:00.000Z");
    const foreign = agentAt("agent_foreign", "2026-08-26T03:00:00.000Z");
    for (const value of [first, archived, third, fourth]) {
      await persistence.insert({ workspaceId: "workspace_01", agent: value });
    }
    await persistence.insert({ workspaceId: "workspace_other", agent: foreign });
    await persistence.archiveCurrent({
      workspaceId: "workspace_01",
      agentId: archived.id,
      archivedAt: "2026-08-26T04:00:00.000Z",
    });

    await expect(
      persistence.listCurrent({
        workspaceId: "workspace_01",
        limit: 2,
        includeArchived: false,
        createdAtOrAfter: "2026-08-26T00:00:00.000Z",
        createdAtOrBefore: "2026-08-26T02:00:00.000Z",
      }),
    ).resolves.toEqual([fourth, third]);
    await expect(
      persistence.listCurrent({
        workspaceId: "workspace_01",
        limit: 10,
        includeArchived: false,
        after: { createdAt: third.createdAt, agentId: third.id },
      }),
    ).resolves.toEqual([first]);
    await expect(
      persistence.listCurrent({
        workspaceId: "workspace_01",
        limit: 10,
        includeArchived: true,
      }),
    ).resolves.toEqual([
      fourth,
      third,
      {
        ...archived,
        archivedAt: "2026-08-26T04:00:00.000Z",
        updatedAt: "2026-08-26T04:00:00.000Z",
      },
      first,
    ]);
  });

  it("lists historical versions newest first before the supplied version", async () => {
    const persistence = new SqlAgentPersistence(client);
    await persistence.insert({ workspaceId: "workspace_01", agent });
    const second = {
      ...agent,
      name: "Version two",
      updatedAt: "2026-08-26T01:00:00.000Z",
      version: 2,
    };
    const third = {
      ...second,
      name: "Version three",
      updatedAt: "2026-08-26T02:00:00.000Z",
      version: 3,
    };
    await persistence.replaceCurrent({
      workspaceId: "workspace_01",
      agentId: agent.id,
      expectedVersion: 1,
      next: second,
    });
    await persistence.replaceCurrent({
      workspaceId: "workspace_01",
      agentId: agent.id,
      expectedVersion: 2,
      next: third,
    });

    await expect(
      persistence.listVersions({
        workspaceId: "workspace_01",
        agentId: agent.id,
        beforeVersion: 3,
        limit: 2,
      }),
    ).resolves.toEqual([second, agent]);
    await expect(
      persistence.listVersions({
        workspaceId: "workspace_01",
        agentId: agent.id,
        beforeVersion: 2,
        limit: 1,
      }),
    ).resolves.toEqual([agent]);
  });

  it("allows exactly one application update to win a concurrent CAS race", async () => {
    const persistence = new SqlAgentPersistence(client);
    const firstService = new AgentsApplicationService({
      workspaceId: "workspace_01",
      store: persistence,
      clock: { now: () => new Date("2026-08-26T01:00:00.000Z") },
      ids: { nextAgentId: () => agent.id },
    });
    const secondService = new AgentsApplicationService({
      workspaceId: "workspace_01",
      store: persistence,
      clock: { now: () => new Date("2026-08-26T02:00:00.000Z") },
      ids: { nextAgentId: () => "unused" },
    });
    await firstService.createAgent({
      name: agent.name,
      model: agent.model,
    });

    const results = await Promise.all([
      firstService.updateAgent({ agentId: agent.id, name: "First writer" }),
      secondService.updateAgent({ agentId: agent.id, name: "Second writer" }),
    ]);

    expect(results.map((result) => result.type).sort()).toEqual([
      "updated",
      "version_conflict",
    ]);
    await expect(
      persistence.findCurrent({
        workspaceId: "workspace_01",
        agentId: agent.id,
      }),
    ).resolves.toMatchObject({ version: 2 });
    await expect(
      persistence.findVersion({
        workspaceId: "workspace_01",
        agentId: agent.id,
        version: 1,
      }),
    ).resolves.toMatchObject({ version: 1 });
  });
});

agentStorePortContract("SQLite", () => new SqlAgentPersistence(client));
