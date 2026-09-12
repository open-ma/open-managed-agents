import { describe, expect, it } from "vitest";
import {
  createBetterSqlite3SqlClient,
  type SqlClient,
  type SqlStatement,
} from "@open-managed-agents/sql-client";
import {
  createSqlQueue,
  ensureSqlQueueSchema,
} from "@open-managed-agents/queue";

describe("SQLite queue lease conformance", () => {
  it("installs the durable queue schema through the shared SQL adapter", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");

    await expect(ensureSqlQueueSchema(sql, "sqlite")).resolves.toBeUndefined();
    await expect(
      sql.prepare(
        `SELECT id, queue_name, claim_token
           FROM queue_messages`,
      ).all(),
    ).resolves.toEqual({ results: [], meta: { changes: 0 } });
    const indexes = await sql.prepare(`PRAGMA index_list("queue_messages")`)
      .all<{ name: string }>();
    expect(new Set(indexes.results?.map((index) => index.name))).toEqual(
      new Set([
        "sqlite_autoindex_queue_messages_1",
        "idx_queue_messages_pending",
        "idx_queue_messages_processing",
        "idx_queue_messages_dlq",
      ]),
    );
  });

  it("enqueues and consumes through the same leased queue contract", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    await ensureSqlQueueSchema(sql, "sqlite");
    const queue = createSqlQueue<{ id: string }>({
      name: "sqlite-basic",
      sql,
      dialect: "sqlite",
      pollIntervalMs: 10,
    });
    const seen: string[] = [];
    const stop = queue.subscribe(async (message) => {
      seen.push(message.body.id);
    });
    try {
      await queue.enqueue({ id: "sqlite-message" });
      await waitFor(() => seen.length === 1, 1_000);
      expect(seen).toEqual(["sqlite-message"]);
    } finally {
      stop();
    }
  });

  it("reclaims an expired owner and fences its stale acknowledgement", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    await ensureSqlQueueSchema(sql, "sqlite");
    let releaseStale!: () => void;
    const staleBlocked = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    let staleStarted!: () => void;
    const staleClaimed = new Promise<void>((resolve) => {
      staleStarted = resolve;
    });
    let replacementStarted!: () => void;
    const replacementClaimed = new Promise<void>((resolve) => {
      replacementStarted = resolve;
    });
    let releaseReplacement!: () => void;
    const replacementBlocked = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    let staleMutationFinished!: () => void;
    const staleMutation = new Promise<void>((resolve) => {
      staleMutationFinished = resolve;
    });
    const staleSql = dropMutations(
      observeMutation(
        sql,
        (statement) => statement.includes("DELETE FROM queue_messages"),
        staleMutationFinished,
      ),
      isLeaseHeartbeat,
    );
    const stale = createSqlQueue<{ id: string }>({
      name: "sqlite-fencing",
      sql: staleSql,
      dialect: "sqlite",
      workerId: "stale",
      pollIntervalMs: 5,
      batchSize: 1,
      visibilityTimeoutMs: 60,
    });
    const replacement = createSqlQueue<{ id: string }>({
      name: "sqlite-fencing",
      sql,
      dialect: "sqlite",
      workerId: "replacement",
      pollIntervalMs: 5,
      batchSize: 1,
      visibilityTimeoutMs: 1_000,
    });

    await stale.enqueue({ id: "recover-me" });
    const stopStale = stale.subscribe(async () => {
      staleStarted();
      await staleBlocked;
    });
    await staleClaimed;
    const stoppingStale = Promise.resolve(stopStale());

    const stopReplacement = replacement.subscribe(async () => {
      replacementStarted();
      await replacementBlocked;
    });
    try {
      await replacementClaimed;
      releaseStale();
      await staleMutation;
      const row = await sql.prepare(
        `SELECT status, locked_by
           FROM queue_messages
          WHERE queue_name = ?`,
      ).bind("sqlite-fencing").first<{
        status: string;
        locked_by: string | null;
      }>();
      expect(row).toEqual({
        status: "processing",
        locked_by: "replacement",
      });
    } finally {
      releaseStale();
      releaseReplacement();
      await Promise.all([
        stoppingStale,
        Promise.resolve(stopReplacement()),
      ]);
    }
  });

  it("atomically distributes one SQLite queue across concurrent subscribers", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    await ensureSqlQueueSchema(sql, "sqlite");
    const queueA = createSqlQueue<{ id: string }>({
      name: "sqlite-concurrency",
      sql,
      dialect: "sqlite",
      workerId: "sqlite-a",
      pollIntervalMs: 5,
      batchSize: 4,
    });
    const queueB = createSqlQueue<{ id: string }>({
      name: "sqlite-concurrency",
      sql,
      dialect: "sqlite",
      workerId: "sqlite-b",
      pollIntervalMs: 5,
      batchSize: 4,
    });
    const seenA: string[] = [];
    const seenB: string[] = [];
    await queueA.enqueueBatch(
      Array.from({ length: 16 }, (_, index) => ({ id: `m${index}` })),
    );
    const stopA = queueA.subscribe(async (message) => {
      seenA.push(message.body.id);
    });
    const stopB = queueB.subscribe(async (message) => {
      seenB.push(message.body.id);
    });
    try {
      await waitFor(() => seenA.length + seenB.length === 16, 2_000);
      const all = [...seenA, ...seenB];
      expect(all).toHaveLength(16);
      expect(new Set(all).size).toBe(16);
    } finally {
      await Promise.all([
        Promise.resolve(stopA()),
        Promise.resolve(stopB()),
      ]);
    }
  });

  it("waits for an in-flight handler before graceful subscription shutdown completes", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    await ensureSqlQueueSchema(sql, "sqlite");
    const queue = createSqlQueue<{ id: string }>({
      name: "sqlite-graceful-stop",
      sql,
      dialect: "sqlite",
      pollIntervalMs: 5,
    });
    let handlerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      handlerStarted = resolve;
    });
    let releaseHandler!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });

    await queue.enqueue({ id: "in-flight" });
    const stop = queue.subscribe(async () => {
      handlerStarted();
      await blocked;
    });
    await started;
    let stopped = false;
    const stopping = Promise.resolve(stop()).then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);

    releaseHandler();
    await stopping;
    const remaining = await sql.prepare(
      `SELECT COUNT(*) AS count FROM queue_messages WHERE queue_name = ?`,
    ).bind("sqlite-graceful-stop").first<{ count: number }>();
    expect(remaining?.count).toBe(0);
  });

  it("keeps renewing an in-flight claim while graceful shutdown drains the handler", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    await ensureSqlQueueSchema(sql, "sqlite");
    const primary = createSqlQueue<{ id: string }>({
      name: "sqlite-graceful-lease",
      sql,
      dialect: "sqlite",
      workerId: "primary",
      pollIntervalMs: 5,
      batchSize: 1,
      visibilityTimeoutMs: 60,
    });
    const replacement = createSqlQueue<{ id: string }>({
      name: "sqlite-graceful-lease",
      sql,
      dialect: "sqlite",
      workerId: "replacement",
      pollIntervalMs: 5,
      batchSize: 1,
      visibilityTimeoutMs: 60,
    });
    let handlerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      handlerStarted = resolve;
    });
    let releaseHandler!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let replacementDeliveries = 0;

    await primary.enqueue({ id: "drain-me" });
    const stopPrimary = primary.subscribe(async () => {
      handlerStarted();
      await blocked;
    });
    await started;
    const stoppingPrimary = Promise.resolve(stopPrimary());
    const stopReplacement = replacement.subscribe(async () => {
      replacementDeliveries += 1;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 220));
      expect(replacementDeliveries).toBe(0);
    } finally {
      releaseHandler();
      await stoppingPrimary;
      await Promise.resolve(stopReplacement());
    }
  });

  it("cancels an idle poll immediately during graceful shutdown", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    await ensureSqlQueueSchema(sql, "sqlite");
    const queue = createSqlQueue({
      name: "sqlite-idle-stop",
      sql,
      dialect: "sqlite",
      pollIntervalMs: 5_000,
    });
    const stop = queue.subscribe(async () => {});
    await new Promise((resolve) => setTimeout(resolve, 20));

    const startedAt = Date.now();
    await Promise.resolve(stop());
    expect(Date.now() - startedAt).toBeLessThan(200);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
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
