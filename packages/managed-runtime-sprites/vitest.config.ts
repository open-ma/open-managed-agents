import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@fly/sprites": fileURLToPath(new URL("./test/fixtures/sprites-sdk.ts", import.meta.url)) },
  },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
