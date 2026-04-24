// Cloudflare adapter wiring. Exports the D1 implementation of FileRepo
// plus a `createCfFileService` factory that callers in apps/main and
// apps/agent use to instantiate the service.

export { D1FileRepo } from "./d1-file-repo";

import { D1FileRepo } from "./d1-file-repo";
import type { Logger } from "../ports";
import { FileService } from "../service";

export function createCfFileService(
  deps: { db: D1Database },
  opts?: { logger?: Logger },
): FileService {
  return new FileService({
    repo: new D1FileRepo(deps.db),
    logger: opts?.logger,
  });
}
