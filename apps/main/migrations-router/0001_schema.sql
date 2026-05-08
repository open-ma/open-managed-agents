-- ============================================================
-- 0001: ROUTER_DB initial schema — tenant→shard routing.
-- ============================================================
--
-- ROUTER_DB is a small, hot-read D1 that every request consults to
-- resolve which AUTH_DB_<NN> shard owns a given tenant. Workers cache
-- the result in KV (1hr TTL) so steady-state load on this DB is low.
--
-- Two tables (mirrored from the legacy `apps/main/migrations/0003_tenant_shard.sql`
-- which originally lived in AUTH_DB itself before the dedicated router
-- DB existed). Once the cutover is verified, the AUTH_DB versions of
-- these tables can be dropped — they're ignored at runtime now.

-- One row per tenant. Sticky: a tenant lives on its assigned shard
-- forever (or until manually rebalanced via the rebalance script).
CREATE TABLE IF NOT EXISTS "tenant_shard" (
  "tenant_id"    TEXT PRIMARY KEY NOT NULL,
  "binding_name" TEXT NOT NULL,             -- e.g. 'AUTH_DB_00'
  "created_at"   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_tenant_shard_binding"
  ON "tenant_shard" ("binding_name");

-- Pool of available shards. `tenant_count` + `size_bytes` are observed
-- by a periodic cron and used by the placement algorithm to pick the
-- least-loaded open shard for a new tenant. status='open' = accepts new;
-- 'draining' = no new tenants, existing stay; 'full' = read-only / hand
-- off; 'archived' = deprovisioned.
CREATE TABLE IF NOT EXISTS "shard_pool" (
  "binding_name"  TEXT PRIMARY KEY NOT NULL,
  "status"        TEXT NOT NULL DEFAULT 'open',
  "tenant_count"  INTEGER NOT NULL DEFAULT 0,
  "size_bytes"    INTEGER,
  "observed_at"   INTEGER,
  "notes"         TEXT
);

CREATE INDEX IF NOT EXISTS "idx_shard_pool_status"
  ON "shard_pool" ("status", "tenant_count");

-- Seed the 4 initial shards. AUTH_DB_00 is the original openma-auth
-- (where all current data lives); _01..03 are net-new empty shards.
-- Idempotent — INSERT OR IGNORE no-ops on re-run.
INSERT OR IGNORE INTO "shard_pool" ("binding_name", "status", "notes") VALUES
  ('AUTH_DB_00', 'open', 'original openma-auth — pre-shard data'),
  ('AUTH_DB_01', 'open', NULL),
  ('AUTH_DB_02', 'open', NULL),
  ('AUTH_DB_03', 'open', NULL);
