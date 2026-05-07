// Adapter wiring. CF + SQLite factories share a single SqlVaultRepo class.

export { SqlVaultRepo } from "./sql-vault-repo";

import { SqlVaultRepo } from "./sql-vault-repo";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { Logger } from "../ports";
import { VaultService } from "../service";

/** CF deployment factory. */
export function createCfVaultService(
  deps: { db: D1Database },
  opts?: { logger?: Logger },
): VaultService {
  return new VaultService({
    repo: new SqlVaultRepo(new CfD1SqlClient(deps.db)),
    logger: opts?.logger,
  });
}

/** Node deployment factory — accepts any SqlClient. */
export function createSqliteVaultService(
  deps: { client: SqlClient },
  opts?: { logger?: Logger },
): VaultService {
  return new VaultService({
    repo: new SqlVaultRepo(deps.client),
    logger: opts?.logger,
  });
}
