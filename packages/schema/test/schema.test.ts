import { describe, it, expect } from "vitest";
import { applySchema, applyTenantSchema } from "../src/index";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import BetterSqlite3 from "better-sqlite3";

describe("@open-managed-agents/schema", () => {
  it("applySchema is idempotent on sqlite", async () => {
    const db = new BetterSqlite3(":memory:");
    const sql = await createBetterSqlite3SqlClient(":memory:");
    // Run twice — should not throw on the second pass.
    await applySchema({ sql, dialect: "sqlite" });
    await applySchema({ sql, dialect: "sqlite" });
    await applyTenantSchema(sql);
    await applyTenantSchema(sql);

    const r = await sql
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
      )
      .all<{ name: string }>();
    const tables = (r.results ?? []).map((row) => row.name);
    expect(tables).toContain("agents");
    expect(tables).toContain("vaults");
    expect(tables).toContain("credentials");
    expect(tables).toContain("memory_stores");
    expect(tables).toContain("kv_entries");
    expect(tables).toContain("api_keys");
    expect(tables).toContain("tenant");
    expect(tables).toContain("membership");
    db.close();
  });
});
