import { beforeEach, describe, expect, it } from "vitest";

import {
  createBetterSqlite3SqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";

import { SqlAgentStore } from "../src";

const SCHEMA = `
CREATE TABLE managed_agents (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL,
  document text NOT NULL,
  version integer NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  archived_at integer
);
CREATE TABLE managed_agent_versions (
  agent_id text NOT NULL,
  workspace_id text NOT NULL,
  version integer NOT NULL,
  document text NOT NULL,
  created_at integer NOT NULL,
  PRIMARY KEY (agent_id, version)
);`;

describe("SqlAgentStore", () => {
  let client: SqlClient;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA);
  });

  it("implements the AgentStore contract through an injected SqlClient", async () => {
    const store = new SqlAgentStore(client);
    const agent = {
      id: "agent-1",
      archivedAt: null,
      createdAt: "2026-08-26T00:00:00.000Z",
      description: null,
      mcpServers: [],
      metadata: {},
      model: {
        id: "claude-opus-5",
        providerOptions: {
          anthropic: { beta: ["context-1m"], request: { priority: null } },
        },
      },
      multiagent: null,
      name: "Agent One",
      openma: {
        auxiliaryModel: {
          id: "deepseek-chat",
          providerOptions: { pi: { reasoning: "off" } },
        },
      },
      skills: [],
      system: null,
      tools: [],
      updatedAt: "2026-08-26T00:00:00.000Z",
      version: 1,
    };

    await store.insert({ workspaceId: "workspace-a", agent });

    await expect(store.findCurrent({
      workspaceId: "workspace-a",
      agentId: agent.id,
    })).resolves.toEqual(agent);
    await expect(store.findCurrent({
      workspaceId: "workspace-b",
      agentId: agent.id,
    })).resolves.toBeNull();
  });

  it("does not let a replacement resurrect an archived current Agent", async () => {
    const store = new SqlAgentStore(client);
    const agent = {
      id: "agent-1",
      archivedAt: null,
      createdAt: "2026-08-26T00:00:00.000Z",
      description: null,
      mcpServers: [],
      metadata: {},
      model: { id: "claude-opus-5" },
      multiagent: null,
      name: "Agent One",
      skills: [],
      system: null,
      tools: [],
      updatedAt: "2026-08-26T00:00:00.000Z",
      version: 1,
    };
    await store.insert({ workspaceId: "workspace-a", agent });
    await store.archiveCurrent({
      workspaceId: "workspace-a",
      agentId: agent.id,
      archivedAt: "2026-08-26T01:00:00.000Z",
    });

    await expect(store.replaceCurrent({
      workspaceId: "workspace-a",
      agentId: agent.id,
      expectedVersion: 1,
      next: { ...agent, name: "resurrected", version: 2 },
    })).resolves.toEqual({ type: "version_conflict", actualVersion: 1 });
    await expect(store.findCurrent({
      workspaceId: "workspace-a",
      agentId: agent.id,
    })).resolves.toMatchObject({
      archivedAt: "2026-08-26T01:00:00.000Z",
      name: "Agent One",
      version: 1,
    });
  });
});
