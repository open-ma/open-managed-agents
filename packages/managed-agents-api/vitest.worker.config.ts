import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/official-environment-worker.contract.test.ts"],
  },
});
