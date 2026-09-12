// PG queue — SKIP LOCKED concurrent-subscriber test.
//
// Runs through `pnpm test:integration:storage`, which owns a disposable
// PostgreSQL container. It asserts:
//   1. ensureSqlQueueSchema applies idempotently.
//   2. Two parallel subscribers (replicas A + B) on the same queue
//      never see the same message — FOR UPDATE SKIP LOCKED holds.
//   3. enqueue from one client + consume from another sees the message.
//   4. Failed messages (handler throws maxRetries+1 times) land in the
//      DLQ subscriber.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createPostgresSqlClient,
  type SqlClient,
  type SqlStatement,
} from "@open-managed-agents/sql-client";
import {
  createSqlQueue,
  createSqlDlq,
  ensureSqlQueueSchema,
} from "@open-managed-agents/queue";
import { getStorageIntegrationConfig } from "../../../test/storage-integration.js";

const PG_URL = getStorageIntegrationConfig().postgres.queue;

let sql: SqlClient;

beforeAll(async () => {
  sql = await createPostgresSqlClient(PG_URL);
  await ensureSqlQueueSchema(sql, "postgres");
});

afterAll(async () => {
  await sql.prepare(`DELETE FROM queue_messages WHERE queue_name LIKE ?`).bind("test-%").run();
});

describe("PG queue — SKIP LOCKED concurrency", () => {
  it("installs indexes for ready, expired-processing, and DLQ scans", async () => {
    const indexes = await sql.prepare(
      `SELECT indexname AS name
         FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = 'queue_messages'`,
    ).all<{ name: string }>();
    expect(new Set(indexes.results?.map((index) => index.name))).toEqual(
      new Set([
        "queue_messages_pkey",
        "idx_queue_messages_pending",
        "idx_queue_messages_processing",
        "idx_queue_messages_dlq",
      ]),
    );
  });

  it("reclaims a processing message after its visibility lease expires", async () => {
    const name = `test-reclaim-${Date.now()}`;
    let releaseFirstHandler!: () => void;
    const firstHandlerBlocked = new Promise<void>((resolve) => {
      releaseFirstHandler = resolve;
    });
    let firstHandlerStarted!: () => void;
    const firstHandlerClaimed = new Promise<void>((resolve) => {
      firstHandlerStarted = resolve;
    });
    const seenByReplacement: string[] = [];
    const first = createSqlQueue<{ id: string }>({
      name,
      sql: dropMutations(sql, isLeaseHeartbeat),
      dialect: "postgres",
      workerId: "crashing-worker",
      pollIntervalMs: 10,
      batchSize: 1,
      visibilityTimeoutMs: 100,
    });
    const replacement = createSqlQueue<{ id: string }>({
      name,
      sql,
      dialect: "postgres",
      workerId: "replacement-worker",
      pollIntervalMs: 10,
      batchSize: 1,
      visibilityTimeoutMs: 100,
    });

    await first.enqueue({ id: "recover-me" });
    const stopFirst = first.subscribe(async () => {
      firstHandlerStarted();
      await firstHandlerBlocked;
    });
    await firstHandlerClaimed;
    stopFirst();

    const stopReplacement = replacement.subscribe(async (message) => {
      seenByReplacement.push(message.body.id);
    });
    try {
      await waitFor(() => seenByReplacement.length === 1, 3_000);
      expect(seenByReplacement).toEqual(["recover-me"]);
    } finally {
      stopReplacement();
      releaseFirstHandler();
    }
  });

  it("renews one batch lease while its handler is still running", async () => {
    const name = `test-renew-${Date.now()}`;
    let releaseHandler!: () => void;
    const handlerBlocked = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let handlerStarted!: () => void;
    const handlerClaimed = new Promise<void>((resolve) => {
      handlerStarted = resolve;
    });
    const primary = createSqlQueue<{ id: string }>({
      name,
      sql,
      dialect: "postgres",
      workerId: "live-worker",
      pollIntervalMs: 10,
      batchSize: 1,
      visibilityTimeoutMs: 120,
    });
    const replacement = createSqlQueue<{ id: string }>({
      name,
      sql,
      dialect: "postgres",
      workerId: "replacement-worker",
      pollIntervalMs: 10,
      batchSize: 1,
      visibilityTimeoutMs: 120,
    });
    let replacementDeliveries = 0;

    await primary.enqueue({ id: "stay-owned" });
    const stopPrimary = primary.subscribe(async () => {
      handlerStarted();
      await handlerBlocked;
    });
    await handlerClaimed;
    const stopReplacement = replacement.subscribe(async () => {
      replacementDeliveries += 1;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(replacementDeliveries).toBe(0);
    } finally {
      stopPrimary();
      stopReplacement();
      releaseHandler();
    }
  });

  it("does not let a stale handler acknowledge a replacement worker's claim", async () => {
    const name = `test-stale-ack-${Date.now()}`;
    let releaseStaleHandler!: () => void;
    const staleHandlerBlocked = new Promise<void>((resolve) => {
      releaseStaleHandler = resolve;
    });
    let staleHandlerStarted!: () => void;
    const staleHandlerClaimed = new Promise<void>((resolve) => {
      staleHandlerStarted = resolve;
    });
    let replacementHandlerStarted!: () => void;
    const replacementHandlerClaimed = new Promise<void>((resolve) => {
      replacementHandlerStarted = resolve;
    });
    let releaseReplacementHandler!: () => void;
    const replacementHandlerBlocked = new Promise<void>((resolve) => {
      releaseReplacementHandler = resolve;
    });
    let staleAckFinished!: () => void;
    const staleAckAttempted = new Promise<void>((resolve) => {
      staleAckFinished = resolve;
    });
    const staleWorkerSql = dropMutations(
      observeMutation(
        sql,
        (statement) => statement.includes("DELETE FROM queue_messages"),
        staleAckFinished,
      ),
      isLeaseHeartbeat,
    );
    const staleWorker = createSqlQueue<{ id: string }>({
      name,
      sql: staleWorkerSql,
      dialect: "postgres",
      workerId: "stale-worker",
      pollIntervalMs: 10,
      batchSize: 1,
      visibilityTimeoutMs: 100,
    });
    const replacementWorker = createSqlQueue<{ id: string }>({
      name,
      sql,
      dialect: "postgres",
      workerId: "replacement-worker",
      pollIntervalMs: 10,
      batchSize: 1,
      visibilityTimeoutMs: 1_000,
    });

    await staleWorker.enqueue({ id: "fenced-message" });
    const stopStaleWorker = staleWorker.subscribe(async () => {
      staleHandlerStarted();
      await staleHandlerBlocked;
    });
    await staleHandlerClaimed;
    stopStaleWorker();

    const stopReplacementWorker = replacementWorker.subscribe(async () => {
      replacementHandlerStarted();
      await replacementHandlerBlocked;
    });
    try {
      await replacementHandlerClaimed;
      releaseStaleHandler();
      await staleAckAttempted;

      const activeClaim = await sql
        .prepare(
          `SELECT status, locked_by
             FROM queue_messages
            WHERE queue_name = ?`,
        )
        .bind(name)
        .first<{ status: string; locked_by: string | null }>();
      expect(activeClaim).toEqual({
        status: "processing",
        locked_by: "replacement-worker",
      });
    } finally {
      stopReplacementWorker();
      releaseStaleHandler();
      releaseReplacementHandler();
    }
  });

  it("does not let a stale handler retry a replacement worker's claim", async () => {
    const name = `test-stale-retry-${Date.now()}`;
    let rejectStaleHandler!: () => void;
    const staleHandlerBlocked = new Promise<void>((_resolve, reject) => {
      rejectStaleHandler = () => reject(new Error("stale failure"));
    });
    let staleHandlerStarted!: () => void;
    const staleHandlerClaimed = new Promise<void>((resolve) => {
      staleHandlerStarted = resolve;
    });
    let replacementHandlerStarted!: () => void;
    const replacementHandlerClaimed = new Promise<void>((resolve) => {
      replacementHandlerStarted = resolve;
    });
    let releaseReplacementHandler!: () => void;
    const replacementHandlerBlocked = new Promise<void>((resolve) => {
      releaseReplacementHandler = resolve;
    });
    let staleRetryFinished!: () => void;
    const staleRetryAttempted = new Promise<void>((resolve) => {
      staleRetryFinished = resolve;
    });
    const staleWorkerSql = dropMutations(
      observeMutation(
        sql,
        (statement) => statement.includes("SET status = 'pending'"),
        staleRetryFinished,
      ),
      isLeaseHeartbeat,
    );
    const staleWorker = createSqlQueue<{ id: string }>({
      name,
      sql: staleWorkerSql,
      dialect: "postgres",
      workerId: "stale-worker",
      pollIntervalMs: 10,
      batchSize: 1,
      visibilityTimeoutMs: 100,
      logger: { warn() {} },
    });
    const replacementWorker = createSqlQueue<{ id: string }>({
      name,
      sql,
      dialect: "postgres",
      workerId: "replacement-worker",
      pollIntervalMs: 10,
      batchSize: 1,
      visibilityTimeoutMs: 1_000,
    });

    await staleWorker.enqueue({ id: "fenced-message" });
    const stopStaleWorker = staleWorker.subscribe(async () => {
      staleHandlerStarted();
      await staleHandlerBlocked;
    });
    await staleHandlerClaimed;
    stopStaleWorker();

    const stopReplacementWorker = replacementWorker.subscribe(async () => {
      replacementHandlerStarted();
      await replacementHandlerBlocked;
    });
    try {
      await replacementHandlerClaimed;
      rejectStaleHandler();
      await staleRetryAttempted;

      const activeClaim = await sql
        .prepare(
          `SELECT status, locked_by
             FROM queue_messages
            WHERE queue_name = ?`,
        )
        .bind(name)
        .first<{ status: string; locked_by: string | null }>();
      expect(activeClaim).toEqual({
        status: "processing",
        locked_by: "replacement-worker",
      });
    } finally {
      stopReplacementWorker();
      rejectStaleHandler();
      releaseReplacementHandler();
    }
  });

  it("two subscribers on the same queue never claim the same message", async () => {
    const name = `test-skip-${Date.now()}`;
    const seenA: string[] = [];
    const seenB: string[] = [];
    const queueA = createSqlQueue<{ id: string }>({ name, sql, dialect: "postgres", workerId: "A", pollIntervalMs: 50, batchSize: 5 });
    const queueB = createSqlQueue<{ id: string }>({ name, sql, dialect: "postgres", workerId: "B", pollIntervalMs: 50, batchSize: 5 });

    // Enqueue 20 messages from a third producer client (single tx-batch).
    const producer = createSqlQueue<{ id: string }>({ name, sql, dialect: "postgres", workerId: "P", pollIntervalMs: 5_000 });
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
    const queue = createSqlQueue<{ msg: string }>({
      name,
      sql,
      dialect: "postgres",
      workerId: "fail",
      pollIntervalMs: 50,
      maxRetries: 2,
      logger: { warn() {} },
    });
    const dlq = createSqlDlq<{ msg: string }>({
      name,
      sql,
      dialect: "postgres",
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

function observeMutation(
  client: SqlClient,
  matches: (statement: string) => boolean,
  afterRun: () => void,
): SqlClient {
  return {
    prepare(statement) {
      let delegate = client.prepare(statement);
      const observed: SqlStatement = {
        bind(...params) {
          delegate = delegate.bind(...params);
          return observed;
        },
        async run<T>() {
          const result = await delegate.run<T>();
          if (matches(statement)) afterRun();
          return result;
        },
        first<T>() {
          return delegate.first<T>();
        },
        all<T>() {
          return delegate.all<T>();
        },
      };
      return observed;
    },
    batch(statements) {
      return client.batch(statements);
    },
    exec(statement) {
      return client.exec(statement);
    },
  };
}

function dropMutations(
  client: SqlClient,
  matches: (statement: string) => boolean,
): SqlClient {
  return {
    prepare(statement) {
      let delegate = client.prepare(statement);
      const intercepted: SqlStatement = {
        bind(...params) {
          delegate = delegate.bind(...params);
          return intercepted;
        },
        run<T>() {
          return matches(statement)
            ? Promise.resolve({ meta: { changes: 0 } })
            : delegate.run<T>();
        },
        first<T>() {
          return delegate.first<T>();
        },
        all<T>() {
          return delegate.all<T>();
        },
      };
      return intercepted;
    },
    batch(statements) {
      return client.batch(statements);
    },
    exec(statement) {
      return client.exec(statement);
    },
  };
}

function isLeaseHeartbeat(statement: string): boolean {
  return statement.includes("SET locked_until = ?")
    && statement.includes("AND locked_until > ?");
}
