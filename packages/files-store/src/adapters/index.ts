// Adapter wiring. Both Cloudflare (D1) and Node (any SqlClient)
// deployment factories live here behind a single SqlFileRepo class.

export { SqlFileRepo } from "./sql-file-repo";

import { SqlFileRepo } from "./sql-file-repo";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { Logger } from "../ports";
import { FileService } from "../service";

export function createCfFileService(
  deps: { db: D1Database },
  opts?: { logger?: Logger },
): FileService {
  return new FileService({
    repo: new SqlFileRepo(new CfD1SqlClient(deps.db)),
    logger: opts?.logger,
  });
}

export function createSqliteFileService(
  deps: { client: SqlClient },
  opts?: { logger?: Logger },
): FileService {
  return new FileService({
    repo: new SqlFileRepo(deps.client),
    logger: opts?.logger,
  });
}
