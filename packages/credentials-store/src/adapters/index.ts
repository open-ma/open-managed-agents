// Adapter wiring. CF + SQLite factories share a single SqlCredentialRepo class.

export { SqlCredentialRepo } from "./sql-credential-repo";

import { SqlCredentialRepo } from "./sql-credential-repo";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { Logger } from "../ports";
import { CredentialService } from "../service";

/** CF deployment factory. */
export function createCfCredentialService(
  deps: { db: D1Database },
  opts?: { logger?: Logger },
): CredentialService {
  return new CredentialService({
    repo: new SqlCredentialRepo(new CfD1SqlClient(deps.db)),
    logger: opts?.logger,
  });
}

/** CFless / Node deployment factory — accepts any SqlClient. */
export function createSqliteCredentialService(
  deps: { client: SqlClient },
  opts?: { logger?: Logger },
): CredentialService {
  return new CredentialService({
    repo: new SqlCredentialRepo(deps.client),
    logger: opts?.logger,
  });
}
