import { defineConfig } from "vitest/config";

/** Node-side coverage gate for the Pi harness compaction policy. */
export default defineConfig({
  test: {
    pool: "threads",
    environment: "node",
    include: [
      "apps/agent/tests/pi-loop.test.ts",
      "apps/agent/tests/pi-compaction.test.ts",
      "apps/main-node/test/pi-sandbox-harness.e2e.test.ts",
    ],
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["apps/agent/src/harness/pi-compaction.ts"],
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage/pi",
      thresholds: {
        perFile: true,
        lines: 85,
        statements: 85,
        functions: 80,
        branches: 70,
      },
    },
  },
});
