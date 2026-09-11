import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  SessionExecutionContextSourcePort,
} from "@open-managed-agents/session-runtime-contract/context";
import type {
  SessionRuntimeHistorySourcePort,
} from "@open-managed-agents/session-runtime-contract/history";

import { SqlSessionExecutionContextSource } from "./context";
import { SqlSessionRuntimeHistorySource } from "./history";

export {
  ensureSessionExecutionCoordinatorSchema,
  sessionExecutionCoordinatorSqlSchema,
  SqlSessionExecutionStore,
  SqlSessionExecutionCoordinator,
} from "./coordination";
export { SqlSessionExecutionContextSource } from "./context";
export { SqlSessionRuntimeHistorySource } from "./history";

export interface SqlSessionRuntimeReaders {
  executionContext: SessionExecutionContextSourcePort;
  history: SessionRuntimeHistorySourcePort;
}

export function createSqlSessionRuntimeReaders(
  client: SqlClient,
): SqlSessionRuntimeReaders {
  return {
    executionContext: new SqlSessionExecutionContextSource(client),
    history: new SqlSessionRuntimeHistorySource(client),
  };
}
