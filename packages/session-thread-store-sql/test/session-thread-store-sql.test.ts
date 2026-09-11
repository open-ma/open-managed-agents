import { beforeEach, describe, expect, it } from "vitest";
import type { SessionThread } from "@open-managed-agents/domain/sessions";
import {
  createBetterSqlite3SqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";

import { SqlSessionThreadStore } from "../src/index";

const SCHEMA_SQL = `
CREATE TABLE managed_session_threads (
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  id text NOT NULL,
  document text NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  archived_at integer,
  PRIMARY KEY (workspace_id, session_id, id)
);
CREATE INDEX idx_managed_session_threads_workspace_session_created_id
  ON managed_session_threads (workspace_id, session_id, created_at, id);
`;

function thread(id: string, createdAt: string): SessionThread {
  return {
    id,
    agent: {
      type: "agent",
      id: "agent_01",
      description: null,
      mcpServers: [],
      model: { id: "claude-opus-5" },
      name: "Coding agent",
      skills: [],
      system: null,
      tools: [],
      version: 1,
    },
    archivedAt: null,
    createdAt,
    parentThreadId: null,
    sessionId: "session_01",
    stats: null,
    status: "running",
    updatedAt: createdAt,
    usage: null,
  };
}

describe("SqlSessionThreadStore", () => {
  let client: SqlClient;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA_SQL);
  });

  it("inserts, isolates, and pages complete Session Thread aggregates", async () => {
    const store = new SqlSessionThreadStore(client);
    const first = thread("thread_01", "2026-08-26T01:00:00.000Z");
    const second = thread("thread_02", "2026-08-26T02:00:00.000Z");
    await store.insert({ workspaceId: "workspace_01", thread: first });
    await store.insert({ workspaceId: "workspace_01", thread: second });
    await store.insert({ workspaceId: "workspace_other", thread: first });

    await expect(store.list({
      workspaceId: "workspace_01",
      sessionId: "session_01",
      limit: 10,
      position: { createdAt: first.createdAt, threadId: first.id },
    })).resolves.toEqual([second]);
    await expect(store.find({
      workspaceId: "workspace_other",
      sessionId: "session_01",
      threadId: "thread_02",
    })).resolves.toBeNull();
  });

  it("preserves the first archive transition across retries", async () => {
    const store = new SqlSessionThreadStore(client);
    await store.insert({
      workspaceId: "workspace_01",
      thread: thread("thread_01", "2026-08-26T01:00:00.000Z"),
    });

    await expect(store.archive({
      workspaceId: "workspace_01",
      sessionId: "session_01",
      threadId: "thread_01",
      archivedAt: "2026-08-26T03:00:00.000Z",
    })).resolves.toMatchObject({
      type: "archived",
      transitioned: true,
      thread: { archivedAt: "2026-08-26T03:00:00.000Z" },
    });
    await expect(store.archive({
      workspaceId: "workspace_01",
      sessionId: "session_01",
      threadId: "thread_01",
      archivedAt: "2026-08-26T04:00:00.000Z",
    })).resolves.toMatchObject({
      type: "archived",
      transitioned: false,
      thread: {
        archivedAt: "2026-08-26T03:00:00.000Z",
        updatedAt: "2026-08-26T03:00:00.000Z",
      },
    });
  });

  it("rejects child creation after its parent execution fence expires or changes owner", async () => {
    await client.exec(`CREATE TABLE managed_session_executions (
      workspace_id text, id text, session_id text, state text, attempt_id text,
      owner_id text, generation integer, lease_expires_at_ms integer
    )`);
    const now = Date.parse("2026-09-11T00:00:00Z");
    await client.prepare(`INSERT INTO managed_session_executions VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind("workspace_01", "execution", "session_01", "running", "attempt", "owner", 2, now + 60_000).run();
    const store = new SqlSessionThreadStore(client, { now: () => new Date(now) });
    const fence = { workspaceId: "workspace_01", sessionId: "session_01", executionId: "execution",
      attemptId: "attempt", ownerId: "owner", generation: 2, expiresAt: new Date(now + 60_000).toISOString() };
    const child = thread("child_fenced", new Date(now).toISOString());
    await expect(store.insert({ workspaceId: "workspace_01", thread: child, executionFence: { ...fence, generation: 1 } }))
      .rejects.toThrow(/fence/i);
    expect(await store.find({ workspaceId: "workspace_01", sessionId: "session_01", threadId: child.id })).toBeNull();
    await expect(store.insert({ workspaceId: "workspace_other", thread: child, executionFence: fence })).rejects.toThrow(/scope|fence/i);
    await store.insert({ workspaceId: "workspace_01", thread: child, executionFence: fence });
    const expiredStore = new SqlSessionThreadStore(client, { now: () => new Date(now + 60_001) });
    await expect(expiredStore.insert({ workspaceId: "workspace_01", thread: { ...child, id: "child_after_expiry" }, executionFence: fence }))
      .rejects.toThrow(/fence/i);
    expect((await store.list({ workspaceId: "workspace_01", sessionId: "session_01", limit: 10 })).map((value) => value.id)).toEqual(["child_fenced"]);
  });
});
