import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { MySqlContainer, type StartedMySqlContainer } from "@testcontainers/mysql";
import Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import {
  createSqlQueue,
  ensureSqlQueueSchema,
} from "@open-managed-agents/queue";
import {
  createMysql2SqlClient,
  type SqlClient,
  type SqlStatement,
} from "@open-managed-agents/sql-client";

import { detachedProcessOptions, killProcessTree } from "./helpers/process-tree";

const repoRoot = resolve(import.meta.dirname, "../../..");
const entry = resolve(repoRoot, "apps/main-node/src/index.ts");
const tsx = resolve(repoRoot, "apps/main-node/node_modules/.bin/tsx");

let mysqlContainer: StartedMySqlContainer;
let child: ChildProcess | undefined;
let baseUrl: string;
let logs = "";
let scratchRoot: string;

beforeAll(async () => {
  scratchRoot = await mkdtemp(resolve(tmpdir(), "oma-main-node-mysql-"));
  mysqlContainer = await new MySqlContainer("mysql:8.4").start();
  await startServer(true);
});

async function startServer(authDisabled: boolean): Promise<void> {
  const port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  logs = "";
  child = spawn(tsx, [entry], {
    ...detachedProcessOptions,
    cwd: repoRoot,
    env: {
      ...process.env,
      AUTH_DISABLED: authDisabled ? "1" : "0",
      BETTER_AUTH_SECRET: "mysql-integration-secret-at-least-32-characters",
      DATABASE_URL: mysqlContainer.getConnectionUri(),
      FILES_BLOB_DIR: resolve(scratchRoot, "files"),
      MEMORY_BLOB_DIR: resolve(scratchRoot, "memory"),
      MEMORY_QUEUE: "disabled",
      PLATFORM_ROOT_SECRET: "mysql-integration-platform-root-secret",
      PORT: String(port),
      PUBLIC_BASE_URL: baseUrl,
      SANDBOX_WORKDIR: resolve(scratchRoot, "sandboxes"),
      SESSION_OUTPUTS_DIR: resolve(scratchRoot, "outputs"),
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { logs += String(chunk); });
  child.stderr?.on("data", (chunk) => { logs += String(chunk); });
  await waitForHealth();
}

afterAll(async () => {
  if (child) await killProcessTree(child).catch(() => undefined);
  await mysqlContainer?.stop();
  await rm(scratchRoot, { recursive: true, force: true });
});

describe.sequential("main-node MySQL composition root", () => {
  it("upgrades the known local snapshot with Pi configuration and preserves model cards", async () => {
    if (child) await killProcessTree(child);
    child = undefined;
    const sql = await createMysql2SqlClient(mysqlContainer.getConnectionUri());
    try {
      // Reproduce the last pre-merge MySQL snapshot using its recorded
      // identity and only structural difference from the merged snapshot.
      await sql.exec("ALTER TABLE model_cards DROP COLUMN pi_config");
      await sql.prepare("UPDATE openma_schema_metadata SET snapshot_id = ? WHERE name = ?")
        .bind("d5cf91d0-02c4-4655-9ecf-af7e8d916ecc", "main-node").run();
      await sql.prepare(`INSERT INTO model_cards
        (id, tenant_id, model_id, model, provider, api_key_cipher, api_key_preview, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind("merge_keep", "default", "merge-model", "wire-model", "ant", "encrypted-test", "test", 1)
        .run();

      await startServer(true);
      expect(await sql.prepare("SELECT model, pi_config FROM model_cards WHERE id = ?")
        .bind("merge_keep").first()).toEqual({ model: "wire-model", pi_config: null });
      // A second startup must accept the migrated snapshot and retain data.
      if (child) await killProcessTree(child);
      child = undefined;
      await startServer(true);
      expect(await sql.prepare("SELECT model FROM model_cards WHERE id = ?")
        .bind("merge_keep").first()).toEqual({ model: "wire-model" });
    } finally {
      await sql.prepare("DELETE FROM model_cards WHERE id = ?").bind("merge_keep").run();
      await sql.close();
    }
  });

  it("installs the shared durable queue schema on MySQL", async () => {
    const sql = await createMysql2SqlClient(mysqlContainer.getConnectionUri());
    try {
      await expect(ensureSqlQueueSchema(sql, "mysql")).resolves.toBeUndefined();
      await expect(
        sql.prepare(
          `SELECT id, queue_name, claim_token
             FROM queue_messages`,
        ).all(),
      ).resolves.toEqual({ results: [], meta: { changes: 0 } });
      const indexes = await sql.prepare(
        `SELECT DISTINCT index_name AS name
           FROM information_schema.statistics
          WHERE table_schema = DATABASE() AND table_name = 'queue_messages'`,
      ).all<{ name: string }>();
      expect(new Set(indexes.results?.map((index) => index.name))).toEqual(
        new Set([
          "PRIMARY",
          "idx_queue_messages_pending",
          "idx_queue_messages_processing",
          "idx_queue_messages_dlq",
        ]),
      );
    } finally {
      await sql.close();
    }
  });

  it("enqueues and consumes through the shared MySQL lease contract", async () => {
    const sql = await createMysql2SqlClient(mysqlContainer.getConnectionUri());
    const name = `mysql-queue-${Date.now()}`;
    try {
      await ensureSqlQueueSchema(sql, "mysql");
      const queue = createSqlQueue<{ id: string }>({
        name,
        sql,
        dialect: "mysql",
        workerId: "mysql-worker",
        pollIntervalMs: 10,
      });
      let receive!: (id: string) => void;
      const received = new Promise<string>((resolve) => {
        receive = resolve;
      });
      const stop = queue.subscribe(async (message) => {
        receive(message.body.id);
      });
      try {
        await queue.enqueue({ id: "mysql-message" });
        await expect(withTimeout(received, 2_000)).resolves.toBe("mysql-message");
      } finally {
        await Promise.resolve(stop());
      }
    } finally {
      await sql.prepare(`DELETE FROM queue_messages WHERE queue_name = ?`)
        .bind(name).run();
      await sql.close();
    }
  });

  it("reclaims an expired MySQL owner and fences its stale acknowledgement", async () => {
    const sql = await createMysql2SqlClient(mysqlContainer.getConnectionUri());
    const name = `mysql-fencing-${Date.now()}`;
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
      name,
      sql: staleSql,
      dialect: "mysql",
      workerId: "stale",
      pollIntervalMs: 5,
      batchSize: 1,
      visibilityTimeoutMs: 100,
    });
    const replacement = createSqlQueue<{ id: string }>({
      name,
      sql,
      dialect: "mysql",
      workerId: "replacement",
      pollIntervalMs: 5,
      batchSize: 1,
      visibilityTimeoutMs: 1_000,
    });

    try {
      await ensureSqlQueueSchema(sql, "mysql");
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
        await withTimeout(replacementClaimed, 2_000);
        releaseStale();
        await withTimeout(staleMutation, 2_000);
        const row = await sql.prepare(
          `SELECT status, locked_by
             FROM queue_messages
            WHERE queue_name = ?`,
        ).bind(name).first<{ status: string; locked_by: string | null }>();
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
    } finally {
      await sql.prepare(`DELETE FROM queue_messages WHERE queue_name = ?`)
        .bind(name).run();
      await sql.close();
    }
  });

  it("atomically distributes one MySQL queue across concurrent subscribers", async () => {
    const sql = await createMysql2SqlClient(mysqlContainer.getConnectionUri());
    const name = `mysql-concurrency-${Date.now()}`;
    const seenA: string[] = [];
    const seenB: string[] = [];
    try {
      await ensureSqlQueueSchema(sql, "mysql");
      const queueA = createSqlQueue<{ id: string }>({
        name,
        sql,
        dialect: "mysql",
        workerId: "mysql-a",
        pollIntervalMs: 5,
        batchSize: 4,
      });
      const queueB = createSqlQueue<{ id: string }>({
        name,
        sql,
        dialect: "mysql",
        workerId: "mysql-b",
        pollIntervalMs: 5,
        batchSize: 4,
      });
      const producer = createSqlQueue<{ id: string }>({
        name,
        sql,
        dialect: "mysql",
        workerId: "mysql-producer",
      });
      await producer.enqueueBatch(
        Array.from({ length: 16 }, (_, index) => ({ id: `m${index}` })),
      );
      const stopA = queueA.subscribe(async (message) => {
        seenA.push(message.body.id);
      });
      const stopB = queueB.subscribe(async (message) => {
        seenB.push(message.body.id);
      });
      try {
        await waitFor(() => seenA.length + seenB.length === 16, 3_000);
      } finally {
        await Promise.all([
          Promise.resolve(stopA()),
          Promise.resolve(stopB()),
        ]);
      }
      const all = [...seenA, ...seenB];
      expect(new Set(all).size).toBe(16);
      expect(all).toHaveLength(16);
    } finally {
      await sql.prepare(`DELETE FROM queue_messages WHERE queue_name = ?`)
        .bind(name).run();
      await sql.close();
    }
  });

  it("boots the real server against MySQL and reports the selected backend", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    const health = await response.json() as {
      backends: { agents: string; events: string; db: string };
    };
    expect(health.backends.agents).toBe("mysql");
    expect(health.backends.events).toBe("mysql");
    expect(health.backends.db).toContain("mysql");
  });

  it("installs the application and event-log schemas in the selected database", async () => {
    const db = await mysql.createConnection(mysqlContainer.getConnectionUri());
    try {
      const [rows] = await db.query<mysql.RowDataPacket[]>(
        `SELECT table_name AS name FROM information_schema.tables
         WHERE table_schema = DATABASE()`,
      );
      const tables = new Set(rows.map((row) => String(row.name)));
      expect(tables).toContain("managed_agents");
      expect(tables).toContain("managed_sessions");
      expect(tables).toContain("managed_environment_work");
      expect(tables).toContain("session_events");
    } finally {
      await db.end();
    }
  });

  it("serves v1 Managed Agents CRUD through the official SDK", async () => {
    const client = new Anthropic({
      apiKey: "mysql-integration-test",
      baseURL: baseUrl,
      maxRetries: 0,
    });
    const suffix = Date.now().toString(36);
    const environment = await client.beta.environments.create({
      name: `mysql-${suffix}`,
      scope: "organization",
      config: {
        type: "cloud",
        networking: { type: "unrestricted" },
        packages: { type: "packages" },
      },
    });
    const agent = await client.beta.agents.create({
      name: `mysql-${suffix}`,
      model: "mysql-test-model",
      system: "MySQL integration test",
    });
    const session = await client.beta.sessions.create({
      agent: { type: "agent", id: agent.id, version: agent.version },
      environment_id: environment.id,
      title: `mysql-${suffix}`,
    });

    expect((await client.beta.agents.retrieve(agent.id)).id).toBe(agent.id);
    expect((await client.beta.environments.retrieve(environment.id)).id)
      .toBe(environment.id);
    expect((await client.beta.sessions.retrieve(session.id)).id).toBe(session.id);

    // Self-hosted Environment Work is the second v1 ownership lane. Exercise
    // its real MySQL dequeue/CAS path under contention, not only CRUD.
    const selfHosted = await client.beta.environments.create({
      name: `mysql-worker-${suffix}`,
      config: { type: "self_hosted" },
    });
    const workerSession = await client.beta.sessions.create({
      agent: { type: "agent", id: agent.id, version: agent.version },
      environment_id: selfHosted.id,
      title: `mysql-worker-${suffix}`,
    });
    const claims = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      client.beta.environments.work.poll(selfHosted.id, {
        block_ms: 1,
        "Anthropic-Worker-ID": `mysql-worker-${index}`,
      })
    ));
    const winners = claims.filter((work) => work !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({
      data: { id: workerSession.id, type: "session" },
      environment_id: selfHosted.id,
      state: "queued",
    });
    const work = winners[0]!;
    await expect(client.beta.environments.work.ack(work.id, {
      environment_id: selfHosted.id,
    })).resolves.toMatchObject({ state: "starting" });
    await expect(client.beta.environments.work.heartbeat(work.id, {
      environment_id: selfHosted.id,
      desired_ttl_seconds: 60,
      expected_last_heartbeat: "NO_HEARTBEAT",
    })).resolves.toMatchObject({ state: "active", lease_extended: true });

    const accepted = await client.beta.sessions.events.send(session.id, {
      events: [{
        type: "user.message",
        content: [{ type: "text", text: "exercise the MySQL execution lane" }],
      }],
    });
    expect(accepted.data[0]?.type).toBe("user.message");

    const db = await mysql.createConnection(mysqlContainer.getConnectionUri());
    try {
      const deadline = Date.now() + 10_000;
      let execution: mysql.RowDataPacket | undefined;
      while (Date.now() < deadline) {
        const [rows] = await db.query<mysql.RowDataPacket[]>(
          `SELECT state, attempt_count, revision
             FROM managed_session_executions
            WHERE workspace_id = ? AND session_id = ?`,
          ["default", session.id],
        );
        execution = rows[0];
        if (execution && execution.state !== "queued" && execution.state !== "running") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(execution).toBeDefined();
      expect(["succeeded", "failed", "cancelled"]).toContain(execution?.state);
      expect(Number(execution?.attempt_count)).toBeGreaterThan(0);
      expect(Number(execution?.revision)).toBeGreaterThan(1);
      const [eventRows] = await db.query<mysql.RowDataPacket[]>(
        `SELECT COUNT(*) AS count FROM managed_session_events
          WHERE workspace_id = ? AND session_id = ?`,
        ["default", session.id],
      );
      expect(Number(eventRows[0]?.count)).toBeGreaterThan(0);
    } finally {
      await db.end();
    }
  });

  it("boots Better Auth on MySQL and provisions the v1 tenant boundary", async () => {
    if (child) await killProcessTree(child);
    child = undefined;
    await startServer(false);

    const health = await fetch(`${baseUrl}/health`).then((response) => response.json()) as {
      auth: string;
    };
    expect(health.auth).toBe("better-auth-mysql");

    const email = `mysql-auth-${Date.now()}@local.test`;
    const signUp = await fetch(`${baseUrl}/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        name: "MySQL Auth",
        password: "mysql-integration-password",
      }),
    });
    const body = await signUp.json().catch(() => ({}));
    expect(
      [200, 201],
      `unexpected sign-up status ${signUp.status}: ${JSON.stringify(body)}\n${logs}`,
    ).toContain(signUp.status);

    const db = await mysql.createConnection(mysqlContainer.getConnectionUri());
    try {
      const [rows] = await db.query<mysql.RowDataPacket[]>(
        `SELECT m.tenant_id
           FROM membership m
           JOIN \`user\` u ON u.id = m.user_id
          WHERE u.email = ?`,
        [email],
      );
      expect(rows[0]?.tenant_id).toBeTruthy();
    } finally {
      await db.end();
    }
  });
});

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`main-node did not boot against MySQL:\n${logs}`);
}

function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate test port"));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

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
