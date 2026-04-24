// Cloudflare adapter wiring for the control-plane shard router store. All
// reads and writes target the control-plane DB (env.AUTH_DB), never a
// per-tenant DB.

export { D1TenantShardDirectoryRepo } from "./d1-tenant-shard-repo";
export { D1ShardPoolRepo } from "./d1-shard-pool-repo";

import { D1TenantShardDirectoryRepo } from "./d1-tenant-shard-repo";
import { D1ShardPoolRepo } from "./d1-shard-pool-repo";
import {
  TenantShardDirectoryService,
  ShardPoolService,
} from "../service";

export function createCfTenantShardDirectoryService(deps: {
  controlPlaneDb: D1Database;
}): TenantShardDirectoryService {
  return new TenantShardDirectoryService(new D1TenantShardDirectoryRepo(deps.controlPlaneDb));
}

export function createCfShardPoolService(deps: {
  controlPlaneDb: D1Database;
}): ShardPoolService {
  return new ShardPoolService(new D1ShardPoolRepo(deps.controlPlaneDb));
}
