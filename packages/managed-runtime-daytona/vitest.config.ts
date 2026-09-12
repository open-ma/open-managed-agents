import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@daytona/sdk": fileURLToPath(new URL("./test/fixtures/daytona-sdk.ts", import.meta.url)),
      "@daytonaio/sdk": fileURLToPath(new URL("./test/fixtures/daytona-legacy-sdk.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
