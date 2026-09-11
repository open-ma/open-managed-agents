import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "threads",
    include: ["test/**/*.e2e.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
