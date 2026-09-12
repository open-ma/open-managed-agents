import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  InMemoryBlobStore,
  InMemoryMemoryRepo,
} from "@open-managed-agents/memory-store/test-fakes";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import { startNodeMemoryQueue } from "../src/lib/node-memory-queue.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    force: true,
    recursive: true,
  })));
});

describe("Node memory queue SQL composition", () => {
  it("uses the durable SQL queue for SQLite instead of process-local delivery", async () => {
    const root = await mkdtemp(join(tmpdir(), "oma-node-memory-queue-"));
    roots.push(root);
    const sql = await createBetterSqlite3SqlClient(":memory:");

    const handle = await startNodeMemoryQueue({
      mode: "sql",
      sql,
      sqlDialect: "sqlite",
      memoryRepo: new InMemoryMemoryRepo(),
      memoryBlobs: new InMemoryBlobStore(),
      memoryRoot: root,
      logger: { log() {}, warn() {} },
    });
    try {
      const table = await sql.prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name = 'queue_messages'`,
      ).first<{ name: string }>();
      expect(table).toEqual({ name: "queue_messages" });
    } finally {
      await handle.stop();
    }
  });
});
