import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/sprites-certification.e2e.test.ts"],
  },
});
