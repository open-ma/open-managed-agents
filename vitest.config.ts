import { defineConfig } from "vitest/config";
import { cloudflarePool, cloudflareTest } from "@cloudflare/vitest-pool-workers";

const cfWorkerOptions = {
  wrangler: { configPath: "./wrangler.test.jsonc" },
  miniflare: {
    bindings: {
      API_KEY: "test-key",
      ANTHROPIC_API_KEY: "sk-ant-test-key",
      BETTER_AUTH_SECRET: "test-auth-secret-for-vitest",
      // Required by buildServices for at-rest encryption of credentials.auth
      // and model_cards.api_key_cipher. Tests don't care about the value as
      // long as it's stable across encrypt/decrypt within a single process.
      PLATFORM_ROOT_SECRET: "test-platform-root-secret-padded-to-thirtytwo",
      RATE_LIMIT_WRITE: 10000,
      RATE_LIMIT_READ: 10000,
    },
  },
};

export default defineConfig({
  // cloudflareTest registers the `cloudflare:test` virtual module
  // (runInDurableObject, listDurableObjectIds, etc.) — the pool runner
  // alone doesn't expose it, only the plugin does.
  plugins: [cloudflareTest(cfWorkerOptions)],
  resolve: {
    // vitest-pool-workers bridges these into the miniflare/workerd runtime
    // by string match — RegExp entries only work for the vitest module graph
    // (Vite resolver), not for workerd's package resolution. So every
    // workspace package + subpath that workerd-side test code imports
    // needs an explicit string alias here.
    alias: [
      // Stub out @cloudflare/sandbox in tests — the real module depends on
      // @cloudflare/containers which has workerd-native code that miniflare
      // can't load. Production builds use wrangler bundling which handles this.
      { find: "@cloudflare/sandbox", replacement: "./test/sandbox-stub.ts" },

      // ─── Stores: package + test-fakes subpath ─────────────────────────
      { find: "@open-managed-agents/api-types", replacement: "./packages/api-types/src/index.ts" },
      { find: "@open-managed-agents/cf-billing", replacement: "./packages/cf-billing/src/index.ts" },
      { find: "@open-managed-agents/eval-core", replacement: "./packages/eval-core/src/index.ts" },
      { find: "@open-managed-agents/shared", replacement: "./packages/shared/src/index.ts" },
      { find: "@open-managed-agents/memory-store/test-fakes", replacement: "./packages/memory-store/src/test-fakes.ts" },
      { find: "@open-managed-agents/memory-store/adapters/local-fs-blob", replacement: "./packages/memory-store/src/adapters/local-fs-blob.ts" },
      { find: "@open-managed-agents/memory-store/adapters/s3-blob", replacement: "./packages/memory-store/src/adapters/s3-blob.ts" },
      { find: "@open-managed-agents/memory-store", replacement: "./packages/memory-store/src/index.ts" },
      { find: "@open-managed-agents/credentials-store/test-fakes", replacement: "./packages/credentials-store/src/test-fakes.ts" },
      { find: "@open-managed-agents/credentials-store", replacement: "./packages/credentials-store/src/index.ts" },
      { find: "@open-managed-agents/vaults-store/test-fakes", replacement: "./packages/vaults-store/src/test-fakes.ts" },
      { find: "@open-managed-agents/vaults-store", replacement: "./packages/vaults-store/src/index.ts" },
      { find: "@open-managed-agents/sessions-store/test-fakes", replacement: "./packages/sessions-store/src/test-fakes.ts" },
      { find: "@open-managed-agents/sessions-store", replacement: "./packages/sessions-store/src/index.ts" },
      { find: "@open-managed-agents/files-store/test-fakes", replacement: "./packages/files-store/src/test-fakes.ts" },
      { find: "@open-managed-agents/files-store", replacement: "./packages/files-store/src/index.ts" },
      { find: "@open-managed-agents/evals-store/test-fakes", replacement: "./packages/evals-store/src/test-fakes.ts" },
      { find: "@open-managed-agents/evals-store", replacement: "./packages/evals-store/src/index.ts" },
      { find: "@open-managed-agents/model-cards-store/test-fakes", replacement: "./packages/model-cards-store/src/test-fakes.ts" },
      { find: "@open-managed-agents/model-cards-store", replacement: "./packages/model-cards-store/src/index.ts" },
      { find: "@open-managed-agents/agents-store/test-fakes", replacement: "./packages/agents-store/src/test-fakes.ts" },
      { find: "@open-managed-agents/agents-store", replacement: "./packages/agents-store/src/index.ts" },
      { find: "@open-managed-agents/environments-store/test-fakes", replacement: "./packages/environments-store/src/test-fakes.ts" },
      { find: "@open-managed-agents/environments-store", replacement: "./packages/environments-store/src/index.ts" },
      { find: "@open-managed-agents/outbound-snapshots-store/test-fakes", replacement: "./packages/outbound-snapshots-store/src/test-fakes.ts" },
      { find: "@open-managed-agents/outbound-snapshots-store", replacement: "./packages/outbound-snapshots-store/src/index.ts" },
      { find: "@open-managed-agents/session-secrets-store/test-fakes", replacement: "./packages/session-secrets-store/src/test-fakes.ts" },
      { find: "@open-managed-agents/session-secrets-store", replacement: "./packages/session-secrets-store/src/index.ts" },
      { find: "@open-managed-agents/services", replacement: "./packages/services/src/index.ts" },

      // ─── sql-client ───────────────────────────────────────────────────
      { find: "@open-managed-agents/sql-client/adapters/cf-d1", replacement: "./packages/sql-client/src/adapters/cf-d1.ts" },
      { find: "@open-managed-agents/sql-client", replacement: "./packages/sql-client/src/index.ts" },

      // ─── scheduler (subpaths matter) ──────────────────────────────────
      { find: "@open-managed-agents/scheduler/cf", replacement: "./packages/scheduler/src/adapters/cf.ts" },
      { find: "@open-managed-agents/scheduler/node", replacement: "./packages/scheduler/src/adapters/node.ts" },
      { find: "@open-managed-agents/scheduler/jobs/memory-retention", replacement: "./packages/scheduler/src/jobs/memory-retention.ts" },
      { find: "@open-managed-agents/scheduler/jobs/webhook-events-retention", replacement: "./packages/scheduler/src/jobs/webhook-events-retention.ts" },
      { find: "@open-managed-agents/scheduler/jobs/linear-dispatch", replacement: "./packages/scheduler/src/jobs/linear-dispatch.ts" },
      { find: "@open-managed-agents/scheduler", replacement: "./packages/scheduler/src/index.ts" },

      // ─── queue ────────────────────────────────────────────────────────
      { find: "@open-managed-agents/queue/cf", replacement: "./packages/queue/src/adapters/cf.ts" },
      { find: "@open-managed-agents/queue/pg", replacement: "./packages/queue/src/adapters/pg.ts" },
      { find: "@open-managed-agents/queue/in-memory", replacement: "./packages/queue/src/adapters/in-memory.ts" },
      { find: "@open-managed-agents/queue/handlers/memory-events", replacement: "./packages/queue/src/handlers/memory-events.ts" },
      { find: "@open-managed-agents/queue", replacement: "./packages/queue/src/index.ts" },

      // ─── evals-runner / tenant-db / event-log / cap ───────────────────
      { find: "@open-managed-agents/evals-runner", replacement: "./packages/evals-runner/src/index.ts" },
      { find: "@open-managed-agents/tenant-db/test-fakes", replacement: "./packages/tenant-db/src/test-fakes.ts" },
      { find: "@open-managed-agents/tenant-db", replacement: "./packages/tenant-db/src/index.ts" },
      { find: "@open-managed-agents/tenant-dbs-store/test-fakes", replacement: "./packages/tenant-dbs-store/src/test-fakes.ts" },
      { find: "@open-managed-agents/tenant-dbs-store", replacement: "./packages/tenant-dbs-store/src/index.ts" },
      { find: "@open-managed-agents/event-log/memory", replacement: "./packages/event-log/src/memory/index.ts" },
      { find: "@open-managed-agents/event-log/cf-do", replacement: "./packages/event-log/src/cf-do/index.ts" },
      { find: "@open-managed-agents/event-log/sql", replacement: "./packages/event-log/src/sql/index.ts" },
      { find: "@open-managed-agents/event-log", replacement: "./packages/event-log/src/index.ts" },
      { find: "@open-managed-agents/cap/test-fakes", replacement: "./packages/cap/src/test-fakes.ts" },
      { find: "@open-managed-agents/cap", replacement: "./packages/cap/src/index.ts" },
      { find: "@open-managed-agents/oma-cap-adapter", replacement: "./packages/oma-cap-adapter/src/index.ts" },

      // ─── environment-images (irregular subpath layout) ────────────────
      { find: "@open-managed-agents/environment-images/memory", replacement: "./packages/environment-images/src/adapters/memory/index.ts" },
      { find: "@open-managed-agents/environment-images/cf-base-snapshot", replacement: "./packages/environment-images/src/adapters/cf-base-snapshot/index.ts" },
      { find: "@open-managed-agents/environment-images/cf-dockerfile", replacement: "./packages/environment-images/src/adapters/cf-dockerfile/index.ts" },
      { find: "@open-managed-agents/environment-images", replacement: "./packages/environment-images/src/index.ts" },

      // ─── observability + browser-harness (P6 / P7) ────────────────────
      { find: "@open-managed-agents/observability/logger/node", replacement: "./packages/observability/src/logger/node.ts" },
      { find: "@open-managed-agents/observability/logger/cf", replacement: "./packages/observability/src/logger/cf.ts" },
      { find: "@open-managed-agents/observability/metrics/node", replacement: "./packages/observability/src/metrics/node.ts" },
      { find: "@open-managed-agents/observability/metrics/cf", replacement: "./packages/observability/src/metrics/cf.ts" },
      { find: "@open-managed-agents/observability/tracer/node", replacement: "./packages/observability/src/tracer/node.ts" },
      { find: "@open-managed-agents/observability/tracer/cf", replacement: "./packages/observability/src/tracer/cf.ts" },
      { find: "@open-managed-agents/observability", replacement: "./packages/observability/src/index.ts" },
      { find: "@open-managed-agents/browser-harness/cf", replacement: "./packages/browser-harness/src/cf.ts" },
      { find: "@open-managed-agents/browser-harness/node", replacement: "./packages/browser-harness/src/node.ts" },
      { find: "@open-managed-agents/browser-harness/cdp", replacement: "./packages/browser-harness/src/cdp.ts" },
      { find: "@open-managed-agents/browser-harness/disabled", replacement: "./packages/browser-harness/src/disabled.ts" },
      { find: "@open-managed-agents/browser-harness/select", replacement: "./packages/browser-harness/src/select.ts" },
      { find: "@open-managed-agents/browser-harness", replacement: "./packages/browser-harness/src/index.ts" },

      // ─── sandbox (subpaths) + blob-store ──────────────────────────────
      { find: "@open-managed-agents/sandbox/orchestrator", replacement: "./packages/sandbox/src/orchestrator.ts" },
      { find: "@open-managed-agents/sandbox/adapters/local-subprocess", replacement: "./packages/sandbox/src/adapters/local-subprocess.ts" },
      { find: "@open-managed-agents/sandbox/adapters/litebox", replacement: "./packages/sandbox/src/adapters/litebox.ts" },
      { find: "@open-managed-agents/sandbox/adapters/daytona", replacement: "./packages/sandbox/src/adapters/daytona.ts" },
      { find: "@open-managed-agents/sandbox/adapters/e2b", replacement: "./packages/sandbox/src/adapters/e2b.ts" },
      { find: "@open-managed-agents/sandbox/adapters/boxrun", replacement: "./packages/sandbox/src/adapters/boxrun.ts" },
      { find: "@open-managed-agents/sandbox", replacement: "./packages/sandbox/src/index.ts" },
      { find: "@open-managed-agents/blob-store/adapters/local-fs", replacement: "./packages/blob-store/src/adapters/local-fs.ts" },
      { find: "@open-managed-agents/blob-store/adapters/s3", replacement: "./packages/blob-store/src/adapters/s3.ts" },
      { find: "@open-managed-agents/blob-store/adapters/in-memory", replacement: "./packages/blob-store/src/adapters/in-memory.ts" },
      { find: "@open-managed-agents/blob-store", replacement: "./packages/blob-store/src/index.ts" },

      // ─── auth / auth-config / email / kv-store / quotas / rate-limit / vault-forward / schema / http-routes / install-bridge ─
      { find: "@open-managed-agents/auth", replacement: "./packages/auth/src/index.ts" },
      { find: "@open-managed-agents/auth-config", replacement: "./packages/auth-config/src/index.ts" },
      { find: "@open-managed-agents/email/adapters/nodemailer", replacement: "./packages/email/src/adapters/nodemailer.ts" },
      { find: "@open-managed-agents/email/adapters/cf-send-email", replacement: "./packages/email/src/adapters/cf-send-email.ts" },
      { find: "@open-managed-agents/email", replacement: "./packages/email/src/index.ts" },
      { find: "@open-managed-agents/kv-store/adapters/sql", replacement: "./packages/kv-store/src/adapters/sql.ts" },
      { find: "@open-managed-agents/kv-store/adapters/in-memory", replacement: "./packages/kv-store/src/adapters/in-memory.ts" },
      { find: "@open-managed-agents/kv-store/adapters/cf", replacement: "./packages/kv-store/src/adapters/cf.ts" },
      { find: "@open-managed-agents/kv-store", replacement: "./packages/kv-store/src/index.ts" },
      { find: "@open-managed-agents/quotas", replacement: "./packages/quotas/src/index.ts" },
      { find: "@open-managed-agents/rate-limit", replacement: "./packages/rate-limit/src/index.ts" },
      { find: "@open-managed-agents/vault-forward", replacement: "./packages/vault-forward/src/index.ts" },
      { find: "@open-managed-agents/schema", replacement: "./packages/schema/src/index.ts" },
      { find: "@open-managed-agents/http-routes", replacement: "./packages/http-routes/src/index.ts" },
      { find: "@open-managed-agents/integrations-core", replacement: "./packages/integrations-core/src/index.ts" },
      { find: "@open-managed-agents/integrations-adapters-cf", replacement: "./packages/integrations-adapters-cf/src/index.ts" },
      { find: "@open-managed-agents/integrations-adapters-node", replacement: "./packages/integrations-adapters-node/src/index.ts" },

      // ─── markdown / session-runtime / acp-runtime / agent (internal) ──
      { find: "@open-managed-agents/markdown/adapters/node", replacement: "./packages/markdown/src/adapters/node.ts" },
      { find: "@open-managed-agents/markdown/adapters/cf-workers-ai", replacement: "./packages/markdown/src/adapters/cf-workers-ai.ts" },
      { find: "@open-managed-agents/markdown", replacement: "./packages/markdown/src/index.ts" },
      { find: "@open-managed-agents/session-runtime/recovery", replacement: "./packages/session-runtime/src/recovery.ts" },
      { find: "@open-managed-agents/session-runtime", replacement: "./packages/session-runtime/src/index.ts" },
      { find: "@open-managed-agents/acp-runtime/cf-sandbox", replacement: "./packages/acp-runtime/src/cf-sandbox.ts" },
      { find: "@open-managed-agents/acp-runtime/known-agents", replacement: "./packages/acp-runtime/src/known-agents.ts" },
      { find: "@open-managed-agents/acp-runtime/node-spawner", replacement: "./packages/acp-runtime/src/node-spawner.ts" },
      { find: "@open-managed-agents/acp-runtime/registry", replacement: "./packages/acp-runtime/src/registry.ts" },
      { find: "@open-managed-agents/acp-runtime", replacement: "./packages/acp-runtime/src/index.ts" },

      // Catch-all fallbacks for the vitest module graph (workerd needs the
      // explicit entries above; this helps node-side tests resolve any
      // newly-added subpath without a config edit).
      { find: /^@open-managed-agents\/([a-z][a-z0-9-]*)\/(.+)$/, replacement: "./packages/$1/src/$2" },
      { find: /^@open-managed-agents\/([a-z][a-z0-9-]*)$/, replacement: "./packages/$1/src/index.ts" },
    ],
  },
  test: {
    testTimeout: 30000,
    exclude: ["**/node_modules/**", "**/.git/**", "**/.claude/worktrees/**", "**/.pnpm-store/**", "test/e2e/**", "packages/cap/test/**", "packages/session-runtime/test/**"],
    pool: cloudflarePool(cfWorkerOptions),
  },
});
