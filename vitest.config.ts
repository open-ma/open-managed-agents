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
      "@open-managed-agents/api-types": "./packages/api-types/src/index.ts",
      "@open-managed-agents/cf-billing": "./packages/cf-billing/src/index.ts",
      "@open-managed-agents/eval-core": "./packages/eval-core/src/index.ts",
      "@open-managed-agents/shared": "./packages/shared/src/index.ts",
      "@open-managed-agents/memory-store/test-fakes": "./packages/memory-store/src/test-fakes.ts",
      "@open-managed-agents/memory-store": "./packages/memory-store/src/index.ts",
      "@open-managed-agents/credentials-store/test-fakes": "./packages/credentials-store/src/test-fakes.ts",
      "@open-managed-agents/credentials-store": "./packages/credentials-store/src/index.ts",
      "@open-managed-agents/vaults-store/test-fakes": "./packages/vaults-store/src/test-fakes.ts",
      "@open-managed-agents/vaults-store": "./packages/vaults-store/src/index.ts",
      "@open-managed-agents/sessions-store/test-fakes": "./packages/sessions-store/src/test-fakes.ts",
      "@open-managed-agents/sessions-store": "./packages/sessions-store/src/index.ts",
      "@open-managed-agents/files-store/test-fakes": "./packages/files-store/src/test-fakes.ts",
      "@open-managed-agents/files-store": "./packages/files-store/src/index.ts",
      "@open-managed-agents/evals-store/test-fakes": "./packages/evals-store/src/test-fakes.ts",
      "@open-managed-agents/evals-store": "./packages/evals-store/src/index.ts",
      "@open-managed-agents/model-cards-store/test-fakes": "./packages/model-cards-store/src/test-fakes.ts",
      "@open-managed-agents/model-cards-store": "./packages/model-cards-store/src/index.ts",
      "@open-managed-agents/agents-store/test-fakes": "./packages/agents-store/src/test-fakes.ts",
      "@open-managed-agents/agents-store": "./packages/agents-store/src/index.ts",
      "@open-managed-agents/environments-store/test-fakes": "./packages/environments-store/src/test-fakes.ts",
      "@open-managed-agents/environments-store": "./packages/environments-store/src/index.ts",
      "@open-managed-agents/outbound-snapshots-store/test-fakes": "./packages/outbound-snapshots-store/src/test-fakes.ts",
      "@open-managed-agents/outbound-snapshots-store": "./packages/outbound-snapshots-store/src/index.ts",
      "@open-managed-agents/session-secrets-store/test-fakes": "./packages/session-secrets-store/src/test-fakes.ts",
      "@open-managed-agents/session-secrets-store": "./packages/session-secrets-store/src/index.ts",
      "@open-managed-agents/services": "./packages/services/src/index.ts",
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
