import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "threads",
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.e2e.test.ts"],
    testTimeout: 10_000,
  },
});
