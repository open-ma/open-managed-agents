import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@boxlite-ai/boxlite": fileURLToPath(new URL("./test/fixtures/boxlite-sdk.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    pool: "threads",
    include: ["test/**/*.test.ts"],
    coverage: {
      enabled: true,
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json"],
      thresholds: { perFile: true, statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
