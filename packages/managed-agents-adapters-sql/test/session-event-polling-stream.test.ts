import { describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import type { Session } from "@open-managed-agents/managed-agents-application";
import { SqlPersistedSessionEventStream } from "../src/session-event-polling-stream";

const session = {
  id: "session_01",
  agent: {} as never,
  archivedAt: null,
  budget: null,
  createdAt: "2026-09-08T00:00:00.000Z",
  environmentId: "env_self_01",
  metadata: {},
  outcomeEvaluations: [],
  resources: [],
  stats: {},
  status: "running",
  title: null,
  updatedAt: "2026-09-08T00:00:00.000Z",
  usage: {},
  vaultIds: [],
} satisfies Session;

async function fixture() {
  const client = await createBetterSqlite3SqlClient(":memory:");
  await client.exec(`CREATE TABLE managed_session_events (
    workspace_id text NOT NULL,
    session_id text NOT NULL,
    thread_id text,
    id text NOT NULL,
    type text NOT NULL,
    document text NOT NULL,
    processed_at integer NOT NULL,
    PRIMARY KEY (workspace_id, session_id, id)
  )`);
  const sleepers: Array<() => void> = [];
  const stream = new SqlPersistedSessionEventStream(client, {
    pollIntervalMs: 1,
    sleep: async () => new Promise<void>((resolve) => sleepers.push(resolve)),
  });
  const append = async (event: Record<string, unknown>, threadId: string | null = null) => {
    await client.prepare(
      `INSERT INTO managed_session_events
        (workspace_id, session_id, thread_id, id, type, document, processed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "workspace_01",
      session.id,
      threadId,
      event.id,
      event.type,
      JSON.stringify(event),
      Date.parse(String(event.processedAt)),
    ).run();
  };
  return { append, sleepers, stream };
}

async function waitForSleeper(sleepers: Array<() => void>) {
  for (let attempt = 0; attempt < 20 && sleepers.length === 0; attempt += 1) {
    await Promise.resolve();
  }
  expect(sleepers).toHaveLength(1);
}

describe("SqlPersistedSessionEventStream", () => {
  it("starts at the subscription watermark and emits new canonical events until idle", async () => {
    const { append, sleepers, stream } = await fixture();
    await append({
      id: "old",
      type: "session.status_running",
      processedAt: "2026-09-08T00:00:01.000Z",
    });
    const iterator = stream.subscribe({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
    })[Symbol.asyncIterator]();
    const next = iterator.next();
    await waitForSleeper(sleepers);
    await append({
      id: "idle",
      type: "session.status_idle",
      processedAt: "2026-09-08T00:00:02.000Z",
      stopReason: { type: "end_turn" },
    });
    sleepers.shift()!();

    await expect(next).resolves.toMatchObject({
      done: false,
      value: { id: "idle", type: "session.status_idle" },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("isolates a thread lane and terminates on its terminal event", async () => {
    const { append, sleepers, stream } = await fixture();
    const iterator = stream.subscribe({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      threadId: "thread_01",
      thread: {} as never,
    })[Symbol.asyncIterator]();
    const next = iterator.next();
    await waitForSleeper(sleepers);
    await append({
      id: "other",
      type: "agent.message",
      processedAt: "2026-09-08T00:00:02.000Z",
      content: [{ type: "text", text: "other" }],
    }, "thread_02");
    await append({
      id: "thread-idle",
      type: "session.thread_status_idle",
      processedAt: "2026-09-08T00:00:03.000Z",
      sessionThreadId: "thread_01",
      agentName: "worker",
      stopReason: { type: "end_turn" },
    }, "thread_01");
    sleepers.shift()!();

    await expect(next).resolves.toMatchObject({
      value: { id: "thread-idle", sessionThreadId: "thread_01" },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });
});
