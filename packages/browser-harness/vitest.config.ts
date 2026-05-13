// Vitest config local to @open-managed-agents/browser-harness.
//
// Runs in plain Node thread pool (not the workerd pool the rest of OMA
// uses) — these tests exercise the Disabled impl + env-driven dispatch
// shape via duck-typed fakes; no playwright peer is needed at test time.
//
// Run with:
//   pnpm --filter @open-managed-agents/browser-harness test

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "threads",
    include: ["test/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
