import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/native-state.test.ts"],
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text"],
      include: ["src/native-state.ts"],
      thresholds: {
        statements: 95,
        branches: 85,
        functions: 95,
        lines: 95,
      },
    },
  },
});
