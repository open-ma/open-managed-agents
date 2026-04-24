-- Phase 2-revised of the per-tenant-D1 work: meta table router.
--
-- Two control-plane tables that drive how MetaTableTenantDbProvider
-- (packages/tenant-db) routes tenant_id → D1 binding:
--
--   tenant_shard — assignment record. tenant_id → binding_name. The first
--                  write per tenant wins (INSERT OR IGNORE in adapter), so
--                  re-running sign-up never re-routes a live tenant. Missing
--                  row = tenant falls back to env.AUTH_DB (the default
--                  shard), which is the N=1 deployment behaviour.
--
--   shard_pool   — operational state per binding. status drives "which shard
--                  do new tenants land on" via ORDER BY tenant_count ASC.
--                  size_bytes / observed_at are populated by an out-of-band
--                  capacity monitor (scripts/shard-pool-monitor.ts, future).
--                  status='full' or 'archived' removes a shard from rotation.
--
-- N=1 seed: a single shard_pool row for AUTH_DB so the assign flow has
-- something to pick. tenant_shard stays empty until N>1 — every tenant
-- fallback resolves to AUTH_DB, no behaviour change.

CREATE TABLE IF NOT EXISTS "tenant_shard" (
  "tenant_id"    TEXT PRIMARY KEY NOT NULL,
  "binding_name" TEXT NOT NULL,
  "created_at"   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_tenant_shard_binding"
  ON "tenant_shard" ("binding_name");

CREATE TABLE IF NOT EXISTS "shard_pool" (
  "binding_name"  TEXT PRIMARY KEY NOT NULL,
  "status"        TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'draining' | 'full' | 'archived'
  "tenant_count"  INTEGER NOT NULL DEFAULT 0,
  "size_bytes"    INTEGER,                       -- last observed; NULL = unknown
  "observed_at"   INTEGER,                       -- ms epoch of last observation
  "notes"         TEXT
);

CREATE INDEX IF NOT EXISTS "idx_shard_pool_status"
  ON "shard_pool" ("status", "tenant_count");

-- Seed N=1 default shard. Idempotent — re-running this migration in any
-- environment that already has the row no-ops via INSERT OR IGNORE.
INSERT OR IGNORE INTO "shard_pool" ("binding_name", "status", "notes")
VALUES ('AUTH_DB', 'open', 'default shard (N=1 baseline)');
