// Cloudflare adapter wiring. Exports the D1 implementation of AgentRepo
// plus a `createCfAgentService` factory that callers in apps/main and
// apps/agent use to instantiate the service.

export { D1AgentRepo } from "./d1-agent-repo";

import { D1AgentRepo } from "./d1-agent-repo";
import type { Logger } from "../ports";
import { AgentService } from "../service";

export function createCfAgentService(
  deps: { db: D1Database },
  opts?: { logger?: Logger },
): AgentService {
  return new AgentService({
    repo: new D1AgentRepo(deps.db),
    logger: opts?.logger,
  });
}
