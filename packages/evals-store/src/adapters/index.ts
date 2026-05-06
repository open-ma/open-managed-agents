// Adapter wiring. Both Cloudflare (D1) and Node (any SqlClient)
// deployment factories live here behind a single SqlEvalRunRepo class.

export { SqlEvalRunRepo } from "./sql-eval-run-repo";

import { SqlEvalRunRepo } from "./sql-eval-run-repo";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { Logger } from "../ports";
import { EvalRunService } from "../service";

export function createCfEvalRunService(
  deps: { db: D1Database },
  opts?: { logger?: Logger },
): EvalRunService {
  return new EvalRunService({
    repo: new SqlEvalRunRepo(new CfD1SqlClient(deps.db)),
    logger: opts?.logger,
  });
}

export function createSqliteEvalRunService(
  deps: { client: SqlClient },
  opts?: { logger?: Logger },
): EvalRunService {
  return new EvalRunService({
    repo: new SqlEvalRunRepo(deps.client),
    logger: opts?.logger,
  });
}
