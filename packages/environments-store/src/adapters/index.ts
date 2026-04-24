// Cloudflare adapter wiring.

export { D1EnvironmentRepo } from "./d1-environment-repo";

import { D1EnvironmentRepo } from "./d1-environment-repo";
import type { Logger } from "../ports";
import { EnvironmentService } from "../service";

export function createCfEnvironmentService(
  deps: { db: D1Database },
  opts?: { logger?: Logger },
): EnvironmentService {
  return new EnvironmentService({
    repo: new D1EnvironmentRepo(deps.db),
    logger: opts?.logger,
  });
}
