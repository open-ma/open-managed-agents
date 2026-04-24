// Cloudflare adapter wiring. Exports the D1 implementation of CredentialRepo
// plus a `createCfCredentialService` factory that callers in apps/main and
// apps/agent use to instantiate the service.

export { D1CredentialRepo } from "./d1-credential-repo";

import { D1CredentialRepo } from "./d1-credential-repo";
import type { Logger } from "../ports";
import { CredentialService } from "../service";

export function createCfCredentialService(
  deps: { db: D1Database },
  opts?: { logger?: Logger },
): CredentialService {
  return new CredentialService({
    repo: new D1CredentialRepo(deps.db),
    logger: opts?.logger,
  });
}
