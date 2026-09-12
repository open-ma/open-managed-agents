import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { PostgresSqlClient } from "@open-managed-agents/sql-client/adapters/postgres";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { AgentRecord } from "@open-managed-agents/managed-agents-application/agents-persistence-port";
import { getStorageIntegrationConfig } from "../../../test/storage-integration.js";
import { SqlAgentPersistence } from "../src";
import { agentStorePortContract } from "./contracts/store-port-contracts";

const PG_URL = getStorageIntegrationConfig().postgres.agentsSql;
const WORKSPACE_ID = "managed_agents_adapter_pg_contract";

const agent: AgentRecord = {
  id: "agent_pg_contract_01",
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
  name: "PostgreSQL agent",
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

let connection: ReturnType<typeof postgres>;
let client: SqlClient;

function assertLocalTestDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error(`Refusing PostgreSQL contract test against non-loopback host ${host}`);
  }
}

beforeAll(async () => {
  assertLocalTestDatabase(PG_URL);
  connection = postgres(PG_URL, {
    max: 1,
    types: {
      bigint: {
        to: 20,
        from: [20],
        serialize: (value: number) => value.toString(),
        parse: (value: string) => Number(value),
      },
    },
  });
  client = new PostgresSqlClient(
    connection as unknown as ConstructorParameters<typeof PostgresSqlClient>[0],
  );
  await client.exec(`
    CREATE TABLE IF NOT EXISTS managed_agents (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      document text NOT NULL,
      version bigint NOT NULL,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL,
      archived_at bigint
    );
    CREATE TABLE IF NOT EXISTS managed_agent_versions (
      agent_id text NOT NULL,
      workspace_id text NOT NULL,
      version bigint NOT NULL,
      document text NOT NULL,
      created_at bigint NOT NULL,
      PRIMARY KEY (agent_id, version)
    );
  `);
  await client
    .prepare("DELETE FROM managed_agent_versions WHERE workspace_id = ?")
    .bind(WORKSPACE_ID)
    .run();
  await client
    .prepare("DELETE FROM managed_agents WHERE workspace_id = ?")
    .bind(WORKSPACE_ID)
    .run();
});

afterAll(async () => {
  await client
    .prepare("DELETE FROM managed_agent_versions WHERE workspace_id = ?")
    .bind(WORKSPACE_ID)
    .run();
  await client
    .prepare("DELETE FROM managed_agents WHERE workspace_id = ?")
    .bind(WORKSPACE_ID)
    .run();
  await connection.end({ timeout: 5 });
});

describe("SqlAgentPersistence on PostgreSQL", () => {
  it("honors insert, atomic CAS, conflict, history, and list Port semantics", async () => {
    const persistence = new SqlAgentPersistence(client);
    const next = {
      ...agent,
      name: "PostgreSQL agent v2",
      updatedAt: "2026-08-26T01:00:00.000Z",
      version: 2,
    };

    await persistence.insert({ workspaceId: WORKSPACE_ID, agent });
    await expect(
      persistence.replaceCurrent({
        workspaceId: WORKSPACE_ID,
        agentId: agent.id,
        expectedVersion: 1,
        next,
      }),
    ).resolves.toEqual({ type: "replaced", agent: next });
    await expect(
      persistence.replaceCurrent({
        workspaceId: WORKSPACE_ID,
        agentId: agent.id,
        expectedVersion: 1,
        next,
      }),
    ).resolves.toEqual({ type: "version_conflict", actualVersion: 2 });
    await expect(
      persistence.findVersion({
        workspaceId: WORKSPACE_ID,
        agentId: agent.id,
        version: 1,
      }),
    ).resolves.toEqual(agent);
    await expect(
      persistence.listCurrent({
        workspaceId: WORKSPACE_ID,
        includeArchived: false,
        limit: 10,
      }),
    ).resolves.toEqual([next]);
  });
});

agentStorePortContract("Docker PostgreSQL", () => new SqlAgentPersistence(client));
