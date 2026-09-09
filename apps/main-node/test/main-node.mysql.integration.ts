import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { MySqlContainer, type StartedMySqlContainer } from "@testcontainers/mysql";
import Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";

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
