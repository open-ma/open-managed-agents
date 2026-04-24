// @open-managed-agents/tenant-db
//
// Abstraction for "given a tenant id, give me the D1 database that holds that
// tenant's data".
//
// Phase 2-revised (current): the production implementation will be a
// MetaTableTenantDbProvider that reads `tenant_shard` from the control-plane
// DB to look up which binding holds a tenant's data. With permanent
// per-isolate cache and AUTH_DB fallback for tenants without a shard row.
// N=1 deployment: nothing in tenant_shard, all tenants fallback to AUTH_DB
// and behaviour matches today's shared-DB OMA. Adding new shards = add
// binding + insert shard_pool row + assign new tenants to it; existing
// tenants stay (no rehash).
//
// CfSharedAuthDbProvider is the killswitch fallback that always returns
// AUTH_DB regardless of tenant — used when PER_TENANT_DB_ENABLED=false or
// during early-boot routes that don't have a control-plane lookup yet.

export type { TenantDbProvider } from "./ports";
export { CfSharedAuthDbProvider } from "./cf-shared-default";
export { MetaTableTenantDbProvider } from "./cf-meta-router";

