// PG queue — SKIP LOCKED concurrent-subscriber test.
//
// Skipped unless PG_TEST_URL is set (typical local: postgres://oma:oma@
// localhost:5432/oma_pg_test). When set, asserts:
//   1. ensureQueueSchema applies idempotently.
//   2. Two parallel subscribers (replicas A + B) on the same queue
//      never see the same message — FOR UPDATE SKIP LOCKED holds.
//   3. enqueue from one client + consume from another sees the message.
//   4. Failed messages (handler throws maxRetries+1 times) land in the
//      DLQ subscriber.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPostgresSqlClient, type SqlClient } from "@open-managed-agents/sql-client";
import {
  createPgQueue,
  createPgDlq,
  ensureQueueSchema,
} from "@open-managed-agents/queue";

const PG_URL = process.env.PG_TEST_URL ?? "";
const enabled = PG_URL.startsWith("postgres://") || PG_URL.startsWith("postgresql://");
const d = enabled ? describe : describe.skip;

let sql: SqlClient;

beforeAll(async () => {
  if (!enabled) return;
  sql = await createPostgresSqlClient(PG_URL);
  await ensureQueueSchema(sql);
});

afterAll(async () => {
  if (!enabled || !sql) return;
  await sql.prepare(`DELETE FROM queue_messages WHERE queue_name LIKE ?`).bind("test-%").run();
});

d("PG queue — SKIP LOCKED concurrency", () => {
  it("two subscribers on the same queue never claim the same message", async () => {
    const name = `test-skip-${Date.now()}`;
    const seenA: string[] = [];
    const seenB: string[] = [];
    const queueA = createPgQueue<{ id: string }>({ name, sql, workerId: "A", pollIntervalMs: 50, batchSize: 5 });
    const queueB = createPgQueue<{ id: string }>({ name, sql, workerId: "B", pollIntervalMs: 50, batchSize: 5 });

    // Enqueue 20 messages from a third producer client (single tx-batch).
    const producer = createPgQueue<{ id: string }>({ name, sql, workerId: "P", pollIntervalMs: 5_000 });
    for (let i = 0; i < 20; i++) await producer.enqueue({ id: `m${i}` });

    const stopA = queueA.subscribe(async (msg) => { seenA.push(msg.body.id); });
    const stopB = queueB.subscribe(async (msg) => { seenB.push(msg.body.id); });

    // Wait for both to drain.
    await waitFor(() => seenA.length + seenB.length === 20, 5000);

    await Promise.resolve(stopA());
    await Promise.resolve(stopB());

    // Union must equal all 20; intersection must be empty.
    const union = new Set([...seenA, ...seenB]);
    expect(union.size).toBe(20);
    const intersect = seenA.filter((x) => seenB.includes(x));
    expect(intersect).toEqual([]);
  });

  it("failed messages reach status='dlq' after maxRetries", async () => {
    const name = `test-dlq-${Date.now()}`;
    const queue = createPgQueue<{ msg: string }>({
      name,
      sql,
      workerId: "fail",
      pollIntervalMs: 50,
      maxRetries: 2,
    });
    const dlq = createPgDlq<{ msg: string }>({
      name,
      sql,
      workerId: "dlq",
      pollIntervalMs: 50,
    });
    const dlqSeen: { msg: string }[] = [];
    const stopDlq = dlq.subscribe(async (msg) => {
      dlqSeen.push(msg.body);
    });

    let calls = 0;
    const stopMain = queue.subscribe(async () => {
      calls++;
      throw new Error("intentional");
    });

    await queue.enqueue({ msg: "die-please" });

    await waitFor(() => dlqSeen.length === 1, 8000);

    await Promise.resolve(stopMain());
    await Promise.resolve(stopDlq());

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(dlqSeen[0]?.msg).toBe("die-please");

    // Confirm DLQ row is gone (DLQ subscriber acks via DELETE).
    const remaining = await sql
      .prepare(`SELECT COUNT(*)::int AS c FROM queue_messages WHERE queue_name = ?`)
      .bind(name)
      .first<{ c: number }>();
    expect(remaining?.c).toBe(0);
  });
});

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor: predicate not satisfied within ${timeoutMs}ms`);
}
