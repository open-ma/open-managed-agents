import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The one-line stdio bootstrap is exercised by the packaged Docker E2E;
      // unit coverage applies to the reusable composition and protocol code.
      exclude: ["src/node-cli.ts"],
      reporter: ["text", "json"],
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
});
