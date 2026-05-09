-- ============================================================
-- 0002: ROUTER_DB — memory_store → tenant index.
-- ============================================================
--
-- Why this exists: the memory queue consumer
-- (apps/main/src/queue/memory-events.ts) receives R2 PUT/DELETE events
-- with key `<store_id>/<memory_path>`. With horizontal sharding, the
-- consumer needs to know which AUTH_DB_NN shard owns the memory_store
-- before it can UPSERT the memories index row. The R2 event payload has
-- no tenant_id field, so the consumer can't derive the shard from the
-- event alone.
--
-- This table is the lookup. Populated synchronously when a memory store
-- is created (apps/main/src/routes/memory.ts POST /v1/memory). The
-- consumer queries it once per event (cached per-isolate in CF runtime
-- via the consumer's own Map; this DB query is a fallback).
--
-- Why ROUTER_DB and not AUTH_DB: same SPOF reasoning as tenant_shard —
-- if shard 0 is down, queue consumer needs to keep routing memory events
-- for tenants on shards 1-3. Putting the index here means the lookup
-- doesn't depend on the data plane being up.
--
-- Empty by default: the consumer treats "missing row" as "store on
-- AUTH_DB_00" (legacy fallback), so pre-shard stores keep working
-- even without backfill. Operators with existing memory_stores at the
-- time of shard rollout should backfill via:
--
--   wrangler d1 execute ROUTER_DB --remote --command \
--     "INSERT INTO memory_store_tenant (store_id, tenant_id, created_at)
--      SELECT id, tenant_id, COALESCE(created_at*1000, strftime('%s','now')*1000)
--        FROM memory_stores"
--
-- (run from apps/main, before traffic for new tenants on non-shard-0
-- shards starts creating memory_stores).

CREATE TABLE IF NOT EXISTS "memory_store_tenant" (
  "store_id"     TEXT PRIMARY KEY NOT NULL,
  "tenant_id"    TEXT NOT NULL,
  "created_at"   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_memory_store_tenant_tenant"
  ON "memory_store_tenant" ("tenant_id");
