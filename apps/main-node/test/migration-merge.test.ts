import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BetterSqlite3SqlClient } from "@open-managed-agents/sql-client/adapters/better-sqlite3";
import { reconcilePiModelConfigMigration } from "../src/lib/reconcile-pi-model-config-migration";

const migrationsFolder = resolve(import.meta.dirname, "../migrations-sqlite");
const directories: string[] = [];
const databases: Database.Database[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function database() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  databases.push(db);
  return db;
}

async function historicalMigrations(include: (entry: { tag: string; when: number }) => boolean) {
  const directory = await mkdtemp(join(tmpdir(), "migration-merge-"));
  directories.push(directory);
  await mkdir(join(directory, "meta"));
  const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8"));
  journal.entries = journal.entries.filter(include);
  await writeFile(join(directory, "meta/_journal.json"), JSON.stringify(journal));
  for (const entry of journal.entries) {
    await cp(join(migrationsFolder, `${entry.tag}.sql`), join(directory, `${entry.tag}.sql`));
  }
  return directory;
}

function expectMergedSchema(db: Database.Database) {
  const columns = (table: string) =>
    (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(({ name }) => name);
  expect(columns("model_cards")).toContain("pi_config");
  expect(columns("api_keys")).toEqual(expect.arrayContaining(["credential_type", "environment_id"]));
  expect(columns("managed_environment_work")).toContain("claim_generation");
  expect(columns("managed_session_executions")).toContain("lease_expires_at_ms");
}

function insertCard(db: Database.Database) {
  db.prepare(`INSERT INTO model_cards
    (id, tenant_id, model_id, model, provider, api_key_cipher, api_key_preview, created_at)
    VALUES ('card_keep', 'default', 'chat', 'model-test', 'ant', 'encrypted-test', 'test', 1)`).run();
}

describe("merged migration history", () => {
  it("installs both Pi model configuration and durable execution on an empty SQLite database", async () => {
    const db = database();
    await reconcilePiModelConfigMigration(new BetterSqlite3SqlClient(db), "sqlite");
    migrate(drizzle(db), { migrationsFolder });
    expectMergedSchema(db);
    migrate(drizzle(db), { migrationsFolder });
    expectMergedSchema(db);
  });

  it("upgrades the released main schema without losing stored model configuration", async () => {
    const db = database();
    const history = await historicalMigrations(({ when }) => when <= 1788327653139);
    migrate(drizzle(db), { migrationsFolder: history });
    insertCard(db);
    db.prepare("UPDATE model_cards SET pi_config = ? WHERE id = 'card_keep'").run('{"reasoning":true}');
    await reconcilePiModelConfigMigration(new BetterSqlite3SqlClient(db), "sqlite");
    migrate(drizzle(db), { migrationsFolder });
    expectMergedSchema(db);
    expect(db.prepare("SELECT model, pi_config FROM model_cards WHERE id = 'card_keep'").get())
      .toEqual({ model: "model-test", pi_config: '{"reasoning":true}' });
  });

  it("upgrades the newer local branch schema without silently skipping Pi configuration", async () => {
    const db = database();
    const history = await historicalMigrations(({ tag }) => tag !== "0022_loud_the_captain");
    migrate(drizzle(db), { migrationsFolder: history });
    insertCard(db);
    await reconcilePiModelConfigMigration(new BetterSqlite3SqlClient(db), "sqlite");
    migrate(drizzle(db), { migrationsFolder });
    expectMergedSchema(db);
    expect(db.prepare("SELECT model FROM model_cards WHERE id = 'card_keep'").get())
      .toEqual({ model: "model-test" });
    await reconcilePiModelConfigMigration(new BetterSqlite3SqlClient(db), "sqlite");
    migrate(drizzle(db), { migrationsFolder });
    expect(db.prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations WHERE created_at = 1788327653139").get())
      .toEqual({ count: 1 });
  });

  it("does not repair a different migration history merely because its timestamp is newer", async () => {
    const db = database();
    const history = await historicalMigrations(({ tag }) => tag !== "0022_loud_the_captain");
    migrate(drizzle(db), { migrationsFolder: history });
    db.prepare("UPDATE __drizzle_migrations SET hash = 'unrelated' WHERE created_at = 1788455360798").run();
    await reconcilePiModelConfigMigration(new BetterSqlite3SqlClient(db), "sqlite");
    expect((db.pragma("table_info(model_cards)") as Array<{ name: string }>).map(({ name }) => name))
      .not.toContain("pi_config");
  });

  it("fails startup when repair cannot commit and does not claim the migration was applied", async () => {
    const db = database();
    const history = await historicalMigrations(({ tag }) => tag !== "0022_loud_the_captain");
    migrate(drizzle(db), { migrationsFolder: history });
    db.pragma("query_only = ON");
    await expect(reconcilePiModelConfigMigration(new BetterSqlite3SqlClient(db), "sqlite"))
      .rejects.toThrow("readonly");
    expect(db.prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations WHERE created_at = 1788327653139").get())
      .toEqual({ count: 0 });
  });
});
