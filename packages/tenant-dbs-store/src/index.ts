// @open-managed-agents/tenant-dbs-store
//
// Control-plane shard router tables. Two responsibilities:
//
//   tenant_shard  — tenant_id → binding_name. Permanent assignment record.
//                   Read on every authenticated request via
//                   MetaTableTenantDbProvider (with per-isolate cache).
//                   Missing row = tenant falls back to the default shard
//                   (env.AUTH_DB), which is the N=1 default behaviour.
//
//   shard_pool    — binding_name → status / capacity. Operational state for
//                   choosing where new tenants land + capacity monitoring.
//                   Updated by the capacity monitor cron and admin scripts.
//
// Both ALWAYS query the control-plane DB (env.AUTH_DB) regardless of how
// per-tenant data is sharded — they're the routing map itself.

export * from "./ports";
export * from "./service";
export {
  D1TenantShardDirectoryRepo,
  D1ShardPoolRepo,
  createCfTenantShardDirectoryService,
  createCfShardPoolService,
} from "./adapters";
