import { defineConfig } from "vitest/config";

/** Node-side coverage gate for canonical-events to ACP semantic recovery. */
export default defineConfig({
  test: {
    pool: "threads",
    environment: "node",
    include: ["apps/agent/tests/acp-recovery.test.ts"],
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["apps/agent/src/harness/acp-recovery.ts"],
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage/acp-recovery",
      thresholds: {
        perFile: true,
        lines: 95,
        statements: 95,
        functions: 90,
        branches: 75,
      },
    },
  },
});
