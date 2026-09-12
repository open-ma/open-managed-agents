import { describe, expect, it } from "vitest";
import type {
  AdmitSessionExecution,
  SessionExecutionStorePort,
} from "../src/coordination";

export interface SessionExecutionStoreTestHarness {
  withStore<T>(
    fixtureId: string,
    run: (store: SessionExecutionStorePort) => Promise<T>,
  ): Promise<T>;
}

const at = (seconds: number) =>
  new Date(Date.UTC(2026, 8, 4, 0, 0, seconds)).toISOString();

function admitted(
  id: string,
  sessionId: string,
  admittedAt: string,
  text = id,
  laneId?: string,
): AdmitSessionExecution {
  return {
    execution: {
      id,
      workspaceId: "workspace_01",
      sessionId,
      ...(laneId !== undefined && { laneId }),
      admittedAt,
      events: [{
        id,
        type: "user.message",
        content: [{ type: "text", text }],
        processedAt: admittedAt,
      }],
    },
  };
}

/** Behavior suite every SessionExecutionStorePort adapter must pass. */
export function sessionExecutionStoreConformance(
  adapterName: string,
  harness: SessionExecutionStoreTestHarness,
): void {
  describe(`${adapterName} SessionExecutionStorePort conformance`, () => {
    it("admits idempotently and reports an execution identity collision", () =>
      harness.withStore("admission", async (store) => {
        const input = admitted("execution_01", "session_01", at(1));
        await expect(store.admit(input)).resolves.toMatchObject({
          type: "admitted",
          execution: { state: "queued", attemptCount: 0 },
        });
        await expect(store.admit(structuredClone(input))).resolves.toMatchObject({
          type: "replayed",
          execution: { revision: 1 },
        });
        await expect(store.admit(
          admitted("execution_01", "session_01", at(1), "different"),
        )).resolves.toMatchObject({ type: "conflict" });
      }));

    it("claims one FIFO head per session while allowing distinct sessions", () =>
      harness.withStore("fifo", async (store) => {
        await store.admit(admitted("a1", "session_a", at(1)));
        await store.admit(admitted("a2", "session_a", at(2)));
        await store.admit(admitted("b1", "session_b", at(3)));

        const first = await store.claim({
          ownerId: "owner_a",
          attemptId: "attempt_a",
          claimedAt: at(4),
          leaseTtlMs: 30_000,
        });
        const second = await store.claim({
          ownerId: "owner_b",
          attemptId: "attempt_b",
          claimedAt: at(4),
          leaseTtlMs: 30_000,
        });
        const third = await store.claim({
          ownerId: "owner_c",
          attemptId: "attempt_c",
          claimedAt: at(4),
          leaseTtlMs: 30_000,
        });

        expect(first).toMatchObject({
          type: "claimed",
          execution: { id: "a1", sessionId: "session_a" },
        });
        expect(second).toMatchObject({
          type: "claimed",
          execution: { id: "b1", sessionId: "session_b" },
        });
        expect(third).toEqual({ type: "empty" });
      }));

    it("serializes one thread lane without blocking a sibling thread", () =>
      harness.withStore("lanes", async (store) => {
        await store.admit(admitted("primary_1", "session_a", at(1), "p1", "sthr_primary"));
        await store.admit(admitted("primary_2", "session_a", at(2), "p2", "sthr_primary"));
        await store.admit(admitted("sibling_1", "session_a", at(3), "s1", "sthr_sibling"));

        const first = await store.claim({
          ownerId: "owner_a",
          attemptId: "attempt_primary",
          claimedAt: at(4),
          leaseTtlMs: 30_000,
        });
        const second = await store.claim({
          ownerId: "owner_b",
          attemptId: "attempt_sibling",
          claimedAt: at(4),
          leaseTtlMs: 30_000,
        });
        const blocked = await store.claim({
          ownerId: "owner_c",
          attemptId: "attempt_blocked",
          claimedAt: at(4),
          leaseTtlMs: 30_000,
        });

        expect(first).toMatchObject({
          type: "claimed",
          execution: { id: "primary_1", laneId: "sthr_primary" },
        });
        expect(second).toMatchObject({
          type: "claimed",
          execution: { id: "sibling_1", laneId: "sthr_sibling" },
        });
        expect(blocked).toEqual({ type: "empty" });
      }));

    it("claims only work inside an explicitly scoped session lane", () =>
      harness.withStore("scoped-claim", async (store) => {
        await store.admit(admitted(
          "primary_1",
          "session_a",
          at(1),
          "primary",
          "sthr_primary",
        ));
        await store.admit(admitted(
          "sibling_1",
          "session_a",
          at(2),
          "sibling",
          "sthr_sibling",
        ));
        await store.admit(admitted(
          "other_1",
          "session_b",
          at(3),
          "other",
          "sthr_primary",
        ));

        await expect(store.claim({
          workspaceId: "workspace_01",
          sessionId: "session_a",
          laneId: "sthr_sibling",
          ownerId: "owner_scoped",
          attemptId: "attempt_scoped",
          claimedAt: at(4),
          leaseTtlMs: 30_000,
        })).resolves.toMatchObject({
          type: "claimed",
          execution: {
            id: "sibling_1",
            sessionId: "session_a",
            laneId: "sthr_sibling",
          },
        });

        await expect(store.claim({
          workspaceId: "workspace_missing",
          sessionId: "session_a",
          laneId: "sthr_primary",
          ownerId: "owner_missing",
          attemptId: "attempt_missing",
          claimedAt: at(4),
          leaseTtlMs: 30_000,
        })).resolves.toEqual({ type: "empty" });
      }));

    it("reclaims an expired lease and fences the stale attempt", () =>
      harness.withStore("reclaim", async (store) => {
        await store.admit(admitted("execution_01", "session_01", at(1)));
        const stale = await store.claim({
          ownerId: "owner_stale",
          attemptId: "attempt_stale",
          claimedAt: at(2),
          leaseTtlMs: 1_000,
        });
        expect(stale.type).toBe("claimed");
        if (stale.type !== "claimed") return;

        const current = await store.claim({
          ownerId: "owner_current",
          attemptId: "attempt_current",
          claimedAt: at(4),
          leaseTtlMs: 30_000,
        });
        expect(current).toMatchObject({
          type: "claimed",
          fence: { generation: 2, ownerId: "owner_current" },
        });
        await expect(store.renew({
          fence: stale.fence,
          renewedAt: at(5),
          leaseTtlMs: 30_000,
        })).resolves.toEqual({ type: "lost" });
        await expect(store.settle({
          fence: stale.fence,
          settledAt: at(5),
          outcome: "completed",
        })).resolves.toEqual({ type: "lost" });
      }));

    it("terminalizes attempt exhaustion and absolute deadline expiry", () =>
      harness.withStore("terminal", async (store) => {
        await store.admit({
          ...admitted("poison", "session_a", at(1)),
          policy: { maxAttempts: 1, timeoutMs: 60_000 },
        });
        await store.claim({
          ownerId: "owner_dead",
          attemptId: "attempt_1",
          claimedAt: at(2),
          leaseTtlMs: 1_000,
        });
        await expect(store.claim({
          ownerId: "owner_replacement",
          attemptId: "attempt_2",
          claimedAt: at(4),
          leaseTtlMs: 30_000,
        })).resolves.toEqual({ type: "empty" });
        await expect(store.find({
          workspaceId: "workspace_01",
          executionId: "poison",
        })).resolves.toMatchObject({
          state: "failed",
          attemptCount: 1,
          maxAttempts: 1,
          failure: "execution attempt limit exhausted",
        });

        await store.admit({
          ...admitted("deadline", "session_b", at(5)),
          policy: { maxAttempts: 3, timeoutMs: 1_000 },
        });
        await expect(store.claim({
          ownerId: "owner_late",
          attemptId: "attempt_late",
          claimedAt: at(7),
          leaseTtlMs: 30_000,
        })).resolves.toEqual({ type: "empty" });
        await expect(store.find({
          workspaceId: "workspace_01",
          executionId: "deadline",
        })).resolves.toMatchObject({
          state: "failed",
          deadlineAt: at(6),
          failure: "execution deadline exceeded",
        });
      }));

    it("delivers interrupt through renewal and invalidates a cancelled fence", () =>
      harness.withStore("interrupt", async (store) => {
        await store.admit(admitted(
          "execution_01",
          "session_01",
          at(1),
          "primary",
          "sthr_primary",
        ));
        await store.admit(admitted(
          "execution_02",
          "session_01",
          at(1),
          "sibling",
          "sthr_sibling",
        ));
        const claimed = await store.claim({
          ownerId: "owner_a",
          attemptId: "attempt_a",
          claimedAt: at(2),
          leaseTtlMs: 30_000,
        });
        expect(claimed.type).toBe("claimed");
        if (claimed.type !== "claimed") return;
        const sibling = await store.claim({
          ownerId: "owner_b",
          attemptId: "attempt_b",
          claimedAt: at(2),
          leaseTtlMs: 30_000,
        });
        expect(sibling.type).toBe("claimed");
        if (sibling.type !== "claimed") return;

        await expect(store.requestInterrupt({
          workspaceId: "workspace_01",
          sessionId: "session_01",
          laneId: "sthr_primary",
          requestedAt: at(3),
        })).resolves.toEqual({ type: "requested" });
        await expect(store.renew({
          fence: claimed.fence,
          renewedAt: at(4),
          leaseTtlMs: 30_000,
        })).resolves.toMatchObject({
          type: "renewed",
          interruptRequestedAt: at(3),
        });
        await expect(store.renew({
          fence: sibling.fence,
          renewedAt: at(4),
          leaseTtlMs: 30_000,
        })).resolves.toMatchObject({
          type: "renewed",
          interruptRequestedAt: null,
        });

        await expect(store.cancelSession({
          workspaceId: "workspace_01",
          sessionId: "session_01",
          cancelledAt: at(5),
          reason: "session terminated",
        })).resolves.toEqual({ queued: 0, running: 2 });
        await expect(store.settle({
          fence: claimed.fence,
          settledAt: at(6),
          outcome: "completed",
        })).resolves.toEqual({ type: "lost" });
      }));

    it("commits an interrupt that races the final settle", () =>
      harness.withStore("interrupt-settle-race", async (store) => {
        await store.admit(admitted("execution_01", "session_01", at(1)));
        const claimed = await store.claim({
          ownerId: "owner_a",
          attemptId: "attempt_a",
          claimedAt: at(2),
          leaseTtlMs: 30_000,
        });
        expect(claimed.type).toBe("claimed");
        if (claimed.type !== "claimed") return;

        // Simulate the interrupt arriving after the host's last renewal but
        // before it executes the atomic settle statement. The store must not
        // let a completed result win over the durable cancellation bit.
        await expect(store.requestInterrupt({
          workspaceId: "workspace_01",
          sessionId: "session_01",
          laneId: "sthr_primary",
          requestedAt: at(3),
        })).resolves.toEqual({ type: "requested" });
        await expect(store.settle({
          fence: claimed.fence,
          settledAt: at(4),
          outcome: "completed",
        })).resolves.toMatchObject({
          type: "settled",
          execution: {
            state: "cancelled",
            interruptRequestedAt: at(3),
            failure: "interrupted during execution",
          },
        });
      }));
  });
}
