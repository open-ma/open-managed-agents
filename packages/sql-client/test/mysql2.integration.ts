import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MySqlContainer, type StartedMySqlContainer } from "@testcontainers/mysql";

import {
  createMysql2SqlClient,
  type Mysql2SqlClient,
} from "../src/adapters/mysql2";

let container: StartedMySqlContainer;
let client: Mysql2SqlClient;

beforeAll(async () => {
  container = await new MySqlContainer("mysql:8.4").start();
  client = await createMysql2SqlClient(container.getConnectionUri());
  await client.exec(`
    CREATE TABLE adapter_items (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      created_at_ms BIGINT NOT NULL
    );
    CREATE TABLE adapter_audit (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      item_name VARCHAR(255) NOT NULL
    );
    CREATE TABLE portable_claims (
      workspace_id VARCHAR(191) NOT NULL,
      id VARCHAR(191) NOT NULL,
      state VARCHAR(32) NOT NULL,
      owner_id VARCHAR(191),
      generation BIGINT NOT NULL DEFAULT 0,
      expires_at BIGINT,
      PRIMARY KEY (workspace_id, id)
    );
  `);
});

afterAll(async () => {
  await client?.close();
  await container?.stop();
});

beforeEach(async () => {
  await client.exec(`
    DELETE FROM adapter_audit;
    DELETE FROM adapter_items;
    DELETE FROM portable_claims;
    ALTER TABLE adapter_audit AUTO_INCREMENT = 1;
    ALTER TABLE adapter_items AUTO_INCREMENT = 1;
  `);
});

describe("Mysql2SqlClient", () => {
  it("maps prepared mutations and generated ids to the SqlClient result shape", async () => {
    const inserted = await client
      .prepare("INSERT INTO adapter_items (name, created_at_ms) VALUES (?, ?)")
      .bind("alpha", 1_700_000_000_000)
      .run();

    expect(inserted).toEqual({
      meta: { changes: 1, last_row_id: 1 },
      success: true,
    });
    await expect(
      client
        .prepare("SELECT id, name, created_at_ms FROM adapter_items WHERE name = ?")
        .bind("alpha")
        .first(),
    ).resolves.toEqual({
      id: 1,
      name: "alpha",
      created_at_ms: 1_700_000_000_000,
    });
  });

  it("returns all selected rows through the D1-compatible envelope", async () => {
    await client
      .prepare("INSERT INTO adapter_items (name, created_at_ms) VALUES (?, ?)")
      .bind("alpha", 1_700_000_000_000)
      .run();
    await client
      .prepare("INSERT INTO adapter_items (name, created_at_ms) VALUES (?, ?)")
      .bind("beta", 1_700_000_000_001)
      .run();

    await expect(
      client
        .prepare("SELECT name FROM adapter_items ORDER BY id")
        .all<{ name: string }>(),
    ).resolves.toEqual({
      results: [{ name: "alpha" }, { name: "beta" }],
      meta: { changes: 0 },
    });
  });

  it("counts only real placeholders when validating bind arity", async () => {
    await expect(
      client
        .prepare("SELECT '?' AS literal_value, ? AS bound_value /* ? */")
        .bind("bound")
        .first(),
    ).resolves.toEqual({ literal_value: "?", bound_value: "bound" });

    expect(() => client.prepare("SELECT ? + ? AS total").bind(1)).toThrow(
      "Mysql2SqlStatement.bind: expected 2 params, got 1",
    );
  });

  it("normalizes portable ANSI identifier quotes without touching string literals", async () => {
    await client
      .prepare(`INSERT INTO "adapter_items" ("name", "created_at_ms") VALUES (?, ?)`)
      .bind("quoted", 42)
      .run();

    await expect(
      client
        .prepare(`SELECT "name", '?' AS literal_value FROM "adapter_items" WHERE "name" = ?`)
        .bind("quoted")
        .first(),
    ).resolves.toEqual({ name: "quoted", literal_value: "?" });
  });

  it("executes a batch atomically and rolls back every statement on failure", async () => {
    await client
      .prepare("INSERT INTO adapter_items (name, created_at_ms) VALUES (?, ?)")
      .bind("alpha", 1_700_000_000_000)
      .run();
    const first = client
      .prepare("INSERT INTO adapter_audit (item_name) VALUES (?)")
      .bind("before-failure");
    const duplicate = client
      .prepare("INSERT INTO adapter_items (name, created_at_ms) VALUES (?, ?)")
      .bind("alpha", 1_700_000_000_002);

    await expect(client.batch([first, duplicate])).rejects.toThrow();
    await expect(
      client.prepare("SELECT item_name FROM adapter_audit").all(),
    ).resolves.toEqual({ results: [], meta: { changes: 0 } });

    // A failed transaction must release its connection back to the pool.
    await expect(client.prepare("SELECT 1 AS healthy").first()).resolves.toEqual({
      healthy: 1,
    });
  });

  it("rejects statements prepared by another client instead of mixing pools", async () => {
    const other = await createMysql2SqlClient(container.getConnectionUri());
    try {
      await expect(
        client.batch([other.prepare("INSERT INTO adapter_audit (item_name) VALUES ('foreign')")]),
      ).rejects.toThrow(
        "Mysql2SqlClient.batch: foreign SqlStatement (not from this client's prepare)",
      );
    } finally {
      await other.close();
    }
  });

  it("adapts the portable ON CONFLICT contract without leaking MySQL syntax", async () => {
    const insert = `INSERT INTO portable_claims
      (workspace_id, id, state, owner_id, generation, expires_at)
      VALUES (?, ?, 'queued', NULL, 0, NULL)
      ON CONFLICT (workspace_id, id) DO NOTHING`;
    await expect(client.prepare(insert).bind("ws", "job").run()).resolves.toMatchObject({
      meta: { changes: 1 },
    });
    await expect(client.prepare(insert).bind("ws", "job").run()).resolves.toMatchObject({
      meta: { changes: 0 },
    });

    const heartbeat = `INSERT INTO portable_claims
      (workspace_id, id, state, owner_id, generation, expires_at)
      VALUES (?, ?, 'queued', ?, 0, ?)
      ON CONFLICT (workspace_id, id)
      DO UPDATE SET expires_at = excluded.expires_at`;
    await client.prepare(heartbeat).bind("ws", "job", "worker-a", 100).run();
    await expect(
      client.prepare("SELECT expires_at FROM portable_claims WHERE workspace_id = ? AND id = ?")
        .bind("ws", "job").first(),
    ).resolves.toEqual({ expires_at: 100 });
  });

  it("emulates conditional UPDATE RETURNING atomically for lease claims", async () => {
    await client.prepare(`INSERT INTO portable_claims
      (workspace_id, id, state, owner_id, generation, expires_at)
      VALUES (?, ?, 'queued', NULL, 0, NULL)`)
      .bind("ws", "job-a").run();
    await client.prepare(`INSERT INTO portable_claims
      (workspace_id, id, state, owner_id, generation, expires_at)
      VALUES (?, ?, 'queued', NULL, 0, NULL)`)
      .bind("ws", "job-b").run();

    const claim = `UPDATE portable_claims
      SET state = 'running', owner_id = ?, generation = generation + 1, expires_at = ?
      WHERE (workspace_id, id) = (
        SELECT candidate.workspace_id, candidate.id
        FROM portable_claims AS candidate
        WHERE candidate.workspace_id = ? AND candidate.state = 'queued'
        ORDER BY candidate.id
        LIMIT 1
      )
      AND state = 'queued'
      RETURNING workspace_id, id, state, owner_id, generation, expires_at`;
    await expect(
      client.prepare(claim).bind("worker-a", 1_000, "ws").all(),
    ).resolves.toEqual({
      results: [{
        workspace_id: "ws",
        id: "job-a",
        state: "running",
        owner_id: "worker-a",
        generation: 1,
        expires_at: 1_000,
      }],
      meta: { changes: 1 },
    });
  });

  it("preserves conditional upsert fencing and RETURNING semantics", async () => {
    await client.prepare(`INSERT INTO portable_claims
      (workspace_id, id, state, owner_id, generation, expires_at)
      VALUES (?, ?, 'running', ?, 1, ?)`)
      .bind("ws", "fence", "worker-a", 1_000).run();

    const acquire = `INSERT INTO portable_claims
      (workspace_id, id, state, owner_id, generation, expires_at)
      VALUES (?, ?, 'running', ?, 1, ?)
      ON CONFLICT (workspace_id, id) DO UPDATE SET
        owner_id = excluded.owner_id,
        generation = portable_claims.generation + 1,
        expires_at = excluded.expires_at
      WHERE portable_claims.expires_at < ?
      RETURNING owner_id, generation, expires_at`;

    await expect(
      client.prepare(acquire).bind("ws", "fence", "worker-b", 2_000, 999).all(),
    ).resolves.toEqual({ results: [], meta: { changes: 0 } });
    await expect(
      client.prepare(acquire).bind("ws", "fence", "worker-b", 2_000, 1_001).all(),
    ).resolves.toEqual({
      results: [{ owner_id: "worker-b", generation: 2, expires_at: 2_000 }],
      meta: { changes: 1 },
    });
  });

  it("allows exactly one concurrent owner to win an insert-or-CAS lease", async () => {
    const acquire = `INSERT INTO portable_claims
      (workspace_id, id, state, owner_id, generation, expires_at)
      VALUES (?, ?, 'running', ?, 1, ?)
      ON CONFLICT (workspace_id, id) DO UPDATE SET
        generation = CASE
          WHEN portable_claims.expires_at <= ?
            THEN portable_claims.generation + 1
            ELSE portable_claims.generation END,
        owner_id = CASE
          WHEN portable_claims.expires_at <= ?
            THEN excluded.owner_id ELSE portable_claims.owner_id END,
        expires_at = CASE
          WHEN portable_claims.expires_at <= ?
            THEN excluded.expires_at ELSE portable_claims.expires_at END
      WHERE portable_claims.expires_at <= ?
      RETURNING owner_id, generation, expires_at`;
    const owners = Array.from({ length: 24 }, (_, index) => `worker-${index}`);
    const results = await Promise.all(owners.map((owner) =>
      client.prepare(acquire)
        .bind("ws", "contended", owner, 1_100, 100, 100, 100, 100)
        .first<{ owner_id: string; generation: number; expires_at: number }>()
    ));
    const winners = results.filter((row) => row !== null);

    expect(winners).toHaveLength(1);
    await expect(
      client.prepare(`SELECT owner_id, generation, expires_at
        FROM portable_claims WHERE workspace_id = ? AND id = ?`)
        .bind("ws", "contended")
        .first(),
    ).resolves.toEqual(winners[0]);
  });
});
