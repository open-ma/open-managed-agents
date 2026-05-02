// Adapter wiring for the control-plane shard router store. All reads and
// writes target the control-plane DB (env.AUTH_DB on CF, the shared SQL
// client on CFless).

export { SqlTenantShardDirectoryRepo } from "./sql-tenant-shard-repo";
export { SqlShardPoolRepo } from "./sql-shard-pool-repo";

import { SqlTenantShardDirectoryRepo } from "./sql-tenant-shard-repo";
import { SqlShardPoolRepo } from "./sql-shard-pool-repo";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import type { SqlClient } from "@open-managed-agents/sql-client";
import {
  TenantShardDirectoryService,
  ShardPoolService,
} from "../service";

export function createCfTenantShardDirectoryService(deps: {
  controlPlaneDb: D1Database;
}): TenantShardDirectoryService {
  return new TenantShardDirectoryService(
    new SqlTenantShardDirectoryRepo(new CfD1SqlClient(deps.controlPlaneDb)),
  );
}

export function createCfShardPoolService(deps: {
  controlPlaneDb: D1Database;
}): ShardPoolService {
  return new ShardPoolService(new SqlShardPoolRepo(new CfD1SqlClient(deps.controlPlaneDb)));
}

export function createSqliteTenantShardDirectoryService(deps: {
  client: SqlClient;
}): TenantShardDirectoryService {
  return new TenantShardDirectoryService(new SqlTenantShardDirectoryRepo(deps.client));
}

export function createSqliteShardPoolService(deps: {
  client: SqlClient;
}): ShardPoolService {
  return new ShardPoolService(new SqlShardPoolRepo(deps.client));
}
