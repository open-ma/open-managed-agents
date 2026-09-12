import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@daytona/sdk": fileURLToPath(new URL("./test/fixtures/daytona-sdk.ts", import.meta.url)),
      "@daytonaio/sdk": fileURLToPath(new URL("./test/fixtures/daytona-legacy-sdk.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
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
