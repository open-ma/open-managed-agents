// Cloudflare adapter wiring. Exports the D1 implementation of ModelCardRepo
// plus a `createCfModelCardService` factory that callers in apps/main and
// apps/agent use to instantiate the service.

export { D1ModelCardRepo } from "./d1-model-card-repo";

import { D1ModelCardRepo } from "./d1-model-card-repo";
import type { Crypto, Logger } from "../ports";
import { ModelCardService } from "../service";

export function createCfModelCardService(
  env: { AUTH_DB: D1Database },
  opts?: { logger?: Logger; crypto?: Crypto },
): ModelCardService {
  return new ModelCardService({
    repo: new D1ModelCardRepo(env.AUTH_DB),
    logger: opts?.logger,
    crypto: opts?.crypto,
  });
}
