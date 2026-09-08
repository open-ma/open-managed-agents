import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "threads",
    include: ["test/boxlite-certification.e2e.test.ts"],
  },
});
