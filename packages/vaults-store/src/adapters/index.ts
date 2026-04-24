// Cloudflare adapter wiring.

export { D1VaultRepo } from "./d1-vault-repo";

import { D1VaultRepo } from "./d1-vault-repo";
import type { Logger } from "../ports";
import { VaultService } from "../service";

export function createCfVaultService(
  env: { AUTH_DB: D1Database },
  opts?: { logger?: Logger },
): VaultService {
  return new VaultService({
    repo: new D1VaultRepo(env.AUTH_DB),
    logger: opts?.logger,
  });
}
