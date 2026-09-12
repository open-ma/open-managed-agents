import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The one-line stdio bootstraps are exercised by packaged Docker E2E;
      // unit coverage applies to their reusable composition/protocol modules.
      exclude: ["src/node-cli.ts", "src/node-work-item-cli.ts"],
      reporter: ["text", "json"],
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
});
