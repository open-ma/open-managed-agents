import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@vercel/sandbox": fileURLToPath(new URL("./test/fixtures/vercel-sdk.ts", import.meta.url)) },
  },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
