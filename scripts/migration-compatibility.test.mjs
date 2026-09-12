import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const environmentServiceKeysMigration = await readFile(
  new URL("../apps/main/migrations/0021_environment_service_keys.sql", import.meta.url),
  "utf8",
);

const legacyApiKeysSchema = `
  CREATE TABLE api_keys (
    id TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT NOT NULL,
    user_id TEXT,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  );
`;

for (const [name, bootstrap] of [
  ["Cloudflare KV-backed database without an api_keys table", ""],
  ["Node SQL database with the legacy api_keys table", legacyApiKeysSchema],
]) {
  test(`0021 applies to ${name}`, () => {
    const database = new DatabaseSync(":memory:");
    try {
      if (bootstrap) database.exec(bootstrap);
      database.exec(environmentServiceKeysMigration);
      const columns = database
        .prepare("PRAGMA table_info(api_keys)")
        .all()
        .map((column) => column.name);
      assert.ok(columns.includes("credential_type"));
      assert.ok(columns.includes("environment_id"));
    } finally {
      database.close();
    }
  });
}
