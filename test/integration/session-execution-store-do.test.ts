// @ts-nocheck
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  ensureSessionExecutionCoordinatorSchema,
  SqlSessionExecutionStore,
} from "@open-managed-agents/session-runtime-sql/coordination";
import { sqlClientFromDurableObjectStorage } from
  "@open-managed-agents/sql-client/adapters/cf-do";
import { sessionExecutionStoreConformance } from
  "../../packages/session-runtime-contract/test/execution-store-conformance";

const at = (seconds: number) =>
  new Date(Date.UTC(2026, 8, 4, 0, 0, seconds)).toISOString();

let fixtureSerial = 0;
const fixtureRunId = Date.now().toString(36);

function freshDoStub(fixtureId = `case_${++fixtureSerial}`) {
  const id = `execution_store_${fixtureRunId}_${fixtureId}`;
  return env.SESSION_DO.get(env.SESSION_DO.idFromName(id));
}

describe("SessionExecutionStorePort on Durable Object SQLite", () => {
  it("reclaims an expired attempt and fences the stale DO incarnation", async () => {
    await runInDurableObject(freshDoStub(), async (_instance, state) => {
      const sql = sqlClientFromDurableObjectStorage(state.storage);
      await ensureSessionExecutionCoordinatorSchema(sql);
      const store = new SqlSessionExecutionStore(sql);
      await store.admit({
        execution: {
          id: "execution_01",
          workspaceId: "workspace_01",
          sessionId: "session_01",
          admittedAt: at(1),
          events: [{
            id: "event_01",
            type: "user.message",
            content: [{ type: "text", text: "run" }],
            processedAt: at(1),
          }],
        },
        policy: { maxAttempts: 2, timeoutMs: 60_000 },
      });

      const stale = await store.claim({
        ownerId: "do_incarnation_1",
        attemptId: "attempt_1",
        claimedAt: at(2),
        leaseTtlMs: 1_000,
      });
      expect(stale.type).toBe("claimed");
      if (stale.type !== "claimed") return;

      const replacement = await store.claim({
        ownerId: "do_incarnation_2",
        attemptId: "attempt_2",
        claimedAt: at(4),
        leaseTtlMs: 30_000,
      });
      expect(replacement).toMatchObject({
        type: "claimed",
        fence: { ownerId: "do_incarnation_2", generation: 2 },
      });
      await expect(store.settle({
        fence: stale.fence,
        settledAt: at(5),
        outcome: "completed",
      })).resolves.toEqual({ type: "lost" });
    });
  });
});

sessionExecutionStoreConformance("Durable Object SQLite", {
  async withStore(fixtureId, run) {
    return runInDurableObject(freshDoStub(fixtureId), async (_instance, state) => {
      const sql = sqlClientFromDurableObjectStorage(state.storage);
      await sql.exec("DROP TABLE IF EXISTS managed_session_executions");
      await ensureSessionExecutionCoordinatorSchema(sql);
      return run(new SqlSessionExecutionStore(sql));
    });
  },
});
