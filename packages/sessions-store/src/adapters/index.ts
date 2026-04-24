// Cloudflare adapter wiring. Exports the D1 implementation of SessionRepo
// plus a `createCfSessionService` factory that callers in apps/main and
// apps/agent use to instantiate the service.

export { D1SessionRepo } from "./d1-session-repo";

import { D1SessionRepo } from "./d1-session-repo";
import type { Logger } from "../ports";
import { SessionService } from "../service";

export function createCfSessionService(
  env: { AUTH_DB: D1Database },
  opts?: { logger?: Logger },
): SessionService {
  return new SessionService({
    repo: new D1SessionRepo(env.AUTH_DB),
    logger: opts?.logger,
  });
}
