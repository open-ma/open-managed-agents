import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Cloudflare single-D1 migrations", () => {
  it("create the tenant routing control-plane tables used during signup", () => {
    const migrationsDir = resolve(import.meta.dirname, "../../main/migrations");
    const migrationFiles = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const db = new Database(":memory:");

    try {
      for (const file of migrationFiles) {
        db.exec(readFileSync(resolve(migrationsDir, file), "utf8"));
      }

      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('tenant_shard', 'shard_pool', 'memory_store_tenant') ORDER BY name",
        )
        .all() as Array<{ name: string }>;

      expect(tables.map(({ name }) => name)).toEqual([
        "memory_store_tenant",
        "shard_pool",
        "tenant_shard",
      ]);
      const modelCardColumns = db
        .prepare("PRAGMA table_info(model_cards)")
        .all() as Array<{ name: string }>;
      expect(modelCardColumns.map(({ name }) => name)).toContain("pi_config");
    } finally {
      db.close();
    }
  });
});

describe("Cloudflare integrations migrations", () => {
  it("apply cleanly from the consolidated baseline through the latest schema", () => {
    const migrationsDir = resolve(
      import.meta.dirname,
      "../../main/migrations-integrations",
    );
    const migrationFiles = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const db = new Database(":memory:");

    try {
      for (const file of migrationFiles) {
        db.exec(readFileSync(resolve(migrationsDir, file), "utf8"));
      }

      const feishuTable = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'feishu_publications'",
        )
        .get() as { name: string } | undefined;
      const publicationForeignKeys = ["linear", "github", "slack"].flatMap(
        (provider) =>
          db.prepare(`PRAGMA foreign_key_list(${provider}_publications)`).all(),
      );

      expect(feishuTable?.name).toBe("feishu_publications");
      expect(publicationForeignKeys).toEqual([]);
    } finally {
      db.close();
    }
  });
});
