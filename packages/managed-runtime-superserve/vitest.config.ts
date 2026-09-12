import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@superserve/sdk": fileURLToPath(new URL("./test/fixtures/superserve-sdk.ts", import.meta.url)) },
  },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
