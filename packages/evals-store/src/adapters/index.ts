// Cloudflare adapter wiring. Exports the D1 implementation of EvalRunRepo
// plus a `createCfEvalRunService` factory that callers in apps/main use to
// instantiate the service.

export { D1EvalRunRepo } from "./d1-eval-run-repo";

import { D1EvalRunRepo } from "./d1-eval-run-repo";
import type { Logger } from "../ports";
import { EvalRunService } from "../service";

export function createCfEvalRunService(
  env: { AUTH_DB: D1Database },
  opts?: { logger?: Logger },
): EvalRunService {
  return new EvalRunService({
    repo: new D1EvalRunRepo(env.AUTH_DB),
    logger: opts?.logger,
  });
}
