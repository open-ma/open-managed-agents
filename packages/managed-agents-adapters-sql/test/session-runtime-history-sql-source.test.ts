import { beforeEach, describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  InitialSessionEvent,
  SessionExecutionContextSourcePort,
  SessionEventView,
  SessionRuntimeHistorySourcePort,
} from "@open-managed-agents/managed-agents-application";
import * as sqlAdapters from "../src";

const SCHEMA_SQL = `
CREATE TABLE managed_sessions (
  workspace_id text NOT NULL,
  id text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE managed_session_initial_events (
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  sequence integer NOT NULL,
  document text NOT NULL,
  PRIMARY KEY (workspace_id, session_id, sequence)
);
CREATE TABLE managed_session_events (
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  id text NOT NULL,
  type text NOT NULL,
  document text NOT NULL,
  processed_at integer NOT NULL,
  PRIMARY KEY (workspace_id, session_id, id)
);
`;

interface ReadersFactory {
  (client: SqlClient): {
    executionContext: SessionExecutionContextSourcePort;
    history: SessionRuntimeHistorySourcePort;
  };
}

describe("SqlSessionRuntimeHistorySource", () => {
  let client: SqlClient;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA_SQL);
  });

  it("loads ordered initial and official event history in tenant scope", async () => {
    const createReaders = (
      sqlAdapters as typeof sqlAdapters & {
        createSqlSessionRuntimeReaders?: ReadersFactory;
      }
    ).createSqlSessionRuntimeReaders;
    expect(createReaders).toBeTypeOf("function");
    if (createReaders === undefined) return;

    const initialEvents: InitialSessionEvent[] = [
      {
        type: "user.message",
        content: [{ type: "text", text: "First" }],
      },
      {
        type: "user.define_outcome",
        description: "Done",
        rubric: { type: "text", content: "All checks pass" },
      },
    ];
    const events: SessionEventView[] = [
      {
        id: "event_02",
        type: "session.status_idle",
        processedAt: "2026-08-26T02:00:00.000Z",
        stopReason: { type: "end_turn" },
      },
      {
        id: "event_01",
        type: "session.status_running",
        processedAt: "2026-08-26T01:00:00.000Z",
      },
    ];
    await client
      .prepare(`INSERT INTO managed_sessions (workspace_id, id) VALUES (?, ?)`)
      .bind("workspace_01", "session_01")
      .run();
    for (const [sequence, event] of initialEvents.entries()) {
      await client
        .prepare(
          `INSERT INTO managed_session_initial_events
            (workspace_id, session_id, sequence, document)
           VALUES (?, ?, ?, ?)`,
        )
        .bind("workspace_01", "session_01", sequence, JSON.stringify(event))
        .run();
    }
    for (const event of events) {
      await client
        .prepare(
          `INSERT INTO managed_session_events
            (workspace_id, session_id, id, type, document, processed_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          "workspace_01",
          "session_01",
          event.id,
          event.type,
          JSON.stringify(event),
          Date.parse(event.processedAt ?? ""),
        )
        .run();
    }
    const source = createReaders(client).history;

    await expect(
      source.load({ workspaceId: "workspace_01", sessionId: "session_01" }),
    ).resolves.toEqual({ revision: 1, initialEvents, events: [events[1], events[0]] });
    await expect(
      source.load({ workspaceId: "workspace_other", sessionId: "session_01" }),
    ).resolves.toBeNull();
  });
});
