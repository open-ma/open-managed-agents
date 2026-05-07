// Vitest config local to @open-managed-agents/session-runtime.
//
// The root vitest.config.ts pins everything to @cloudflare/vitest-pool-
// workers, which runs in workerd — fine for code that lives in apps/agent
// or apps/main, but breaks anything that needs Node-native bindings like
// better-sqlite3. The adapter unit tests here use better-sqlite3 in
// `:memory:` mode to exercise the unified RuntimeAdapter shape without
// any I/O, so they need to run in the Node thread pool instead.
//
// Run with:
//   pnpm --filter @open-managed-agents/session-runtime test

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "threads",
    include: ["test/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
