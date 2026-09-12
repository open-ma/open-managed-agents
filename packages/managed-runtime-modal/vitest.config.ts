import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { modal: fileURLToPath(new URL("./test/fixtures/modal-sdk.ts", import.meta.url)) },
  },
  test: { include: ["test/**/*.test.ts"] },
});
