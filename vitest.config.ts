import { readFile } from "node:fs/promises";
import { defineConfig } from "vitest/config";
import { cloudflarePool, cloudflareTest } from "@cloudflare/vitest-pool-workers";
import type { Plugin } from "vite";

const packagesWithUnpublishedSourcemapSources = [
  "/node_modules/.pnpm/@workflow+serde@",
  "/node_modules/.pnpm/cron-schedule@",
  "/node_modules/.pnpm/standardwebhooks@",
  "/node_modules/.pnpm/@cloudflare+containers@",
  "/node_modules/.pnpm/@openma+common@",
  "/node_modules/.pnpm/@agentclientprotocol+sdk@",
];

/**
 * These published packages reference source files that are absent from their
 * npm tarballs. Strip only their unusable sourceMappingURL comments so Vite
 * keeps validating first-party and all other dependency sourcemaps normally.
 */
function stripUnpublishedDependencySourcemaps(): Plugin {
  return {
    name: "strip-unpublished-dependency-sourcemaps",
    enforce: "pre",
    async load(id) {
      const filePath = id.split("?", 1)[0];
      const normalizedPath = filePath.replaceAll("\\", "/");
      if (
        !normalizedPath.endsWith(".js") ||
        !packagesWithUnpublishedSourcemapSources.some((packagePath) => normalizedPath.includes(packagePath))
      ) {
        return null;
      }

      const code = await readFile(filePath, "utf8");
      return code.replace(/^\/\/# sourceMappingURL=.*(?:\r?\n|$)/gm, "");
    },
  };
}

const cfWorkerOptions = {
  wrangler: { configPath: "./wrangler.test.jsonc" },
  miniflare: {
    bindings: {
      API_KEY: "test-key",
      ANTHROPIC_API_KEY: "sk-ant-test-key",
      DREAM_CURATOR_MODE: "dedup",
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
  plugins: [stripUnpublishedDependencySourcemaps(), cloudflareTest(cfWorkerOptions)],
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
      { find: "@open-managed-agents/mcp", replacement: "./packages/mcp/src/index.ts" },
      { find: "@open-managed-agents/dreams-store/test-fakes", replacement: "./packages/dreams-store/src/test-fakes.ts" },
      { find: "@open-managed-agents/dreams-store", replacement: "./packages/dreams-store/src/index.ts" },
      { find: "@open-managed-agents/dreams-pipeline", replacement: "./packages/dreams-pipeline/src/index.ts" },
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
      { find: "@open-managed-agents/sql-client/adapters/cf-do", replacement: "./packages/sql-client/src/adapters/cf-do.ts" },
      { find: "@open-managed-agents/sql-client/adapters/cf-d1", replacement: "./packages/sql-client/src/adapters/cf-d1.ts" },
      { find: "@open-managed-agents/sql-client", replacement: "./packages/sql-client/src/index.ts" },

      // ─── v1 domain interfaces and OMA extension lane ────────────────
      { find: "@open-managed-agents/domain/agents", replacement: "./packages/managed-agents-domain/src/agents/index.ts" },
      { find: "@open-managed-agents/domain/credentials", replacement: "./packages/managed-agents-domain/src/credentials/index.ts" },
      { find: "@open-managed-agents/domain/deployments", replacement: "./packages/managed-agents-domain/src/deployments/index.ts" },
      { find: "@open-managed-agents/domain/dreams", replacement: "./packages/managed-agents-domain/src/dreams/index.ts" },
      { find: "@open-managed-agents/domain/environments", replacement: "./packages/managed-agents-domain/src/environments/index.ts" },
      { find: "@open-managed-agents/domain/environment-work", replacement: "./packages/managed-agents-domain/src/environment-work/index.ts" },
      { find: "@open-managed-agents/domain/files", replacement: "./packages/managed-agents-domain/src/files/index.ts" },
      { find: "@open-managed-agents/domain/memory-stores", replacement: "./packages/managed-agents-domain/src/memory-stores/index.ts" },
      { find: "@open-managed-agents/domain/memories", replacement: "./packages/managed-agents-domain/src/memories/index.ts" },
      { find: "@open-managed-agents/domain/sessions", replacement: "./packages/managed-agents-domain/src/sessions/index.ts" },
      { find: "@open-managed-agents/domain/skills", replacement: "./packages/managed-agents-domain/src/skills/index.ts" },
      { find: "@open-managed-agents/domain/tunnels", replacement: "./packages/managed-agents-domain/src/tunnels/index.ts" },
      { find: "@open-managed-agents/domain/user-profiles", replacement: "./packages/managed-agents-domain/src/user-profiles/index.ts" },
      { find: "@open-managed-agents/domain/vaults", replacement: "./packages/managed-agents-domain/src/vaults/index.ts" },
      { find: "@open-managed-agents/domain", replacement: "./packages/managed-agents-domain/src/index.ts" },
      { find: "@open-managed-agents/agent-store", replacement: "./packages/agent-store/src/index.ts" },
      { find: "@open-managed-agents/credential-store-sql", replacement: "./packages/credential-store-sql/src/index.ts" },
      { find: "@open-managed-agents/credential-store-memory", replacement: "./packages/credential-store-memory/src/index.ts" },
      { find: "@open-managed-agents/credential-store", replacement: "./packages/credential-store/src/index.ts" },
      { find: "@open-managed-agents/deployment-store-sql", replacement: "./packages/deployment-store-sql/src/index.ts" },
      { find: "@open-managed-agents/deployment-store-memory", replacement: "./packages/deployment-store-memory/src/index.ts" },
      { find: "@open-managed-agents/deployment-store", replacement: "./packages/deployment-store/src/index.ts" },
      { find: "@open-managed-agents/deployment-run-store-sql", replacement: "./packages/deployment-run-store-sql/src/index.ts" },
      { find: "@open-managed-agents/deployment-run-store-memory", replacement: "./packages/deployment-run-store-memory/src/index.ts" },
      { find: "@open-managed-agents/deployment-run-store", replacement: "./packages/deployment-run-store/src/index.ts" },
      { find: "@open-managed-agents/dream-store-sql", replacement: "./packages/dream-store-sql/src/index.ts" },
      { find: "@open-managed-agents/dream-store-memory", replacement: "./packages/dream-store-memory/src/index.ts" },
      { find: "@open-managed-agents/dream-store", replacement: "./packages/dream-store/src/index.ts" },
      { find: "@open-managed-agents/environment-store-sql", replacement: "./packages/environment-store-sql/src/index.ts" },
      { find: "@open-managed-agents/environment-store-memory", replacement: "./packages/environment-store-memory/src/index.ts" },
      { find: "@open-managed-agents/environment-store", replacement: "./packages/environment-store/src/index.ts" },
      { find: "@open-managed-agents/environment-work-store-memory", replacement: "./packages/environment-work-store-memory/src/index.ts" },
      { find: "@open-managed-agents/environment-work-store-sql", replacement: "./packages/environment-work-store-sql/src/index.ts" },
      { find: "@open-managed-agents/environment-work-store", replacement: "./packages/environment-work-store/src/index.ts" },
      { find: "@open-managed-agents/file-content-store", replacement: "./packages/file-content-store/src/index.ts" },
      { find: "@open-managed-agents/file-store-sql", replacement: "./packages/file-store-sql/src/index.ts" },
      { find: "@open-managed-agents/file-store-memory", replacement: "./packages/file-store-memory/src/index.ts" },
      { find: "@open-managed-agents/file-store", replacement: "./packages/file-store/src/index.ts" },
      { find: "@open-managed-agents/memory-store-store-sql", replacement: "./packages/memory-store-store-sql/src/index.ts" },
      { find: "@open-managed-agents/memory-store-store-memory", replacement: "./packages/memory-store-store-memory/src/index.ts" },
      { find: "@open-managed-agents/memory-store-store", replacement: "./packages/memory-store-store/src/index.ts" },
      { find: "@open-managed-agents/memory-document-store-sql", replacement: "./packages/memory-document-store-sql/src/index.ts" },
      { find: "@open-managed-agents/memory-document-store-memory", replacement: "./packages/memory-document-store-memory/src/index.ts" },
      { find: "@open-managed-agents/memory-document-store", replacement: "./packages/memory-document-store/src/index.ts" },
      { find: "@open-managed-agents/session-store-sql", replacement: "./packages/session-store-sql/src/index.ts" },
      { find: "@open-managed-agents/session-store-memory", replacement: "./packages/session-store-memory/src/index.ts" },
      { find: "@open-managed-agents/session-store", replacement: "./packages/session-store/src/index.ts" },
      { find: "@open-managed-agents/session-thread-store-sql", replacement: "./packages/session-thread-store-sql/src/index.ts" },
      { find: "@open-managed-agents/session-thread-store-memory", replacement: "./packages/session-thread-store-memory/src/index.ts" },
      { find: "@open-managed-agents/session-thread-store", replacement: "./packages/session-thread-store/src/index.ts" },
      { find: "@open-managed-agents/session-resource-store-sql", replacement: "./packages/session-resource-store-sql/src/index.ts" },
      { find: "@open-managed-agents/session-resource-store-memory", replacement: "./packages/session-resource-store-memory/src/index.ts" },
      { find: "@open-managed-agents/session-resource-store", replacement: "./packages/session-resource-store/src/index.ts" },
      { find: "@open-managed-agents/skill-store-sql", replacement: "./packages/skill-store-sql/src/index.ts" },
      { find: "@open-managed-agents/skill-store-memory", replacement: "./packages/skill-store-memory/src/index.ts" },
      { find: "@open-managed-agents/skill-store", replacement: "./packages/skill-store/src/index.ts" },
      { find: "@open-managed-agents/tunnel-store-memory", replacement: "./packages/tunnel-store-memory/src/index.ts" },
      { find: "@open-managed-agents/tunnel-store-sql", replacement: "./packages/tunnel-store-sql/src/index.ts" },
      { find: "@open-managed-agents/tunnel-store", replacement: "./packages/tunnel-store/src/index.ts" },
      { find: "@open-managed-agents/user-profile-store-memory", replacement: "./packages/user-profile-store-memory/src/index.ts" },
      { find: "@open-managed-agents/user-profile-store-sql", replacement: "./packages/user-profile-store-sql/src/index.ts" },
      { find: "@open-managed-agents/user-profile-store", replacement: "./packages/user-profile-store/src/index.ts" },
      { find: "@open-managed-agents/session-event-store", replacement: "./packages/session-event-store/src/index.ts" },
      { find: "@open-managed-agents/session-event-store-sql", replacement: "./packages/session-event-store-sql/src/index.ts" },
      { find: "@open-managed-agents/session-event-store-memory", replacement: "./packages/session-event-store-memory/src/index.ts" },
      { find: "@open-managed-agents/vault-store-sql", replacement: "./packages/vault-store-sql/src/index.ts" },
      { find: "@open-managed-agents/vault-store-memory", replacement: "./packages/vault-store-memory/src/index.ts" },
      { find: "@open-managed-agents/vault-store", replacement: "./packages/vault-store/src/index.ts" },
      { find: "@open-managed-agents/session-runtime-contract/context", replacement: "./packages/session-runtime-contract/src/context.ts" },
      { find: "@open-managed-agents/session-runtime-contract/coordination", replacement: "./packages/session-runtime-contract/src/coordination.ts" },
      { find: "@open-managed-agents/session-runtime-contract/dispatch", replacement: "./packages/session-runtime-contract/src/dispatch.ts" },
      { find: "@open-managed-agents/session-runtime-contract/history", replacement: "./packages/session-runtime-contract/src/history.ts" },
      { find: "@open-managed-agents/session-runtime-contract/lifecycle", replacement: "./packages/session-runtime-contract/src/lifecycle.ts" },
      { find: "@open-managed-agents/session-runtime-contract/stream", replacement: "./packages/session-runtime-contract/src/stream.ts" },
      { find: "@open-managed-agents/session-runtime-contract", replacement: "./packages/session-runtime-contract/src/index.ts" },
      { find: "@open-managed-agents/session-runtime-sql/context", replacement: "./packages/session-runtime-sql/src/context.ts" },
      { find: "@open-managed-agents/session-runtime-sql/coordination", replacement: "./packages/session-runtime-sql/src/coordination.ts" },
      { find: "@open-managed-agents/session-runtime-sql/history", replacement: "./packages/session-runtime-sql/src/history.ts" },
      { find: "@open-managed-agents/session-runtime-sql", replacement: "./packages/session-runtime-sql/src/index.ts" },
      { find: "@open-managed-agents/session-realtime", replacement: "./packages/session-realtime/src/index.ts" },
      { find: "@open-managed-agents/session-realtime-memory", replacement: "./packages/session-realtime-memory/src/index.ts" },
      { find: "@open-managed-agents/session-wakeup", replacement: "./packages/session-wakeup/src/index.ts" },
      { find: "@open-managed-agents/session-wakeup-memory", replacement: "./packages/session-wakeup-memory/src/index.ts" },
      { find: "@open-managed-agents/session-wakeup-cloudflare", replacement: "./packages/session-wakeup-cloudflare/src/index.ts" },
      { find: "@open-managed-agents/runtime", replacement: "./packages/managed-agents-runtime/src/index.ts" },
      { find: "@open-managed-agents/runtime-relay", replacement: "./packages/runtime-relay/src/index.ts" },
      { find: "@open-managed-agents/oma-models", replacement: "./packages/oma-models/src/index.ts" },
      { find: "@open-managed-agents/oma-api", replacement: "./packages/oma-api/src/index.ts" },

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
      { find: "@open-managed-agents/runtime-resource-contract", replacement: "./packages/runtime-resource-contract/src/index.ts" },
      { find: "@open-managed-agents/runtime-resource-fence-sql", replacement: "./packages/runtime-resource-fence-sql/src/index.ts" },
      { find: "@open-managed-agents/managed-runtime-host", replacement: "./packages/managed-runtime-host/src/index.ts" },
      { find: "@open-managed-agents/managed-runtime-sandbox", replacement: "./packages/managed-runtime-sandbox/src/index.ts" },
      { find: "@open-managed-agents/blob-store/adapters/local-fs", replacement: "./packages/blob-store/src/adapters/local-fs.ts" },
      { find: "@open-managed-agents/blob-store/adapters/s3", replacement: "./packages/blob-store/src/adapters/s3.ts" },
      { find: "@open-managed-agents/blob-store/adapters/in-memory", replacement: "./packages/blob-store/src/adapters/in-memory.ts" },
      { find: "@open-managed-agents/blob-store/adapters/cf-r2", replacement: "./packages/blob-store/src/adapters/cf-r2.ts" },
      { find: "@open-managed-agents/blob-store/ports", replacement: "./packages/blob-store/src/ports.ts" },
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
      { find: "@open-managed-agents/acp-runtime/native-state", replacement: "./packages/acp-runtime/src/native-state.ts" },
      { find: "@open-managed-agents/acp-runtime/placement", replacement: "./packages/acp-runtime/src/placement.ts" },
      { find: "@open-managed-agents/acp-runtime/sandbox-spawner", replacement: "./packages/acp-runtime/src/spawners/sandbox.ts" },
      { find: "@open-managed-agents/acp-runtime/node-spawner", replacement: "./packages/acp-runtime/src/node-spawner.ts" },
      { find: "@open-managed-agents/acp-runtime/registry", replacement: "./packages/acp-runtime/src/registry.ts" },
      { find: "@open-managed-agents/acp-runtime", replacement: "./packages/acp-runtime/src/index.ts" },

      // ─── v2 composition SDK (package name intentionally shorter than folder) ───
      { find: "@open-managed-agents/app/capabilities", replacement: "./packages/managed-agents-app/src/capabilities.ts" },
      { find: "@open-managed-agents/app/features", replacement: "./packages/managed-agents-app/src/features.ts" },
      { find: "@open-managed-agents/app/managed-agents", replacement: "./packages/managed-agents-app/src/managed-agents.ts" },
      { find: "@open-managed-agents/app/modules/agents", replacement: "./packages/managed-agents-app/src/modules/agents.ts" },
      { find: "@open-managed-agents/app/modules/credentials", replacement: "./packages/managed-agents-app/src/modules/credentials.ts" },
      { find: "@open-managed-agents/app/modules/deployment-runs", replacement: "./packages/managed-agents-app/src/modules/deployment-runs.ts" },
      { find: "@open-managed-agents/app/modules/deployments", replacement: "./packages/managed-agents-app/src/modules/deployments.ts" },
      { find: "@open-managed-agents/app/modules/dreams", replacement: "./packages/managed-agents-app/src/modules/dreams.ts" },
      { find: "@open-managed-agents/app/modules/environments", replacement: "./packages/managed-agents-app/src/modules/environments.ts" },
      { find: "@open-managed-agents/app/modules/environment-work", replacement: "./packages/managed-agents-app/src/modules/environment-work.ts" },
      { find: "@open-managed-agents/app/modules/files", replacement: "./packages/managed-agents-app/src/modules/files.ts" },
      { find: "@open-managed-agents/app/modules/memory-stores", replacement: "./packages/managed-agents-app/src/modules/memory-stores.ts" },
      { find: "@open-managed-agents/app/modules/memories", replacement: "./packages/managed-agents-app/src/modules/memories.ts" },
      { find: "@open-managed-agents/app/modules/models", replacement: "./packages/managed-agents-app/src/modules/models.ts" },
      { find: "@open-managed-agents/app/modules/session-events", replacement: "./packages/managed-agents-app/src/modules/session-events.ts" },
      { find: "@open-managed-agents/app/modules/session-resources", replacement: "./packages/managed-agents-app/src/modules/session-resources.ts" },
      { find: "@open-managed-agents/app/modules/session-thread-events", replacement: "./packages/managed-agents-app/src/modules/session-thread-events.ts" },
      { find: "@open-managed-agents/app/modules/session-threads", replacement: "./packages/managed-agents-app/src/modules/session-threads.ts" },
      { find: "@open-managed-agents/app/modules/sessions", replacement: "./packages/managed-agents-app/src/modules/sessions.ts" },
      { find: "@open-managed-agents/app/modules/skills", replacement: "./packages/managed-agents-app/src/modules/skills.ts" },
      { find: "@open-managed-agents/app/modules/tunnels", replacement: "./packages/managed-agents-app/src/modules/tunnels.ts" },
      { find: "@open-managed-agents/app/modules/user-profiles", replacement: "./packages/managed-agents-app/src/modules/user-profiles.ts" },
      { find: "@open-managed-agents/app/modules/vaults", replacement: "./packages/managed-agents-app/src/modules/vaults.ts" },
      { find: "@open-managed-agents/app/openma", replacement: "./packages/managed-agents-app/src/openma.ts" },
      { find: "@open-managed-agents/app", replacement: "./packages/managed-agents-app/src/index.ts" },

      // Catch-all fallbacks for the vitest module graph (workerd needs the
      // explicit entries above; this helps node-side tests resolve any
      // newly-added subpath without a config edit).
      { find: /^@open-managed-agents\/([a-z][a-z0-9-]*)\/(.+)$/, replacement: "./packages/$1/src/$2" },
      { find: /^@open-managed-agents\/([a-z][a-z0-9-]*)$/, replacement: "./packages/$1/src/index.ts" },
    ],
  },
  test: {
    testTimeout: 30000,
    hookTimeout: 30000,
    // Each file owns a workerd/miniflare runtime. Letting Vitest scale to all
    // host CPUs exhausts the local runtime and turns trivial requests into
    // exact 30s timeouts; two workers keeps the suite deterministic on local
    // workerd while CI runners with fewer cores still use their natural limit.
    maxWorkers: 2,
    exclude: [
      "**/node_modules/**",
      "**/.git/**",
      "**/.claude/worktrees/**",
      "**/.pnpm-store/**",
      "test/e2e/**",
      "apps/agent/build-*/**",
      "apps/console/**",
      "apps/main-node/**",
      "packages/auth/**",
      "packages/acp-runtime/**",
      "packages/cli/**",
      "packages/cap/test/**",
      "packages/integrations-adapters-node/**",
      "packages/integrations-adapters-cf/test/**",
      "packages/managed-agents-adapters-blob/test/**",
      "packages/managed-agents-adapters-sql/test/**",
      "packages/managed-agents-adapters-runtime/test/**",
      "packages/managed-agents-runtime/**",
      "packages/managed-runtime-host/**",
      "packages/managed-runtime-node/**",
      "packages/managed-runtime-sandbox/**",
      "packages/harness-supervisor/**",
      "packages/runtime-resource-fence-sql/**",
      "packages/session-runtime-sql/test/**",
      "packages/managed-agents-api/test/official-environment-worker.contract.test.ts",
      "packages/sandbox/test/**",
      "packages/agent-store-sql/test/**",
      "packages/credential-store-sql/test/**",
      "packages/deployment-store-sql/test/**",
      "packages/deployment-run-store-sql/test/**",
      "packages/dream-store-sql/test/**",
      "packages/environment-store-sql/test/**",
      "packages/environment-work-store-sql/test/**",
      "packages/file-store-sql/test/**",
      "packages/memory-store-store-sql/test/**",
      "packages/memory-document-store-sql/test/**",
      "packages/skill-store-sql/test/**",
      "packages/tunnel-store-sql/test/**",
      "packages/user-profile-store-sql/test/**",
      "packages/session-event-store-sql/test/**",
      "packages/session-resource-store-sql/test/**",
      "packages/session-thread-store-sql/test/**",
      "packages/session-runtime/test/**",
      "packages/vault-store-sql/test/**",
    ],
    pool: cloudflarePool(cfWorkerOptions),
  },
});
