-- Adds image_strategy + image_handle to environments.
--
-- image_strategy:
--   'base_snapshot' = packages installed once into /home/env-cache/<id>/
--                     and snapshotted via CF Sandbox createBackup. All
--                     envs share the sandbox-default worker. Default for
--                     new envs.
--   'dockerfile'    = legacy / opt-in path. Per-env CI build via
--                     deploy-sandbox.yml + per-env wrangler deploy.
--                     User dockerfile body MUST omit FROM (platform
--                     forces FROM openma/sandbox-base) — see the
--                     CfDockerfileStrategy adapter for the policy gate.
--   NULL            = pre-migration row. Treated as 'dockerfile' for
--                     back-compat by callers that bother to read the
--                     column.
--
-- image_handle:
--   JSON blob from EnvironmentImageStrategy.prepare(). Strategy-shaped
--   (see packages/environment-images/src/adapters/*/index.ts). Platform
--   stores opaquely and hands back to bootSandbox().

ALTER TABLE "environments" ADD COLUMN image_strategy TEXT;
ALTER TABLE "environments" ADD COLUMN image_handle TEXT;
