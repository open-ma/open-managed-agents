// Adapter wiring. Both Cloudflare (D1) and Node (any SqlClient)
// deployment factories live here behind a single SqlModelCardRepo class.

export { SqlModelCardRepo } from "./sql-model-card-repo";

import { SqlModelCardRepo } from "./sql-model-card-repo";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { Crypto, Logger } from "../ports";
import { ModelCardService } from "../service";

export function createCfModelCardService(
  deps: { db: D1Database },
  opts?: { logger?: Logger; crypto?: Crypto },
): ModelCardService {
  return new ModelCardService({
    repo: new SqlModelCardRepo(new CfD1SqlClient(deps.db)),
    logger: opts?.logger,
    crypto: opts?.crypto,
  });
}

export function createSqliteModelCardService(
  deps: { client: SqlClient },
  opts?: { logger?: Logger; crypto?: Crypto },
): ModelCardService {
  return new ModelCardService({
    repo: new SqlModelCardRepo(deps.client),
    logger: opts?.logger,
    crypto: opts?.crypto,
  });
}
