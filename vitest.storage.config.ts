import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "threads",
    include: [
      "apps/main-node/test/feishu-tables.schema.pg.test.ts",
      "apps/main-node/test/pg-better-auth.test.ts",
      "apps/main-node/test/pg-fanout.test.ts",
      "apps/main-node/test/pg-queue.test.ts",
      "apps/main-node/test/s3-memory.test.ts",
      "packages/managed-agents-adapters-sql/test/agents-sql-persistence.pg.test.ts",
      "packages/managed-agents-adapters-sql/test/sessions-sql-persistence.pg.test.ts",
      "packages/runtime-resource-fence-sql/test/sql-fence.pg.test.ts",
    ],
    globalSetup: ["./test/storage-global-setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
