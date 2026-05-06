// Adapter wiring for the agents-store. Both CF (D1) and self-host (any
// SqlClient — typically better-sqlite3 via createBetterSqlite3SqlClient)
// factories live here behind a single SqlAgentRepo class.

export { SqlAgentRepo } from "./sql-agent-repo";

import { SqlAgentRepo } from "./sql-agent-repo";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { Logger } from "../ports";
import { AgentService } from "../service";

/**
 * CF deployment factory. Wraps the D1Database binding in a SqlClient so the
 * repo stays runtime-agnostic. apps/main + apps/agent + tests call this
 * unchanged — the SqlClient adapter is an internal detail.
 */
export function createCfAgentService(
  deps: { db: D1Database },
  opts?: { logger?: Logger },
): AgentService {
  return new AgentService({
    repo: new SqlAgentRepo(new CfD1SqlClient(deps.db)),
    logger: opts?.logger,
  });
}

/**
 * Node deployment factory. Caller passes any SqlClient — typically
 * BetterSqlite3SqlClient (`createBetterSqlite3SqlClient(path)`) for embedded
 * SQLite, but a future PG adapter would slot in identically.
 *
 * Coexisting in the same file as createCfAgentService means Node consumers
 * (apps/main-node) must include `@cloudflare/workers-types` in their tsconfig
 * to satisfy the D1Database type reference above. Workerd's resolver in
 * @cloudflare/vitest-pool-workers doesn't honour deep package.json subpath
 * exports for workspace packages — splitting cf/sqlite into separate entries
 * was tried and rejected for that reason.
 */
export function createSqliteAgentService(
  deps: { client: SqlClient },
  opts?: { logger?: Logger },
): AgentService {
  return new AgentService({
    repo: new SqlAgentRepo(deps.client),
    logger: opts?.logger,
  });
}
