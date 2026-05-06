// Adapter wiring. Both Cloudflare (D1) and Node (any SqlClient)
// deployment factories live here behind a single SqlEnvironmentRepo class.

export { SqlEnvironmentRepo } from "./sql-environment-repo";

import { SqlEnvironmentRepo } from "./sql-environment-repo";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { Logger } from "../ports";
import { EnvironmentService } from "../service";

export function createCfEnvironmentService(
  deps: { db: D1Database },
  opts?: { logger?: Logger },
): EnvironmentService {
  return new EnvironmentService({
    repo: new SqlEnvironmentRepo(new CfD1SqlClient(deps.db)),
    logger: opts?.logger,
  });
}

/**
 * Node deployment factory. Caller passes any SqlClient
 * (better-sqlite3, postgres.js wrapper, etc.).
 */
export function createSqliteEnvironmentService(
  deps: { client: SqlClient },
  opts?: { logger?: Logger },
): EnvironmentService {
  return new EnvironmentService({
    repo: new SqlEnvironmentRepo(deps.client),
    logger: opts?.logger,
  });
}
