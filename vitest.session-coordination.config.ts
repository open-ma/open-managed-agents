import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "threads",
    include: [
      "packages/session-runtime-sql/test/coordination.test.ts",
      "packages/managed-agents-adapters-sql/test/session-events-sql-persistence.test.ts",
      "apps/main-node/test/node-session-execution-worker.test.ts",
    ],
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: [
        "packages/session-runtime-contract/src/coordination.ts",
        "packages/session-runtime-sql/src/coordination.ts",
        "apps/main-node/src/lib/node-session-execution-worker.ts",
      ],
      thresholds: {
        perFile: true,
        lines: 100,
        statements: 100,
        functions: 100,
        branches: 100,
      },
    },
  },
});
