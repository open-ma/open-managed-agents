import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@boxlite-ai/boxlite": fileURLToPath(new URL("./test/fixtures/boxlite-sdk.ts", import.meta.url)),
    },
  },
  test: { pool: "threads", include: ["test/**/*.test.ts"] },
});
