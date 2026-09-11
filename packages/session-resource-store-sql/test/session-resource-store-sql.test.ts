import { beforeEach, describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { Session, SessionResource } from "@open-managed-agents/domain/sessions";
import * as sessionResourceSql from "../src/index";

const { SqlSessionResourceStore } = sessionResourceSql;

const SCHEMA = `
CREATE TABLE managed_sessions (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL,
  document text NOT NULL,
  revision integer NOT NULL,
  agent_id text NOT NULL,
  agent_version integer NOT NULL,
  environment_id text NOT NULL,
  deployment_id text,
  status text NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  archived_at integer
);
CREATE TABLE managed_session_memory_stores (
  session_id text NOT NULL,
  workspace_id text NOT NULL,
  memory_store_id text NOT NULL,
  PRIMARY KEY (session_id, workspace_id, memory_store_id)
);
CREATE TABLE managed_session_resource_secrets (
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  resource_id text NOT NULL,
  secret_type text NOT NULL,
  sealed_value text NOT NULL,
  updated_at integer NOT NULL,
  PRIMARY KEY (workspace_id, session_id, resource_id)
);
`;

const oldMemory: Extract<SessionResource, { type: "memory_store" }> = {
  type: "memory_store",
  memoryStoreId: "memory_old",
  access: "read_only",
  description: "",
  name: "old",
};

const repository: SessionResource = {
  id: "sesrsc_repo_01",
  type: "github_repository",
  createdAt: "2026-08-26T01:00:00.000Z",
  mountPath: "/workspace/repository",
  updatedAt: "2026-08-26T01:00:00.000Z",
  url: "https://github.com/openma-ai/open-managed-agents",
};

const session: Session = {
  id: "session_01",
  agent: {
    id: "agent_01",
    description: null,
    mcpServers: [],
    model: { id: "claude-opus-5" },
    multiagent: null,
    name: "Coding agent",
    skills: [],
    system: null,
    tools: [],
    version: 1,
  },
  archivedAt: null,
  budget: null,
  createdAt: "2026-08-26T01:00:00.000Z",
  environmentId: "environment_01",
  metadata: {},
  outcomeEvaluations: [],
  resources: [oldMemory, repository],
  stats: {},
  status: "running",
  title: null,
  updatedAt: "2026-08-26T01:00:00.000Z",
  usage: {},
  vaultIds: [],
};

describe("SqlSessionResourceStore", () => {
  let client: SqlClient;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA);
    await client
      .prepare(
        `INSERT INTO managed_sessions
          (id, workspace_id, document, revision, agent_id, agent_version,
           environment_id, deployment_id, status, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        session.id,
        "workspace_01",
        JSON.stringify(session),
        3,
        session.agent.id,
        session.agent.version,
        session.environmentId,
        null,
        session.status,
        Date.parse(session.createdAt),
        Date.parse(session.updatedAt),
        null,
      )
      .run();
    await client
      .prepare(
        `INSERT INTO managed_session_memory_stores
          (session_id, workspace_id, memory_store_id) VALUES (?, ?, ?)`,
      )
      .bind(session.id, "workspace_01", oldMemory.memoryStoreId)
      .run();
  });

  it("atomically CASes the snapshot, secret, and Memory Store relation", async () => {
    const store = new SqlSessionResourceStore(client, {
      seal: async (value) => `sealed:${value}`,
    });
    const newMemory: SessionResource = {
      ...oldMemory,
      memoryStoreId: "memory_new",
      name: "new",
    };
    const updatedRepository: SessionResource = {
      ...repository,
      updatedAt: "2026-08-26T02:00:00.000Z",
    };

    await expect(store.replaceCurrent({
      workspaceId: "workspace_01",
      sessionId: session.id,
      expectedRevision: 3,
      resources: [newMemory, updatedRepository],
      updatedAt: "2026-08-26T02:00:00.000Z",
      secretChanges: [{
        type: "store_github_token",
        resourceId: repository.id,
        authorizationToken: "ghp_current",
      }],
    })).resolves.toEqual({
      type: "replaced",
      record: { resources: [newMemory, updatedRepository], revision: 4 },
    });
    await expect(store.replaceCurrent({
      workspaceId: "workspace_01",
      sessionId: session.id,
      expectedRevision: 3,
      resources: [],
      updatedAt: "2026-08-26T03:00:00.000Z",
      secretChanges: [{
        type: "store_github_token",
        resourceId: repository.id,
        authorizationToken: "ghp_stale",
      }],
    })).resolves.toEqual({ type: "revision_conflict", actualRevision: 4 });

    await expect(client
      .prepare(
        `SELECT memory_store_id FROM managed_session_memory_stores
          WHERE workspace_id = ? AND session_id = ? ORDER BY memory_store_id`,
      )
      .bind("workspace_01", session.id)
      .all<{ memory_store_id: string }>()).resolves.toMatchObject({
        results: [{ memory_store_id: "memory_new" }],
      });
    await expect(client
      .prepare(
        `SELECT sealed_value FROM managed_session_resource_secrets
          WHERE workspace_id = ? AND session_id = ? AND resource_id = ?`,
      )
      .bind("workspace_01", session.id, repository.id)
      .first<{ sealed_value: string }>()).resolves.toEqual({
        sealed_value: "sealed:ghp_current",
      });
    const stored = await client
      .prepare("SELECT document FROM managed_sessions WHERE id = ?")
      .bind(session.id)
      .first<{ document: string }>();
    expect(stored?.document).not.toContain("ghp_current");
    expect(stored?.document).not.toContain("ghp_stale");
  });

  it("opens a GitHub token only within its workspace, session, and resource scope", async () => {
    await client
      .prepare(
        `INSERT INTO managed_session_resource_secrets
          (workspace_id, session_id, resource_id, secret_type, sealed_value, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "workspace_01",
        session.id,
        repository.id,
        "github_token",
        "sealed:ghp_private",
        Date.parse(session.updatedAt),
      )
      .run();
    const Source = (sessionResourceSql as Record<string, unknown>)
      .SqlSessionResourceSecretSource as undefined | (new (
        client: SqlClient,
        opener: { open(value: string): Promise<string> },
      ) => {
        findGithubToken(input: {
          workspaceId: string;
          sessionId: string;
          resourceId: string;
        }): Promise<string | null>;
      });
    expect(Source).toBeTypeOf("function");
    if (Source === undefined) return;
    const source = new Source(client, {
      open: async (value) => value.replace(/^sealed:/u, ""),
    });

    await expect(source.findGithubToken({
      workspaceId: "workspace_01",
      sessionId: session.id,
      resourceId: repository.id,
    })).resolves.toBe("ghp_private");
    await expect(source.findGithubToken({
      workspaceId: "workspace_other",
      sessionId: session.id,
      resourceId: repository.id,
    })).resolves.toBeNull();
  });
});
