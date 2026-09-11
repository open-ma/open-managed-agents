import type { SqlClient } from "@open-managed-agents/sql-client";

// These are the two histories joined by the OpenAI Agents merge.
// Drizzle skips migrations older than its latest applied timestamp, so a
// database from the later local branch otherwise never receives pi_config.
const histories = {
  sqlite: {
    localHash: "27f22eda9c7ecefb167533e1f4dc2a4fbb680cd1e2d8b7beb2f97d716cc537bd",
    localWhen: 1788455360798,
    piHash: "78c09ba711127c1c4e2a3af55f1a41792f5fd4d87b931560357027f768357140",
    piWhen: 1788327653139,
  },
  postgres: {
    localHash: "197fe8aa91119b41e0b3d6a32220b7b7ae5719cf34146418bbdd3fe370c28979",
    localWhen: 1788455359814,
    piHash: "e15c34ac9a8a503d371ed9878be96c20ef0fd5fa5da4737805ff14e8ddd1146a",
    piWhen: 1788327636529,
  },
} as const;

const previousMysqlSnapshot = "d5cf91d0-02c4-4655-9ecf-af7e8d916ecc";
const mergedMysqlSnapshot = "f1e9f474-d719-4e31-b69e-dd7ae24f9bd4";

/** Run immediately before the normal Node schema migrator. */
export async function reconcilePiModelConfigMigration(
  sql: SqlClient,
  dialect: "sqlite" | "postgres" | "mysql",
): Promise<void> {
  if (dialect === "mysql") {
    const metadataExists = await sql.prepare(
      "SELECT 1 AS present FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'openma_schema_metadata'",
    ).first();
    if (!metadataExists) return;
    const installed = await sql.prepare(
      "SELECT snapshot_id FROM openma_schema_metadata WHERE name = ?",
    ).bind("main-node").first<{ snapshot_id: string }>();
    if (installed?.snapshot_id !== previousMysqlSnapshot) return;
    const column = await sql.prepare(
      "SELECT 1 AS present FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'model_cards' AND column_name = 'pi_config'",
    ).first();
    if (!column) await sql.exec("ALTER TABLE model_cards ADD COLUMN pi_config LONGTEXT");
    // MySQL DDL commits separately. If interrupted after ALTER, the next boot
    // observes the column and finishes this exact snapshot transition.
    await sql.prepare(
      "UPDATE openma_schema_metadata SET snapshot_id = ?, applied_at_ms = ? WHERE name = ? AND snapshot_id = ?",
    ).bind(mergedMysqlSnapshot, Date.now(), "main-node", previousMysqlSnapshot).run();
    return;
  }

  const journalExists = await sql.prepare(dialect === "sqlite"
    ? "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'"
    : "SELECT 1 AS present FROM information_schema.tables WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'",
  ).first();
  if (!journalExists) return;
  const journal = dialect === "sqlite" ? "__drizzle_migrations" : "drizzle.__drizzle_migrations";
  const history = histories[dialect];
  const localMigration = await sql.prepare(
    `SELECT 1 AS present FROM ${journal} WHERE hash = ? AND created_at = ?`,
  ).bind(history.localHash, history.localWhen).first();
  if (!localMigration) return;
  const column = await sql.prepare(dialect === "sqlite"
    ? "SELECT 1 AS present FROM pragma_table_info('model_cards') WHERE name = 'pi_config'"
    : "SELECT 1 AS present FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'model_cards' AND column_name = 'pi_config'",
  ).first();
  if (column) return;

  // Preserve the original migration's hash and timestamp. The repair and
  // history row commit together; other schema failures remain startup errors.
  await sql.batch([
    sql.prepare(dialect === "sqlite"
      ? "ALTER TABLE model_cards ADD COLUMN pi_config text"
      : "ALTER TABLE model_cards ADD COLUMN IF NOT EXISTS pi_config text"),
    sql.prepare(`INSERT INTO ${journal} (hash, created_at) VALUES (?, ?)`)
      .bind(history.piHash, history.piWhen),
  ]);
}
