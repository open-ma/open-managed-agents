// Adapter wiring. Both Cloudflare (D1) and Node (any SqlClient)
// deployment factories live here behind a single SqlSessionRepo class.

export { SqlSessionRepo } from "./sql-session-repo";

import { SqlSessionRepo } from "./sql-session-repo";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { Logger } from "../ports";
import { SessionService } from "../service";

export function createCfSessionService(
  deps: { db: D1Database },
  opts?: { logger?: Logger },
): SessionService {
  return new SessionService({
    repo: new SqlSessionRepo(new CfD1SqlClient(deps.db)),
    logger: opts?.logger,
  });
}

export function createSqliteSessionService(
  deps: { client: SqlClient },
  opts?: { logger?: Logger },
): SessionService {
  return new SessionService({
    repo: new SqlSessionRepo(deps.client),
    logger: opts?.logger,
  });
}
