import { defineConfig } from "vitest/config";
import { cloudflarePool } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  resolve: {
    alias: {
      // Stub out @cloudflare/sandbox in tests — the real module depends on
      // @cloudflare/containers which has workerd-native code that miniflare
      // can't load. Production builds use wrangler bundling which handles this.
      "@cloudflare/sandbox": "./test/sandbox-stub.ts",
      // Resolve workspace package for miniflare/workerd runtime
      "@open-managed-agents/shared": "./packages/shared/src/index.ts",
      "@open-managed-agents/memory-store/test-fakes": "./packages/memory-store/src/test-fakes.ts",
      "@open-managed-agents/memory-store": "./packages/memory-store/src/index.ts",
    },
  },
  test: {
    testTimeout: 30000,
    exclude: ["**/node_modules/**", "**/.git/**", "**/.claude/worktrees/**", "test/e2e/**"],
    pool: cloudflarePool({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        bindings: {
          API_KEY: "test-key",
          ANTHROPIC_API_KEY: "sk-ant-test-key",
          BETTER_AUTH_SECRET: "test-auth-secret-for-vitest",
          RATE_LIMIT_WRITE: 10000,
          RATE_LIMIT_READ: 10000,
        },
      },
    }),
  },
});
